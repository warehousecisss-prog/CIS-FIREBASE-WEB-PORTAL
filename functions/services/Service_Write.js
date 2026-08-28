const SS_API = require('./Service_SheetsAPI');
const logger = require('firebase-functions/logger');

/**
 * ============================================================================
 * CIS WAREHOUSE PORTAL - CORE INVENTORY & FEDEX MUTATION SERVICES
 * PORTED TO NODE.JS (FIREBASE CLOUD FUNCTIONS)
 * ============================================================================
 */

// Helper to get active user equivalent in Firebase (would come from Auth context)
function getActiveUserEmail(context) {
  return context?.auth?.token?.email || "system@cis-portal.app";
}

// Generate UUID substitute for Utilities.getUuid()
function getUuid() {
  return require('crypto').randomUUID();
}

/**
 * Core helper that finds a row based on locId and sku (or instanceId)
 * and allows a callback to define what happens to it.
 * 
 * In GAS, this passed a "sheetWrapper" to simulate getRange().setValue().
 * In Node, we will read all data, find the row, let the callback define mutations,
 * and then run SS_API.batchUpdateValues / batchDeleteRows.
 */
async function modifySheetRow(locId, sku, instanceOrRowId, callback, context) {
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
  }
  
  if (targetRowIdx === -1) {
    for (let i = 1; i < data.length; i++) {
      const rowLoc = cleanStr(data[i][0]);
      const rowSku = cleanStr(data[i][1]);
      
      if (rowLoc === targetLoc && rowSku === targetSku) {
        let rCom = data[i][5] ? data[i][5].toString() : "";
        let isHub = false;
        if (rCom.includes('_SYS_')) {
          try {
            let sObj = JSON.parse(rCom.split('_SYS_')[1].trim());
            if (sObj && sObj.t === 'B') isHub = true;
          } catch(e){}
        }
        if (!isHub) {
          targetRowIdx = i + 1;
          break;
        }
      }
    }
  }
  
  if (targetRowIdx > -1) { 
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

    // Assuming Inventory is the first sheet or we resolve its sheetId via metadata
    // For now we pass a placeholder sheetId (0) which usually maps to the first sheet.
    // In production, we'd fetch the sheetId via sheets.spreadsheets.get
    const inventorySheetId = 0; 

    callback(sheetWrapper, targetRowIdx, itemsAtLoc);
    
    if (sheetUpdates.length > 0) await SS_API.batchUpdateValues(sheetUpdates);
    if (rowsToDelete.length > 0) await SS_API.batchDeleteRows(inventorySheetId, rowsToDelete);
  }
}

async function setTotalStock(locId, sku, newQty, instanceOrRowId, context) {
  await modifySheetRow(locId, sku, instanceOrRowId, async (sheet, rowIdx, itemsAtLoc) => {
    newQty = Number(newQty);
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
  return { success: true };
}

async function updateStock(locId, sku, adjustment, instanceOrRowId, context) {
  await modifySheetRow(locId, sku, instanceOrRowId, async (sheet, rowIdx, itemsAtLoc) => {
    const userEmail = getActiveUserEmail(context);
    const currentQty = Number(sheet.getRange(rowIdx, 3).getValue()) || 0;
    let newQty = currentQty + Number(adjustment);
    
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
  return { success: true };
}

async function addNewItemToLocation(locId, sku, initialQty, context) {
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

async function moveInventoryItem(fromLoc, toLoc, sku, moveQty, isHubMove, instanceOrRowId, context) {
  const { planCaseConversion } = require('./Service_Conversions');
  moveQty = Number(moveQty);
  isHubMove = !!isHubMove;
  toLoc = String(toLoc || '').trim();
  if (!toLoc) return { success: false, error: "Destination location is required." };

  const data = await SS_API.getSheetValues("Inventory!A:G");
  const VIRTUAL_ZONES = ['ZONE-BUFFER', 'ZONE-STAGED'];
  const toLocUpper = toLoc.toUpperCase();
  if (!VIRTUAL_ZONES.includes(toLocUpper)) {
    let knownLocation = null;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0] || '').toUpperCase() === toLocUpper) { knownLocation = data[i][0]; break; }
    }
    if (knownLocation === null) {
      return { success: false, error: `Unknown destination '${toLoc}' -- it doesn't match any existing location or recognized zone. Move rejected rather than creating a new one.` };
    }
    toLoc = knownLocation;
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
          if (comTag.includes('_SYS_')) {
            try { sysData = JSON.parse(comTag.split('_SYS_')[1].trim()); } catch(e){}
          }
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
    if (comTag.includes('_SYS_')) {
      try { sysData = JSON.parse(comTag.split('_SYS_')[1].trim()); } catch(e){}
    }
  }

  if (fromRowIdx === -1) {
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === fromLoc && data[i][1] === sku) { 
        let rCom = data[i][5] ? data[i][5].toString() : "";
        let rType = "normal";
        let sObj = null;
        if (rCom.includes('_SYS_')) {
          try {
            sObj = JSON.parse(rCom.split('_SYS_')[1].trim());
            if (sObj && sObj.t) rType = sObj.t;
          } catch(e){}
        }
        
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
    let origSysData = null;
    if (comTag.includes('_SYS_')) {
      try { origSysData = JSON.parse(comTag.split('_SYS_')[1].trim()); } catch(e){}
    }
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
            if (frameComment.includes('_SYS_')) {
              try {
                let fSys = JSON.parse(frameComment.split('_SYS_')[1].trim());
                if (fSys.t === 'F' && fSys.b && fSys.b[origSysData.p]) {
                  let currentFromLocAlloc = fSys.b[origSysData.p][fromLoc] || 0;
                  fSys.b[origSysData.p][fromLoc] = currentFromLocAlloc - allocated;
                  if (fSys.b[origSysData.p][fromLoc] <= 0) delete fSys.b[origSysData.p][fromLoc];
                  
                  if (!fSys.b[origSysData.p][toLoc]) fSys.b[origSysData.p][toLoc] = 0;
                  fSys.b[origSysData.p][toLoc] += allocated;
                  
                  sheetUpdates.push({ range: `Inventory!F${k+1}`, values: [[frameComment.split('_SYS_')[0].trim() + " _SYS_ " + JSON.stringify(fSys)]] });
                }
              } catch(e){}
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
  if (rowsToDelete.length > 0) await SS_API.batchDeleteRows(0, rowsToDelete); // Assuming Sheet 0 is Inventory

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

async function updateInventoryField(locId, sku, fieldType, value, instanceOrRowId, context) {
  await modifySheetRow(locId, sku, instanceOrRowId, (sheet, rowIdx) => {
    if (fieldType === 'status') sheet.getRange(rowIdx, 4).setValue(value);
    if (fieldType === 'assembly') sheet.getRange(rowIdx, 5).setValue(value);
  }, context);
}

async function updatePalletComment(locId, sku, commentText, instanceOrRowId, context) {
  await modifySheetRow(locId, sku, instanceOrRowId, (sheet, rowIdx) => { sheet.getRange(rowIdx, 6).setValue(commentText); }, context);
}

async function reservePallet(locId, sku, statusString, instanceOrRowId, context) { 
  await modifySheetRow(locId, sku, instanceOrRowId, (sheet, rowIdx) => { sheet.getRange(rowIdx, 4).setValue(statusString); }, context);
  return { success: true }; 
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
    await SS_API.batchDeleteRows(0, rowsToDelete); // Assuming Sheet ID 0 is Inventory
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

async function updateInventoryByRow(rowIdx, locId, sku, adjustment, context) {
  // In Node.js environment, rowIdx mutations can easily race, 
  // so this acts similarly to updateStock but enforces finding the exact row.
  return await updateStock(locId, sku, adjustment, rowIdx, context);
}

async function setTotalStockByRow(rowIdx, locId, sku, newQty, context) {
  return await setTotalStock(locId, sku, newQty, rowIdx, context);
}

async function receivePOCardItems(cardId, cardName, itemsReceived, context) {
  try {
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
    
    // Note: getProductMap is not implemented yet in this file, we assume it's imported or stubbed.
    // Assuming resolveCanonicalItemName is available via Shared_Classifiers if we had them.
    // We will do a generic replacement here.
    const productMapUpper = {};
    const resolveCanonicalItemName = (desc) => {
      // Stub implementation: extract [SKU]
      const match = desc.match(/^\[(.*?)\]/);
      return match ? match[1].trim() : desc;
    };
    const splitProductIdFromDesc = (desc) => {
      const match = desc.match(/^\[(.*?)\]\s*(.*)$/);
      return match ? { productId: match[1].trim(), cleanDescription: match[2].trim() } : { productId: "", cleanDescription: desc };
    };

    let trelloComments = [];
    let rowsToAppend = [];
    let logRowsToAppend = [];
    let confirmedItems = [];
    let now = new Date();

    itemsReceived.forEach(item => {
      const inventoryName = resolveCanonicalItemName(item.desc);
      const instanceId = getUuid();
      rowsToAppend.push(['ZONE-BUFFER', inventoryName, item.qty, 'PO_RECEIVED', now.toISOString(), 'RCVD from ' + cardName, instanceId]);

      let userEmail = getActiveUserEmail(context);
      if (item.stationId) userEmail += ' [' + item.stationId + ']';
      logRowsToAppend.push([now.toISOString(), 'ZONE-BUFFER', inventoryName, 'PO_RECEIVED', 0, item.qty, userEmail]);

      confirmedItems.push({
        idCheckItem: item.idCheckItem,
        desc: item.desc,
        newQty: Math.max(0, item.oldQty - item.qty),
        newRcvd: item.oldRcvd + item.qty
      });

      const parsed = splitProductIdFromDesc(item.desc);
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
      
    if (rowsToAppend.length > 0) await SS_API.batchAppendRows("Inventory", rowsToAppend);
    if (logRowsToAppend.length > 0) await SS_API.batchAppendRows("Audit_Log", logRowsToAppend);
      
    // Post to Trello using fetch
    const apiKey = process.env.TRELLO_KEY;
    const apiToken = process.env.TRELLO_TOKEN;
    
    if (apiKey && apiToken) {
      await Promise.all(itemsReceived.map(async (item) => {
        if (item.idCheckItem) {
          const newRcvd = item.oldRcvd + item.qty;
          const newQty = Math.max(0, item.oldQty - item.qty);
          const newName = `${item.desc} | QTY: ${newQty} | RCVD: ${newRcvd}`;
          const state = newQty === 0 ? 'complete' : 'incomplete';
          
          const url = `https://api.trello.com/1/cards/${cardId}/checkItem/${item.idCheckItem}?key=${apiKey}&token=${apiToken}`;
          try {
            await fetch(url, {
              method: 'put',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newName, state: state })
            });
          } catch(e) {}
        }
      }));

      await Promise.all(trelloComments.map(async (comment) => {
        const url = `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${apiKey}&token=${apiToken}`;
        try {
          await fetch(url, {
            method: 'post',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: comment })
          });
        } catch(e) {}
      }));
    }
    
    const receivedAny = itemsReceived.some(item => item.qty > 0);
    const stillPending = !isPoFullyReceived;
    const isPartial = receivedAny && stillPending;

    // TODO: Send Email using SendGrid or Firebase Extension instead of MailApp
    logger.info("TODO: Implement Email sending", { emails, subject: isPoFullyReceived ? '✅ PO Received in Full' : '⚠️ Partial PO Receipt', text: plainText });

    if (apiKey && apiToken && isPoFullyReceived && receivedAny) {
      try {
        const commentUrl = `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${apiKey}&token=${apiToken}`;
        await fetch(commentUrl, {
            method: 'post',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: `🎉 PO #${cleanCardName} has been RECEIVED IN FULL! Total Quantity: ${poTotalRcvd} / ${poTotalExpected}. Ready for final QuickBooks bill closeout.` })
        });

        const cardRes = await fetch(`https://api.trello.com/1/cards/${cardId}?fields=idBoard&key=${apiKey}&token=${apiToken}`);
        if (cardRes.ok) {
          const cardData = await cardRes.json();
          const boardId = cardData.idBoard;
          const listsRes = await fetch(`https://api.trello.com/1/boards/${boardId}/lists?key=${apiKey}&token=${apiToken}`);
          if (listsRes.ok) {
            const lists = await listsRes.json();
            const deliveredList = lists.find(l => {
              const name = l.name.toLowerCase();
              return name.includes('delivered') || name.includes('done') || name.includes('received');
            });
            if (deliveredList) {
              await fetch(`https://api.trello.com/1/cards/${cardId}?idList=${deliveredList.id}&key=${apiKey}&token=${apiToken}`, { method: 'put' });
            }
          }
        }
      } catch(e) {
        logger.error("Failed to move card to Delivered list", { error: e.toString() });
      }
    }

    return {
      success: true,
      confirmedItems: confirmedItems,
      isPoFullyReceived: isPoFullyReceived,
      poTotalRcvd: poTotalRcvd,
      poTotalExpected: poTotalExpected
    };
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
  const trelloKey = process.env.TRELLO_KEY;
  const trelloToken = process.env.TRELLO_TOKEN;
  
  if (!trelloKey || !trelloToken || !cardId) return { success: false, error: "Missing config or ID" };
  
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  
  try {
    const commentUrl = `https://api.trello.com/1/cards/${cardId}/actions/comments?key=${trelloKey}&token=${trelloToken}`;
    await fetch(commentUrl, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `📦 **PACKED & STAGED** via CIS Portal at ${timestamp}` })
    });

    const labelUrl = `https://api.trello.com/1/cards/${cardId}/labels?key=${trelloKey}&token=${trelloToken}`;
    await fetch(labelUrl, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: "orange", name: "PACKED" })
    });

    const clRes = await fetch(`https://api.trello.com/1/cards/${cardId}/checklists?key=${trelloKey}&token=${trelloToken}`);
    if (clRes.ok) {
      const checklists = await clRes.json();
      
      if (checklists.length === 0) {
        const createRes = await fetch(`https://api.trello.com/1/cards/${cardId}/checklists?name=Status&key=${trelloKey}&token=${trelloToken}`, { method: 'post' });
        if (createRes.ok) {
          const newCl = await createRes.json();
          await fetch(`https://api.trello.com/1/checklists/${newCl.id}/checkItems?name=Packed&state=complete&checked=true&key=${trelloKey}&token=${trelloToken}`, { method: 'post' });
        }
      } else {
        for (const cl of checklists) {
          if (cl.checkItems && cl.checkItems.length > 0) {
            for (const item of cl.checkItems) {
              if (item.state !== 'complete') {
                await fetch(`https://api.trello.com/1/cards/${cardId}/checkItem/${item.id}?state=complete&key=${trelloKey}&token=${trelloToken}`, { method: 'put' });
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

module.exports = {
  modifySheetRow,
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
