const SS_API = require('./Service_SheetsAPI');
const { logger } = require('firebase-functions');
const config = require('../config');
const {
  trelloCreds_,
  trelloFetch_,
  getBoardMatrix_,
  parseSysBlob_,
  PORTAL_IGNORED_MARKER
} = require('./Shared_Classifiers');

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
const CACHE_KEY_SKU_LAST_UPDATED = "SKU_LAST_UPDATED_PAYLOAD_V1";
const CACHE_TTL_SKU_LAST_UPDATED_SECONDS = 300;
const BUILD_VERSION = "2026-08-13.1-NODEJS";

// Imported, never re-declared. This was a local literal spelled
// "PORTAL_IGNORED_MARKER" while the real marker is "[PORTAL_IGNORED]", so the
// dashboard's ignore filter matched nothing and every .ignore'd card kept
// showing. See isCardIgnored_ in Shared_Classifiers.js.

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
      
      const sysData = parseSysBlob_(row[5], 'Inventory row (getInventoryTotals)');
      if (sysData && sysData.t === 'B') return;

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
    // Only ARRIVAL events are valid age anchors -- SET_TOTAL / REMOVE /
    // MOVE_OUT / VERIFIED / CONVERT_OUT are excluded deliberately, because
    // "how old is the stock here" is not "when did someone last touch it".
    //
    // TWO NAMES IN THIS LIST WERE WRONG IN THIS PORT (fixed 2026-08-28):
    //
    //  - "EXPLODE_ASSEMBLY" is a string NOTHING EVER WRITES. Every explode path
    //    in Service_Assembly.js logs "EXPLODE_RESTORE" (:183, :200, :209), which
    //    is also what SRC lists here. So every component row an explode returned
    //    to the floor had no anchor at all and its location read as unknown age
    //    on the heatmap.
    //  - "SPLIT_IN" was missing entirely. splitInventoryRow mints a brand-new
    //    Inventory row, so a location holding ONLY split-off rows had no anchor
    //    either. Like MOVE_IN it carries the lot's TRUE arrival date in column
    //    H, honoured by the branch below -- so it anchors the row without
    //    resetting the dwell clock to the moment of the split.
    //
    // Matches SRC/src/Service_Read.js:622.
    const validActions = ["STOW", "INITIAL_STOW", "PO_RECEIVED", "ADD", "MOVE_IN", "SPLIT_IN", "CONVERT_IN", "EXPLODE_RESTORE"];
    data.slice(1).forEach(row => {
      const rawTimestamp = row[0];
      const locId = row[1];
      const logSkuString = row[2] ? row[2].toString().toLowerCase().trim() : "";
      const action = row[3];
      const originalArrivalRaw = row[7];
      // A blank SKU cell matches every SKU downstream (calculateInventoryAgeDays'
      // two-way substring test: "".includes(x) and x.includes("") are both always
      // true) -- skip these so a blank row can't act as a wildcard anchor for
      // whatever SKU last happened to occupy the location. Confirmed live: ~0.8%
      // of Audit_Log rows, concentrated in ADD (16%).
      if (logSkuString === "") return;
      if (locId && rawTimestamp && validActions.includes(action)) {
        let parsedDate = new Date(rawTimestamp);
        if (parsedDate && !isNaN(parsedDate.getTime())) {
          const key = locId.toUpperCase().trim();
          if (!agingMap[key]) agingMap[key] = [];
          const entry = { date: parsedDate.toISOString(), rawSku: logSkuString };
          if ((action === "MOVE_IN" || action === "SPLIT_IN") && originalArrivalRaw) {
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
          // The sheet's own column-A text, carried on the entry so callers that
          // reach an entry through an uppercased or nickname-keyed index can
          // still recover the canonical Product ID exactly as written -- needed
          // by resolveCanonicalProductId_ (Shared_Classifiers.js), which decides
          // what goes in Inventory's SKU column. Without this field that
          // function silently falls through to the nickname, which is the exact
          // identity drift it exists to prevent.
          productId: row[0].toString().trim(),
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
  const { key, token } = trelloCreds_();
  if (!key || !token) return null;
  return { key, token };
}

/**
 * The inbound Purchase Orders board. SRC/src/Service_Read.js:1396.
 * @return {string}
 */
function getInboundPoBoardId_() {
  return config.get('INBOUND_PO_BOARD_ID');
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
    const res = await trelloFetch_(url);
    if (res.ok) {
      // Filtered to the 4 boards in the matrix, matching SRC. Returning every
      // board the token can see (what this did before Shared_Classifiers was
      // ported) puts boards the sync pipeline knows nothing about into the
      // injector's picker -- a card created on one of them is invisible to
      // everything downstream. See SCHEMA section 2.
      const allBoards = JSON.parse(res.text);
      const knownIds = getBoardMatrix_().map(b => b.id);
      const boards = allBoards.filter(b => knownIds.indexOf(b.id) !== -1);
      boards.sort((a, b) => a.name.localeCompare(b.name));
      return { success: true, boards: boards };
    } else {
      const text = res.text;
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
    const res = await trelloFetch_(url);
    if (res.ok) {
      const lists = JSON.parse(res.text);
      return { success: true, lists: lists };
    } else {
      return { success: false, message: 'Trello API Error: ' + res.text };
    }
  } catch (e) { return { success: false, message: 'Fetch Exception: ' + e.message }; }
}

async function getTrelloCardsByList(listId) {
  if (!listId) return { success: false, message: 'No List ID provided.' };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.' };

  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/lists/${listId}/cards?fields=name,shortUrl&filter=open&key=${creds.key}&token=${creds.token}`;
  try {
    const res = await trelloFetch_(url);
    if (res.ok) {
      const cards = JSON.parse(res.text);
      cards.sort((a, b) => a.name.localeCompare(b.name));
      return { success: true, cards: cards };
    } else {
      return { success: false, message: 'Trello API Error: ' + res.text };
    }
  } catch (e) { return { success: false, message: 'Fetch Exception: ' + e.message }; }
}

async function createTrelloCard(listId, cardName) {
  if (!listId || !cardName) return { success: false, message: 'Missing List ID or Card Name.' };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.' };

  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards`;
  try {
    const res = await trelloFetch_(url, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idList: listId, name: cardName, key: creds.key, token: creds.token })
    });
    if (res.ok) {
      const newCard = JSON.parse(res.text);
      return { success: true, card: newCard };
    } else {
      return { success: false, message: 'Trello API Error: ' + res.text };
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
    const res = await trelloFetch_(url, { method: 'put' });
    if (res.ok) return { success: true };
    else return { success: false, message: 'Trello API Error: ' + res.text };
  } catch (e) { return { success: false, message: 'Move Card Exception: ' + e.message }; }
}

async function getTrelloCardsByBoard_(boardId, creds) {
  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/boards/${boardId}/cards?fields=name,shortUrl&filter=open&key=${creds.key}&token=${creds.token}`;
  const res = await trelloFetch_(url);
  if (!res.ok) throw new Error('Trello API Error fetching board cards: ' + res.text);
  return JSON.parse(res.text);
}

/**
 * @param {Object} parsedPO the parsed PO (poNumber, vendor, lineItems).
 * @param {string} [idLabel] an explicit label id picked in the ingest UI's
 *   Customer Label dropdown. SRC/src/Service_Read.js:1211 takes this as its
 *   second argument and TrelloInjector.html:786 passes it; the port had
 *   dropped it.
 * @return {Promise<Object>} {success, cardId, cardUrl, ...} or
 *   {success:false, message}.
 */
async function findOrCreatePOCardAndInject(parsedPO, idLabel) {
  try {
    if (!parsedPO || !parsedPO.poNumber) return { success: false, message: 'Parsed PO is missing a PO number.' };
    if (!parsedPO.lineItems || parsedPO.lineItems.length === 0) return { success: false, message: 'No line items to inject.' };

    const creds = getTrelloInjectorCredentials();
    if (!creds) return { success: false, message: 'Missing Trello credentials.' };

    const boardId = getInboundPoBoardId_();
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

    // Tag the new card with one of the board's EXISTING labels rather than
    // minting a new one -- boards accumulate their own label vocab/casing over
    // time (confirmed 2026-08-21: the Purchase Orders board already carries
    // both "BURLINGTON INVENTORY" and a typo'd "BURLINTON INVENTORY" as
    // separate labels), so blindly creating a label named after the vendor
    // produced near-duplicates like a fresh "Nordstrom" next to the board's
    // real "NORDSTROM". Priority: (1) idLabel, an explicit pick from the
    // ingest UI's Customer Label dropdown, (2) an existing board label whose
    // name matches the resolved vendor exactly (case-insensitive). No match on
    // either -> leave the card unlabeled; someone applies the right label by
    // hand rather than growing the board's label list further.
    //
    // The port had replaced all of this with a POST to /cards/{id}/labels
    // carrying a colour and a name -- i.e. the label-creating behaviour SRC
    // removed -- gated on `parsedPO.labelColor`, a field nothing in the parse
    // path ever sets. Restored to SRC/src/Service_Read.js:1258-1281.
    let resolvedLabelId = idLabel || '';
    if (!resolvedLabelId && parsedPO.vendor) {
      const boardLabels = await getTrelloBoardLabels(boardId);
      if (boardLabels.success) {
        const vendorUpper = String(parsedPO.vendor).trim().toUpperCase();
        const match = boardLabels.labels.find(l => String(l.name).trim().toUpperCase() === vendorUpper);
        if (match) resolvedLabelId = match.id;
      }
    }
    if (resolvedLabelId) {
      const addLabelUrl = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/idLabels?value=${encodeURIComponent(resolvedLabelId)}&key=${creds.key}&token=${creds.token}`;
      await trelloFetch_(addLabelUrl, { method: 'post', muteHttpExceptions: true });
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
    const getRes = await trelloFetch_(getUrl);
    if (getRes.ok) {
      const checklists = JSON.parse(getRes.text);
      const match = checklists.find(cl => cl.name.toLowerCase() === targetName.toLowerCase());
      if (match) return match.id;
    }
  } catch (e) {}

  const postUrl = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/checklists`;
  try {
    const postRes = await trelloFetch_(postUrl, {
      method: 'post', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: targetName, key: creds.key, token: creds.token })
    });
    if (postRes.ok) return (JSON.parse(postRes.text)).id;
  } catch (e) {}
  return null;
}

async function addChecklistItemToInjectorTrello(checklistId, itemText, creds) {
  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/checklists/${checklistId}/checkItems`;
  try {
    const res = await trelloFetch_(url, {
      method: 'post', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: itemText, checked: 'false', key: creds.key, token: creds.token })
    });
    return res.ok;
  } catch (e) { return false; }
}

async function updateChecklistItemInTrello(cardId, idCheckItem, itemText, creds) {
  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/checkItem/${idCheckItem}?key=${creds.key}&token=${creds.token}`;
  try {
    const res = await trelloFetch_(url, {
      method: 'put', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: itemText })
    });
    return res.ok;
  } catch (e) { return false; }
}

async function deleteChecklistItemInTrello(cardId, idCheckItem, creds) {
  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/checkItem/${idCheckItem}?key=${creds.key}&token=${creds.token}`;
  try {
    const res = await trelloFetch_(url, { method: 'delete' });
    return res.ok;
  } catch (e) { return false; }
}

async function getExistingCardChecklist(cardId) {
  if (!cardId) return { success: false, items: [] };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, items: [] };

  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/checklists?key=${creds.key}&token=${creds.token}`;
  try {
    const res = await trelloFetch_(url);
    if (res.ok) {
      const checklists = JSON.parse(res.text);
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

/**
 * ============================================================================
 * SKU "LAST TOUCHED" MAP
 * ============================================================================
 * Deliberately NOT the same signal as buildAgingData_(). Aging answers "how
 * long has this pallet physically sat here", so it counts arrival events only
 * and ignores VERIFIED/adjustment rows. "When was this SKU's inventory last
 * touched" is the opposite question: every action type counts, including those.
 *
 * Keyed by canonical SKU text (uppercased, trimmed) rather than the locId-keyed
 * substring matching calculateInventoryAgeDays() needs -- Audit_Log's sku column
 * is written as the canonical inventoryName at every write site (see
 * receivePOCardItems()), so an exact match is correct and simpler here.
 *
 * Parity with SRC/src/Service_Read.js:667-708.
 *
 * @return {Promise<Object<string, string>>} uppercased SKU -> ISO timestamp.
 */
async function getSkuLastUpdatedMap() {
  const cachedJson = getLargeCache_(CACHE_KEY_SKU_LAST_UPDATED);
  if (cachedJson) {
    try {
      return JSON.parse(cachedJson);
    } catch (e) {
      logger.warn("SKU last-updated cache parse error. Rebuilding from sheet...");
    }
  }
  const map = await buildSkuLastUpdatedMap_();
  try {
    putLargeCache_(CACHE_KEY_SKU_LAST_UPDATED, JSON.stringify(map), CACHE_TTL_SKU_LAST_UPDATED_SECONDS);
  } catch (e) {
    logger.warn("Could not warm SKU last-updated cache: " + e.message);
  }
  return map;
}

/**
 * @return {Promise<Object<string, string>>} uppercased SKU -> newest ISO stamp.
 */
async function buildSkuLastUpdatedMap_() {
  try {
    const data = await SS_API.getSheetValues("Audit_Log!A:C");
    if (!data || data.length < 2) return {};
    const map = {};
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rawTimestamp = row[0];
      const sku = row[2] ? row[2].toString().trim() : "";
      if (!sku || !rawTimestamp) continue;
      const parsedDate = (rawTimestamp instanceof Date) ? rawTimestamp : new Date(Date.parse(rawTimestamp));
      if (isNaN(parsedDate.getTime())) continue;
      const key = sku.toUpperCase();
      const iso = parsedDate.toISOString();
      if (!map[key] || iso > map[key]) map[key] = iso;
    }
    return map;
  } catch (e) {
    logger.error("buildSkuLastUpdatedMap_ error", { error: e.message });
    return {};
  }
}

/**
 * ============================================================================
 * TRELLO LABEL MANAGEMENT (TrelloInjector)
 * ============================================================================
 */

/**
 * A board's actual existing labels (id/name/color), live from Trello -- used so
 * the Injector can attach a card to a label the board already has instead of
 * minting a new near-duplicate one.
 *
 * Parity with SRC/src/Service_Read.js:1406-1424.
 *
 * @param {string} boardId
 * @return {Promise<{success: boolean, labels: Array<Object>, message?: string}>}
 */
async function getTrelloBoardLabels(boardId) {
  if (!boardId) return { success: false, message: 'No Board ID provided.', labels: [] };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.', labels: [] };

  try {
    const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/boards/${boardId}/labels?fields=name,color&limit=1000&key=${creds.key}&token=${creds.token}`;
    const res = await trelloFetch_(url, { method: 'get' }, { label: 'board labels' });
    if (!res.ok) {
      return { success: false, message: 'Trello API error: ' + res.getContentText(), labels: [] };
    }
    const labels = JSON.parse(res.text)
        .filter(l => l.name)
        .sort((a, b) => a.name.localeCompare(b.name));
    return { success: true, labels: labels };
  } catch (e) {
    return { success: false, message: 'getTrelloBoardLabels failed: ' + e.message, labels: [] };
  }
}

/**
 * Convenience wrapper for the PO Ingest modal's Customer Label dropdown, which
 * always targets the fixed inbound PO board (same default as
 * findOrCreatePOCardAndInject) and has no board picker of its own to read a
 * board ID from client-side.
 *
 * @return {Promise<{success: boolean, labels: Array<Object>, message?: string}>}
 */
async function getInboundPoBoardLabels() {
  return getTrelloBoardLabels(getInboundPoBoardId_());
}

/**
 * The labels currently attached to a specific card -- used to pre-check the
 * main Injector's Card Labels checkbox list when a card is selected.
 *
 * Parity with SRC/src/Service_Read.js:1441-1458.
 *
 * @param {string} cardId
 * @return {Promise<{success: boolean, labels: Array<Object>, message?: string}>}
 */
async function getCardLabels(cardId) {
  if (!cardId) return { success: false, message: 'No Card ID provided.', labels: [] };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.', labels: [] };

  try {
    const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/labels?fields=name,color&key=${creds.key}&token=${creds.token}`;
    const res = await trelloFetch_(url, { method: 'get' }, { label: 'card labels' });
    if (!res.ok) {
      return { success: false, message: 'Trello API error: ' + res.getContentText(), labels: [] };
    }
    return { success: true, labels: JSON.parse(res.text) };
  } catch (e) {
    return { success: false, message: 'getCardLabels failed: ' + e.message, labels: [] };
  }
}

/**
 * Syncs a card's labels to exactly the given set of label IDs -- backs the main
 * Injector's manual Card Labels checkbox list. Diffs against the card's current
 * labels (via getCardLabels()) so only what actually changed makes an API call,
 * rather than a blind clear-then-reapply.
 *
 * Unlike SRC this reports per-call failures rather than assuming each write
 * landed: every one of these goes through trelloFetch_, so a 429 is already
 * retried, and what survives that is a real failure worth surfacing.
 *
 * Parity with SRC/src/Service_Read.js:1464-1490.
 *
 * @param {string} cardId
 * @param {Array<string>} labelIds
 * @return {Promise<Object>}
 */
async function updateCardLabels(cardId, labelIds) {
  if (!cardId) return { success: false, message: 'No Card ID provided.' };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.' };

  const desired = Array.isArray(labelIds) ? labelIds : [];
  const currentRes = await getCardLabels(cardId);
  if (!currentRes.success) return { success: false, message: currentRes.message };

  const currentIds = currentRes.labels.map(l => l.id);
  const toAdd = desired.filter(id => !currentIds.includes(id));
  const toRemove = currentIds.filter(id => !desired.includes(id));

  try {
    const failed = [];

    for (const id of toAdd) {
      const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/idLabels?value=${encodeURIComponent(id)}&key=${creds.key}&token=${creds.token}`;
      const res = await trelloFetch_(url, { method: 'post' }, { label: 'add card label' });
      if (!res.ok) failed.push({ id: id, action: 'add', reason: res.error || ('HTTP ' + res.code) });
    }
    for (const id of toRemove) {
      const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}/idLabels/${id}?key=${creds.key}&token=${creds.token}`;
      const res = await trelloFetch_(url, { method: 'delete' }, { label: 'remove card label' });
      if (!res.ok) failed.push({ id: id, action: 'remove', reason: res.error || ('HTTP ' + res.code) });
    }

    if (failed.length > 0) {
      return {
        success: false,
        message: failed.length + ' label change(s) failed on Trello.',
        failed: failed,
        added: toAdd.length - failed.filter(f => f.action === 'add').length,
        removed: toRemove.length - failed.filter(f => f.action === 'remove').length
      };
    }
    return { success: true, added: toAdd.length, removed: toRemove.length };
  } catch (e) {
    return { success: false, message: 'updateCardLabels failed: ' + e.message };
  }
}

/**
 * Deep link to the standalone Injector page.
 *
 * SRC returns `ScriptApp.getService().getUrl() + '?page=injector'` -- the Apps
 * Script web-app URL, which the runtime knows about itself. Cloud Functions has
 * no equivalent: the backend does not know the Hosting domain it is served
 * behind. So this derives the origin from the incoming request when one is
 * passed, and otherwise falls back to the PORTAL_BASE_URL config key.
 *
 * @param {Object} [req] Express request, to derive the origin from.
 * @return {{success: boolean, url?: string, message?: string}}
 */
function getInjectorUrl(req) {
  const configured = config.get('PORTAL_BASE_URL');
  let base = configured ? String(configured).replace(/\/+$/, '') : '';

  if (!base && req && typeof req.get === 'function') {
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = req.get('x-forwarded-proto') || 'https';
    if (host) base = proto + '://' + host;
  }

  if (!base) {
    return {
      success: false,
      message: 'Cannot resolve the portal URL. Set PORTAL_BASE_URL, or call this ' +
               'with the request so the origin can be derived from it.'
    };
  }
  return { success: true, url: base + '/?page=injector' };
}

/**
 * ============================================================================
 * TRELLO PO CHECKLIST INJECTOR - SHIPPING REFERENCE # (freight/carrier ref)
 * ============================================================================
 * Stored as a single "Shipping Ref #: <value>" line in the card's description,
 * not the checklist or a comment, so there is exactly one place to read/update
 * it and it stays out of the line-item parsing regex. This is intentionally a
 * standalone action, separate from line-item injection: unlike PO line items
 * (known at order time), a freight/carrier reference number is usually only
 * handed over weeks or months later, once the supplier actually ships -- often
 * long after the original PO card was created. Formatted as a distinct labeled
 * line so it can be regex-parsed later for a carrier-integration (e.g. RXO)
 * lookup, the same way harvestFedExTrackingNumber() already harvests outbound
 * FedEx tracking numbers out of card text.
 * ============================================================================
 */

/**
 * Reads the current Shipping Ref # (if any) off a card's description, to
 * pre-fill the Injector's optional field when a card is selected.
 *
 * Parity with SRC/src/Service_Read.js:1666-1684.
 *
 * @param {string} cardId
 * @return {Promise<{success: boolean, reference?: string, message?: string}>}
 */
async function getCardShippingReference(cardId) {
  if (!cardId) return { success: false, message: 'No Card ID provided.' };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.' };

  const url = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}?fields=desc&key=${creds.key}&token=${creds.token}`;

  try {
    const res = await trelloFetch_(url, { method: 'get' }, { label: 'card description' });
    if (!res.ok) {
      return { success: false, message: 'Trello API Error: ' + res.getContentText() };
    }
    const desc = JSON.parse(res.text).desc || '';
    const match = desc.match(/^Shipping Ref #:\s*(.+)$/mi);
    return { success: true, reference: match ? match[1].trim() : '' };
  } catch (e) {
    return { success: false, message: 'Fetch Exception: ' + e.message };
  }
}

/**
 * Sets, updates, or clears (blank referenceNumber) the "Shipping Ref #:" line
 * in a card's description, leaving the rest of the description intact.
 *
 * Parity with SRC/src/Service_Read.js:1690-1729, with one necessary change:
 * SRC passes `payload: { desc: newDesc }`, which UrlFetchApp form-encodes.
 * Node's fetch does not do that, so the body is sent as JSON with an explicit
 * Content-Type -- which Trello accepts for PUT /1/cards/{id}. Sending the
 * description as a query parameter instead was rejected on purpose: a long
 * description would blow the URL length limit, and it would put free card text
 * into a URL that ends up in logs.
 *
 * @param {string} cardId
 * @param {string} referenceNumber blank to clear.
 * @return {Promise<{success: boolean, reference?: string, message?: string}>}
 */
async function setCardShippingReference(cardId, referenceNumber) {
  if (!cardId) return { success: false, message: 'No Card ID provided.' };
  const creds = getTrelloInjectorCredentials();
  if (!creds) return { success: false, message: 'Missing Trello credentials.' };

  const getUrl = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}?fields=desc&key=${creds.key}&token=${creds.token}`;

  try {
    const getRes = await trelloFetch_(getUrl, { method: 'get' }, { label: 'card description' });
    if (!getRes.ok) {
      return { success: false, message: 'Trello API Error: ' + getRes.getContentText() };
    }
    const currentDesc = JSON.parse(getRes.text).desc || '';
    const cleanRef = String(referenceNumber || '').trim();

    // Strip any existing "Shipping Ref #:" line (and trailing blank lines), then
    // re-append the new value unless clearing, so there is always at most one
    // such line.
    const otherLines = currentDesc.split(/\r?\n/).filter(l => !/^Shipping Ref #:/i.test(l.trim()));
    while (otherLines.length && otherLines[otherLines.length - 1].trim() === '') otherLines.pop();

    let newDesc = otherLines.join('\n');
    if (cleanRef) {
      newDesc = newDesc ? newDesc + '\n\nShipping Ref #: ' + cleanRef : 'Shipping Ref #: ' + cleanRef;
    }

    const putUrl = `${TRELLO_INJECTOR_CONFIG.BASE_URL}/cards/${cardId}?key=${creds.key}&token=${creds.token}`;
    const putRes = await trelloFetch_(putUrl, {
      method: 'put',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desc: newDesc })
    }, { label: 'set shipping reference' });

    if (putRes.ok) return { success: true, reference: cleanRef };
    return { success: false, message: 'Trello API Error: ' + putRes.getContentText() };
  } catch (e) {
    return { success: false, message: 'Update Exception: ' + e.message };
  }
}

module.exports = {
  // Exported for test/parity_Aging.js. The heatmap's age anchors are derived
  // here and nowhere else, and two of the action names in its validActions list
  // were wrong in this port -- so the derivation is worth pinning against SRC.
  buildAgingData_,
  getInboundPoBoardId_,
  getSkuLastUpdatedMap,
  buildSkuLastUpdatedMap_,
  getTrelloBoardLabels,
  getInboundPoBoardLabels,
  getCardLabels,
  updateCardLabels,
  getInjectorUrl,
  getCardShippingReference,
  setCardShippingReference,
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
