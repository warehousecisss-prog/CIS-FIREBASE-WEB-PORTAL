const SS_API = require('./Service_SheetsAPI');
const logger = require('firebase-functions/logger');
const { getActiveUserEmail } = require('../auth');
// The Node stand-in for Apps Script's LockService.getScriptLock(), which has no
// counterpart here. AUDIT_2026-08-24.md B7. Deliberately disposable -- see the
// header of functions/lock.js before adding a second call site.
const { withInventoryLock } = require('../lock');
const {
  trelloCreds_,
  trelloFetch_,
  parseSysBlob_,
  resolveCanonicalProductId_,
  splitProductIdFromDesc_
} = require('./Shared_Classifiers');

/**
 * ============================================================================
 * CIS WAREHOUSE PORTAL - CORE INVENTORY & FEDEX MUTATION SERVICES
 * PORTED TO NODE.JS (FIREBASE CLOUD FUNCTIONS)
 * ============================================================================
 */

// The Inventory tab title. Every delete path resolves this to a real numeric
// gid at call time via SS_API.getSheetId() -- see PORT_AUDIT C4.
const INVENTORY_SHEET = "Inventory";

// Generate UUID substitute for Utilities.getUuid()
function getUuid() {
  return require('crypto').randomUUID();
}

/**
 * Coerces a client-supplied quantity to a finite number, or reports why not.
 *
 * NaN is the specific hazard. Every qty write in this file branches on
 * `newQty <= 0` to decide between "clear/delete the pallet" and "write the
 * number" -- and `NaN <= 0` is FALSE, so a NaN silently falls through to the
 * else and writes the literal value NaN into column C. The row then reads as
 * blank/#VALUE and every downstream Number(...) on it produces NaN in turn.
 *
 * Reachable from the drawer with any non-numeric input ("12o", "abc", "1.2.3")
 * because the client only does `Number(rawVal.replace(/,/g,''))` with no isNaN
 * check. Guarded on both sides in SRC; this is the server half.
 * See AUDIT_2026-08-24.md B5. Parity with SRC/src/Service_Write.js:26-36.
 *
 * @param {*} raw the incoming value.
 * @param {string} label what to call it in the error message.
 * @return {{ok: boolean, value?: number, error?: string}}
 */
function validateQty_(raw, label) {
  const n = Number(raw);
  if (!isFinite(n)) {
    return {
      ok: false,
      error: (label || "Quantity") + " must be a number — got \"" +
             String(raw === null || raw === undefined ? "" : raw) + "\"."
    };
  }
  return { ok: true, value: n };
}

/**
 * Core helper that finds a row based on locId and sku (or instanceId)
 * and allows a callback to define what happens to it.
 *
 * In GAS, this passed a "sheetWrapper" to simulate getRange().setValue().
 * In Node, we will read all data, find the row, let the callback define mutations,
 * and then run SS_API.batchUpdateValues / batchDeleteRows.
 *
 * ALWAYS returns a result object; never undefined. When no row resolves it
 * returns {success:false, error:'Row not found for <loc>/<sku>...'} and every
 * caller returns that verbatim. This is AUDIT_2026-08-24.md A1 / PORT_AUDIT C2:
 * the version this replaces ended with a bare `if (targetRowIdx > -1) {...}`
 * and no else, so an operator tapping SET on a pallet whose row had been
 * shifted or deleted by the concurrent sync wrote nothing, got {success:true}
 * from the caller anyway, and watched the UI repaint the old number. Matches
 * SRC/src/Service_Write.js:751-848.
 *
 * Runs under the project-wide write lease (functions/lock.js), which is the
 * Node stand-in for SRC's `LockService.getScriptLock()` at
 * SRC/src/Service_Write.js:752 -- AUDIT_2026-08-24.md B7, SCHEMA invariant #59.
 * The lock covers the WHOLE read-compute-write below: the row index is derived
 * from the snapshot read on the first line, so protecting only the write would
 * still let a row inserted or deleted in between send it to the wrong pallet.
 * On contention this returns SRC's exact {success:false, error:"Server busy.
 * Please try again."} without touching the sheet.
 *
 * The Phase 2 row-data-mismatch guard below is NOT made redundant by the lock
 * and must stay: the lease only serialises OUR writers, and people edit this
 * spreadsheet by hand in the Sheets UI. A row shifted by a human typing
 * directly into it is invisible to any lock, and that guard is the only thing
 * that catches it.
 *
 * @param {string} locId
 * @param {string} sku
 * @param {string|number} instanceOrRowId instanceId, row number, or falsy.
 * @param {Function} callback receives (sheetWrapper, rowIdx, itemsAtLoc).
 * @param {Object} [context] Express req / callable context, for attribution.
 * @return {Promise<{success: boolean, error?: string}>}
 */
async function modifySheetRow(locId, sku, instanceOrRowId, callback, context) {
  return withInventoryLock(
      () => modifySheetRowLocked_(locId, sku, instanceOrRowId, callback, context),
      { label: 'modifySheetRow ' + (locId || '(no location)') + '/' + (sku || '(no SKU)') }
  );
}

/**
 * The body of modifySheetRow, with the lease already held.
 *
 * Split out only so the lock is one deletable line rather than an extra level
 * of indentation over 100 lines -- see the disposability note in
 * functions/lock.js. Never call this directly: it does the read-compute-write
 * with no serialisation at all.
 *
 * @param {string} locId
 * @param {string} sku
 * @param {string|number} instanceOrRowId
 * @param {Function} callback
 * @param {Object} [context]
 * @return {Promise<{success: boolean, error?: string}>}
 */
async function modifySheetRowLocked_(locId, sku, instanceOrRowId, callback, context) {
 try {
  const data = await SS_API.getSheetValues("Inventory!A:G");
  const cleanStr = (str) => str ? str.toString().replace(/(\r\n|\n|\r)/gm, "").trim() : "";
  const targetLoc = cleanStr(locId);
  const targetSku = cleanStr(sku);
  
  let targetRowIdx = -1;
  let itemsAtLoc = 0;

  for (let i = 1; i < data.length; i++) {
    const rowLoc = cleanStr(data[i][0]);
    if (rowLoc === targetLoc && cleanStr(data[i][1]) !== "Vacant") itemsAtLoc++;
  }

  if (typeof instanceOrRowId === 'string' && instanceOrRowId.length > 10) {
    for (let i = 1; i < data.length; i++) {
       if (data[i][6] === instanceOrRowId) {
          targetRowIdx = i + 1; // 1-indexed for Sheets
          break;
       }
    }
  } else if (typeof instanceOrRowId === 'number' && instanceOrRowId > 1) {
    targetRowIdx = instanceOrRowId;

    // A raw row index from the client is an assertion about the sheet, not a
    // fact about it. SRC's *ByRow twins (updateInventoryByRow:846,
    // setTotalStockByRow:896) re-read the row and refuse on a mismatch; in this
    // port those twins delegate here, so the guard has to live here or it is
    // lost. Without it, a row shifted by a concurrent sync between page load
    // and tap means the write lands on a DIFFERENT pallet -- silently, and
    // reported as success.
    const snapshot = data[targetRowIdx - 1];
    if (!snapshot) {
      const err = 'Row ' + targetRowIdx + ' is past the end of Inventory. ' +
                  'The sheet may have been modified.';
      logger.warn('modifySheetRow: ' + err);
      return { success: false, error: err };
    }
    if (targetLoc && targetSku &&
        (cleanStr(snapshot[0]) !== targetLoc || cleanStr(snapshot[1]) !== targetSku)) {
      const err = 'Row data mismatch. The sheet may have been modified.';
      logger.warn('modifySheetRow: ' + err + ' (row ' + targetRowIdx + ' holds ' +
                  cleanStr(snapshot[0]) + '/' + cleanStr(snapshot[1]) + ', expected ' +
                  targetLoc + '/' + targetSku + ')');
      return { success: false, error: err };
    }
  }
  
  if (targetRowIdx === -1) {
    for (let i = 1; i < data.length; i++) {
      const rowLoc = cleanStr(data[i][0]);
      const rowSku = cleanStr(data[i][1]);
      
      if (rowLoc === targetLoc && rowSku === targetSku) {
        const sObj = parseSysBlob_(data[i][5], 'Inventory row ' + (i + 1));
        const isHub = !!(sObj && sObj.t === 'B');
        if (!isHub) {
          targetRowIdx = i + 1;
          break;
        }
      }
    }
  }
  
  if (targetRowIdx === -1) {
    const err = 'Row not found for ' + (targetLoc || '(no location)') + '/' + (targetSku || '(no SKU)') +
                '. The pallet may have been moved or deleted by another station.';
    logger.warn('modifySheetRow: ' + err, { instanceOrRowId: instanceOrRowId });
    return { success: false, error: err };
  }

  {
    let sheetUpdates = [];
    let rowsToDelete = [];

    // Simulate the sheetWrapper passed in GAS
    const sheetWrapper = {
        getRange: function(row, col) {
            return {
                setValue: function(val) {
                    const colLetter = String.fromCharCode(64 + col);
                    sheetUpdates.push({ range: `Inventory!${colLetter}${row}`, values: [[val]] });
                },
                getValue: function() {
                    // This relies on the current state in `data` (which is 0-indexed while row is 1-indexed)
                    return data[row - 1][col - 1];
                }
            };
        },
        deleteRow: function(row) {
            rowsToDelete.push(row);
        }
    };

    // Awaited. Several callbacks are async (they append to Audit_Log), and the
    // previous fire-and-forget call meant modifySheetRow could resolve before
    // the audit write had left the process -- in Cloud Functions the container
    // is free to freeze at that point, so the row simply never landed.
    await callback(sheetWrapper, targetRowIdx, itemsAtLoc);

    if (sheetUpdates.length > 0) await SS_API.batchUpdateValues(sheetUpdates);
    if (rowsToDelete.length > 0) {
      // Real gid, resolved once and cached. Never a hardcoded 0 -- see C4.
      const inventorySheetId = await SS_API.getSheetId(INVENTORY_SHEET);
      await SS_API.batchDeleteRows(inventorySheetId, rowsToDelete);
    }
  }

  return { success: true };
 } catch (e) {
  logger.error('modifySheetRow threw for ' + locId + '/' + sku, { error: e.message });
  return { success: false, error: e.toString() };
 }
}

// Returns modifySheetRow()'s own result verbatim -- this used to be a hardcoded
// `return {success:true}` that fired even when no row matched (AUDIT A1).
// Parity with SRC/src/Service_Write.js:220-244.
async function setTotalStock(locId, sku, newQty, instanceOrRowId, context) {
  const qty = validateQty_(newQty, "New total");
  if (!qty.ok) return { success: false, error: qty.error };
  newQty = qty.value;

  return modifySheetRow(locId, sku, instanceOrRowId, async (sheet, rowIdx, itemsAtLoc) => {
    const userEmail = getActiveUserEmail(context);
    
    if (newQty <= 0) {
      if (itemsAtLoc > 1) {
          sheet.deleteRow(rowIdx);
      } else {
          sheet.getRange(rowIdx, 2).setValue("Vacant");
          sheet.getRange(rowIdx, 3).setValue(0);
          sheet.getRange(rowIdx, 4).setValue("Open"); 
          sheet.getRange(rowIdx, 5).setValue("None"); 
          sheet.getRange(rowIdx, 6).setValue("");     
      }
      await SS_API.batchAppendRows("Audit_Log", [[new Date().toISOString(), locId, sku, "SET_TOTAL", 0, 0, userEmail]]);
    } else {
      sheet.getRange(rowIdx, 3).setValue(newQty);
      await SS_API.batchAppendRows("Audit_Log", [[new Date().toISOString(), locId, sku, "SET_TOTAL", 0, newQty, userEmail]]);
    }
  }, context);
}

// Same verbatim propagation as setTotalStock. Parity with SRC:246-271.
async function updateStock(locId, sku, adjustment, instanceOrRowId, context) {
  const adj = validateQty_(adjustment, "Adjustment");
  if (!adj.ok) return { success: false, error: adj.error };
  adjustment = adj.value;

  return modifySheetRow(locId, sku, instanceOrRowId, async (sheet, rowIdx, itemsAtLoc) => {
    const userEmail = getActiveUserEmail(context);
    const currentQty = Number(sheet.getRange(rowIdx, 3).getValue()) || 0;
    let newQty = currentQty + adjustment;
    
    if (newQty <= 0) {
      if (itemsAtLoc > 1) {
          sheet.deleteRow(rowIdx);
      } else {
          sheet.getRange(rowIdx, 2).setValue("Vacant");
          sheet.getRange(rowIdx, 3).setValue(0);
          sheet.getRange(rowIdx, 4).setValue("Open");
          sheet.getRange(rowIdx, 5).setValue("None");
          sheet.getRange(rowIdx, 6).setValue(""); 
      }
      await SS_API.batchAppendRows("Audit_Log", [[new Date().toISOString(), locId, sku, "SET_TOTAL", adjustment, 0, userEmail]]);
    } else {
      sheet.getRange(rowIdx, 3).setValue(newQty);
      await SS_API.batchAppendRows("Audit_Log", [[new Date().toISOString(), locId, sku, adjustment > 0 ? "ADD" : "REMOVE", adjustment, newQty, userEmail]]);
    }
  }, context);
}

async function addNewItemToLocation(locId, sku, initialQty, context) {
  // Same NaN hazard as setTotalStock (B5) -- this one wrote the raw value
  // straight to column C with no Number() at all, so "12o" landed as text.
  const qty = validateQty_(initialQty, "Quantity");
  if (!qty.ok) return { success: false, error: qty.error };
  initialQty = qty.value;

  const data = await SS_API.getSheetValues("Inventory!A:G");
  
  let vacantIdx = data.findIndex(r => r[0] === locId && r[1] === "Vacant");
  const instanceId = getUuid();
  
  if (vacantIdx > -1) {
    const row = vacantIdx + 1;
    const updates = [
      { range: `Inventory!B${row}`, values: [[sku]] },
      { range: `Inventory!C${row}`, values: [[initialQty]] },
      { range: `Inventory!D${row}`, values: [["Open"]] },
      { range: `Inventory!E${row}`, values: [["None"]] },
      { range: `Inventory!F${row}`, values: [[""]] },
      { range: `Inventory!G${row}`, values: [[instanceId]] },
    ];
    await SS_API.batchUpdateValues(updates);
  } else { 
    await SS_API.batchAppendRows("Inventory", [[locId, sku, initialQty, "Open", "None", "", instanceId]]);
  }
  
  const userEmail = getActiveUserEmail(context);
  await SS_API.batchAppendRows("Audit_Log", [[new Date().toISOString(), locId, sku, "STOW", initialQty, initialQty, userEmail]]);
  
  return { success: true };
}

async function resolveOriginalArrivalDate(locId, sku) {
  try {
    const data = await SS_API.getSheetValues("Audit_Log!A:H");
    if (!data) return null;
    const relevantActions = ["STOW", "PO_RECEIVED", "ADD", "CONVERT_IN", "EXPLODE_ASSEMBLY", "MOVE_IN"];
    const cleanSku = String(sku || "").toLowerCase().trim();
    let mostRecentMatch = null; 

    for (let i = 1; i < data.length; i++) {
      const rowLoc = data[i][1];
      const rowSku = data[i][2] ? data[i][2].toString().toLowerCase().trim() : "";
      const action = data[i][3];
      if (rowLoc !== locId || !relevantActions.includes(action)) continue;
      if (rowSku === "") continue;
      if (!(rowSku.includes(cleanSku) || cleanSku.includes(rowSku))) continue;

      const ts = new Date(Date.parse(data[i][0]));
      if (isNaN(ts.getTime())) continue;

      if (!mostRecentMatch || ts > mostRecentMatch.ts) {
        let originalDate = ts;
        if (action === "MOVE_IN" && data[i][7]) {
          const carried = new Date(Date.parse(data[i][7]));
          if (!isNaN(carried.getTime())) originalDate = carried;
        }
        mostRecentMatch = { ts: ts, originalDate: originalDate };
      }
    }

    return mostRecentMatch ? mostRecentMatch.originalDate : null;
  } catch (e) {
    logger.error("resolveOriginalArrivalDate failed", { error: e.message });
    return null;
  }
}

/**
 * @param {string} fromLoc source location id.
 * @param {string} toLoc destination location id.
 * @param {string} sku item SKU.
 * @param {number} moveQty quantity to move.
 * @param {boolean} isHubMove whether the source row is a bulk-hub row.
 * @param {string|number} instanceOrRowId instance id or 1-based row index.
 * @param {boolean} clientAssertsKnownCoordinate operator confirmed a real but
 *   never-yet-used floor coordinate -- the client checked it against the
 *   SVG-scraped slot list before calling in, so "no matching Inventory row" is
 *   an empty slot rather than a typo. Matches moveHubGroup's parameter of the
 *   same name and SRC/src/Service_Write.js:274. It had been dropped in the
 *   port, with `context` occupying its position, which made every move to an
 *   empty-but-real coordinate fail with "Unknown destination".
 * @param {Object} context Express req, for Audit_Log attribution.
 * @return {Promise<Object>} {success} or {success:false, error}.
 *
 * RUNS UNDER THE WRITE LEASE, and this is a step BEYOND SRC, taken deliberately
 * on 2026-08-28 rather than inherited. SRC leaves this function unlocked
 * (`LockService` appears nowhere in it), but of everything on this write path it
 * has the widest read-compute-write: one full-sheet snapshot, then a source-row
 * update, a destination update or append, an Audit_Log append and sometimes a
 * delete -- all keyed off row indices derived from that one snapshot. A
 * concurrent SET on the same pallet lands inside that window and one of the two
 * writes disappears silently, which is the exact failure AUDIT B7 is about;
 * matching SRC here would have meant closing the hole on the quantity paths and
 * leaving it open on the riskiest one. Same reasoning for moveHubGroup and
 * removeItemFromLocation below.
 */
async function moveInventoryItem(fromLoc, toLoc, sku, moveQty, isHubMove, instanceOrRowId, clientAssertsKnownCoordinate, context) {
  // NaN would survive every comparison below (`NaN > currentFromQty` is false,
  // so the clamp never fires) and reach both the source and destination writes.
  // See AUDIT_2026-08-24.md B5. Validated BEFORE the lease is taken, as
  // splitInventoryRow does: a request that is going to be refused should not
  // hold the project-wide lock while being refused.
  const qty = validateQty_(moveQty, "Move quantity");
  if (!qty.ok) return { success: false, error: qty.error };
  moveQty = qty.value;
  isHubMove = !!isHubMove;
  toLoc = String(toLoc || '').trim();
  if (!toLoc) return { success: false, error: "Destination location is required." };

  return withInventoryLock(
      () => moveInventoryItemLocked_(fromLoc, toLoc, sku, moveQty, isHubMove,
          instanceOrRowId, clientAssertsKnownCoordinate, context),
      { label: 'moveInventoryItem ' + (fromLoc || '?') + ' -> ' + toLoc }
  );
}

/**
 * The body of moveInventoryItem, with the lease already held. Split out only so
 * the lock is one deletable line -- see functions/lock.js. Never call directly.
 *
 * @param {string} fromLoc
 * @param {string} toLoc already trimmed and non-empty.
 * @param {string} sku
 * @param {number} moveQty already validated to a finite number.
 * @param {boolean} isHubMove already coerced to a boolean.
 * @param {string|number} instanceOrRowId
 * @param {boolean} clientAssertsKnownCoordinate
 * @param {Object} [context]
 * @return {Promise<Object>}
 */
async function moveInventoryItemLocked_(fromLoc, toLoc, sku, moveQty, isHubMove, instanceOrRowId, clientAssertsKnownCoordinate, context) {
  const { planCaseConversion } = require('./Service_Conversions');

  const data = await SS_API.getSheetValues("Inventory!A:G");
  // ZONE-STAGED removed 2026-08-27 (SCHEMA v17 item 1, PHASE_3_NOTES F2) --
  // staging is a workflow STATUS (column D), not a destination. Moving a pallet
  // to a "ZONE-STAGED" location emptied its rack slot instead of recoloring it
  // in place; both STAGED controls now call updateInventoryField(...,'status',
  // 'Staged',...) instead. No client path can send a move here any more, so the
  // server should reject one exactly as it would any other unrecognized
  // destination rather than silently accepting it as always-vacant.
  // Matches SRC/src/Service_Write.js:306 and moveHubGroup below.
  const VIRTUAL_ZONES = ['ZONE-BUFFER'];
  const toLocUpper = toLoc.toUpperCase();
  if (!VIRTUAL_ZONES.includes(toLocUpper)) {
    let knownLocation = null;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0] || '').toUpperCase() === toLocUpper) { knownLocation = data[i][0]; break; }
    }
    if (knownLocation !== null) {
      // Use the sheet's existing casing so a typo'd-case match (e.g.
      // "swh-a-01" vs "SWH-A-01") resolves to the same physical row instead
      // of forking it into a case-variant duplicate.
      toLoc = knownLocation;
    } else if (!clientAssertsKnownCoordinate) {
      return { success: false, error: `Unknown destination '${toLoc}' -- it doesn't match any existing location or recognized zone. Move rejected rather than creating a new one.` };
    }
    // else: a real coordinate off the floor plan that simply has never
    // received anything yet, so there is no row to match -- not a typo. Falls
    // through with toLoc as the client-provided value; the destination-write
    // path below appends a fresh row for it. Matches
    // SRC/src/Service_Write.js:318-325.
  }

  let fromRowIdx = -1, currentFromQty = 0, resTag = "Open", softKitTag = "None", comTag = "";
  let sysData = null, itemsAtFromLoc = 0, sourceInstanceId = "";

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === fromLoc && data[i][1] !== "Vacant") itemsAtFromLoc++;
  }

  if (typeof instanceOrRowId === 'string' && instanceOrRowId.length > 10) {
    for (let i = 1; i < data.length; i++) {
       if (data[i][6] === instanceOrRowId) {
          fromRowIdx = i + 1;
          currentFromQty = Number(data[i][2]);
          resTag = data[i][3] || "Open";
          softKitTag = data[i][4] || "None";
          comTag = data[i][5] || "";
          sourceInstanceId = data[i][6] || "";
          sysData = parseSysBlob_(comTag, 'Inventory row ' + (i + 1));
          break;
       }
    }
  } else if (typeof instanceOrRowId === 'number' && instanceOrRowId > 1) {
    fromRowIdx = instanceOrRowId;
    let i = fromRowIdx - 1;
    currentFromQty = Number(data[i][2]);
    resTag = data[i][3] || "Open";
    softKitTag = data[i][4] || "None";
    comTag = data[i][5] || "";
    sourceInstanceId = data[i][6] || "";
    sysData = parseSysBlob_(comTag, 'Inventory row ' + fromRowIdx);
  }

  if (fromRowIdx === -1) {
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === fromLoc && data[i][1] === sku) { 
        let rType = "normal";
        const sObj = parseSysBlob_(data[i][5], 'Inventory row ' + (i + 1));
        if (sObj && sObj.t) rType = sObj.t;
        
        let matchCondition = isHubMove ? (rType === 'B') : (rType !== 'B');
        if (matchCondition && fromRowIdx === -1) {
          fromRowIdx = i + 1;
          currentFromQty = Number(data[i][2]);
          resTag = data[i][3] || "Open";
          softKitTag = data[i][4] || "None";
          comTag = data[i][5] || "";
          sourceInstanceId = data[i][6] || "";
          sysData = sObj;
        }
      }
    }
  }

  if (fromRowIdx === -1) return { success: false, error: "Source coordinate tracking match missing" };
  if (moveQty > currentFromQty) moveQty = currentFromQty;

  let destSku = sku;
  let destQty = moveQty;
  let conversion = null;
  if (!comTag.includes('_SYS_')) {
    const plan = await planCaseConversion(fromLoc, toLoc, sku, moveQty);
    if (plan.refuse) return { success: false, error: plan.error };
    if (plan.convert) {
      conversion = plan;
      destSku = plan.caseSku;
      destQty = plan.cases;
      moveQty = plan.unitsConsumed;
    }
  }

  let newFromQty = currentFromQty - moveQty;
  let sheetUpdates = [];
  let rowsToDelete = [];
  let logRowsToAppend = [];

  if (newFromQty <= 0) {
    if (itemsAtFromLoc > 1) {
        rowsToDelete.push(fromRowIdx);
    } else {
        sheetUpdates.push({ range: `Inventory!B${fromRowIdx}`, values: [["Vacant"]] });
        sheetUpdates.push({ range: `Inventory!C${fromRowIdx}`, values: [[0]] });
        sheetUpdates.push({ range: `Inventory!D${fromRowIdx}`, values: [["Open"]] });
        sheetUpdates.push({ range: `Inventory!E${fromRowIdx}`, values: [["None"]] });
        sheetUpdates.push({ range: `Inventory!F${fromRowIdx}`, values: [[""]] });
    }
  } else { 
    sheetUpdates.push({ range: `Inventory!C${fromRowIdx}`, values: [[newFromQty]] });
    if (sysData && sysData.t === 'B') {
      let remainingToDeduct = moveQty;
      let updatedF = {};
      for (let fLoc in sysData.f) {
        let lQty = sysData.f[fLoc];
        if (remainingToDeduct > 0) {
          let deduct = Math.min(remainingToDeduct, lQty);
          sysData.f[fLoc] = lQty - deduct;
          remainingToDeduct -= deduct;
        }
        if (sysData.f[fLoc] > 0) updatedF[fLoc] = sysData.f[fLoc];
      }
      sysData.f = updatedF;
      sheetUpdates.push({ range: `Inventory!F${fromRowIdx}`, values: [[comTag.split('_SYS_')[0].trim() + " _SYS_ " + JSON.stringify(sysData)]] });
    }
  }

  let destComTag = comTag.split('_SYS_')[0].trim();
  if (sysData && sysData.t === 'B') {
    let destF = {};
    let remainingToAllocate = moveQty;
    const origSysData = parseSysBlob_(comTag, 'Inventory row ' + fromRowIdx + ' (hub move source)');
    if (origSysData && origSysData.f) {
      for (let fLoc in origSysData.f) {
        if (remainingToAllocate <= 0) break;
        let lQty = origSysData.f[fLoc];
        let allocated = Math.min(remainingToAllocate, lQty);
        destF[fLoc] = allocated;
        remainingToAllocate -= allocated;
        
        for (let k = 1; k < data.length; k++) {
          if (data[k][0] === fLoc && data[k][1] === sku) {
            let frameComment = data[k][5] ? data[k][5].toString() : "";
            let fSys = parseSysBlob_(frameComment, 'Inventory row ' + (k + 1) + ' (frame)');
            if (fSys && fSys.t === 'F' && fSys.b && fSys.b[origSysData.p]) {
              let currentFromLocAlloc = fSys.b[origSysData.p][fromLoc] || 0;
              fSys.b[origSysData.p][fromLoc] = currentFromLocAlloc - allocated;
              if (fSys.b[origSysData.p][fromLoc] <= 0) delete fSys.b[origSysData.p][fromLoc];

              if (!fSys.b[origSysData.p][toLoc]) fSys.b[origSysData.p][toLoc] = 0;
              fSys.b[origSysData.p][toLoc] += allocated;

              sheetUpdates.push({ range: `Inventory!F${k+1}`, values: [[frameComment.split('_SYS_')[0].trim() + " _SYS_ " + JSON.stringify(fSys)]] });
            }
          }
        }
      }
    }
    let movedSysData = { t: "B", p: origSysData.p, f: destF };
    destComTag = destComTag + " _SYS_ " + JSON.stringify(movedSysData);
  }

  let vacantRowIdx = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === toLoc && data[i][1] === "Vacant") {
      vacantRowIdx = i + 1;
      break;
    }
  }

  const destInstanceId = (newFromQty <= 0) ? (sourceInstanceId || getUuid()) : getUuid();

  if (vacantRowIdx > -1 && toLoc.toUpperCase() !== 'ZONE-BUFFER') {
    sheetUpdates.push({ range: `Inventory!B${vacantRowIdx}`, values: [[destSku]] });
    sheetUpdates.push({ range: `Inventory!C${vacantRowIdx}`, values: [[destQty]] });
    sheetUpdates.push({ range: `Inventory!D${vacantRowIdx}`, values: [[resTag]] });
    sheetUpdates.push({ range: `Inventory!E${vacantRowIdx}`, values: [[softKitTag]] });
    sheetUpdates.push({ range: `Inventory!F${vacantRowIdx}`, values: [[destComTag]] });
    sheetUpdates.push({ range: `Inventory!G${vacantRowIdx}`, values: [[destInstanceId]] });
  } else {
    await SS_API.batchAppendRows("Inventory", [[toLoc, destSku, destQty, resTag, softKitTag, destComTag, destInstanceId]]);
  }

  if (sheetUpdates.length > 0) await SS_API.batchUpdateValues(sheetUpdates);
  if (rowsToDelete.length > 0) {
    await SS_API.batchDeleteRows(await SS_API.getSheetId(INVENTORY_SHEET), rowsToDelete);
  }

  const originalArrivalDate = await resolveOriginalArrivalDate(fromLoc, sku);
  const userEmail = getActiveUserEmail(context);

  if (conversion) {
    logRowsToAppend.push([new Date().toISOString(), fromLoc, sku, "CONVERT_OUT", conversion.unitsConsumed, newFromQty <= 0 ? 0 : newFromQty, userEmail]);
    logRowsToAppend.push([new Date().toISOString(), toLoc, destSku, "CONVERT_IN", conversion.cases, "", userEmail, originalArrivalDate ? originalArrivalDate.toISOString() : ""]);
  } else {
    logRowsToAppend.push([new Date().toISOString(), fromLoc, sku, "MOVE_OUT", moveQty, newFromQty <= 0 ? 0 : newFromQty, userEmail]);
    logRowsToAppend.push([new Date().toISOString(), toLoc, destSku, "MOVE_IN", moveQty, "", userEmail, originalArrivalDate ? originalArrivalDate.toISOString() : ""]);
  }

  if (logRowsToAppend.length > 0) await SS_API.batchAppendRows("Audit_Log", logRowsToAppend);

  if (conversion) {
    return {
      success: true,
      converted: true,
      unitSku: sku,
      caseSku: conversion.caseSku,
      cases: conversion.cases,
      unitsConsumed: conversion.unitsConsumed,
      remainder: conversion.remainder,
      unitsPerCase: conversion.unitsPerCase
    };
  }
  return { success: true };
}

// The three below return modifySheetRow()'s result verbatim (AUDIT A1).
// updateInventoryField and updatePalletComment previously returned undefined
// outright -- the client's `res.success !== false` check reads undefined as
// success, so a comment saved onto a vanished row looked identical to one that
// landed. Parity with SRC/src/Service_Write.js:674-724.
async function updateInventoryField(locId, sku, fieldType, value, instanceOrRowId, context) {
  return modifySheetRow(locId, sku, instanceOrRowId, (sheet, rowIdx) => {
    if (fieldType === 'status') sheet.getRange(rowIdx, 4).setValue(value);
    if (fieldType === 'assembly') sheet.getRange(rowIdx, 5).setValue(value);
  }, context);
}

async function updatePalletComment(locId, sku, commentText, instanceOrRowId, context) {
  return modifySheetRow(locId, sku, instanceOrRowId, (sheet, rowIdx) => { sheet.getRange(rowIdx, 6).setValue(commentText); }, context);
}

async function reservePallet(locId, sku, statusString, instanceOrRowId, context) {
  return modifySheetRow(locId, sku, instanceOrRowId, (sheet, rowIdx) => { sheet.getRange(rowIdx, 4).setValue(statusString); }, context);
}

async function cleanUpVacantRows() {
  const data = await SS_API.getSheetValues("Inventory!A:B");
  let rowsToDelete = [];

  // data[0] is header row (if there is one). We search backwards.
  for (let i = data.length - 1; i >= 1; i--) { 
    const sku = data[i][1] ? data[i][1].toString().trim().toLowerCase() : "";
    if (sku === "vacant") {
      rowsToDelete.push(i + 1); 
    }
  }
  
  if (rowsToDelete.length > 0) {
    await SS_API.batchDeleteRows(await SS_API.getSheetId(INVENTORY_SHEET), rowsToDelete);
  }
  return { success: true, deletedCount: rowsToDelete.length };
}

async function addBulkFedExTracking(numbersArray, direction, storeName, storeNum) {
  try {
    const data = await SS_API.getSheetValues("Multi Piece Tracking!A:D");
    const existingSet = new Set();
    
    if (data && data.length >= 2) {
      for (let i = 1; i < data.length; i++) {
        const trk = String(data[i][3] || "").trim().replace(/\.0+$/, "").replace(/[^0-9]/g, "");
        if (trk) existingSet.add(trk);
      }
    }

    const rowsToAppend = [];
    numbersArray.forEach(rawNum => {
      const cleanNum = String(rawNum).trim().replace(/\.0+$/, "").replace(/[^0-9]/g, "");
      if (cleanNum && (cleanNum.length === 12 || cleanNum.length === 15) && !existingSet.has(cleanNum)) {
        rowsToAppend.push([
          storeName || "Bulk Paste",  
          storeNum || "N/A",          
          direction || "Outbound",    
          cleanNum,                   
          ""                          
        ]);
        existingSet.add(cleanNum);
      }
    });

    if (rowsToAppend.length > 0) {
        await SS_API.batchAppendRows("Multi Piece Tracking", rowsToAppend);
    }
    
    return { success: true, addedCount: rowsToAppend.length };
  } catch (e) {
    logger.error("ERROR in addBulkFedExTracking", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

async function stageBulkFedExTrackingNumbers(stagedItems) {
  if (!Array.isArray(stagedItems) || stagedItems.length === 0) return 0;
  
  const data = await SS_API.getSheetValues("Multi Piece Tracking!A:D");
  const existingTrk = new Set();
  
  if (data && data.length >= 2) {
    for (let i = 1; i < data.length; i++) {
      const trk = String(data[i][3] || "").trim();
      if (trk) existingTrk.add(trk);
    }
  }
  
  const newRows = [];
  stagedItems.forEach(item => {
    const tracking = typeof item === "string" ? item : item.tracking;
    const storeName = (item.storeName || "STAGED ORDER").trim();
    const storeNum = (item.storeNum || "N/A").trim();
    
    const clean = String(tracking).trim().replace(/[^0-9]/g, "");
    if (clean && (clean.length === 12 || clean.length === 15) && !existingTrk.has(clean)) {
      newRows.push([
        storeName,     
        storeNum,      
        "Outbound",    
        clean,         
        ""             
      ]);
      existingTrk.add(clean);
    }
  });
  
  if (newRows.length > 0) {
    await SS_API.batchAppendRows("Multi Piece Tracking", newRows);
  }
  
  return newRows.length;
}

/**
 * ============================================================================
 * ROW-LEVEL TARGETING -- the *ByRow twins
 * ============================================================================
 *
 * SRC takes `LockService.getScriptLock()` inside each of these two directly
 * (SRC/src/Service_Write.js:973 and :1027). Here they delegate to
 * updateStock/setTotalStock, which delegate to modifySheetRow, which takes the
 * lease -- so the lock is INHERITED rather than duplicated, and the two SRC
 * sites are accounted for by the one at modifySheetRow.
 *
 * Taking a second lease here would be harmless (functions/lock.js is reentrant
 * within a request, unlike Apps Script's) but it would be a lie about where the
 * critical section is: the read-compute-write these are guarding happens inside
 * modifySheetRow, not here.
 *
 * SRC's row-data-mismatch check ("Row data mismatch. The sheet may have been
 * modified.") also lives in modifySheetRow's numeric branch for the same
 * reason. See PHASE_2_NOTES.md §3.
 */
async function updateInventoryByRow(rowIdx, locId, sku, adjustment, context) {
  return await updateStock(locId, sku, adjustment, rowIdx, context);
}

async function setTotalStockByRow(rowIdx, locId, sku, newQty, context) {
  return await setTotalStock(locId, sku, newQty, rowIdx, context);
}

async function receivePOCardItems(cardId, cardName, itemsReceived, context) {
  try {
    // ==================================================================
    // TRUST BOUNDARY: replace the browser's oldQty/oldRcvd with what the
    // Trello card actually says right now.
    //
    // Those two fields arrive FROM THE BROWSER, and the over-receipt guard
    // below used to compute originalExpectedQty straight from them. Two
    // stations with the same PO open therefore both held the same stale
    // oldRcvd, both passed the guard, and both appended -- the guard could not
    // see the other station at all. Worse, the stale numbers also fed the
    // "| QTY: x | RCVD: y" string written back to Trello further down, so the
    // losing station overwrote the winner's running total.
    //
    // Everything downstream of this block -- the guard, confirmedItems, the
    // receipt email, and the checklist rewrite -- reads these corrected
    // values. See AUDIT_2026-08-24.md B6 and SCHEMA invariant #53.
    // ==================================================================
    const liveById = await readLiveChecklistState_(cardId);
    if (!liveById) {
      return {
        success: false,
        error: 'Could not read this checklist from Trello to verify quantities. ' +
               'Nothing was received -- please retry.'
      };
    }

    itemsReceived.forEach(function(item) {
      const live = item.idCheckItem ? liveById[item.idCheckItem] : null;
      if (live) {
        item.oldQty = live.qty;
        item.oldRcvd = live.rcvd;
      } else {
        // No idCheckItem to verify against -- the "General Check-in" path,
        // which has no checklist row on the card. Fall back to the payload,
        // normalised. Nothing on Trello can confirm or deny these.
        item.oldQty = Number(item.oldQty || 0);
        item.oldRcvd = Number(item.oldRcvd || 0);
      }
      item.qty = Number(item.qty || 0);
    });

    // MIRRORS: JS_Handlers.html submitBulkPOReceipt()'s "Cannot over-receive!"
    // check. That client check is NOT trusted as the only guard -- this rejects
    // the whole batch atomically, before any Sheets/Trello writes, if any single
    // item would push its total received above its expected quantity (oldQty +
    // oldRcvd, i.e. remaining + already received, now both server-read per the
    // block above). Items with no known expected quantity (both 0 -- e.g. a
    // checklist item with an unparseable/missing qty per SCHEMA 4C) are
    // intentionally not blocked, matching the client's same
    // originalExpectedQty > 0 gate. Keep this in sync with the client check.
    for (let i = 0; i < itemsReceived.length; i++) {
      const item = itemsReceived[i];
      const originalExpectedQty = Number(item.oldQty || 0) + Number(item.oldRcvd || 0);
      const wouldBeTotal = Number(item.oldRcvd || 0) + Number(item.qty || 0);
      if (originalExpectedQty > 0 && wouldBeTotal > originalExpectedQty) {
        return {
          success: false,
          error: `Over-receipt rejected for "${item.desc}": expected ${originalExpectedQty}, already received ${item.oldRcvd}, this submission would bring the total to ${wouldBeTotal}.`
        };
      }
    }

    const configData = await SS_API.getSheetValues("Config!A:B");
    let emails = [];
    if (configData) {
      for (let i = 1; i < configData.length; i++) {
        if (configData[i][0] && String(configData[i][0]).toUpperCase() === 'STAKEHOLDER_EMAILS') {
          emails = String(configData[i][1]).split(',').map(x => x.trim()).filter(x => x);
          break;
        }
      }
    }
    
    if (emails.length === 0) emails = [getActiveUserEmail(context)];
    
    const cleanCardName = cardName.replace(/^PO[:\-\s]*/i, '').trim();
    
    let poBatchQty = 0;
    let poTotalRcvd = 0;
    let poTotalExpected = 0;
    itemsReceived.forEach(item => {
      poBatchQty += item.qty;
      poTotalRcvd += (item.oldRcvd + item.qty);
      poTotalExpected += (item.oldQty + item.oldRcvd);
    });
    const isPoFullyReceived = (poTotalRcvd >= poTotalExpected);

    let plainText = `PO: ${cleanCardName}\nItems have been stored in ZONE-BUFFER (Limbo) and need to be put on the floor.\n\n`;
    let htmlBody = '<div style="font-family: sans-serif; color: #333; max-width: 600px;">';
    
    if (isPoFullyReceived) {
        htmlBody += `<h2 style="color: #28a745; margin-bottom: 10px;">✅ PO Received in Full: ${cleanCardName}</h2>`;
        htmlBody += '<p style="font-size: 15px; background: #d4edda; color: #155724; padding: 10px; border-radius: 5px; border-left: 4px solid #c3e6cb;">';
        htmlBody += `<strong>📌 QuickBooks Action Required:</strong> PO has been received in full. Please update the QuickBooks ledger to reflect Total Quantity: <strong>${poTotalRcvd} / ${poTotalExpected}</strong>.</p>`;
    } else {
        htmlBody += `<h2 style="color: #0056b3; margin-bottom: 10px;">📦 Partial PO Receipt: ${cleanCardName}</h2>`;
        htmlBody += '<p style="font-size: 15px; background: #fff3cd; color: #856404; padding: 10px; border-radius: 5px; border-left: 4px solid #ffeeba;">';
        htmlBody += `<strong>📌 QuickBooks Action Required:</strong> Partial receipt. Increment QB bill by <strong>+${poBatchQty}</strong> (New Total: ${poTotalRcvd} / ${poTotalExpected}).</p>`;
    }
    
    htmlBody += '<ul style="list-style-type: none; padding: 0;">';
    
    // PRODUCT sheet, fetched once for this whole batch (not per item) and
    // re-keyed uppercase for case-insensitive lookup -- see
    // resolveCanonicalProductId_ in Shared_Classifiers.js. Used to write the
    // canonical PRODUCT ID to Inventory instead of the raw
    // "[ProductID] Description" checklist text. This replaces a pair of inline
    // stubs that just pulled the bracket contents out, which is not the same
    // thing: the bracket may hold a nickname, a typo, or the literal "[ITEM]".
    const { getProductMap } = require('./Service_Read');
    const productMap = (await getProductMap()) || {};
    const productMapUpper = {};
    Object.keys(productMap).forEach(k => { productMapUpper[k.toUpperCase()] = productMap[k]; });

    let trelloComments = [];
    let rowsToAppend = [];
    let logRowsToAppend = [];
    let confirmedItems = [];
    let now = new Date();

    itemsReceived.forEach(item => {
      // The Product ID, not the nickname. Between 2026-08-11 and 2026-08-26
      // SRC wrote the nickname, which made a mutable display label the identity
      // of a warehouse row: renaming a product orphaned its stock,
      // findCaseConversion_ stopped firing (a nickname does not start with the
      // supplier code), and every name comparison had to go fuzzy to cope. The
      // nickname is still what staff SEE -- getNickname() resolves it at render
      // time. See resolveCanonicalProductId_ in Shared_Classifiers.js.
      const inventoryName = resolveCanonicalProductId_(item.desc, productMapUpper);
      const instanceId = getUuid();

      // Column D (status) is "Open", same as any other stock -- nobody works
      // the sheet to flip this by hand, so a special received-only status just
      // meant freshly-received Limbo stock silently read as "staged" to any
      // code checking status !== "Open" (generateLocalTotals()). Column E
      // (softKitTag) must stay "None" -- it is a kit/bulk-hub type flag the
      // assembly logic reads, not a timestamp. The receipt trail lives in the
      // comment column (F); Audit_Log still gets its own PO_RECEIVED entry
      // below, and that one must stay -- it is the aging anchor getAgingData()
      // needs. This port had written 'PO_RECEIVED' into D and a timestamp into
      // E, corrupting both.
      const receivedNote = 'RCVD from ' + cardName + ' on ' + now.toISOString();
      rowsToAppend.push(['ZONE-BUFFER', inventoryName, item.qty, 'Open', 'None', receivedNote, instanceId]);

      // stationId tagging removed upstream 2026-08-27.
      const userEmail = getActiveUserEmail(context);
      // Audit_Log sku must match what was actually written to Inventory above
      // (inventoryName), not the raw checklist text -- getAgingData()'s fuzzy
      // match depends on these staying in sync.
      logRowsToAppend.push([now.toISOString(), 'ZONE-BUFFER', inventoryName, 'PO_RECEIVED', 0, item.qty, userEmail]);

      confirmedItems.push({
        idCheckItem: item.idCheckItem,
        desc: item.desc,
        newQty: Math.max(0, item.oldQty - item.qty),
        newRcvd: item.oldRcvd + item.qty
      });

      const parsed = splitProductIdFromDesc_(item.desc);
      let displayDesc = parsed.cleanDescription;
      let extraInfo = parsed.productId;

      plainText += `- ${item.qty}x ${displayDesc} ${extraInfo ? '(' + extraInfo + ')' : ''}\n`;
      
      htmlBody += '<li style="padding: 10px 0; border-bottom: 1px solid #eee;">';
      htmlBody += `<span style="display: inline-block; width: 65px; font-weight: bold; color: #28a745; font-size: 16px;">+${item.qty}x</span> `;
      htmlBody += `<span style="font-weight: bold; font-size: 16px;">${displayDesc}</span>`;
      htmlBody += `<br><span style="color: #666; font-size: 13px; display: inline-block; margin-top: 4px;">Total Received: ${item.oldRcvd + item.qty} / ${item.oldQty + item.oldRcvd}</span>`;
      if (extraInfo) {
        htmlBody += `<br><span style="color: #666; font-size: 13px; display: inline-block; margin-top: 2px;">${extraInfo}</span>`;
      }
      htmlBody += '</li>';
      
      trelloComments.push(`RCVD: +${item.qty}x ${item.desc} | Total: ${item.oldRcvd + item.qty} / ${item.oldQty + item.oldRcvd}`);
    });
    
    htmlBody += '</ul></div>';

    // =====================================================================
    // LATE-STAGE LOCK -- SRC/src/Service_Write.js:1506, and the re-check that
    // goes with it. Both were missing from this port entirely.
    //
    // "Late-stage" is the point (SCHEMA invariant #17): everything above --
    // the Trello checklist read, the product-map lookup, building the rows,
    // composing the receipt email -- runs UNLOCKED, because holding a
    // project-wide lock across network calls would freeze every other station
    // on the floor for the duration. Only the sheet write is serialised.
    //
    // The re-check is why the lock is here at all. Everything between the
    // first checklist read at the top of this function and this line is a
    // window in which another station could have received against the same
    // card. If anything moved, abort before writing: no Inventory rows, no
    // Audit_Log rows, no Trello writes. See AUDIT_2026-08-24.md B6 and SCHEMA
    // invariant #53.
    //
    // This NARROWS the race, it does not eliminate it. The Trello checklist
    // rewrite below happens OUTSIDE the lease, so two stations submitting
    // within the same second can still both get here with matching reads.
    // Closing that completely means holding the lock across ~2 Trello API
    // calls per line item, which is exactly what invariant #17 forbids. SRC
    // makes the same trade and records it in the same place.
    //
    // SRC uses waitLock(10000) here rather than tryLock(10000): a receipt that
    // has already read Trello, resolved products and built its rows should
    // wait its turn rather than throw the work away. withInventoryLock does
    // exactly that -- it retries for ACQUIRE_TIMEOUT_MS (10s, the same budget)
    // before answering "Server busy. Please try again."
    // =====================================================================
    const commit = await withInventoryLock(async () => {
      const recheck = await readLiveChecklistState_(cardId);
      if (!recheck) {
        return {
          success: false,
          error: 'Could not re-verify this PO\'s checklist against Trello before ' +
                 'writing. Nothing was received -- please retry.'
        };
      }
      for (let i = 0; i < itemsReceived.length; i++) {
        const item = itemsReceived[i];
        if (!item.idCheckItem) continue; // nothing on the card to compare against
        const current = recheck[item.idCheckItem];
        if (!current) {
          return {
            success: false,
            error: 'The line item "' + item.desc + '" is no longer on this PO\'s ' +
                   'Trello checklist. Nothing was received -- please reload the PO ' +
                   'and try again.'
          };
        }
        if (current.qty !== item.oldQty || current.rcvd !== item.oldRcvd) {
          return {
            success: false,
            error: 'Another station received against "' + item.desc + '" while this ' +
                   'was being submitted (checklist now shows ' + current.rcvd +
                   ' received of ' + (current.qty + current.rcvd) + '). Nothing was ' +
                   'received -- please reload the PO and try again.'
          };
        }
      }

      if (rowsToAppend.length > 0) await SS_API.batchAppendRows("Inventory", rowsToAppend);
      if (logRowsToAppend.length > 0) await SS_API.batchAppendRows("Audit_Log", logRowsToAppend);
      return { success: true };
    }, { label: 'receivePOCardItems commit (card ' + cardId + ')' });

    // Covers all three refusals above plus the lock's own "Server busy". Every
    // one of them means NOTHING was written, so returning here -- before the
    // Trello half runs -- is what keeps the card and the sheet in step.
    if (!commit.success) return commit;
    const lockDegraded = commit.lockDegraded === true;

    // Post to Trello through the shared rate-limited transport.
    const { key: apiKey, token: apiToken } = trelloCreds_();
    
    // ==================================================================
    // The inventory rows are already committed above. Everything below is the
    // Trello half, and its outcome is REPORTED rather than swallowed.
    //
    // These calls used to run with the response code never inspected and an
    // empty catch around each one, then the function returned {success:true}
    // regardless. Failure scenario: the Trello token expires or Trello answers
    // 429 mid-batch. Inventory gains the units, the Trello checklist still
    // shows the full remaining QTY, the operator sees a success toast, and the
    // next shift receives the same PO again -- inventory double-counts with no
    // error anywhere. See AUDIT_2026-08-24.md A3.
    //
    // The result carries trelloSynced:false and failedItems[] so the client can
    // show a distinct warning state. Deliberately NOT a hard failure: the stock
    // is physically on the floor and the Inventory write already succeeded, so
    // refusing the whole operation would be a lie in the other direction. The
    // operator needs to know to fix the card by hand.
    // ==================================================================
    const failedItems = [];

    if (apiKey && apiToken) {
      await Promise.all(itemsReceived.map(async (item) => {
        if (item.idCheckItem) {
          const newRcvd = item.oldRcvd + item.qty;
          const newQty = Math.max(0, item.oldQty - item.qty);
          const newName = `${item.desc} | QTY: ${newQty} | RCVD: ${newRcvd}`;
          const state = newQty === 0 ? 'complete' : 'incomplete';

          const url = `https://api.trello.com/1/cards/${cardId}/checkItem/${item.idCheckItem}?key=${apiKey}&token=${apiToken}`;
          const res = await trelloFetch_(url, {
            method: 'put',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName, state: state })
          }, { label: 'checklist update' });
          if (!res.ok) {
            failedItems.push({ desc: item.desc, qty: item.qty, reason: res.error || ('HTTP ' + res.code) });
            logger.error('receivePOCardItems: checklist update failed', {
              cardId: cardId, desc: item.desc, code: res.code
            });
          }
        }
      }));

      await Promise.all(trelloComments.map(async (comment) => {
        const url = `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${apiKey}&token=${apiToken}`;
        const res = await trelloFetch_(url, {
          method: 'post',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: comment })
        }, { label: 'receipt comment' });
        if (!res.ok) {
          failedItems.push({ desc: comment, reason: res.error || ('HTTP ' + res.code) });
          logger.error('receivePOCardItems: receipt comment failed', {
            cardId: cardId, code: res.code
          });
        }
      }));
    } else {
      failedItems.push({
        desc: 'all items',
        reason: 'Trello credentials are not configured (TRELLO_KEY / TRELLO_TOKEN).'
      });
      logger.error('receivePOCardItems: no Trello credentials -- inventory was written ' +
                   'but the card was not updated', { cardId: cardId });
    }


    const receivedAny = itemsReceived.some(item => item.qty > 0);
    const stillPending = !isPoFullyReceived;
    const isPartial = receivedAny && stillPending;

    // TODO: Send Email using SendGrid or Firebase Extension instead of MailApp
    logger.info("TODO: Implement Email sending", { emails, subject: isPoFullyReceived ? '✅ PO Received in Full' : '⚠️ Partial PO Receipt', text: plainText });

    if (apiKey && apiToken && isPoFullyReceived && receivedAny) {
      try {
        const commentUrl = `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${apiKey}&token=${apiToken}`;
        await trelloFetch_(commentUrl, {
            method: 'post',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: `🎉 PO #${cleanCardName} has been RECEIVED IN FULL! Total Quantity: ${poTotalRcvd} / ${poTotalExpected}. Ready for final QuickBooks bill closeout.` })
        });

        const cardRes = await trelloFetch_(`https://api.trello.com/1/cards/${cardId}?fields=idBoard&key=${apiKey}&token=${apiToken}`);
        if (cardRes.ok) {
          const cardData = JSON.parse(cardRes.text);
          const boardId = cardData.idBoard;
          const listsRes = await trelloFetch_(`https://api.trello.com/1/boards/${boardId}/lists?key=${apiKey}&token=${apiToken}`);
          if (listsRes.ok) {
            const lists = JSON.parse(listsRes.text);
            const deliveredList = lists.find(l => {
              const name = l.name.toLowerCase();
              return name.includes('delivered') || name.includes('done') || name.includes('received');
            });
            if (deliveredList) {
              await trelloFetch_(`https://api.trello.com/1/cards/${cardId}?idList=${deliveredList.id}&key=${apiKey}&token=${apiToken}`, { method: 'put' });
            }
          }
        }
      } catch(e) {
        logger.error("Failed to move card to Delivered list", { error: e.toString() });
      }
    }

    const outcome = {
      success: true,
      // false means the Inventory write landed but Trello did not fully catch
      // up -- the card still shows stale quantities and needs a manual fix.
      // The client must render this as a warning, not a plain success (A3).
      trelloSynced: failedItems.length === 0,
      failedItems: failedItems,
      confirmedItems: confirmedItems,
      isPoFullyReceived: isPoFullyReceived,
      poTotalRcvd: poTotalRcvd,
      poTotalExpected: poTotalExpected
    };
    // Carried forward from the commit block: the rows landed, but the write
    // lease could not be reached, so nothing was serialising this receipt
    // against another station's. Surfaced rather than log-only -- see
    // functions/lock.js.
    if (lockDegraded) outcome.lockDegraded = true;
    return outcome;
  } catch (e) {
    logger.error("receivePOCardItems failed", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

async function markFedExChildDeliveredInSheet(tracking) {
  try {
    const cleanTarget = String(tracking).trim();
    const manualStatus = 'Delivered (Manually Received)';

    const backendData = await SS_API.getSheetValues("MPS Backend!A:D");
    if (backendData && backendData.length >= 2) {
      let backendUpdated = false;
      let updates = [];
      const nowStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
      for (let i = 1; i < backendData.length; i++) {
        if (String(backendData[i][1]).trim() === cleanTarget) {
          updates.push({ range: `MPS Backend!C${i+1}`, values: [[manualStatus]] });
          updates.push({ range: `MPS Backend!D${i+1}`, values: [[nowStr]] });
        }
      }
      if (updates.length > 0) await SS_API.batchUpdateValues(updates);
    }

    const mpsData = await SS_API.getSheetValues("Multi Piece Tracking!A:Z"); // Read widely
    if (mpsData && mpsData.length >= 2) {
      let updates = [];
      for (let i = 1; i < mpsData.length; i++) {
        for (let col = 4; col < mpsData[i].length; col += 2) { // 0-indexed, col 4 is E
          if (String(mpsData[i][col]).trim() === cleanTarget) {
            const colLetter = String.fromCharCode(65 + col);
            updates.push({ range: `Multi Piece Tracking!${colLetter}${i+1}`, values: [[manualStatus]] });
          }
        }
      }
      if (updates.length > 0) await SS_API.batchUpdateValues(updates);
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

async function processPackedOutboundCard(cardId) {
  const { key: trelloKey, token: trelloToken } = trelloCreds_();
  
  if (!trelloKey || !trelloToken || !cardId) return { success: false, error: "Missing config or ID" };
  
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  
  try {
    const commentUrl = `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${trelloKey}&token=${trelloToken}`;
    await trelloFetch_(commentUrl, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `📦 **PACKED & STAGED** via CIS Portal at ${timestamp}` })
    });

    const labelUrl = `https://api.trello.com/1/cards/${cardId}/labels?key=${trelloKey}&token=${trelloToken}`;
    await trelloFetch_(labelUrl, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: "orange", name: "PACKED" })
    });

    const clRes = await trelloFetch_(`https://api.trello.com/1/cards/${cardId}/checklists?key=${trelloKey}&token=${trelloToken}`);
    if (clRes.ok) {
      const checklists = JSON.parse(clRes.text);
      
      if (checklists.length === 0) {
        const createRes = await trelloFetch_(`https://api.trello.com/1/cards/${cardId}/checklists?name=Status&key=${trelloKey}&token=${trelloToken}`, { method: 'post' });
        if (createRes.ok) {
          const newCl = JSON.parse(createRes.text);
          await trelloFetch_(`https://api.trello.com/1/checklists/${newCl.id}/checkItems?name=Packed&state=complete&checked=true&key=${trelloKey}&token=${trelloToken}`, { method: 'post' });
        }
      } else {
        for (const cl of checklists) {
          if (cl.checkItems && cl.checkItems.length > 0) {
            for (const item of cl.checkItems) {
              if (item.state !== 'complete') {
                await trelloFetch_(`https://api.trello.com/1/cards/${cardId}/checkItem/${item.id}?state=complete&key=${trelloKey}&token=${trelloToken}`, { method: 'put' });
              }
            }
          }
        }
      }
    }
  } catch(e) {
    logger.error("processPackedOutboundCard trello failure", { error: e.toString() });
  }

  try {
    const shipData = await SS_API.getSheetValues("SHIPMENTS!A:J");
    if (shipData) {
      let updates = [];
      for (let i = 1; i < shipData.length; i++) {
        if (String(shipData[i][0]).trim() === String(cardId).trim()) {
          updates.push({ range: `SHIPMENTS!J${i+1}`, values: [["PACKED"]] });
          updates.push({ range: `SHIPMENTS!G${i+1}`, values: [["Packed"]] });
          break;
        }
      }
      if (updates.length > 0) await SS_API.batchUpdateValues(updates);
    }
  } catch(e) {
    return { success: false, error: "SHIPMENTS sheet not found or update failed: " + e.toString() };
  }
  
  return { success: true };
}

/**
 * ============================================================================
 * AUDIT ACTIONS (Wall-to-Wall / QB Audit views)
 * ============================================================================
 */

/**
 * One audit row's outcome. A blank/absent qty means "counted, matches" and
 * stamps a VERIFIED row; a number means "counted, differs" and re-uses the
 * ordinary set-total path so the correction is written and logged like any
 * other.
 *
 * Parity with SRC/src/Service_Write.js:38-46.
 *
 * @param {string} locId
 * @param {string} sku
 * @param {*} newQty blank/null to verify only.
 * @param {Object} [context]
 * @return {Promise<{success: boolean, error?: string}>}
 */
async function processAuditAction(locId, sku, newQty, context) {
  try {
    if (newQty === null || newQty === "" || newQty === undefined) {
      const userEmail = getActiveUserEmail(context);
      await SS_API.batchAppendRows("Audit_Log",
          [[new Date().toISOString(), locId, sku, "VERIFIED", 0, 0, userEmail]]);
      return { success: true };
    }
    return await setTotalStock(locId, sku, newQty, null, context);
  } catch (e) {
    logger.error('processAuditAction failed for ' + locId + '/' + sku, { error: e.message });
    return { success: false, error: e.toString() };
  }
}

/**
 * Bulk counterpart to processAuditAction()'s no-qty branch -- lets the QB Audit
 * page's "Verify All" button stamp every remaining queued location as VERIFIED
 * in one round trip instead of requiring an individual VERIFY click per row.
 *
 * Exists because "last touched" (getSkuLastUpdatedMap(), every action type) and
 * "age" (buildAgingData_(), arrival events only) are deliberately separate
 * signals -- a SKU that hasn't physically moved still needs a way to refresh
 * "last touched" when a floor walk confirms it's still accurate, without that
 * walk also resetting its age/heatmap anchor. VERIFIED is excluded from
 * buildAgingData_()'s validActions, so this bulk write is safe for that reason
 * alone.
 *
 * Parity with SRC/src/Service_Write.js:67-92.
 *
 * @param {Array<{sku: string, locId: string, originalSku: string}>} pairs
 *     sku/locId identify the Audit_Log row to write (matchedSku when the QB
 *     sheet's text differs from the live Inventory sku); originalSku is the
 *     literal QB_Audits sheet value, used to resolve which sheet row(s) to
 *     flag DONE.
 * @param {Object} [context]
 * @return {Promise<{success: boolean, verified?: number, error?: string}>}
 */
async function bulkVerifyAuditLocations(pairs, context) {
  try {
    if (!pairs || !pairs.length) return { success: true, verified: 0 };

    const userEmail = getActiveUserEmail(context);
    const now = new Date().toISOString();
    const rows = pairs.map(p => [now, p.locId, p.sku, "VERIFIED", 0, 0, userEmail]);
    await SS_API.batchAppendRows("Audit_Log", rows);

    const distinctSkus = [...new Set(pairs.map(
        p => (p.originalSku || p.sku).toString().toUpperCase().trim()))];
    const data = await SS_API.getSheetValues("QB_Audits!A:B");
    const updates = [];
    for (let i = 1; i < (data || []).length; i++) {
      const cell = data[i][0] ? data[i][0].toString().toUpperCase().trim() : "";
      if (distinctSkus.includes(cell)) {
        updates.push({ range: `QB_Audits!B${i + 1}`, values: [["DONE"]] });
      }
    }
    if (updates.length > 0) await SS_API.batchUpdateValues(updates);

    return { success: true, verified: rows.length };
  } catch (e) {
    logger.error('bulkVerifyAuditLocations failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Flags every QB_Audits row for a SKU as DONE.
 * Parity with SRC/src/Service_Write.js:94-106.
 *
 * @param {string} targetSku
 * @return {Promise<{success: boolean, error?: string}>}
 */
async function markAuditComplete(targetSku) {
  try {
    const data = await SS_API.getSheetValues("QB_Audits!A:B");
    if (!data || data.length < 2) return { success: false, error: "QB_Audits sheet is empty." };
    const cleanTarget = String(targetSku || "").toUpperCase().trim();
    const updates = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().toUpperCase().trim() === cleanTarget) {
        updates.push({ range: `QB_Audits!B${i + 1}`, values: [["DONE"]] });
      }
    }
    if (updates.length > 0) await SS_API.batchUpdateValues(updates);
    return { success: true };
  } catch (e) {
    logger.error('markAuditComplete failed for ' + targetSku, { error: e.message });
    return { success: false, error: e.toString() };
  }
}

/**
 * Hard-deletes an item from a location, cascading into the Master Hub pieces a
 * Frame row owns.
 *
 * The cascade is the reason this is not just a setTotalStock(0): a Frame row
 * (_SYS_ t:"F") carries a map of which components were pulled to which buffer
 * locations. Deleting the frame without releasing those leaves orphaned "B"
 * rows belonging to a build that no longer exists -- stock that is invisible to
 * the floor and uncorrectable from the UI.
 *
 * Parity with SRC/src/Service_Write.js:108-210.
 *
 * Runs under the write lease. A step beyond SRC -- see moveInventoryItem's
 * comment for why. This one deletes rows, so a stale row index resolved from a
 * snapshot another writer has since shifted destroys the WRONG pallet rather
 * than merely overwriting a number.
 *
 * @param {string} locId
 * @param {string} sku
 * @param {string|number} instanceOrRowId
 * @param {Object} [context]
 * @return {Promise<{success: boolean, error?: string}>}
 */
async function removeItemFromLocation(locId, sku, instanceOrRowId, context) {
  return withInventoryLock(
      () => removeItemFromLocationLocked_(locId, sku, instanceOrRowId, context),
      { label: 'removeItemFromLocation ' + (locId || '?') + '/' + (sku || '?') }
  );
}

/**
 * The body of removeItemFromLocation, with the lease already held. Split out
 * only so the lock is one deletable line -- see functions/lock.js. Never call
 * directly.
 *
 * @param {string} locId
 * @param {string} sku
 * @param {string|number} instanceOrRowId
 * @param {Object} [context]
 * @return {Promise<{success: boolean, error?: string}>}
 */
async function removeItemFromLocationLocked_(locId, sku, instanceOrRowId, context) {
  try {
    const data = await SS_API.getSheetValues("Inventory!A:G");

    let targetRowIdx = -1;
    let sysData = null;
    let itemsAtLoc = 0;

    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === locId && data[i][1] !== "Vacant") itemsAtLoc++;
    }

    if (typeof instanceOrRowId === 'string' && instanceOrRowId.length > 10) {
      for (let i = 1; i < data.length; i++) {
        if (data[i][6] === instanceOrRowId) {
          targetRowIdx = i + 1;
          sysData = parseSysBlob_(data[i][5], 'Inventory row ' + (i + 1)) || sysData;
          break;
        }
      }
    } else if (typeof instanceOrRowId === 'number' && instanceOrRowId > 1) {
      targetRowIdx = instanceOrRowId;
      const snapshot = data[targetRowIdx - 1];
      if (snapshot) sysData = parseSysBlob_(snapshot[5], 'Inventory row ' + targetRowIdx) || sysData;
    }

    if (targetRowIdx === -1) {
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === locId && data[i][1] === sku) {
          targetRowIdx = i + 1;
          sysData = parseSysBlob_(data[i][5], 'Inventory row ' + (i + 1)) || sysData;
        }
      }
    }

    // Returns a real result rather than silently doing nothing -- deleteItem()
    // in the client only ever registered a success handler, so a no-op here
    // used to leave the optimistic "location is now vacant" UI standing.
    if (targetRowIdx === -1) {
      return {
        success: false,
        error: 'Row not found for ' + locId + '/' + sku +
               '. The pallet may have been moved or deleted by another station.'
      };
    }

    let rowsToDelete = [];
    let sheetUpdates = [];
    if (itemsAtLoc > 1) {
      rowsToDelete.push(targetRowIdx);
    } else {
      sheetUpdates.push({
        range: `Inventory!B${targetRowIdx}:F${targetRowIdx}`,
        values: [["Vacant", 0, "Open", "None", ""]]
      });
    }

    const userEmail = getActiveUserEmail(context);
    await SS_API.batchAppendRows("Audit_Log",
        [[new Date().toISOString(), locId, sku, "HARD_DELETE", 0, 0, userEmail]]);

    // --- CASCADE BULK DELETION ---
    if (sysData && sysData.t === 'F' && sysData.b) {
      let bulkRowsToDelete = [];
      let bulkRowsToVacant = [];
      for (let comp in sysData.b) {
        for (let bLoc in sysData.b[comp]) {
          let targetQty = sysData.b[comp][bLoc];
          let itemsAtBLoc = data.filter(r => r[0] === bLoc && r[1] !== "Vacant").length;
          for (let j = 1; j < data.length; j++) {
            if (data[j][0] === bLoc && data[j][1] === sku) {
              const bSys = parseSysBlob_(data[j][5], 'Inventory row ' + (j + 1));
              if (bSys && bSys.t === 'B' && bSys.p === comp && bSys.f && bSys.f[locId] === targetQty) {
                if (itemsAtBLoc > 1) {
                  if (!bulkRowsToDelete.includes(j + 1)) bulkRowsToDelete.push(j + 1);
                } else {
                  if (!bulkRowsToVacant.includes(j + 1)) bulkRowsToVacant.push(j + 1);
                }
                break;
              }
            }
          }
        }
      }

      bulkRowsToVacant.forEach(r => {
        sheetUpdates.push({
          range: `Inventory!B${r}:F${r}`,
          values: [["Vacant", 0, "Open", "None", ""]]
        });
      });

      let finalDeletions = [...rowsToDelete, ...bulkRowsToDelete];
      finalDeletions = [...new Set(finalDeletions)].sort((a, b) => b - a);

      if (sheetUpdates.length > 0) await SS_API.batchUpdateValues(sheetUpdates);
      if (finalDeletions.length > 0) {
        await SS_API.batchDeleteRows(await SS_API.getSheetId(INVENTORY_SHEET), finalDeletions);
      }
    } else {
      if (sheetUpdates.length > 0) await SS_API.batchUpdateValues(sheetUpdates);
      if (rowsToDelete.length > 0) {
        await SS_API.batchDeleteRows(await SS_API.getSheetId(INVENTORY_SHEET), rowsToDelete);
      }
    }

    return { success: true };
  } catch (e) {
    // Unguarded in SRC too until recently -- deleteItem() only ever registered a
    // success handler, so a thrown exception here (locked sheet, stale row after
    // a concurrent edit) used to vanish silently.
    logger.error('removeItemFromLocation failed for ' + locId + '/' + sku, { error: e.message });
    return { success: false, error: e.toString() };
  }
}

/**
 * Moves a whole Master Hub group -- several Inventory rows sharing one build --
 * to a new location in one operation, preserving each row's instanceId, status,
 * soft-kit tag and _SYS_ blob.
 *
 * Parity with SRC/src/Service_Write.js:524-612.
 *
 * @param {string} fromLoc
 * @param {string} toLoc
 * @param {Array<string>} instanceIds
 * @param {boolean} clientAssertsKnownCoordinate operator confirmed a real but
 *     never-stowed-to floor coordinate.
 * @param {Object} [context]
 * @return {Promise<{success: boolean, moved?: number, error?: string}>}
 *
 * Runs under the write lease. A step beyond SRC -- see moveInventoryItem's
 * comment for why. It moves several rows at once, so the window between the
 * snapshot and the last write is wider still.
 *
 * The two argument checks are hoisted ABOVE the lease. SRC reads the sheet
 * first and validates second; neither check looks at `data`, so running them
 * first changes no answer and keeps a request that is going to be refused from
 * holding the project-wide lock across a full-sheet read while being refused.
 */
async function moveHubGroup(fromLoc, toLoc, instanceIds, clientAssertsKnownCoordinate, context) {
  if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
    return { success: false, error: "Nothing selected to move." };
  }

  toLoc = String(toLoc || '').trim();
  if (!toLoc) return { success: false, error: "Destination location is required." };

  return withInventoryLock(
      () => moveHubGroupLocked_(fromLoc, toLoc, instanceIds, clientAssertsKnownCoordinate, context),
      { label: 'moveHubGroup ' + (fromLoc || '?') + ' -> ' + toLoc }
  );
}

/**
 * The body of moveHubGroup, with the lease already held. Split out only so the
 * lock is one deletable line -- see functions/lock.js. Never call directly.
 *
 * @param {string} fromLoc
 * @param {string} toLoc already trimmed and non-empty.
 * @param {Array<string>} instanceIds already checked non-empty.
 * @param {boolean} clientAssertsKnownCoordinate
 * @param {Object} [context]
 * @return {Promise<{success: boolean, moved?: number, error?: string}>}
 */
async function moveHubGroupLocked_(fromLoc, toLoc, instanceIds, clientAssertsKnownCoordinate, context) {
  try {
    const data = await SS_API.getSheetValues("Inventory!A:G");

    // ZONE-STAGED removed 2026-08-27 -- staging is a status (column D), not a
    // destination; no client-side path can send a move here anymore, and the
    // server should reject one just as it would any other unrecognized
    // destination now, rather than silently accepting it as always-vacant.
    const VIRTUAL_ZONES = ['ZONE-BUFFER'];
    const toLocUpper = toLoc.toUpperCase();
    if (!VIRTUAL_ZONES.includes(toLocUpper)) {
      let knownLocation = null;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0] || '').toUpperCase() === toLocUpper) { knownLocation = data[i][0]; break; }
      }
      if (knownLocation !== null) {
        toLoc = knownLocation;
      } else if (!clientAssertsKnownCoordinate) {
        return {
          success: false,
          error: "Unknown destination '" + toLoc + "' -- it doesn't match any existing " +
                 "location or recognized zone. Move rejected rather than creating a new one."
        };
      }
      // else: a real, never-stowed-to floor coordinate -- see
      // moveInventoryItem()'s matching comment.
    }
    if (String(toLoc).toUpperCase() === String(fromLoc).toUpperCase()) {
      return { success: false, error: "Destination is the same as the source." };
    }

    const userEmail = getActiveUserEmail(context);
    let updates = [];
    let rowsToDelete = [];
    let newRows = [];
    let logEntries = [];
    let movedCount = 0;

    instanceIds.forEach(instId => {
      for (let i = 1; i < data.length; i++) {
        if (data[i][6] !== instId) continue;
        const qty = Number(data[i][2]);
        if (qty <= 0) break;
        const sku = data[i][1];
        const resTag = data[i][3] || "Open";
        const softKitTag = data[i][4] || "None";
        const comTag = data[i][5] || "";

        const itemsAtFromLoc = data.filter(r => r[0] === fromLoc && r[1] !== "Vacant").length;
        if (itemsAtFromLoc - rowsToDelete.length > 1) {
          rowsToDelete.push(i + 1);
        } else {
          updates.push([i + 1, 2, "Vacant"], [i + 1, 3, 0], [i + 1, 4, "Open"],
                       [i + 1, 5, "None"], [i + 1, 6, ""]);
        }

        newRows.push([toLoc, sku, qty, resTag, softKitTag, comTag, instId]);
        logEntries.push([new Date().toISOString(), fromLoc, sku, "MOVE_OUT", qty, 0, userEmail]);
        logEntries.push([new Date().toISOString(), toLoc, sku, "MOVE_IN", qty, "", userEmail]);
        movedCount++;
        break;
      }
    });

    if (movedCount === 0) {
      return {
        success: false,
        error: "None of this pallet's rows were found at " + fromLoc + " -- it may have already moved."
      };
    }

    const sheetUpdates = updates.map(upd => {
      const colLetter = String.fromCharCode(64 + upd[1]);
      return { range: `Inventory!${colLetter}${upd[0]}`, values: [[upd[2]]] };
    });
    if (sheetUpdates.length > 0) await SS_API.batchUpdateValues(sheetUpdates);
    if (rowsToDelete.length > 0) {
      await SS_API.batchDeleteRows(await SS_API.getSheetId(INVENTORY_SHEET), rowsToDelete);
    }
    if (newRows.length > 0) await SS_API.batchAppendRows("Inventory", newRows);
    if (logEntries.length > 0) await SS_API.batchAppendRows("Audit_Log", logEntries);

    return { success: true, moved: movedCount };
  } catch (e) {
    logger.error('moveHubGroup failed ' + fromLoc + ' -> ' + toLoc, { error: e.message });
    return { success: false, error: e.toString() };
  }
}

/**
 * Splits part of a row's quantity onto a new row with its own workflow status
 * -- the Adjust popup's auto-split (SCHEMA v17 item 2).
 *
 * Parity with SRC/src/Service_Write.js:1100-1190, including its
 * `LockService.getScriptLock()` at :1118 -- now the Firestore lease
 * (functions/lock.js). Validation runs BEFORE the lease is taken, exactly as
 * SRC orders it: a request rejected for a bad quantity or an unrecognized
 * status never touches the sheet, so there is nothing to serialise, and holding
 * the project-wide lock while deciding that would block every other station for
 * no reason.
 *
 * @param {number} rowIdx 1-based Inventory row.
 * @param {string} locId
 * @param {string} sku
 * @param {*} splitQty
 * @param {string} newStatus one of Open / Staging / Staged / Labeled.
 * @param {Object} [context]
 * @return {Promise<Object>}
 */
async function splitInventoryRow(rowIdx, locId, sku, splitQty, newStatus, context) {
  // Same NaN guard every other qty entry point uses -- '12o' is NaN, and NaN
  // fails every `<= 0` test below, so an unguarded one would reach the sheet.
  // See AUDIT_2026-08-24.md B5.
  const qty = validateQty_(splitQty, "Split quantity");
  if (!qty.ok) return { success: false, error: qty.error };
  splitQty = qty.value;
  if (splitQty <= 0) return { success: false, error: "Split quantity must be greater than 0." };

  // The client is not the trust boundary: an unrecognized status would write a
  // value that generateLocalTotals()/renderLabels() classify as "not Open"
  // forever, with no way to see why.
  const VALID_STATUSES = ["Open", "Staging", "Staged", "Labeled"];
  newStatus = String(newStatus || "").trim();
  if (VALID_STATUSES.indexOf(newStatus) === -1) {
    return { success: false, error: "Unrecognized workflow status '" + newStatus + "'." };
  }

  return withInventoryLock(
      () => splitInventoryRowLocked_(rowIdx, locId, sku, splitQty, newStatus, context),
      { label: 'splitInventoryRow row ' + rowIdx }
  );
}

/**
 * The body of splitInventoryRow, with the lease already held. Split out only so
 * the lock is one deletable line -- see functions/lock.js. Never call directly.
 *
 * @param {number} rowIdx
 * @param {string} locId
 * @param {string} sku
 * @param {number} splitQty already validated to a finite number > 0.
 * @param {string} newStatus already validated against VALID_STATUSES.
 * @param {Object} [context]
 * @return {Promise<Object>}
 */
async function splitInventoryRowLocked_(rowIdx, locId, sku, splitQty, newStatus, context) {
  try {
    const data = await SS_API.getSheetValues("Inventory!A:G");
    const row = data[rowIdx - 1];
    if (!row) return { success: false, error: "Row data mismatch. The sheet may have been modified." };

    const currentLoc = String(row[0] || "").trim();
    const currentSku = String(row[1] || "").trim();

    if (currentLoc !== String(locId || "").trim() || currentSku !== String(sku || "").trim()) {
      return { success: false, error: "Row data mismatch. The sheet may have been modified." };
    }

    // A _SYS_ row is a Master Hub piece (t:"B") or an assembly Frame (t:"F"):
    // its comment carries a JSON blob binding it to one build. Copying that blob
    // onto a second row would fork one build's identity across two rows and
    // double-count it in every hub rollup (updateDetails() and renderLabels()
    // both group by pId); dropping it would orphan the split-off half out of its
    // build entirely. Neither is right, and pulling part of a hub out already
    // has its own operation -- explodePartialHub(). Refused here rather than
    // guessed at.
    if (row[5] && row[5].toString().indexOf("_SYS_") !== -1) {
      return {
        success: false,
        error: "This row is part of an assembly build -- use the hub's Explode action to pull part of it out."
      };
    }

    const currentQty = Number(row[2]) || 0;
    if (splitQty >= currentQty) {
      return {
        success: false,
        error: "Split quantity (" + splitQty + ") must be less than this row's current total (" +
               currentQty + "). To change the whole row, use the Workflow Status dropdown instead."
      };
    }
    const remainder = currentQty - splitQty;

    // Resolved BEFORE either write, so the new row inherits the lot's true dwell
    // start instead of reading as a fresh arrival to getAgingData() /
    // calculateInventoryAgeDays(). Same column-H convention moveInventoryItem()
    // uses for MOVE_IN -- and the reason "SPLIT_IN" had to be added to
    // buildAgingData_()'s validActions (Service_Read.js) and to
    // resolveOriginalArrivalDate()'s own relevantActions: without that, the
    // split-off row would have NO arrival anchor at all and its location would
    // read as unknown age.
    const originalArrivalDate = await resolveOriginalArrivalDate(currentLoc, currentSku);

    await SS_API.batchUpdateValues([
      { range: `Inventory!C${rowIdx}`, values: [[remainder]] }
    ]);
    // Never vacates or deletes the source row: the splitQty < currentQty guard
    // above means the remainder is always >= 1, which is exactly why this
    // function carries none of setTotalStockByRow's itemsAtLoc /
    // vacate-vs-delete branching. Soft kit (col E) and comment (col F) carry
    // forward -- the split-off units are the same allocation and the same
    // context notes, just tracked separately from here on.
    await SS_API.batchAppendRows("Inventory",
        [[currentLoc, currentSku, splitQty, newStatus, row[4] || "None", row[5] || "", getUuid()]]);

    const userEmail = getActiveUserEmail(context);
    await SS_API.batchAppendRows("Audit_Log", [
      [new Date().toISOString(), currentLoc, currentSku, "SPLIT_OUT", splitQty, remainder, userEmail],
      [new Date().toISOString(), currentLoc, currentSku, "SPLIT_IN", splitQty, splitQty, userEmail,
        originalArrivalDate ? new Date(originalArrivalDate).toISOString() : ""]
    ]);

    return { success: true, remainder: remainder, splitQty: splitQty, newStatus: newStatus };
  } catch (e) {
    logger.error('splitInventoryRow failed for ' + locId + '/' + sku, { error: e.message });
    return { success: false, error: e.toString() };
  }
}

/**
 * Records a viewport/user-agent sample from a floor device.
 *
 * Writes to its own `Diagnostics` tab. In SRC it used to append into `Config` --
 * the hand-maintained sheet that also holds the port lead-time table
 * (getPortGroups_, Service_Dates.js) and STAKEHOLDER_EMAILS. Two problems with
 * that, both fixed:
 *
 *  1. Unbounded machine-generated growth inside a table humans edit by hand.
 *  2. Worse: when `Config` was missing it CREATED it, with diagnostic headers.
 *     getPortGroups_() would then find a Config sheet that parses to zero port
 *     rows and every ETA in the app would silently fall back -- permanently, and
 *     with no error, because a missing Config throws but a useless one does not.
 *
 * This never touches `Config`. See AUDIT_2026-08-24.md B8 and SCHEMA section 4F.
 * Parity with SRC/src/Service_Write.js:1211-1231.
 *
 * @param {number} width
 * @param {number} height
 * @param {string} userAgent
 * @return {Promise<{success: boolean, error?: string}>}
 */
async function logDisplayDiagnostic(width, height, userAgent) {
  const MAX_DIAGNOSTIC_ROWS = 1000;
  try {
    await SS_API.batchAppendRows("Diagnostics",
        [[new Date().toISOString(), width, height, userAgent]]);

    // Keep the tab bounded -- it grows on every manual diagnostic tap and
    // nothing else ever prunes it. Oldest first, header row preserved.
    const data = await SS_API.getSheetValues("Diagnostics!A:A");
    const lastRow = (data || []).length;
    const overflow = lastRow - (MAX_DIAGNOSTIC_ROWS + 1);
    if (overflow > 0) {
      const sheetId = await SS_API.getSheetId("Diagnostics");
      const rows = [];
      for (let r = 2; r < 2 + overflow; r++) rows.push(r);
      await SS_API.batchDeleteRows(sheetId, rows);
    }

    return { success: true };
  } catch (e) {
    // The Diagnostics tab may not exist yet. Unlike SRC this does NOT create it
    // -- SS_API has no insertSheet, and a diagnostics write is the last thing
    // that should be minting tabs in the operational workbook, since that exact
    // creation path is what broke Config (AUDIT B8). Create it by hand once.
    logger.warn('logDisplayDiagnostic failed', { error: e.message });
    return { success: false, error: e.toString() };
  }
}

/**
 * The card's live checklist state, keyed by idCheckItem.
 *
 * This is the trust boundary for receivePOCardItems: oldQty/oldRcvd arrive FROM
 * THE BROWSER, and the over-receipt guard used to compute originalExpectedQty
 * straight from them. Two stations with the same PO open therefore both held
 * the same stale oldRcvd, both passed the guard, and both appended -- the guard
 * could not see the other station at all. See AUDIT_2026-08-24.md B6 and
 * SCHEMA invariant #53. Parity with SRC/src/Service_Write.js:1292-1302.
 *
 * @param {string} cardId
 * @return {Promise<Object<string, {qty: number, rcvd: number}>|null>} null when
 *     the checklist could not be read at all.
 */
async function readLiveChecklistState_(cardId) {
  const { getExistingCardChecklist } = require('./Service_Read');
  const live = await getExistingCardChecklist(cardId);
  if (!live || live.success === false) return null;
  const byId = {};
  (live.items || []).forEach(function(it) {
    if (it && it.idCheckItem) {
      byId[it.idCheckItem] = { qty: Number(it.qty) || 0, rcvd: Number(it.rcvd) || 0 };
    }
  });
  return byId;
}

module.exports = {
  modifySheetRow,
  validateQty_,
  processAuditAction,
  bulkVerifyAuditLocations,
  markAuditComplete,
  removeItemFromLocation,
  moveHubGroup,
  splitInventoryRow,
  logDisplayDiagnostic,
  readLiveChecklistState_,
  setTotalStock,
  updateStock,
  addNewItemToLocation,
  resolveOriginalArrivalDate,
  moveInventoryItem,
  updateInventoryField,
  updatePalletComment,
  reservePallet,

  cleanUpVacantRows,
  addBulkFedExTracking,
  stageBulkFedExTrackingNumbers,
  updateInventoryByRow,
  setTotalStockByRow,

  receivePOCardItems,
  markFedExChildDeliveredInSheet,
  processPackedOutboundCard,

  // Other exports will go here
};
