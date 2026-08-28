const SS_API = require('./Service_SheetsAPI');
const { logger } = require('firebase-functions');
const { getActiveUserEmail } = require('../auth');
const { parseSysBlob_ } = require('./Shared_Classifiers');
// The Node stand-in for LockService (AUDIT B7). See functions/lock.js.
const { withInventoryLock } = require('../lock');

const INVENTORY_SHEET = "Inventory";

// Utilities.getUuid() equivalent. `crypto` exports randomUUID, not getUuid --
// the previous `const { getUuid } = require('crypto')` destructured undefined,
// so every call site below threw "getUuid is not a function" at runtime.
function getUuid() {
  return require('crypto').randomUUID();
}

/**
 * The single commit point for every assembly write path.
 *
 * All three used to commit through three or four SEPARATE Sheets API calls, and
 * a quota error or a timeout landing between two of them corrupted inventory in
 * a way nothing reported:
 *
 *  - `explodeAssembly` / `explodePartialHub` committed the restores (update +
 *    append) BEFORE the delete. Failing in between left the components restored
 *    AND the assembly rows still standing — inventory silently **doubled**.
 *  - `buildHardAssembly` was the mirror image: it deleted the consumed
 *    component rows in one call and minted the new assembly rows in a later
 *    one. Failing in between **destroyed** the stock outright.
 *
 * `SS_API.commitAtomic()` puts the Inventory updates, appends and deletes into
 * one `batchUpdate`, which the API applies atomically — all of it or none.
 * See AUDIT_2026-08-24.md B3.
 *
 * This is a DIFFERENT guarantee from the write lease in functions/lock.js, and
 * neither replaces the other: the lease stops two writers interleaving, this
 * stops one writer half-finishing.
 *
 * Audit_Log is deliberately written afterwards, OUTSIDE the atomic set. A
 * missing log line is a reporting gap, not an inventory error, so it is logged
 * and swallowed rather than allowed to fail an operation whose inventory effect
 * has already committed correctly. (SRC's reason is that its log rows carry a
 * live `new Date()` and a Date cannot go through `updateCells` without a
 * numberFormat — this port writes ISO strings, so that specific constraint does
 * not bite here, but the reporting-gap reasoning stands on its own.)
 *
 * Parity with SRC/src/Service_Assembly.js:327-383.
 *
 * @param {{updates: Array<{range: string, values: Array<Array<*>>}>,
 *          appends: Array<Array<*>>,
 *          deletes: Array<number>,
 *          logs: Array<Array<*>>}} ops
 * @return {Promise<void>}
 */
async function commitInventoryMutation_(ops) {
  const updates = ops.updates || [];
  const appends = ops.appends || [];
  const deletes = ops.deletes || [];
  const logs = ops.logs || [];

  if (updates.length || appends.length || deletes.length) {
    // Real gid, resolved and cached. Never a hardcoded 0 -- PORT_AUDIT C4.
    const sheetId = await SS_API.getSheetId(INVENTORY_SHEET);
    await SS_API.commitAtomic({
      updates: updates,
      appends: appends.length > 0 ? [{ sheetId: sheetId, rows: appends }] : [],
      deletes: deletes.length > 0 ? [{ sheetId: sheetId, rowIndices: deletes }] : []
    }, sheetId);
  }

  if (logs.length > 0) {
    try {
      await SS_API.batchAppendRows("Audit_Log", logs);
    } catch (e) {
      // Inventory is already committed and correct at this point -- do not
      // rethrow and make the caller report a failed operation.
      logger.error("commitInventoryMutation_: Audit_Log append failed after a " +
        "successful inventory commit (" + logs.length + " rows lost)", { error: e.message });
    }
  }
}

/**
 * Server-side twin of `findEffectiveQtyPer_()` in `JS_Render_UI.html` -- walks
 * the Assemblies recipe tree, multiplying `qtyPer` down through nested levels so
 * a component several levels deep still resolves to its true per-kit ratio.
 *
 * Duplicated rather than shared because the client and server run in separate
 * JS environments with no common module to import from. `explodePartialHub()`
 * re-derives this instead of trusting a client-supplied ratio, since the client
 * is not the trust boundary for a quantity about to be written to the sheet.
 *
 * `visited` guards a recipe that references itself, directly or through a
 * cycle -- without it a malformed Assemblies tab hangs the request.
 *
 * Parity with SRC/src/Service_Assembly.js:394-408.
 *
 * @param {Array<Object>} recipeData rows from getAssemblyData().
 * @param {string} parentSku
 * @param {string} targetComponent
 * @param {number} multiplier accumulated ratio from the levels above.
 * @param {Set<string>} visited
 * @return {?number} units of targetComponent per one parentSku, or null.
 */
function findEffectiveQtyPer_(recipeData, parentSku, targetComponent, multiplier, visited) {
  if (visited.has(parentSku)) return null;
  visited.add(parentSku);
  const recipe = recipeData.filter(r => String(r.parent) === String(parentSku));
  for (let i = 0; i < recipe.length; i++) {
    const comp = recipe[i];
    const qtyPer = Number(comp.qtyPer) || 0;
    if (qtyPer <= 0) continue;
    const effectiveQty = multiplier * qtyPer;
    if (String(comp.component) === String(targetComponent)) return effectiveQty;
    const nested = findEffectiveQtyPer_(recipeData, comp.component, targetComponent, effectiveQty, visited);
    if (nested !== null) return nested;
  }
  return null;
}

async function getAssemblyData() {
  try {
    const data = await SS_API.getSheetValues("Assemblies!A:D");
    if (!data || data.length < 2) return [];
    return data.slice(1).map(row => ({ 
      parent: row[0], 
      component: row[1], 
      qtyPer: Number(row[2]) || 1,
      type: row[3] ? row[3].toString().trim() : "Affixed"
    })).filter(r => r.parent && r.component);
  } catch (e) { 
    logger.error("getAssemblyData error", { error: e.toString() });
    return []; 
  }
}

async function buildHardAssembly(locId, parentSku, buildQty, bulkAllocationsPayload, context) {
  return withInventoryLock(
      () => buildHardAssemblyLocked_(locId, parentSku, buildQty, bulkAllocationsPayload, context),
      { label: 'buildHardAssembly ' + (parentSku || '?') + ' @ ' + (locId || '?') }
  );
}

/**
 * The body of buildHardAssembly, with the write lease already held. Split out only so the
 * lock is one deletable line -- see functions/lock.js. Never call directly.
 *
 * @return {Promise<Object>}
 */
async function buildHardAssemblyLocked_(locId, parentSku, buildQty, bulkAllocationsPayload, context) {
  try {
    const data = await SS_API.getSheetValues("Inventory!A:G");
    if (!data || data.length < 2) return { success: false, error: "Inventory not found" };

    const userEmail = getActiveUserEmail(context);
    buildQty = Number(buildQty);
    if (buildQty <= 0) return { success: false, error: "Invalid quantity entered." };
    
    let bulkAllocations = {};
    if (bulkAllocationsPayload) {
      if (typeof bulkAllocationsPayload === 'string') {
        try { bulkAllocations = JSON.parse(bulkAllocationsPayload); } catch(e){}
      } else {
        bulkAllocations = bulkAllocationsPayload;
      }
    }

    const recipeData = await getAssemblyData();
    const components = recipeData.filter(r => r.parent === parentSku);
    if (components.length === 0) return { success: false, error: "No blueprint recipe found." };

    const logEntries = [];
    const updates = []; 
    let rowsToDelete = [];

    // 1. Deduct Affixed Parts
    const affixedComps = components.filter(c => c.type.toLowerCase() !== "loose" && c.type.toLowerCase() !== "bulk");
    affixedComps.forEach(comp => {
      const qtyNeeded = Number(comp.qtyPer) * buildQty;
      let itemsAtLoc = data.slice(1).filter(r => r[0] === locId && r[1] !== "Vacant").length;
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === locId && data[i][1] === comp.component) {
          let currentQty = Number(data[i][2]);
          let newQty = currentQty - qtyNeeded;
          if (newQty <= 0) {
             if (itemsAtLoc > 1) {
                 if (!rowsToDelete.includes(i + 1)) rowsToDelete.push(i + 1);
             } else {
                 updates.push([i + 1, 2, "Vacant"], [i + 1, 3, 0], [i + 1, 4, "Open"], [i + 1, 5, "None"], [i + 1, 6, ""]);
             }
          } else {
            updates.push([i + 1, 3, newQty]);
          }
          logEntries.push([new Date().toISOString(), locId, comp.component, "CONVERT_OUT", qtyNeeded, newQty <= 0 ? 0 : newQty, userEmail]);
          break; 
        }
      }
    });

    // 2. Deduct Earmarked/Loose Parts
    for (let compName in bulkAllocations) {
       for (let bLoc in bulkAllocations[compName]) {
          let pullQty = bulkAllocations[compName][bLoc];
          let itemsAtBLoc = data.slice(1).filter(r => r[0] === bLoc && r[1] !== "Vacant").length;
          for (let i = 1; i < data.length; i++) {
             if (data[i][0] === bLoc && data[i][1] === compName) {
                let currentQty = Number(data[i][2]);
                let newQty = currentQty - pullQty;
                if (newQty <= 0) {
                  if (itemsAtBLoc > 1) {
                      if (!rowsToDelete.includes(i + 1)) rowsToDelete.push(i + 1);
                  } else {
                      updates.push([i + 1, 2, "Vacant"], [i + 1, 3, 0], [i + 1, 4, "Open"], [i + 1, 5, "None"], [i + 1, 6, ""]);
                  }
                } else {
                  updates.push([i + 1, 3, newQty]);
                }
                logEntries.push([new Date().toISOString(), bLoc, compName, "CONVERT_OUT", pullQty, newQty <= 0 ? 0 : newQty, userEmail]);
                break;
             }
          }
       }
    }

    // The component deductions and deletions above are NOT committed here.
    // They used to be -- batchUpdateValues, then batchDeleteRows, then a later
    // batchAppendRows for the new assembly rows. A quota error or a timeout
    // between the delete and the append destroyed the consumed stock outright
    // with nothing minted in its place, and nothing reported it. Everything is
    // collected and committed once at the bottom of this function instead.
    // See AUDIT_2026-08-24.md B3.

    // 3 & 4. Minting new rows
    let newRows = [];
    let parentUuid = getUuid();
    let childUuids = [];

    for (let compName in bulkAllocations) {
        for (let bLoc in bulkAllocations[compName]) {
            let pullQty = bulkAllocations[compName][bLoc];
            let childUuid = getUuid();
            childUuids.push(childUuid);
            let bulkSys = { t: "B", pId: parentUuid, pSku: parentSku, cSku: compName };
            newRows.push([bLoc, parentSku, pullQty, "Open", "None", "_SYS_" + JSON.stringify(bulkSys), childUuid]);
            logEntries.push([new Date().toISOString(), bLoc, parentSku, "CONVERT_IN", pullQty, pullQty, userEmail]);
        }
    }
    
    let frameSys = { t: "F", cIds: childUuids };
    newRows.unshift([locId, parentSku, buildQty, "Open", "None", "_SYS_" + JSON.stringify(frameSys), parentUuid]);
    logEntries.push([new Date().toISOString(), locId, parentSku, "CONVERT_IN", buildQty, buildQty, userEmail]);

    // Single atomic commit: the component deductions/deletions from steps 1-2
    // and the new assembly rows from steps 3-4 land together or not at all.
    await commitInventoryMutation_({
      updates: updates.map(upd => {
        const colLetter = String.fromCharCode(64 + upd[1]);
        return { range: `Inventory!${colLetter}${upd[0]}`, values: [[upd[2]]] };
      }),
      appends: newRows,
      deletes: rowsToDelete,
      logs: logEntries
    });

    return { success: true };
  } catch (e) {
    logger.error("buildHardAssembly failure", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

async function explodeAssembly(locId, sku, qty, instanceId = null, context) {
  return withInventoryLock(
      () => explodeAssemblyLocked_(locId, sku, qty, instanceId, context),
      { label: 'explodeAssembly ' + (sku || '?') + ' @ ' + (locId || '?') }
  );
}

/**
 * The body of explodeAssembly, with the write lease already held. Split out only so the
 * lock is one deletable line -- see functions/lock.js. Never call directly.
 *
 * @return {Promise<Object>}
 */
async function explodeAssemblyLocked_(locId, sku, qty, instanceId = null, context) {
  try {
    const data = await SS_API.getSheetValues("Inventory!A:G");
    if (!data || data.length < 2) return { success: false, error: "Inventory not found" };

    const userEmail = getActiveUserEmail(context);
    qty = Number(qty);

    let assemblyRowIndex = -1;
    let frameUuid = instanceId;

    for (let i = 1; i < data.length; i++) {
      if ((instanceId && data[i][6] === instanceId) || (!instanceId && data[i][0] === locId && data[i][1] === sku)) {
        const sysData = parseSysBlob_(data[i][5], 'Inventory row ' + (i + 1));
        if (sysData && sysData.t === "F") {
          frameUuid = data[i][6] || instanceId;
          assemblyRowIndex = i + 1;
          break;
        }
      }
    }

    if (assemblyRowIndex === -1) return { success: false, error: "Assembly metadata not found." };
    
    let sheetUpdates = [];
    let sheetAppends = [];
    let logAppends = [];

    function restoreItemToSheet(targetLoc, compName, returnQty) {
      let restored = false;
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === targetLoc && data[i][1] === compName) {
          let currentQty = Number(data[i][2]);
          let newTotal = currentQty + returnQty;
          data[i][2] = newTotal; // Update in-memory data for subsequent lookups
          sheetUpdates.push({ range: `Inventory!C${i + 1}`, values: [[newTotal]] });
          logAppends.push([new Date().toISOString(), targetLoc, compName, "EXPLODE_RESTORE", returnQty, newTotal, userEmail]);
          restored = true;
          break;
        }
      }
      
      if (!restored) {
        for (let i = 1; i < data.length; i++) {
          if (data[i][0] === targetLoc && data[i][1].toString().toLowerCase() === "vacant") {
            data[i][1] = compName;
            data[i][2] = returnQty;
            data[i][3] = "Open";
            data[i][4] = "None";
            data[i][5] = "";
            data[i][6] = getUuid();
            
            sheetUpdates.push({ range: `Inventory!B${i + 1}:G${i + 1}`, values: [[compName, returnQty, "Open", "None", "", data[i][6]]] });
            logAppends.push([new Date().toISOString(), targetLoc, compName, "EXPLODE_RESTORE", returnQty, returnQty, userEmail]);
            restored = true;
            break;
          }
        }
      }
      
      if (!restored) {
        sheetAppends.push([targetLoc, compName, returnQty, "Open", "None", "", getUuid()]);
        logAppends.push([new Date().toISOString(), targetLoc, compName, "EXPLODE_RESTORE", returnQty, returnQty, userEmail]);
      }
    }

    const recipeData = await getAssemblyData();
    const components = recipeData.filter(r => r.parent === sku);
    const affixedComps = components.filter(c => c.type.toLowerCase() !== "loose" && c.type.toLowerCase() !== "bulk");
    affixedComps.forEach(comp => {
      let returnQty = Number(comp.qtyPer) * qty;
      restoreItemToSheet(locId, comp.component, returnQty);
    });

    let rowsToDelete = [assemblyRowIndex];

    for (let i = 1; i < data.length; i++) {
       const sysData = parseSysBlob_(data[i][5], 'Inventory row ' + (i + 1));
       if (sysData && sysData.t === "B" && sysData.pId === frameUuid) {
          rowsToDelete.push(i + 1);
          let bLoc = data[i][0];
          let cSku = sysData.cSku;
          let pullQty = Number(data[i][2]);
          restoreItemToSheet(bLoc, cSku, pullQty);
       }
    }

    logAppends.push([new Date().toISOString(), locId, sku, "EXPLODE_REMOVE", qty, 0, userEmail]);

    // Single atomic commit. This used to be four calls with the restores
    // (update + append) committed BEFORE the delete -- so a failure in between
    // left the components restored AND the assembly rows still standing, and
    // inventory silently doubled. See AUDIT_2026-08-24.md B3.
    await commitInventoryMutation_({
      updates: sheetUpdates,
      appends: sheetAppends,
      deletes: rowsToDelete,
      logs: logAppends
    });

    return { success: true };
  } catch (e) {
    logger.error("explodeAssembly failure", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

/**
 * Partial explode of ONE Master Hub card -- i.e. one build's (`pId`) footprint
 * at exactly ONE location.
 *
 * Unlike `explodeAssembly()` above, this never touches `t:"B"` rows sharing the
 * same `pId` at OTHER locations: a build scattered across several pallets
 * (sleeves on one rack, an accessory kit on another) must be explodable one
 * pallet at a time without disturbing the others.
 *
 * Restores `kitsToExplode` worth of this card's pieces to plain stock in place,
 * and DECREMENTS the Frame's own quantity by the same amount rather than
 * deleting it -- UNLESS this call drains the very last `t:"B"` row anywhere
 * still carrying this `pId`, in which case it also restores the Frame's Affixed
 * components (never represented by any purple card, since they are consumed
 * silently at build time) at the Frame's own location and removes the Frame,
 * matching what a full `explodeAssembly()` would have done.
 *
 * That fold-in is what makes "explode everything on this pallet" converge to a
 * true full explode without a separate button, once every card sharing this
 * `pId` has been drained the same way.
 *
 * Parity with SRC/src/Service_Assembly.js:425-559.
 *
 * @param {string} locId the pallet being exploded.
 * @param {string} pId the build reference (the Frame row's instance id).
 * @param {*} kitsToExplode how many kits to pull out of this pallet.
 * @param {Object} [context] Express req, for Audit_Log attribution.
 * @return {Promise<{success: boolean, fullyExploded?: boolean, error?: string}>}
 */
async function explodePartialHub(locId, pId, kitsToExplode, context) {
  return withInventoryLock(
      () => explodePartialHubLocked_(locId, pId, kitsToExplode, context),
      { label: 'explodePartialHub ' + (pId || '?') + ' @ ' + (locId || '?') }
  );
}

/**
 * The body of explodePartialHub, with the write lease already held. Split out only so the
 * lock is one deletable line -- see functions/lock.js. Never call directly.
 *
 * @return {Promise<Object>}
 */
async function explodePartialHubLocked_(locId, pId, kitsToExplode, context) {
  try {
    const data = await SS_API.getSheetValues("Inventory!A:G");
    if (!data || data.length < 2) return { success: false, error: "Inventory not found" };

    const userEmail = getActiveUserEmail(context);
    kitsToExplode = Number(kitsToExplode);
    if (!pId) return { success: false, error: "Missing build reference." };
    if (!(kitsToExplode > 0)) return { success: false, error: "Invalid kit quantity." };

    let frameRowIndex = -1;
    let frameRow = null;
    for (let i = 1; i < data.length; i++) {
      if (data[i][6] === pId) {
        const sysData = parseSysBlob_(data[i][5], 'Inventory row ' + (i + 1));
        if (sysData && sysData.t === "F") { frameRowIndex = i + 1; frameRow = data[i]; break; }
      }
    }
    if (frameRowIndex === -1) return { success: false, error: "Build reference not found." };
    const parentSku = frameRow[1];

    const piecesHere = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] !== locId) continue;
      const sysData = parseSysBlob_(data[i][5], 'Inventory row ' + (i + 1));
      if (sysData && sysData.t === 'B' && sysData.pId === pId) {
        piecesHere.push({ rowIndex: i + 1, cSku: sysData.cSku, qty: Number(data[i][2]) });
      }
    }
    if (piecesHere.length === 0) {
      return { success: false, error: "Nothing to explode at this location." };
    }

    // The ratio is re-derived from the recipe rather than taken from the
    // client: this number is about to be written to the sheet, so the browser
    // is not the trust boundary for it.
    const recipeData = await getAssemblyData();
    let maxKits = null;
    piecesHere.forEach(p => {
      const effQtyPer = findEffectiveQtyPer_(recipeData, parentSku, p.cSku, 1, new Set());
      if (!effQtyPer || effQtyPer <= 0) { maxKits = 0; return; }
      p.effQtyPer = effQtyPer;
      const kitsFromPiece = Math.floor(p.qty / effQtyPer);
      maxKits = (maxKits === null) ? kitsFromPiece : Math.min(maxKits, kitsFromPiece);
    });
    if (!maxKits || maxKits <= 0) {
      return {
        success: false,
        error: "No recipe match -- can't compute a kit quantity for this pallet."
      };
    }
    if (kitsToExplode > maxKits) {
      return { success: false, error: "Only " + maxKits + " kit(s) available on this pallet." };
    }

    const sheetUpdates = [];
    const sheetAppends = [];
    const logAppends = [];
    const rowsToDelete = [];

    // See the twin in explodeAssembly() for why this map exists (AUDIT B4): a
    // row that only exists as a pending append has no sheet row number yet, so
    // a second restore into it must amend the queued append, not emit a cell
    // update against a row that is not there.
    const pendingAppendAt = {};

    /**
     * @param {string} targetLoc
     * @param {string} compName
     * @param {number} returnQty
     */
    function restoreItemToSheet(targetLoc, compName, returnQty) {
      let restored = false;
      for (let i = 1; i < data.length; i++) {
        if (rowsToDelete.includes(i + 1)) continue;
        const isTagged = data[i][5] && data[i][5].toString().includes('_SYS_');
        if (data[i][0] === targetLoc && data[i][1] === compName && !isTagged) {
          const newTotal = Number(data[i][2]) + returnQty;
          data[i][2] = newTotal;
          if (Object.prototype.hasOwnProperty.call(pendingAppendAt, i)) {
            sheetAppends[pendingAppendAt[i]][2] = newTotal;
          } else {
            sheetUpdates.push({ range: `Inventory!C${i + 1}`, values: [[newTotal]] });
          }
          logAppends.push([new Date().toISOString(), targetLoc, compName,
            "EXPLODE_PARTIAL_RESTORE", returnQty, newTotal, userEmail]);
          restored = true;
          break;
        }
      }
      if (!restored) {
        for (let i = 1; i < data.length; i++) {
          if (rowsToDelete.includes(i + 1)) continue;
          if (data[i][0] === targetLoc && String(data[i][1]).toLowerCase() === "vacant") {
            data[i][1] = compName; data[i][2] = returnQty; data[i][3] = "Open";
            data[i][4] = "None"; data[i][5] = ""; data[i][6] = getUuid();
            sheetUpdates.push({
              range: `Inventory!B${i + 1}:G${i + 1}`,
              values: [[compName, returnQty, "Open", "None", "", data[i][6]]]
            });
            logAppends.push([new Date().toISOString(), targetLoc, compName,
              "EXPLODE_PARTIAL_RESTORE", returnQty, returnQty, userEmail]);
            restored = true;
            break;
          }
        }
      }
      if (!restored) {
        const newRow = [targetLoc, compName, returnQty, "Open", "None", "", getUuid()];
        pendingAppendAt[data.length] = sheetAppends.length;
        sheetAppends.push(newRow);
        data.push(newRow);
        logAppends.push([new Date().toISOString(), targetLoc, compName,
          "EXPLODE_PARTIAL_RESTORE", returnQty, returnQty, userEmail]);
      }
    }

    piecesHere.forEach(p => {
      const qtyToRemove = p.effQtyPer * kitsToExplode;
      const newQty = p.qty - qtyToRemove;
      if (newQty <= 0) {
        rowsToDelete.push(p.rowIndex);
      } else {
        data[p.rowIndex - 1][2] = newQty;
        sheetUpdates.push({ range: `Inventory!C${p.rowIndex}`, values: [[newQty]] });
      }
      restoreItemToSheet(locId, p.cSku, qtyToRemove);
    });

    const newFrameQty = Math.max(0, Number(frameRow[2]) - kitsToExplode);
    data[frameRowIndex - 1][2] = newFrameQty;
    sheetUpdates.push({ range: `Inventory!C${frameRowIndex}`, values: [[newFrameQty]] });
    logAppends.push([new Date().toISOString(), locId, parentSku,
      "EXPLODE_PARTIAL_REDUCE", kitsToExplode, newFrameQty, userEmail]);

    let anyChildrenRemain = false;
    for (let i = 1; i < data.length; i++) {
      if (rowsToDelete.includes(i + 1)) continue;
      const sysData = parseSysBlob_(data[i][5], 'Inventory row ' + (i + 1));
      if (sysData && sysData.t === 'B' && sysData.pId === pId) { anyChildrenRemain = true; break; }
    }

    if (!anyChildrenRemain) {
      const remainingFrameQty = newFrameQty;
      if (remainingFrameQty > 0) {
        const affixedComps = recipeData.filter(r => r.parent === parentSku &&
          r.type.toLowerCase() !== "loose" && r.type.toLowerCase() !== "bulk");
        affixedComps.forEach(comp => {
          restoreItemToSheet(frameRow[0], comp.component,
              Number(comp.qtyPer) * remainingFrameQty);
        });
      }
      rowsToDelete.push(frameRowIndex);
      logAppends.push([new Date().toISOString(), frameRow[0], parentSku,
        "EXPLODE_REMOVE", remainingFrameQty, 0, userEmail]);
    }

    await commitInventoryMutation_({
      updates: sheetUpdates,
      appends: sheetAppends,
      deletes: rowsToDelete,
      logs: logAppends
    });

    return { success: true, fullyExploded: !anyChildrenRemain };
  } catch (e) {
    logger.error("explodePartialHub failure", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

module.exports = {
  getAssemblyData,
  buildHardAssembly,
  explodeAssembly,
  explodePartialHub,
  // Exported for the parity harness and for any future write path that must
  // land as one atomic commit.
  commitInventoryMutation_,
  findEffectiveQtyPer_
};
