const SS_API = require('./Service_SheetsAPI');
const { getUuid } = require('crypto'); // If needed
const { logger } = require('firebase-functions');

// --- Simple In-Memory Cache to replace Google CacheService ---
const cacheStore = new Map();

function putLargeCache_(key, value, ttlSeconds) {
  cacheStore.set(key, {
    value,
    expiresAt: Date.now() + (ttlSeconds * 1000)
  });
}

function getLargeCache_(key) {
  const cached = cacheStore.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    cacheStore.delete(key);
    return null;
  }
  return cached.value;
}

const CACHE_KEY_LOGISTICS = "LOGISTICS_DASHBOARD_PAYLOAD_V2";
const CACHE_TTL_SECONDS = 21600;
const CACHE_KEY_AGING = "AGING_DATA_PAYLOAD_V1";
const CACHE_TTL_AGING_SECONDS = 300;
const BUILD_VERSION = "2026-08-13.1-NODEJS";

const PORTAL_IGNORED_MARKER = "PORTAL_IGNORED_MARKER"; // Ensure this matches what Shared_Classifiers uses

const TRELLO_INJECTOR_CONFIG = {
  CHECKLIST_NAME: 'PO Line Items',
  BASE_URL: 'https://api.trello.com/1'
};

/**
 * ============================================================================
 * SECTION 1: ACTIVE CACHE WARMING & LOGISTICS CONTROL TOWER READERS
 * ============================================================================
 */

async function getLogisticsDashboardData() {
  const cachedJson = getLargeCache_(CACHE_KEY_LOGISTICS);
  
  let data;
  if (cachedJson) {
    try {
      data = JSON.parse(cachedJson);
    } catch (e) {
      logger.warn("Cache parse error. Rebuilding payload from sheets...");
      data = await warmLogisticsDashboardCache();
    }
  } else {
    data = await warmLogisticsDashboardCache();
  }
  
  data.buildVersion = BUILD_VERSION;
  return data;
}

async function warmLogisticsDashboardCache() {
  const payload = await buildLogisticsDashboardPayload_();
  try {
    const jsonString = JSON.stringify(payload);
    putLargeCache_(CACHE_KEY_LOGISTICS, jsonString, CACHE_TTL_SECONDS);
    logger.info("Successfully pre-warmed Logistics Dashboard cache.");
  } catch (e) {
    logger.warn("Could not warm cache: " + e.message);
  }
  return payload;
}

async function buildLogisticsDashboardPayload_() {
  const tz = "America/New_York";
  
  const packingSpecs = {};
  const packingData = await SS_API.getSheetValues("Packing_Specs!A:B") || await SS_API.getSheetValues("Packing_Directory!A:B");
  if (packingData && packingData.length >= 2) {
    packingData.slice(1).forEach(row => {
      if (row[0]) packingSpecs[String(row[0]).trim().toUpperCase()] = parseInt(row[1], 10) || 0;
    });
  }
  
  const result = {
    inbound: [],
    outbound: [],
    stagedLedger: [],
    childBoxes: {},
    packingSpecs: packingSpecs
  };

  const cleanTrk = (val) => {
    if (val === null || val === undefined || val === "") return "";
    return String(val).trim().replace(/\.0+$/, "").replace(/[^0-9]/g, "");
  };

  const formatSafeDate = (val) => {
    if (!val || val === "-" || val === "N/A") return "-";
    try {
      const parsed = new Date(val);
      if (!isNaN(parsed.getTime())) {
        return parsed.toLocaleDateString("en-US", { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      }
      const str = String(val).trim();
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) return str;
      return "-";
    } catch (e) {
      return "-";
    }
  };

  const mpsData = await SS_API.getSheetValues("Multi Piece Tracking!A:Z");
  if (mpsData && mpsData.length >= 2) {
    mpsData.slice(1).forEach((row, rIdx) => {
      let masterTrk = "";
      for (let i = 0; i <= Math.min(4, row.length - 1); i++) {
        const candidate = cleanTrk(row[i]);
        if (candidate.length === 12 || candidate.length === 15) {
          masterTrk = candidate;
          break;
        }
      }
      
      if (!masterTrk) return;
      
      const storeName = String(row[0] || "STAGED ORDER").trim();
      const storeNum = String(row[1] || "").trim();
      const entityDisplay = (storeNum && storeNum !== "N/A" && !storeName.includes(storeNum)) ? `${storeName} #${storeNum}` : storeName;

      result.stagedLedger.push({
        storeName: storeName,
        storeNum: storeNum,
        direction: String(row[2] || "Outbound").trim(),
        masterTracking: masterTrk,
        entityName: entityDisplay || "STAGED ORDER",
        boardSource: "Multi Piece Tracking",
        rollupStatus: String(row[4] || "").trim()
      });

      const boxes = [];
      for (let col = 5; col < row.length; col += 2) {
        const boxStatus = String(row[col] || "").trim();
        const boxTrk = cleanTrk(row[col + 1]);
        if (boxTrk) boxes.push({ status: boxStatus || "In Transit", tracking: boxTrk });
      }
      if (boxes.length > 0) result.childBoxes[masterTrk] = boxes;
    });
  }

  const activeCardIds = new Set();

  const shipData = await SS_API.getSheetValues("SHIPMENTS!A:R");
  if (shipData && shipData.length >= 2) {
    shipData.slice(1).forEach(row => {
      const cardId = String(row[0] || "").trim();
      const direction = String(row[1] || "Outbound").trim();
      if (!cardId && !row[3]) return;

      if (cardId && activeCardIds.has(cardId)) return;
      if (cardId) activeCardIds.add(cardId);

      const record = {
        cardId: cardId,
        direction: direction,
        boardSource: String(row[2] || "").trim(),
        entityName: String(row[3] || "").trim(),
        transitMode: String(row[4] || "Standard / Ground").trim(),
        scheduledDate: formatSafeDate(row[5]),
        listStatus: String(row[6] || "").trim(),
        summary: String(row[7] || "").trim(),
        masterTracking: cleanTrk(row[8]),
        rollupStatus: String(row[9] || "PENDING").trim().toUpperCase(),
        readyToShipDate: formatSafeDate(row[10]),
        readyToShipBasis: String(row[11] || "").trim().toUpperCase(),
        etaDate: formatSafeDate(row[12]),
        etaBasis: String(row[13] || "").trim().toUpperCase(),
        dateState: String(row[14] || "").trim().toUpperCase(),
        portOfArrival: String(row[15] || "").trim(),
        etaOverridden: String(row[17] || "").trim().toUpperCase() === "MANUAL"
      };

      if (record.listStatus === "Archived/Deleted" || record.rollupStatus === "ARCHIVED/DELETED") return;
      if (record.summary.indexOf(PORTAL_IGNORED_MARKER) === 0) return;

      if (direction.toUpperCase() === "INBOUND") {
        result.inbound.push(record);
      } else {
        result.outbound.push(record);
      }
    });
  }

  const histData = await SS_API.getSheetValues("Shipment_History!A:K");
  if (histData && histData.length >= 2) {
    const recentHist = histData.slice(1).slice(-150); 
    recentHist.forEach(row => {
      const cardId = String(row[1] || "").trim();
      const direction = String(row[2] || "Outbound").trim();
      if (!cardId && !row[4]) return;
      if (cardId && activeCardIds.has(cardId)) return; 
      
      if (cardId) activeCardIds.add(cardId);

      const record = {
        cardId: cardId,
        direction: direction,
        boardSource: String(row[3] || "").trim(),
        entityName: String(row[4] || "").trim(),
        transitMode: String(row[5] || "Standard / Ground").trim(),
        scheduledDate: formatSafeDate(row[6]),
        listStatus: String(row[7] || "").trim(),
        summary: String(row[8] || "").trim(),
        masterTracking: cleanTrk(row[9]),
        rollupStatus: row[10] ? String(row[10]).trim().toUpperCase() : (direction.toUpperCase() === 'INBOUND' ? 'RECEIVED AND DROPS OFF' : 'DELIVERED'),
        historical: true
      };

      if (record.listStatus === "Archived/Deleted" || record.rollupStatus === "ARCHIVED/DELETED") return;
      if (record.summary.indexOf(PORTAL_IGNORED_MARKER) === 0) return; 

      if (direction.toUpperCase() === "INBOUND") {
        result.inbound.push(record);
      } else {
        result.outbound.push(record);
      }
    });
  }

  return result;
}

/**
 * ============================================================================
 * SECTION 2: CORE WAREHOUSE INVENTORY, AUDIT & HTS RETRIEVAL SERVICES
 * ============================================================================
 */

async function getAllInventory() {
  try {
    const data = await SS_API.getSheetValues("Inventory!A:F");
    if (!data || data.length < 2) return [];
    
    return data.slice(1).map((row, idx) => [
      row[0],              
      row[1] || "Vacant",   
      row[2] || 0,          
      row[3] || "Open",     
      row[4] || "None",     
      row[5] || "",
      idx + 2
    ]).filter(row => row[0] && row[0].toString().trim() !== "");
  } catch (e) { 
    logger.error("getAllInventory error", { error: e.toString() });
    return null; 
  }
}

async function getInventoryTotals() {
  try {
    const data = await getAllInventory();
    if (!data) return [];
    const totalsMap = {};
    
    data.forEach(row => {
      if (!row[1] || row[1] === "Vacant") return;
      
      if (row[5] && row[5].toString().includes('_SYS_')) {
         try {
            const sysData = JSON.parse(row[5].toString().split('_SYS_')[1].trim());
            if (sysData.t === 'B') return; 
         } catch(e){}
      }

      const rawSku = row[1].toString().trim();
      const skuKey = rawSku.toUpperCase();
      const qty = Number(row[2]) || 0; 
      const status = row[3] ? row[3].toString().trim() : "Open";
      const softKit = row[4] ? row[4].toString().trim() : "None";
      const locUpper = row[0].toString().toUpperCase().trim();

      if (!totalsMap[skuKey]) {
         totalsMap[skuKey] = { sku: rawSku, cis: 0, timing: 0, rtf: 0, limbo: 0, available: 0, committed: 0, staged: 0 };
      }

      if (locUpper.includes("ZONE-BUFFER")) totalsMap[skuKey].limbo += qty;
      else if (locUpper.startsWith("TIMING")) totalsMap[skuKey].timing += qty;
      else if (locUpper.startsWith("RTF")) totalsMap[skuKey].rtf += qty;
      else totalsMap[skuKey].cis += qty;

      if (locUpper.startsWith("TIMING") || locUpper.startsWith("RTF")) return;

      const statusUpper = status.toUpperCase();
      const isOutboundStaging = statusUpper === "STAGING" || statusUpper === "STAGED" || statusUpper === "LABELED";

      if (isOutboundStaging) totalsMap[skuKey].staged += qty;
      else if (softKit !== "None" && softKit !== "") totalsMap[skuKey].committed += qty;
      else totalsMap[skuKey].available += qty;
    });

    return Object.keys(totalsMap).map(key => ({
      sku: totalsMap[key].sku,
      total: totalsMap[key].cis + totalsMap[key].limbo,
      cis: totalsMap[key].cis,
      timing: totalsMap[key].timing,
      rtf: totalsMap[key].rtf,
      available: totalsMap[key].available,
      committed: totalsMap[key].committed,
      staged: totalsMap[key].staged
    })).sort((a, b) => a.sku.localeCompare(b.sku));
  } catch (e) { return []; }
}

async function getAgingData() {
  const cachedJson = getLargeCache_(CACHE_KEY_AGING);
  if (cachedJson) {
    try {
      return JSON.parse(cachedJson);
    } catch (e) {
      logger.warn("Aging cache parse error. Rebuilding from sheet...");
    }
  }
  const agingMap = await buildAgingData_();
  try {
    putLargeCache_(CACHE_KEY_AGING, JSON.stringify(agingMap), CACHE_TTL_AGING_SECONDS);
  } catch (e) {
    logger.warn("Could not warm aging cache: " + e.message);
  }
  return agingMap;
}

async function buildAgingData_() {
  try {
    const data = await SS_API.getSheetValues("Audit_Log!A:H");
    if (!data || data.length < 2) return {};
    const agingMap = {};
    const validActions = ["STOW", "INITIAL_STOW", "PO_RECEIVED", "ADD", "MOVE_IN", "CONVERT_IN", "EXPLODE_ASSEMBLY"];
    data.slice(1).forEach(row => {
      const rawTimestamp = row[0];
      const locId = row[1];
      const logSkuString = row[2] ? row[2].toString().toLowerCase().trim() : "";
      const action = row[3];
      const originalArrivalRaw = row[7];
      if (logSkuString === "") return;
      if (locId && rawTimestamp && validActions.includes(action)) {
        let parsedDate = new Date(rawTimestamp);
        if (parsedDate && !isNaN(parsedDate.getTime())) {
          const key = locId.toUpperCase().trim();
          if (!agingMap[key]) agingMap[key] = [];
          const entry = { date: parsedDate.toISOString(), rawSku: logSkuString };
          if (action === "MOVE_IN" && originalArrivalRaw) {
            const origParsed = new Date(originalArrivalRaw);
            if (origParsed && !isNaN(origParsed.getTime())) entry.originalDate = origParsed.toISOString();
          }
          agingMap[key].push(entry);
        }
      }
    });
    return agingMap;
  } catch (e) { return {}; }
}

async function getTodayAudits() {
  try {
    const logData = await SS_API.getSheetValues("Audit_Log!A:D");
    if (!logData || logData.length < 2) return [];
    
    const tz = "America/New_York";
    const todayStr = new Date().toLocaleDateString("en-US", { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
    const touchedSkus = new Set();
    
    logData.slice(1).forEach(row => {
      if (!row[0] || !row[2] || row[2] === "Vacant") return;
      
      const locId = row[1] ? row[1].toString().toUpperCase() : "";
      
      if (locId.includes("TIMING") || locId.includes("RTF") || locId.includes("ZONE-BUFFER") || locId.includes("OVERFLOW")) return;
      
      const parsedDate = new Date(row[0]);
      if (!isNaN(parsedDate.getTime())) {
        const logDateStr = parsedDate.toLocaleDateString("en-US", { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
        // Hacky string compare due to format variations, ideally use full parsing
        if (logDateStr === todayStr) { 
          touchedSkus.add(row[2].toString().replace(/(\r\n|\n|\r)/gm, "").trim().toUpperCase()); 
        }
      }
    });
    
    if (touchedSkus.size === 0) return [];
    
    const totals = await getInventoryTotals();
    const todayList = [];
    
    touchedSkus.forEach(sku => {
      const match = totals.find(t => t.sku.toUpperCase() === sku);
      if (match && match.cis > 0) todayList.push({ sku: match.sku, qty: match.cis }); 
    });
    
    return todayList;
  } catch (e) { return []; }
}

async function getProductList() {
  try {
    const data = await SS_API.getSheetValues("PRODUCT!A:A");
    if (!data || data.length < 2) return [];
    return [...new Set(data.slice(1).map(row => row[0]).filter(String))];
  } catch (e) { return []; }
}

async function getProductMap() {
  try {
    const data = await SS_API.getSheetValues("PRODUCT!A:C");
    if (!data || data.length < 2) return {};
    let productMap = {};
    data.slice(1).forEach(row => {
      if (row[0]) {
        productMap[row[0].toString().trim()] = {
          nickname: row[1] ? row[1].toString().trim() : row[0].toString().trim(),
          barcode: row[2] ? row[2].toString().trim() : ""
        };
      }
    });
    return productMap;
  } catch (e) { return {}; }
}

async function getCustomerRegistry() {
  try {
    const data = await SS_API.getSheetValues("CUSTOMER_REGISTRY!A:G");
    if (!data || data.length < 2) return [];
    return data.slice(1).map(row => ({
      Parent_Account: row[0] ? row[0].toString().trim() : "",
      Brand_ID: row[1] ? row[1].toString().trim() : "",
      Brand_Name: row[2] ? row[2].toString().trim() : "",
      Regex_Aliases: row[3] ? row[3].toString().trim() : "",
      Target_Board_ID: row[4] ? row[4].toString().trim() : "",
      Warehouse_Type: row[5] ? row[5].toString().trim() : "",
      Handling_Type: row[6] ? row[6].toString().trim() : ""
    }));
  } catch (e) { return []; }
}

async function getBrandItemCatalog() {
  try {
    const data = await SS_API.getSheetValues("BRAND_ITEM_CATALOG!A:E");
    if (!data || data.length < 2) return [];
    return data.slice(1).map(row => ({
      Brand_ID: row[0] ? row[0].toString().trim() : "",
      Canonical_SKU: row[1] ? row[1].toString().trim() : "",
      Keywords: row[2] ? row[2].toString().trim() : "",
      Default_Qty: row[3] || 0,
      Label_Color: row[4] ? row[4].toString().trim() : ""
    }));
  } catch (e) { return []; }
}

async function fetchPrecompiledHtsData() {
  try {
    const data = await SS_API.getSheetValues("HTS_Data!A:H");
    if (!data || data.length < 2) return [];
    const tz = "America/New_York";
    return data.slice(1).map(row => ({
      htsCode: row[0], description: row[1], coo: row[2], baseDuty: row[3], sec301: row[4], sec232: row[5], totalDuty: row[6],
      timestamp: row[7] ? new Date(row[7]).toLocaleDateString("en-US", { timeZone: tz }) : "N/A"
    }));
  } catch (e) { return []; }
}

function sanitizeString(str) {
  if (!str) return "";
  return str.toString().toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function getAuditWorklist() {
  try {
    const auditData = await SS_API.getSheetValues("QB_Audits!A:B");
    if (!auditData || auditData.length < 2) return [];

    const activeSkus = [];
    for (let i = 1; i < auditData.length; i++) {
      if (auditData[i][0] && auditData[i][1] !== "DONE") activeSkus.push(auditData[i][0].toString().trim());
    }

    const inventory = await getAllInventory();
    const worklist = [];
    activeSkus.forEach(qbSku => {
      const cleanQBSku = sanitizeString(qbSku);
      const locations = inventory
        .filter(row => {
           const invSku = row[1].toString();
           const cleanInvSku = sanitizeString(invSku);
           return cleanInvSku === cleanQBSku || (cleanInvSku.length > 5 && cleanQBSku.includes(cleanInvSku)) || (cleanQBSku.length > 5 && cleanQBSku.includes(cleanInvSku));
        })
        .map(row => ({ locId: row[0], qty: row[2], status: row[3] || "Open", matchedSku: row[1].toString() }));
      worklist.push({ sku: qbSku, locations: locations });
    });
    return worklist;
  } catch(e) { return []; }
}

async function getHeatmapWindowThresholds() {
  try {
    const data = await SS_API.getSheetValues("PRODUCT!E2:F2");
    if (!data || data.length < 1) return [30, 60]; 
    const minVal = Number(data[0][0]);
    const maxVal = Number(data[0][1]);
    return [(!isNaN(minVal) && minVal > 0) ? minVal : 30, (!isNaN(maxVal) && maxVal > 30) ? maxVal : 60];
  } catch (e) { return [30, 60]; }
}

/**
 * ============================================================================
 * SECTION 4: Trello Card Injectors
 * ============================================================================
 */

function getTrelloInjectorCredentials() {
  const key = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) return null;
  return { key, token };
}

async function getSkuCatalog() {
  try {
    const data = await SS_API.getSheetValues("PRODUCT!A:B") || await SS_API.getSheetValues("Inventory!A:B");
    if (!data || data.length < 2) return { success: true, skus: [] };

    const catalog = [];
    const seen = new Set();
    for (let i = 1; i < data.length; i++) {
      const part = String(data[i][0] || "").trim();
      const desc = String(data[i][1] || "").trim();
      if (part !== '' && !seen.has(part)) {
        seen.add(part);
        catalog.push({ partNumber: part, description: desc || part });
      }
    }
    catalog.sort((a, b) => a.partNumber.localeCompare(b.partNumber));
    return { success: true, skus: catalog };
  } catch (e) { return { success: false, message: 'Error reading SKU catalog: ' + e.message }; }
}

async function getTrelloBoards() {
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing TRELLO_KEY or TRELLO_TOKEN in environment.' };

  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/members/me/boards?fields=name,url&filter=open&key=${creds.key}&token=${creds.token}`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const allBoards = await res.json();
      // TODO: Refactor getBoardMatrix_ to an export or constant here if available.
      // For now returning all boards to prevent breaking, or assume getBoardMatrix is implemented elsewhere.
      allBoards.sort((a, b) => a.name.localeCompare(b.name));
      return { success: true, boards: allBoards };
    } else {
      const text = await res.text();
      return { success: false, message: 'Trello API Error: ' + text };
    }
  } catch (e) { return { success: false, message: 'Fetch Exception: ' + e.message }; }
}

async function getTrelloLists(boardId) {
  if (!boardId) return { success: false, message: 'No Board ID provided.' };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.' };

  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/boards/${boardId}/lists?fields=name&filter=open&key=${creds.key}&token=${creds.token}`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const lists = await res.json();
      return { success: true, lists: lists };
    } else {
      return { success: false, message: 'Trello API Error: ' + await res.text() };
    }
  } catch (e) { return { success: false, message: 'Fetch Exception: ' + e.message }; }
}

async function getTrelloCardsByList(listId) {
  if (!listId) return { success: false, message: 'No List ID provided.' };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.' };

  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/lists/${listId}/cards?fields=name,shortUrl&filter=open&key=${creds.key}&token=${creds.token}`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const cards = await res.json();
      cards.sort((a, b) => a.name.localeCompare(b.name));
      return { success: true, cards: cards };
    } else {
      return { success: false, message: 'Trello API Error: ' + await res.text() };
    }
  } catch (e) { return { success: false, message: 'Fetch Exception: ' + e.message }; }
}

async function createTrelloCard(listId, cardName) {
  if (!listId || !cardName) return { success: false, message: 'Missing List ID or Card Name.' };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.' };

  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards`;
  try {
    const res = await fetch(url, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idList: listId, name: cardName, key: creds.key, token: creds.token })
    });
    if (res.ok) {
      const newCard = await res.json();
      return { success: true, card: newCard };
    } else {
      return { success: false, message: 'Trello API Error: ' + await res.text() };
    }
  } catch (e) { return { success: false, message: 'Create Card Exception: ' + e.message }; }
}

async function moveTrelloCard(cardId, idList, idBoard) {
  if (!cardId || !idList) return { success: false, message: 'Missing Card ID or List ID.' };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.' };

  let url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}?idList=${idList}&key=${creds.key}&token=${creds.token}`;
  if (idBoard) url += `&idBoard=${idBoard}`;

  try {
    const res = await fetch(url, { method: 'put' });
    if (res.ok) return { success: true };
    else return { success: false, message: 'Trello API Error: ' + await res.text() };
  } catch (e) { return { success: false, message: 'Move Card Exception: ' + e.message }; }
}

async function getTrelloCardsByBoard_(boardId, creds) {
  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/boards/${boardId}/cards?fields=name,shortUrl&filter=open&key=${creds.key}&token=${creds.token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Trello API Error fetching board cards: ' + await res.text());
  return await res.json();
}

async function findOrCreatePOCardAndInject(parsedPO) {
  try {
    if (!parsedPO || !parsedPO.poNumber) return { success: false, message: 'Parsed PO is missing a PO number.' };
    if (!parsedPO.lineItems || parsedPO.lineItems.length === 0) return { success: false, message: 'No line items to inject.' };

    const creds = getTrelloInjectorCredentials();
    if (!creds) return { success: false, message: 'Missing Trello credentials.' };

    const boardId = process.env.INBOUND_PO_BOARD_ID || '649c805bad63086ff6689611';
    const poNumber = String(parsedPO.poNumber).trim();
    const poNumberRegex = new RegExp('\\b' + poNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');

    const existingCards = await getTrelloCardsByBoard_(boardId, creds);
    const existingMatch = existingCards.find(c => poNumberRegex.test(c.name || ''));

    if (existingMatch) {
      return {
        success: true, wasExisting: true, requiresManualReview: true, cardId: existingMatch.id, cardUrl: existingMatch.shortUrl,
        message: 'A card for PO #' + poNumber + ' already exists. To avoid accidentally deleting any items already on its checklist, this was not auto-injected — please open it in the Trello Injector to add these items safely.'
      };
    }

    const listsRes = await getTrelloLists(boardId);
    if (!listsRes.success || !listsRes.lists || listsRes.lists.length === 0) return { success: false, message: 'Could not find any open lists.' };
    const orderedList = listsRes.lists.find(l => String(l.name).toUpperCase().includes('ORDERED')) || listsRes.lists[0];

    const cardName = 'PO ' + poNumber + (parsedPO.vendor ? ' - ' + parsedPO.vendor : '');
    const createRes = await createTrelloCard(orderedList.id, cardName);
    if (!createRes.success) return { success: false, message: 'Failed to create Trello card: ' + createRes.message };
    const cardId = createRes.card.id;
    const cardUrl = createRes.card.shortUrl;

    const VALID_TRELLO_LABEL_COLORS = ['green', 'yellow', 'orange', 'red', 'purple', 'blue', 'sky', 'lime', 'pink', 'black'];
    if (parsedPO.labelColor && VALID_TRELLO_LABEL_COLORS.includes(parsedPO.labelColor)) {
      // Stubbing addCardLabel since it is defined elsewhere or missing in this snippet
      try {
        await fetch(`${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/labels`, {
          method: 'post', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ color: parsedPO.labelColor, name: parsedPO.vendor || 'PO', key: creds.key, token: creds.token })
        });
      } catch(e) {}
    }

    const mappedLineItems = parsedPO.lineItems.map(item => ({
      partNumber: item.canonicalSku || item.partNumber || '',
      description: item.catalogDesc || item.description || '',
      qty: item.qty, rcvd: 0, idCheckItem: null
    }));

    const injectRes = await injectPOChecklist(cardId, mappedLineItems);
    if (!injectRes.success) return { success: false, message: 'Card created (' + cardUrl + ') but checklist injection failed: ' + injectRes.message };

    return { success: true, cardId: cardId, cardUrl: cardUrl, wasExisting: false, addedCount: injectRes.count, updatedCount: injectRes.updated };
  } catch (e) { return { success: false, message: 'findOrCreatePOCardAndInject failed: ' + e.message }; }
}

async function injectPOChecklist(cardId, lineItems) {
  if (!cardId || !lineItems) return { success: false, message: 'Invalid card selection or empty line items.' };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.' };

  const checklistId = await getOrCreateInjectorChecklist(cardId, TRELLO_INJECTOR_CONFIG.CHECKLIST_NAME, creds);
  if (!checklistId) return { success: false, message: 'Could not access or create Trello checklist.' };

  const existingRes = await getExistingCardChecklist(cardId);
  const existingItems = existingRes.success ? existingRes.items : [];
  const incomingIds = lineItems.filter(i => i.idCheckItem).map(i => i.idCheckItem);

  let addedCount = 0; let updatedCount = 0; let deletedCount = 0;

  for (const exItem of existingItems) {
    if (!incomingIds.includes(exItem.idCheckItem)) {
      if (exItem.rcvd === 0) {
        if (await deleteChecklistItemInTrello(cardId, exItem.idCheckItem, creds)) deletedCount++;
      }
    }
  }

  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    const partNum = String(item.partNumber || '').trim();
    const desc = String(item.description || '').trim();
    const qty = parseInt(item.qty, 10) || 0;
    const rcvd = parseInt(item.rcvd, 10) || 0;

    if (!partNum && !desc) continue;
    const formattedText = partNum ? `[${partNum}] ${desc} | QTY: ${qty} | RCVD: ${rcvd}` : `${desc} | QTY: ${qty} | RCVD: ${rcvd}`;

    if (item.idCheckItem) {
      if (await updateChecklistItemInTrello(cardId, item.idCheckItem, formattedText, creds)) updatedCount++;
    } else {
      if (await addChecklistItemToInjectorTrello(checklistId, formattedText, creds)) addedCount++;
    }
  }

  return { success: true, count: addedCount, updated: updatedCount, deleted: deletedCount, total: lineItems.length };
}

async function getOrCreateInjectorChecklist(cardId, targetName, creds) {
  const getUrl = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/checklists?key=${creds.key}&token=${creds.token}`;
  try {
    const getRes = await fetch(getUrl);
    if (getRes.ok) {
      const checklists = await getRes.json();
      const match = checklists.find(cl => cl.name.toLowerCase() === targetName.toLowerCase());
      if (match) return match.id;
    }
  } catch (e) {}

  const postUrl = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/checklists`;
  try {
    const postRes = await fetch(postUrl, {
      method: 'post', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: targetName, key: creds.key, token: creds.token })
    });
    if (postRes.ok) return (await postRes.json()).id;
  } catch (e) {}
  return null;
}

async function addChecklistItemToInjectorTrello(checklistId, itemText, creds) {
  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/checklists/${checklistId}/checkItems`;
  try {
    const res = await fetch(url, {
      method: 'post', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: itemText, checked: 'false', key: creds.key, token: creds.token })
    });
    return res.ok;
  } catch (e) { return false; }
}

async function updateChecklistItemInTrello(cardId, idCheckItem, itemText, creds) {
  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/checkItem/${idCheckItem}?key=${creds.key}&token=${creds.token}`;
  try {
    const res = await fetch(url, {
      method: 'put', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: itemText })
    });
    return res.ok;
  } catch (e) { return false; }
}

async function deleteChecklistItemInTrello(cardId, idCheckItem, creds) {
  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/checkItem/${idCheckItem}?key=${creds.key}&token=${creds.token}`;
  try {
    const res = await fetch(url, { method: 'delete' });
    return res.ok;
  } catch (e) { return false; }
}

async function getExistingCardChecklist(cardId) {
  if (!cardId) return { success: false, items: [] };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, items: [] };

  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/checklists?key=${creds.key}&token=${creds.token}`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const checklists = await res.json();
      const poChecklist = checklists.find(cl => cl.name.toLowerCase() === TRELLO_INJECTOR_CONFIG.CHECKLIST_NAME.toLowerCase());
      if (!poChecklist || !poChecklist.checkItems) return { success: true, items: [] };

      const parsedItems = [];
      const regex = /^\s*(?:\[(.*?)\]\s*)?(.*?)\s*\|\s*QTY:\s*(\d+)(?:\s*\|\s*RCVD:\s*(\d+))?/i;

      poChecklist.checkItems.forEach(item => {
        const match = item.name.match(regex);
        if (match) {
          parsedItems.push({
            idCheckItem: item.id, idChecklist: poChecklist.id, originalName: item.name,
            partNumber: (match[1] || '').trim(), description: (match[2] || '').trim(),
            qty: parseInt(match[3], 10), rcvd: match[4] ? parseInt(match[4], 10) : 0, state: item.state
          });
        } else {
          parsedItems.push({
            idCheckItem: item.id, idChecklist: poChecklist.id, originalName: item.name,
            partNumber: '', description: item.name, qty: 1, rcvd: 0, state: item.state
          });
        }
      });
      return { success: true, items: parsedItems };
    }
  } catch (e) { logger.warn('Error reading existing checklist: ' + e.message); }
  return { success: true, items: [] };
}

module.exports = {
  getLogisticsDashboardData,
  warmLogisticsDashboardCache,
  getAllInventory,
  getInventoryTotals,
  getAgingData,
  getTodayAudits,
  getProductList,
  getProductMap,
  getCustomerRegistry,
  getBrandItemCatalog,
  fetchPrecompiledHtsData,
  getAuditWorklist,
  getHeatmapWindowThresholds,
  getSkuCatalog,
  getTrelloBoards,
  getTrelloLists,
  getTrelloCardsByList,
  createTrelloCard,
  moveTrelloCard,
  findOrCreatePOCardAndInject,
  injectPOChecklist,
  getExistingCardChecklist
};
