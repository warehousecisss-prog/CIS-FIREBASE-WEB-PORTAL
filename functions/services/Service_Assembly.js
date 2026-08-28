const SS_API = require('./Service_SheetsAPI');
const { logger } = require('firebase-functions');
const { getActiveUserEmail } = require('../auth');
const { parseSysBlob_ } = require('./Shared_Classifiers');

// Utilities.getUuid() equivalent. `crypto` exports randomUUID, not getUuid --
// the previous `const { getUuid } = require('crypto')` destructured undefined,
// so every call site below threw "getUuid is not a function" at runtime.
function getUuid() {
  return require('crypto').randomUUID();
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

    const sheetUpdates = updates.map(upd => {
       const colLetter = String.fromCharCode(64 + upd[1]);
       return { range: `Inventory!${colLetter}${upd[0]}`, values: [[upd[2]]] };
    });
    
    if (sheetUpdates.length > 0) await SS_API.batchUpdateValues(sheetUpdates);

    // Fetch Inventory Sheet ID for row deletion
    const inventoryMetadata = await SS_API.getSheetMetadata("Inventory");
    if (inventoryMetadata && rowsToDelete.length > 0) {
      await SS_API.batchDeleteRows(inventoryMetadata.sheetId, rowsToDelete);
    }

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

    if (newRows.length > 0) await SS_API.batchAppendRows("Inventory", newRows);
    if (logEntries.length > 0) await SS_API.batchAppendRows("Audit_Log", logEntries);

    return { success: true };
  } catch (e) {
    logger.error("buildHardAssembly failure", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

async function explodeAssembly(locId, sku, qty, instanceId = null, context) {
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

    if (sheetUpdates.length > 0) await SS_API.batchUpdateValues(sheetUpdates);
    if (sheetAppends.length > 0) await SS_API.batchAppendRows("Inventory", sheetAppends);
    if (logAppends.length > 0) await SS_API.batchAppendRows("Audit_Log", logAppends);
    
    if (rowsToDelete.length > 0) {
      const inventoryMetadata = await SS_API.getSheetMetadata("Inventory");
      if (inventoryMetadata) {
        await SS_API.batchDeleteRows(inventoryMetadata.sheetId, rowsToDelete);
      }
    }

    return { success: true };
  } catch (e) {
    logger.error("explodeAssembly failure", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

module.exports = {
  getAssemblyData,
  buildHardAssembly,
  explodeAssembly
};
