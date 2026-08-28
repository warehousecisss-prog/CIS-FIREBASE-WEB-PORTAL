const SS_API = require('./Service_SheetsAPI');
const { logger } = require('firebase-functions');

const SHIPMENTS_COL = {
  CARD_ID: 0, DIRECTION: 1, BOARD_SOURCE: 2, ENTITY: 3, TRANSIT_MODE: 4,
  SCHEDULED_DATE: 5, LIST_STATUS: 6, LINE_ITEMS: 7, MASTER_TRACKING: 8,
  ROLLUP_STATUS: 9,
  RTS_DATE: 10, RTS_BASIS: 11, ETA_DATE: 12, ETA_BASIS: 13, DATE_STATE: 14,
  PORT_OF_ARRIVAL: 15, LAST_AUTO_DUE: 16, ETA_OVERRIDDEN: 17
};

const DATE_STATES = {
  NO_DATES: "NO_DATES",
  RTS_ESTIMATED: "RTS_ESTIMATED",
  RTS_CONFIRMED: "RTS_CONFIRMED",
  IN_TRANSIT: "IN_TRANSIT",
  ARRIVED: "ARRIVED"
};

const RTS_BASES = ["ESTIMATE", "SUPPLIER_CONFIRMED", "ACTUAL"];

const TRANSIT_LEAD_DAYS = [
  { key: "ocean",  days: 38 },
  { key: "sea",    days: 38 },
  { key: "air",    days: 6 },
  { key: "fedex",  days: 3 },
  { key: "ups",    days: 3 },
  { key: "ground", days: 4 },
  { key: "truck",  days: 4 },
  { key: "ltl",    days: 5 }
];
const DEFAULT_LEAD_DAYS = 14; 

function leadTimeDaysForMode_(transitMode) {
  const mode = String(transitMode || "").toLowerCase();
  if (!mode) return DEFAULT_LEAD_DAYS;
  for (let i = 0; i < TRANSIT_LEAD_DAYS.length; i++) {
    if (mode.indexOf(TRANSIT_LEAD_DAYS[i].key) !== -1) return TRANSIT_LEAD_DAYS[i].days;
  }
  return DEFAULT_LEAD_DAYS;
}

const PORT_GROUPS_FALLBACK = {
  LA:    { aliases: ["LA", "LAX", "LONG BEACH", "LONGBEACH", "LOS ANGELES"], pickupDays: 5, portToPortDays: 20, customsDeliveryDays: 14, label: "Los Angeles / Long Beach" },
  MIAMI: { aliases: ["MIAMI"], pickupDays: 5, portToPortDays: 35, customsDeliveryDays: 7, label: "Miami" }
};

const PORT_LABEL_TO_GROUP_KEY = {
  "MIAMI": "MIAMI",
  "LONG BEACH": "LA",
  "LAX": "LA",
  "LOS ANGELES": "LA"
};

const CONFIG_PORT_LEG_FIELDS = {
  "ESTIMATED DEPARTURE": "pickupDays",
  "PORT TO PORT": "portToPortDays",
  "CLEARANCE, DELIVERY": "customsDeliveryDays"
};

let _portGroupsCache = null;

async function getPortGroups_() {
  if (_portGroupsCache) return _portGroupsCache;

  try {
    const data = await SS_API.getSheetValues("Config!A:C");
    if (!data) throw new Error("Config sheet not found");

    const groups = {}; 

    data.forEach(row => {
      const portLabelRaw = String(row[0] || "").trim();
      const legNameRaw = String(row[1] || "").trim().toUpperCase();
      const valueRaw = String(row[2] || "").trim();
      if (!portLabelRaw || !legNameRaw || !valueRaw) return;

      const legField = CONFIG_PORT_LEG_FIELDS[legNameRaw];
      if (!legField) return; 

      const days = parseInt(valueRaw, 10);
      if (isNaN(days)) {
        logger.warn("getPortGroups_: could not parse a day count out of \"" + valueRaw + "\" for " + portLabelRaw + " / " + legNameRaw + " — skipping this row.");
        return;
      }

      const portLabelUpper = portLabelRaw.toUpperCase();
      const groupKey = PORT_LABEL_TO_GROUP_KEY[portLabelUpper] || portLabelUpper;

      if (!groups[groupKey]) {
        groups[groupKey] = {
          aliases: new Set(),
          pickupDays: null, portToPortDays: null, customsDeliveryDays: null,
          label: groupKey === "LA" ? "Los Angeles / Long Beach" : portLabelRaw
        };
      }
      const g = groups[groupKey];
      g.aliases.add(portLabelUpper);

      if (g[legField] !== null && g[legField] !== days) {
        return;
      }
      g[legField] = days;
    });

    if (groups.LA) groups.LA.aliases.add("LA");

    const result = {};
    Object.keys(groups).forEach(key => {
      const g = groups[key];
      if (g.pickupDays === null || g.portToPortDays === null || g.customsDeliveryDays === null) return;
      result[key] = {
        aliases: Array.from(g.aliases),
        pickupDays: g.pickupDays,
        portToPortDays: g.portToPortDays,
        customsDeliveryDays: g.customsDeliveryDays,
        label: g.label
      };
    });

    if (Object.keys(result).length === 0) throw new Error("Config port table produced zero complete groups");

    _portGroupsCache = result;
  } catch (e) {
    logger.warn("getPortGroups_: falling back to hardcoded PORT_GROUPS_FALLBACK — " + e.message);
    _portGroupsCache = PORT_GROUPS_FALLBACK;
  }

  return _portGroupsCache;
}

async function classifyPortGroup_(portText) {
  const upper = String(portText || "").toUpperCase().trim();
  if (!upper) return null;
  const groups = await getPortGroups_();
  for (const key in groups) {
    if (groups[key].aliases.indexOf(upper) !== -1) return key;
  }
  for (const key in groups) {
    if (groups[key].aliases.some(function(a) { return upper.indexOf(a) !== -1; })) return key;
  }
  return null;
}

function parseDateCell_(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const parsed = new Date(Date.parse(String(value)));
  return isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateCell_(date) {
  if (!date) return "";
  const pad = (n) => n.toString().padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`;
}

function addDays_(date, days) {
  const out = new Date(date.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

function addBusinessDays_(date, days) {
  const out = new Date(date.getTime());
  let added = 0;
  while (added < days) {
    out.setDate(out.getDate() + 1);
    const dow = out.getDay(); // 0 = Sunday, 6 = Saturday
    if (dow !== 0 && dow !== 6) added++;
  }
  return out;
}

async function addPortGroupLeadTime_(date, groupKey) {
  const groups = await getPortGroups_();
  const g = groups[groupKey];
  if (!g) return date;
  let out = addBusinessDays_(date, g.pickupDays);
  out = addDays_(out, g.portToPortDays);
  out = addBusinessDays_(out, g.customsDeliveryDays);
  return out;
}

async function estimateShippingWindow(readyDateStr, portText, transitMode) {
  try {
    const readyDate = parseDateCell_(readyDateStr);
    if (!readyDate) return { success: false, error: "Enter a valid ready-to-ship date." };

    const groupKey = await classifyPortGroup_(portText);
    let etaDate, basisNote;

    if (groupKey) {
      const groups = await getPortGroups_();
      const g = groups[groupKey];
      etaDate = await addPortGroupLeadTime_(readyDate, groupKey);
      basisNote = "Port-specific lead time (" + g.label + "): " + g.pickupDays +
        " business day(s) to departure, " + g.portToPortDays +
        " calendar day(s) port-to-port, " + g.customsDeliveryDays +
        " business day(s) customs/delivery.";
    } else {
      const days = leadTimeDaysForMode_(transitMode);
      etaDate = addDays_(readyDate, days);
      basisNote = portText
        ? "Port \"" + portText + "\" isn't a recognized port group — used the generic " +
          (transitMode || "default") + " lead time (" + days + " calendar days) instead."
        : "No port entered — used the generic " + (transitMode || "default") +
          " lead time (" + days + " calendar days).";
    }

    return {
      success: true,
      readyDate: formatDateCell_(readyDate),
      etaDate: formatDateCell_(etaDate),
      basisNote: basisNote
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const TRANSIT_TIME_SHEET = "Transit_Time";

const TRAVEL_TYPE_LABELS = {
  OCEAN: "Ocean Freight",
  AIR: "Air Freight",
  FEDEX: "FedEx / UPS / Truck"
};
const ORIGIN_LABELS = {
  "CHINA": "Timing (China)",
  "CIS (FLORIDA)": "CIS (Florida)"
};

let _transitTimeTableCache = null;

async function getTransitTimeTable_() {
  if (_transitTimeTableCache) return _transitTimeTableCache;

  try {
    const data = await SS_API.getSheetValues(`${TRANSIT_TIME_SHEET}!A:N`);
    if (!data) throw new Error(TRANSIT_TIME_SHEET + " sheet not found");

    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      const origin = String(r[0] || "").trim();
      const destination = String(r[1] || "").trim();
      const travelType = String(r[2] || "").trim().toUpperCase();
      if (!origin || !destination || !travelType) continue;

      const totalEstDays = parseInt(r[13], 10);
      rows.push({
        origin: origin,
        destination: destination,
        travelType: travelType,
        loadType: String(r[3] || "").trim(),
        season: String(r[4] || "").trim(),
        port: String(r[5] || "").trim(),
        portKeyword: String(r[6] || "").trim(),
        collectionDays: parseInt(r[7], 10) || 0,
        portToPortDays: parseInt(r[8], 10) || 0,
        portDwellDays: parseInt(r[9], 10) || 0,
        customsDays: parseInt(r[10], 10) || 0,
        deliveryDays: parseInt(r[11], 10) || 0,
        parentAccount: String(r[12] || "").trim(),
        totalEstDays: isNaN(totalEstDays) ? null : totalEstDays
      });
    }
    _transitTimeTableCache = rows;
  } catch (e) {
    logger.warn("getTransitTimeTable_: " + e.message + " — detailed lane lookup unavailable, callers fall back to the older port-group math.");
    _transitTimeTableCache = [];
  }

  return _transitTimeTableCache;
}

let _peakSeasonWindowCache = undefined;

async function getPeakSeasonWindow_() {
  if (_peakSeasonWindowCache !== undefined) return _peakSeasonWindowCache;

  try {
    const data = await SS_API.getSheetValues(`${TRANSIT_TIME_SHEET}!1:2`);
    if (!data || data.length < 2) throw new Error(TRANSIT_TIME_SHEET + " sheet not found");

    const headerRow = data[0];
    let startCol = -1, endCol = -1;
    headerRow.forEach((val, idx) => {
      const text = String(val || "").trim().toUpperCase();
      if (text === "PEAK_START_DATE") startCol = idx;
      if (text === "PEAK_END_DATE") endCol = idx;
    });

    if (startCol === -1 || endCol === -1) {
      _peakSeasonWindowCache = null;
      return _peakSeasonWindowCache;
    }

    const startVal = data[1][startCol];
    const endVal = data[1][endCol];
    const startDate = parseDateCell_(startVal);
    const endDate = parseDateCell_(endVal);
    if (!startDate || !endDate) {
      _peakSeasonWindowCache = null;
      return _peakSeasonWindowCache;
    }

    _peakSeasonWindowCache = {
      startMonth: startDate.getMonth(), startDay: startDate.getDate(),
      endMonth: endDate.getMonth(), endDay: endDate.getDate()
    };
  } catch (e) {
    _peakSeasonWindowCache = null;
  }

  return _peakSeasonWindowCache;
}

async function isPeakSeasonForDate_(dateObj) {
  const window = await getPeakSeasonWindow_();
  if (!window || !dateObj) return false;

  const md = dateObj.getMonth() * 100 + dateObj.getDate();
  const start = window.startMonth * 100 + window.startDay;
  const end = window.endMonth * 100 + window.endDay;

  return start <= end ? (md >= start && md <= end) : (md >= start || md <= end);
}

function mapTransitModeToTravelType_(transitMode) {
  const mode = String(transitMode || "").toLowerCase();
  if (!mode) return null;
  if (mode.indexOf("ocean") !== -1 || mode.indexOf("sea") !== -1) return "OCEAN";
  if (mode.indexOf("air") !== -1) return "AIR";
  if (mode.indexOf("fedex") !== -1 || mode.indexOf("ups") !== -1 || mode.indexOf("truck") !== -1) return "FEDEX";
  return null;
}

async function findTransitLane_(opts) {
  const lanes = await getTransitTimeTable_();
  if (!lanes.length) return null;

  let candidates = lanes;

  if (opts.origin) {
    const wantOrigin = String(opts.origin).trim().toUpperCase();
    const byOrigin = candidates.filter(l => l.origin.toUpperCase() === wantOrigin);
    if (byOrigin.length) candidates = byOrigin;
  }

  if (opts.travelType) {
    const wantType = String(opts.travelType).trim().toUpperCase();
    const byType = candidates.filter(l => l.travelType === wantType);
    if (byType.length) candidates = byType;
  }

  if (opts.destination) {
    const wantDest = String(opts.destination).trim().toUpperCase();
    candidates = candidates.filter(l => l.destination.toUpperCase() === wantDest);
  } else if (opts.portText) {
    const upperPort = String(opts.portText).toUpperCase().trim();
    if (!upperPort) return null;
    let byPort = candidates.filter(l => {
      if (!l.portKeyword) return false;
      return l.portKeyword.split(",").some(alias => alias.trim().toUpperCase() === upperPort);
    });
    if (!byPort.length) {
      byPort = candidates.filter(l => {
        if (!l.portKeyword) return false;
        return l.portKeyword.split(",").some(alias => upperPort.indexOf(alias.trim().toUpperCase()) !== -1);
      });
    }
    candidates = byPort;
  }

  if (!candidates.length) return null;

  if (opts.readyDate) {
    const isPeak = await isPeakSeasonForDate_(opts.readyDate);
    const wantSeason = isPeak ? "Peak Season" : "Standard";
    const bySeason = candidates.filter(l => l.season === wantSeason);
    if (bySeason.length) candidates = bySeason;
  }

  if (opts.loadTypePreference) {
    const wantLoad = String(opts.loadTypePreference).trim().toUpperCase();
    const byLoad = candidates.filter(l => l.loadType.toUpperCase() === wantLoad);
    if (byLoad.length) return byLoad[0];
  }

  let slowest = null;
  candidates.forEach(l => {
    if (l.totalEstDays === null) return;
    if (!slowest || l.totalEstDays > slowest.totalEstDays) slowest = l;
  });
  return slowest || candidates[0];
}

async function getTransitLaneCatalog() {
  return {
    lanes: await getTransitTimeTable_(),
    peakWindow: await getPeakSeasonWindow_(),
    travelTypeLabels: TRAVEL_TYPE_LABELS,
    originLabels: ORIGIN_LABELS
  };
}

async function estimateShippingWindowV2(readyDateStr, travelType, origin, destination, loadType) {
  try {
    const readyDate = parseDateCell_(readyDateStr);
    if (!readyDate) return { success: false, error: "Enter a valid ready-to-ship date." };
    if (!travelType || !origin || !destination) {
      return { success: false, error: "Select a transit type, origin, and destination." };
    }

    const lane = await findTransitLane_({
      travelType: travelType, origin: origin, destination: destination,
      loadTypePreference: loadType, readyDate: readyDate
    });

    if (!lane || lane.totalEstDays === null) {
      return { success: false, error: "No transit-time lane found for that Origin / Transit Type / Destination combination." };
    }

    const etaDate = addDays_(readyDate, lane.totalEstDays);

    return {
      success: true,
      readyDate: formatDateCell_(readyDate),
      etaDate: formatDateCell_(etaDate),
      totalDays: lane.totalEstDays,
      season: lane.season,
      loadType: lane.loadType,
      port: lane.port,
      destination: lane.destination,
      travelType: lane.travelType,
      isFedex: lane.travelType === "FEDEX",
      basisNote: lane.season + " season, " + lane.loadType + " (" + lane.totalEstDays + " total days: " +
        lane.collectionDays + " collection + " + lane.portToPortDays + " transit + " +
        lane.portDwellDays + " dwell + " + lane.customsDays + " customs + " + lane.deliveryDays + " delivery)."
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function resolveEtaAndBasis_(row, rtsDateRaw) {
  const isOverridden = String(row[SHIPMENTS_COL.ETA_OVERRIDDEN] || "").trim().toUpperCase() === "MANUAL";
  const scheduled = parseDateCell_(row[SHIPMENTS_COL.SCHEDULED_DATE]);

  if (isOverridden && scheduled) {
    return { etaDate: formatDateCell_(scheduled), etaBasis: "CONFIRMED" };
  }

  const currentEtaBasis = String(row[SHIPMENTS_COL.ETA_BASIS] || "").trim().toUpperCase();
  const currentEtaDate = parseDateCell_(row[SHIPMENTS_COL.ETA_DATE]);
  if (currentEtaBasis === "CARRIER" && currentEtaDate) {
    return { etaDate: formatDateCell_(currentEtaDate), etaBasis: "CARRIER" };
  }

  if (!rtsDateRaw) {
    return scheduled ? { etaDate: formatDateCell_(scheduled), etaBasis: "SUPPLIER" } : { etaDate: "", etaBasis: "" };
  }

  const lane = await findTransitLane_({
    portText: row[SHIPMENTS_COL.PORT_OF_ARRIVAL],
    travelType: mapTransitModeToTravelType_(row[SHIPMENTS_COL.TRANSIT_MODE]),
    readyDate: rtsDateRaw
  });
  if (lane && lane.totalEstDays !== null) {
    return { etaDate: formatDateCell_(addDays_(rtsDateRaw, lane.totalEstDays)), etaBasis: "DERIVED" };
  }

  const portGroup = await classifyPortGroup_(row[SHIPMENTS_COL.PORT_OF_ARRIVAL]);
  const etaDateObj = portGroup
    ? await addPortGroupLeadTime_(rtsDateRaw, portGroup)
    : addDays_(rtsDateRaw, leadTimeDaysForMode_(row[SHIPMENTS_COL.TRANSIT_MODE]));
  return { etaDate: formatDateCell_(etaDateObj), etaBasis: "DERIVED" };
}

async function computeShipmentDates_(row) {
  const listStatus    = String(row[SHIPMENTS_COL.LIST_STATUS] || "").toUpperCase();
  const rollupStatus  = String(row[SHIPMENTS_COL.ROLLUP_STATUS] || "").toUpperCase();
  const masterTracking= String(row[SHIPMENTS_COL.MASTER_TRACKING] || "").trim();

  const rtsDateRaw    = parseDateCell_(row[SHIPMENTS_COL.RTS_DATE]);
  let   rtsBasis      = String(row[SHIPMENTS_COL.RTS_BASIS] || "").toUpperCase().trim();
  if (RTS_BASES.indexOf(rtsBasis) === -1) rtsBasis = rtsDateRaw ? "ESTIMATE" : "";

  const isDelivered =
    listStatus.indexOf("DELIVERED") !== -1 || rollupStatus.indexOf("DELIVERED") !== -1 ||
    listStatus.indexOf("RECEIVED")  !== -1 || rollupStatus.indexOf("RECEIVED")  !== -1;

  if (isDelivered) {
    const arrivalActual = parseDateCell_(row[SHIPMENTS_COL.SCHEDULED_DATE]);
    return {
      rtsDate: rtsDateRaw ? formatDateCell_(rtsDateRaw) : "",
      rtsBasis: rtsBasis,
      etaDate: arrivalActual ? formatDateCell_(arrivalActual) : "",
      etaBasis: arrivalActual ? "ACTUAL" : "",
      dateState: DATE_STATES.ARRIVED
    };
  }

  if (masterTracking) {
    const resolved = await resolveEtaAndBasis_(row, rtsDateRaw);
    return {
      rtsDate: rtsDateRaw ? formatDateCell_(rtsDateRaw) : "",
      rtsBasis: rtsBasis,
      etaDate: resolved.etaDate,
      etaBasis: resolved.etaBasis,
      dateState: DATE_STATES.IN_TRANSIT
    };
  }

  if (!rtsDateRaw) {
    return { rtsDate: "", rtsBasis: "", etaDate: "", etaBasis: "", dateState: DATE_STATES.NO_DATES };
  }

  const resolved = await resolveEtaAndBasis_(row, rtsDateRaw);
  const confirmed = (rtsBasis === "SUPPLIER_CONFIRMED" || rtsBasis === "ACTUAL");
  return {
    rtsDate: formatDateCell_(rtsDateRaw),
    rtsBasis: rtsBasis,
    etaDate: resolved.etaDate,
    etaBasis: resolved.etaBasis,
    dateState: confirmed ? DATE_STATES.RTS_CONFIRMED : DATE_STATES.RTS_ESTIMATED
  };
}

async function parseReadyPortComment_(commentText) {
  const text = String(commentText || "").toUpperCase();
  const match = text.match(/READY\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+PORT\s*:?\s*([A-Z][A-Z\s]*[A-Z]|[A-Z])/);
  if (!match) return null;
  const parsedDate = parseDateCell_(match[1]);
  if (!parsedDate) return null;
  const portRaw = match[2].trim();
  const portGroup = await classifyPortGroup_(portRaw);
  if (!portGroup) return null;
  return { readyDate: formatDateCell_(parsedDate), portRaw: portRaw, portGroup: portGroup };
}

async function parseSailingScheduleComment_(commentText) {
  const text = String(commentText || "").toUpperCase();
  const etdMatch = text.match(/ETD\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  const etaPortMatch = text.match(/ETA\s*PORT\s*\(([^)]+)\)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (!etdMatch || !etaPortMatch) return null;

  const etdDate = parseDateCell_(etdMatch[1]);
  const portArrivalDate = parseDateCell_(etaPortMatch[2]);
  if (!etdDate || !portArrivalDate) return null;

  const portRaw = etaPortMatch[1].trim();
  const portGroup = await classifyPortGroup_(portRaw);
  if (!portGroup) return null;

  return {
    etdDate: formatDateCell_(etdDate),
    portRaw: portRaw,
    portGroup: portGroup,
    portArrivalDate: formatDateCell_(portArrivalDate)
  };
}

function trelloCreds_() {
  return { key: process.env.TRELLO_KEY, token: process.env.TRELLO_TOKEN };
}

async function pushEtaToTrelloDue_(cardId, etaDateObj) {
  const creds = trelloCreds_();
  if (!creds.key || !creds.token || !cardId || !etaDateObj) return { success: false, error: "Missing Trello credentials, card ID, or ETA date." };
  try {
    const url = "https://api.trello.com/1/cards/" + cardId + "?key=" + creds.key + "&token=" + creds.token;
    const res = await fetch(url, { 
      method: "put", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ due: etaDateObj.toISOString() })
    });
    if (!res.ok) {
        const txt = await res.text();
        return { success: false, error: "Trello due-date write failed (" + res.status + "): " + txt };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

async function writeReadinessAndSyncTrello_(rowIdx1Based, cardId, row) {
  const dates = await computeShipmentDates_(row);
  const updValues = [[dates.rtsDate, dates.rtsBasis, dates.etaDate, dates.etaBasis, dates.dateState]];
  
  const updates = [
    { range: `SHIPMENTS!K${rowIdx1Based}:O${rowIdx1Based}`, values: updValues },
    { range: `SHIPMENTS!P${rowIdx1Based}`, values: [[String(row[SHIPMENTS_COL.PORT_OF_ARRIVAL] || "")]] },
    { range: `SHIPMENTS!R${rowIdx1Based}`, values: [[String(row[SHIPMENTS_COL.ETA_OVERRIDDEN] || "")]] }
  ];

  dates.portOfArrival = String(row[SHIPMENTS_COL.PORT_OF_ARRIVAL] || "").trim();
  dates.trelloDueSync = { attempted: false };

  if ((dates.etaBasis === "DERIVED" || dates.etaBasis === "CARRIER") && dates.etaDate) {
    const lastAutoDue = String(row[SHIPMENTS_COL.LAST_AUTO_DUE] || "").trim();
    if (lastAutoDue !== dates.etaDate) {
      const etaDateObj = parseDateCell_(dates.etaDate);
      if (etaDateObj) {
        dates.trelloDueSync.attempted = true;
        const pushResult = await pushEtaToTrelloDue_(cardId, etaDateObj);
        dates.trelloDueSync.success = pushResult.success;
        dates.trelloDueSync.error = pushResult.error;
        if (pushResult.success) {
          updates.push({ range: `SHIPMENTS!Q${rowIdx1Based}`, values: [[dates.etaDate]] });
        } else {
          logger.warn("pushEtaToTrelloDue_ failed for " + cardId + ": " + pushResult.error);
        }
      }
    }
  }

  await SS_API.batchUpdateValues(updates);
  return dates;
}

async function applySailingScheduleDeclaration_(cardId, etdStr, portArrivalStr, portText, portGroup) {
  try {
    const cleanCardId = String(cardId || "").trim();
    const etdDate = parseDateCell_(etdStr);
    const portArrivalDate = parseDateCell_(portArrivalStr);
    if (!cleanCardId || !etdDate || !portArrivalDate) return { success: false, error: "Missing card ID or unparseable dates." };

    const groups = await getPortGroups_();
    const g = groups[portGroup];
    if (!g) return { success: false, error: "Unknown port group: " + portGroup };

    const finalEta = addBusinessDays_(portArrivalDate, g.customsDeliveryDays);

    const data = await SS_API.getSheetValues("SHIPMENTS!A:S");
    if (!data) return { success: false, error: "SHIPMENTS sheet not found." };

    let foundIdx = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][SHIPMENTS_COL.CARD_ID]).trim() === cleanCardId) { foundIdx = i; break; }
    }
    if (foundIdx === -1) return { success: false, error: "Card " + cleanCardId + " not found in SHIPMENTS." };

    const row = data[foundIdx].slice();
    while (row.length <= SHIPMENTS_COL.ETA_OVERRIDDEN) row.push("");
    row[SHIPMENTS_COL.RTS_DATE] = formatDateCell_(etdDate);
    row[SHIPMENTS_COL.RTS_BASIS] = "ACTUAL";
    row[SHIPMENTS_COL.ETA_DATE] = formatDateCell_(finalEta);
    row[SHIPMENTS_COL.ETA_BASIS] = "CARRIER";
    row[SHIPMENTS_COL.PORT_OF_ARRIVAL] = String(portText || "").trim();
    row[SHIPMENTS_COL.ETA_OVERRIDDEN] = ""; 

    const dates = await writeReadinessAndSyncTrello_(foundIdx + 1, cleanCardId, row);
    return { success: true, dates: dates };
  } catch (e) {
    logger.error("applySailingScheduleDeclaration_ failed", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

async function applyReadyPortDeclaration_(cardId, readyDateStr, portText, rtsBasis) {
  try {
    const cleanCardId = String(cardId || "").trim();
    const parsedDate = parseDateCell_(readyDateStr);
    if (!cleanCardId || !parsedDate) return { success: false, error: "Missing card ID or unparseable ready date." };

    const cleanBasis = RTS_BASES.indexOf(String(rtsBasis || "").toUpperCase()) !== -1
      ? String(rtsBasis).toUpperCase() : "ESTIMATE";
    const cleanPort = String(portText || "").trim();

    const data = await SS_API.getSheetValues("SHIPMENTS!A:S");
    if (!data) return { success: false, error: "SHIPMENTS sheet not found." };

    let foundIdx = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][SHIPMENTS_COL.CARD_ID]).trim() === cleanCardId) { foundIdx = i; break; }
    }
    if (foundIdx === -1) return { success: false, error: "Card " + cleanCardId + " not found in SHIPMENTS." };

    const row = data[foundIdx].slice();
    while (row.length <= SHIPMENTS_COL.ETA_OVERRIDDEN) row.push("");
    row[SHIPMENTS_COL.RTS_DATE] = formatDateCell_(parsedDate);
    row[SHIPMENTS_COL.RTS_BASIS] = cleanBasis;
    row[SHIPMENTS_COL.PORT_OF_ARRIVAL] = cleanPort;
    row[SHIPMENTS_COL.ETA_OVERRIDDEN] = ""; 

    const dates = await writeReadinessAndSyncTrello_(foundIdx + 1, cleanCardId, row);
    return { success: true, dates: dates };
  } catch (e) {
    logger.error("applyReadyPortDeclaration_ failed", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

async function postReadyPortComment_(cardId, readyDateStr, portText) {
  const creds = trelloCreds_();
  if (!creds.key || !creds.token || !cardId) return { success: false, error: "Missing Trello credentials or card ID." };
  const commentText = "READY " + readyDateStr + " PORT " + String(portText || "").toUpperCase();
  try {
    const url = "https://api.trello.com/1/cards/" + cardId + "/actions/comments?key=" + creds.key + "&token=" + creds.token;
    const res = await fetch(url, { 
      method: "post", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: commentText }) 
    });
    if (!res.ok) {
        const txt = await res.text();
        return { success: false, error: "Trello comment post failed (" + res.status + "): " + txt };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

async function updateShipmentReadiness(cardId, rtsDate, rtsBasis, portOfArrival) {
  try {
    const cleanCardId = String(cardId || "").trim();
    if (!cleanCardId) return { success: false, error: "Missing card ID." };

    let cleanBasis = String(rtsBasis || "").toUpperCase().trim();
    if (cleanBasis && RTS_BASES.indexOf(cleanBasis) === -1) {
      return { success: false, error: "Invalid basis '" + rtsBasis + "'. Expected one of: " + RTS_BASES.join(", ") };
    }

    const cleanPort = String(portOfArrival || "").trim();
    const cleanDateStr = String(rtsDate || "").trim();

    if (!cleanDateStr) {
      const data = await SS_API.getSheetValues("SHIPMENTS!A:S");
      if (!data) return { success: false, error: "SHIPMENTS sheet not found." };

      let foundIdx = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][SHIPMENTS_COL.CARD_ID]).trim() === cleanCardId) { foundIdx = i; break; }
      }
      if (foundIdx === -1) return { success: false, error: "Card " + cleanCardId + " not found in SHIPMENTS." };

      const row = data[foundIdx].slice();
      while (row.length <= SHIPMENTS_COL.ETA_OVERRIDDEN) row.push("");
      row[SHIPMENTS_COL.RTS_DATE] = "";
      row[SHIPMENTS_COL.RTS_BASIS] = "";
      row[SHIPMENTS_COL.PORT_OF_ARRIVAL] = cleanPort;

      const dates = await computeShipmentDates_(row);
      const updates = [
        { range: `SHIPMENTS!K${foundIdx + 1}:O${foundIdx + 1}`, values: [[dates.rtsDate, dates.rtsBasis, dates.etaDate, dates.etaBasis, dates.dateState]] },
        { range: `SHIPMENTS!P${foundIdx + 1}`, values: [[cleanPort]] }
      ];
      await SS_API.batchUpdateValues(updates);
      dates.portOfArrival = cleanPort;
      return { success: true, dates: dates };
    }

    const parsedDate = parseDateCell_(cleanDateStr);
    if (!parsedDate) return { success: false, error: "Could not read '" + rtsDate + "' as a date. Use MM/DD/YYYY." };
    if (!cleanBasis) cleanBasis = "ESTIMATE";

    const result = await applyReadyPortDeclaration_(cleanCardId, formatDateCell_(parsedDate), cleanPort, cleanBasis);
    if (!result.success) return result;

    if (cleanPort && await classifyPortGroup_(cleanPort)) {
      const commentResult = await postReadyPortComment_(cleanCardId, formatDateCell_(parsedDate), cleanPort);
      result.dates.trelloCommentPosted = commentResult.success;
      if (!commentResult.success) {
        logger.warn("postReadyPortComment_ failed for " + cleanCardId + " (sheet write still succeeded): " + commentResult.error);
      }
    } else {
      result.dates.trelloCommentPosted = false;
    }

    return result;
  } catch (e) {
    logger.error("updateShipmentReadiness failed", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

async function refreshAllShipmentDateStates() {
  try {
    const data = await SS_API.getSheetValues("SHIPMENTS!A:S");
    if (!data || data.length < 2) return { success: true, updated: 0 };

    let updated = 0;
    let trelloPushed = 0;
    const updates = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const cardId = String(row[SHIPMENTS_COL.CARD_ID] || "").trim();
      if (!cardId) continue;

      const dates = await computeShipmentDates_(row);
      const current = [
        String(row[SHIPMENTS_COL.RTS_DATE] || ""),
        String(row[SHIPMENTS_COL.RTS_BASIS] || ""),
        String(row[SHIPMENTS_COL.ETA_DATE] || ""),
        String(row[SHIPMENTS_COL.ETA_BASIS] || ""),
        String(row[SHIPMENTS_COL.DATE_STATE] || "")
      ];
      
      const currentRts = parseDateCell_(row[SHIPMENTS_COL.RTS_DATE]);
      current[0] = currentRts ? formatDateCell_(currentRts) : "";
      const currentEta = parseDateCell_(row[SHIPMENTS_COL.ETA_DATE]);
      current[2] = currentEta ? formatDateCell_(currentEta) : "";

      const next = [dates.rtsDate, dates.rtsBasis, dates.etaDate, dates.etaBasis, dates.dateState];
      let changed = false;
      for (let j = 0; j < 5; j++) { if (current[j] !== next[j]) { changed = true; break; } }

      if (changed) {
        updates.push({ range: `SHIPMENTS!K${i + 1}:O${i + 1}`, values: [next] });
        updated++;
      }

      if ((dates.etaBasis === "DERIVED" || dates.etaBasis === "CARRIER") && dates.etaDate) {
        const lastAutoDue = String(row[SHIPMENTS_COL.LAST_AUTO_DUE] || "").trim();
        if (lastAutoDue !== dates.etaDate) {
          const etaDateObj = parseDateCell_(dates.etaDate);
          if (etaDateObj) {
            const pushResult = await pushEtaToTrelloDue_(cardId, etaDateObj);
            if (pushResult.success) {
              updates.push({ range: `SHIPMENTS!Q${i + 1}`, values: [[dates.etaDate]] });
              trelloPushed++;
            } else {
              logger.warn("refreshAllShipmentDateStates: Trello due-date push failed for " + cardId + ": " + pushResult.error);
            }
          }
        }
      }
    }

    if (updates.length > 0) {
        await SS_API.batchUpdateValues(updates);
    }

    logger.info("refreshAllShipmentDateStates: " + updated + " row(s) updated, " + trelloPushed + " Trello due-date push(es).");
    return { success: true, updated: updated, trelloPushed: trelloPushed };
  } catch (e) {
    logger.error("refreshAllShipmentDateStates failed", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

module.exports = {
  estimateShippingWindow,
  getTransitLaneCatalog,
  estimateShippingWindowV2,
  updateShipmentReadiness,
  refreshAllShipmentDateStates,
  applySailingScheduleDeclaration_,
  applyReadyPortDeclaration_,
  parseReadyPortComment_,
  parseSailingScheduleComment_
};
