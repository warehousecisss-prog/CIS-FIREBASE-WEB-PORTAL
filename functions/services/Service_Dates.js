const SS_API = require('./Service_SheetsAPI');
const { logger } = require('firebase-functions');
const { trelloCreds_, trelloFetch_ } = require('./Shared_Classifiers');

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

/**
 * Date -> "MM/dd/yyyy".
 *
 * SRC is `Utilities.formatDate(date, ss.getSpreadsheetTimeZone(), "MM/dd/yyyy")`
 * -- it formats in the SPREADSHEET's timezone. There is no equivalent here, so
 * this formats in the container's, which is UTC on Cloud Functions. That is
 * consistent rather than merely different: parseDateCell_ also parses in the
 * container's timezone, so a value read from the sheet as text and written back
 * round-trips to the same calendar day. It would only diverge if a real `Date`
 * object arrived from somewhere else, and the Sheets v4 API returns formatted
 * strings, not Dates.
 *
 * The isNaN guard is a deliberate deviation: SRC's Utilities.formatDate THROWS
 * on an Invalid Date, while this used to produce the literal string
 * "NaN/NaN/NaN" -- and every write in this file goes to a sheet cell as RAW
 * text, so that string would have landed in the ETA column and stuck. The input
 * is unreachable today (every caller passes a parseDateCell_ result, which is
 * null for anything unparseable), but "" is the right answer if it ever is.
 *
 * @param {?Date} date
 * @return {string}
 */
function formatDateCell_(date) {
  if (!date) return "";
  if (typeof date.getTime === 'function' && isNaN(date.getTime())) return "";
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

// Origin/Travel_Type/Load_Type values as they literally appear in the sheet vs.
// the friendlier labels the UI shows. Keep in sync with the live data --
// getTransitTimeTable_() logs (not throws) if a row's Travel_Type doesn't match
// a known key, so a new lane type added to the sheet degrades to "no friendly
// label" rather than silently vanishing from the picker.
//
// TRUCKING was missing from this port. SRC/src/Service_Dates.js:468-473 has it;
// without it an FTL lane reaches the Transit Type dropdown with no label at
// all. Note SCHEMA §4G's prose lists only OCEAN/AIR/FEDEX -- the doc is behind
// the code here; see PHASE_4_NOTES.md.
const TRAVEL_TYPE_LABELS = {
  OCEAN: "Ocean Freight",
  AIR: "Air Freight",
  FEDEX: "FedEx / UPS / Truck",
  TRUCKING: "Full Truckload (FTL)"
};
const ORIGIN_LABELS = {
  "CHINA": "Timing (China)",
  "CIS (FLORIDA)": "CIS (Florida)"
};

const DELIVERY_ADDRESS_SHEET = "Delivery_Address";

/**
 * Literal Delivery_Address `Destination` (col B, upper-cased + trimmed) -> the
 * Transit_Time `Destination_Cluster` its lead-time numbers come from, plus the
 * label the picker shows.
 *
 * The Destination picker (inline RTS panel + standalone Shipping Estimate
 * calculator) was switched from the regional cluster names ("Ontario (GTA)"…)
 * to these literal receiving docks 2026-08-27 -- the user found the cluster
 * abstraction confusing. The lane table is still keyed by cluster: the
 * 2026-08-19 reconciliation deliberately gave BUNZL/TDC/CAVALIER no legs of
 * their own, folding them into one set of Ontario legs. So every lane lookup
 * resolves the literal back to its cluster first
 * (resolveTransitDestinationCluster_ / findTransitLane_). Several docks share
 * one cluster's numbers by design -- confirmed with the user that identical
 * estimates across them is expected, not a bug.
 *
 * A Delivery_Address row whose Destination isn't in this map is logged and left
 * out of the picker (getDeliveryDestinationCatalog_) rather than matched
 * fuzzily -- dock-name substring matching has produced real bugs here before
 * (the CAVALIER-vs-RTF bug in getEstimatorRtfOriginZip's history, the
 * "Los Angeles" wrong-lane bug in findTransitLane_'s portText path). Add a row
 * here when the sheet gains a destination.
 *
 * Parity with SRC/src/Service_Dates.js:504-519. SCHEMA §4G.
 */
const DELIVERY_DESTINATION_CLUSTERS = {
  "RTF":                                  { cluster: "Ontario (GTA)",      label: "RTF — Orangeville, ON" },
  "CAVALIER (RTF STORAGE)":               { cluster: "Ontario (GTA)",      label: "CAVALIER (RTF storage) — Bolton, ON" },
  "TJX CANADA DISTRIBUTION CENTER (TDC)": { cluster: "Ontario (GTA)",      label: "TJX Distribution Centre (TDC) — Brampton, ON" },
  "BUNZL CANADA BURLINGTON 60604":        { cluster: "Ontario (GTA)",      label: "BUNZL Burlington — Burlington, ON" },
  "BUNZL CANADA CH TJX EDMONTON 61611":   { cluster: "Alberta (Edmonton)", label: "BUNZL Edmonton — Edmonton, AB" },
  "CREDO":                                { cluster: "Victoria (AU)",      label: "CREDO — Mount Waverley, VIC" },
  "CIS SECURITY SOLUTIONS":               { cluster: "Florida (US East)",  label: "CIS Security Solutions — Stuart, FL" }
};

// SRC memoizes these "for the life of this script execution" -- in Apps Script
// that is one request. In Cloud Functions a module-level cache lives for the
// life of the CONTAINER, which can be minutes or hours across many requests, so
// a hand-edit to Transit_Time is not picked up until the container recycles.
// Acceptable (this is a rarely-edited reference table, and every lookup would
// otherwise re-read the sheet), but it is a real behaviour difference, so the
// cache is clearable -- same precedent as Shared_Classifiers' clearQbNameIndex.
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

// undefined = not yet computed; null = computed, not configured.
let _peakSeasonWindowCache = undefined;

/**
 * Reads the peak-season date window from the Transit_Time tab -- the user added
 * these by hand 2026-08-17 (header text "Peak_Start_Date"/"Peak_End_Date" in
 * row 1, the actual dates one row below in row 2). Scanned by header TEXT
 * rather than a fixed column letter, same "content over position" philosophy as
 * getPortGroups_()'s Config-sheet scan, so this survives the columns moving.
 * Only month+day are used (year is ignored) -- this is a recurring annual
 * window, not a one-time range, so any year works in the sheet.
 *
 * Returns null (not a thrown error) if the header cells aren't found -- every
 * date is then treated as "Standard" season, which is the behaviour this system
 * had before the peak-season feature existed at all.
 *
 * Each fallback is LOGGED. SCHEMA §4G records that a documentation error about
 * which columns these live in meant `getPeakSeasonWindow_()` silently treated
 * every date as Standard season for two days in 2026-08. Silence is exactly how
 * that goes unnoticed, so the two fallback paths say why they fired -- this
 * port had dropped SRC's log lines.
 *
 * Parity with SRC/src/Service_Dates.js:580-629.
 *
 * @return {Promise<?{startMonth: number, startDay: number, endMonth: number, endDay: number}>}
 */
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
      logger.warn("getPeakSeasonWindow_: Peak_Start_Date/Peak_End_Date headers not found in " +
        TRANSIT_TIME_SHEET + " row 1 — every date treated as Standard season.");
      _peakSeasonWindowCache = null;
      return _peakSeasonWindowCache;
    }

    const startVal = data[1][startCol];
    const endVal = data[1][endCol];
    const startDate = parseDateCell_(startVal);
    const endDate = parseDateCell_(endVal);
    if (!startDate || !endDate) {
      logger.warn("getPeakSeasonWindow_: found the headers but couldn't parse a date out of row 2 " +
        "(start=\"" + startVal + "\", end=\"" + endVal + "\") — every date treated as Standard season.");
      _peakSeasonWindowCache = null;
      return _peakSeasonWindowCache;
    }

    _peakSeasonWindowCache = {
      startMonth: startDate.getMonth(), startDay: startDate.getDate(),
      endMonth: endDate.getMonth(), endDay: endDate.getDate()
    };
  } catch (e) {
    logger.warn("getPeakSeasonWindow_: " + e.message + " — every date treated as Standard season.");
    _peakSeasonWindowCache = null;
  }

  return _peakSeasonWindowCache;
}

/**
 * Drops the memoized lane table and peak window. No SRC counterpart -- in Apps
 * Script the caches die with the request. Here they live as long as the
 * container, so something has to be able to invalidate them after a Transit_Time
 * edit. Nothing calls it yet; the scheduled sync is the natural caller.
 */
function clearTransitTimeCache() {
  _transitTimeTableCache = null;
  _peakSeasonWindowCache = undefined;
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

/**
 * Core matcher against the Transit_Time table. Two calling conventions:
 *
 *  - Explicit selection (the 5-step UI, `port` added 2026-08-20): pass
 *    `destination` (and optionally `origin`/`travelType`/`port`) directly --
 *    used by estimateShippingWindowV2() and estimateShipByDateV2(). `port`
 *    disambiguates a destination fed by more than one entry port (Ontario (GTA)
 *    alone has Vancouver, Prince Rupert, LA to Toronto (IPI), and
 *    Montreal/Halifax); omitting it falls back to the old destination-only
 *    behaviour, where the slowest-wins default below picks whichever port
 *    happens to have the highest totalEstDays among ALL of them.
 *  - Backward-compatible free text (existing saved portOfArrival values,
 *    READY/PORT Trello comments): pass `portText` instead of `destination`.
 *    Used by resolveEtaAndBasis_() so rows saved before this feature existed
 *    still benefit from it without being re-entered.
 *
 * Narrowing order: origin (if given) -> travelType (if given) -> destination
 * (then port, if given) or portText match -> season (Standard vs Peak, from
 * readyDate; if the season filter would eliminate every remaining candidate --
 * e.g. a FedEx lane that only ever has "Standard" rows -- the filter is skipped
 * rather than returning nothing, since "no Peak Season row exists for this
 * lane" isn't the same as "no lane exists").
 *
 * Load_Type selection: an explicit `loadTypePreference` is honoured if it
 * matches a remaining row; otherwise the SLOWEST remaining row (max
 * totalEstDays) wins -- confirmed with the user 2026-08-17: default to the
 * conservative estimate rather than the optimistic one for planning purposes.
 *
 * THREE THINGS WERE MISSING FROM THIS PORT, all restored below and all
 * documented in SCHEMA §4G (PHASE_3_NOTES.md F4):
 *   1. resolveTransitDestinationCluster_ on opts.destination.
 *   2. the opts.port narrowing block.
 *   3. the exact-match against the lane's own `port` field, tried BEFORE the
 *      Port_Keyword alias search, in the portText path.
 * See the comments at each site for the specific bug each one prevents.
 *
 * Parity with SRC/src/Service_Dates.js:692-783.
 *
 * @param {Object} opts
 * @return {Promise<?Object>} the chosen lane row, or null if nothing matched.
 */
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
    // The Destination picker sends a literal Delivery_Address dock name ("RTF",
    // "BUNZL Canada Burlington 60604", …) as of 2026-08-27, not a Transit_Time
    // cluster -- resolve it back to its cluster before filtering.
    // resolveTransitDestinationCluster_ is a no-op for a value that is already a
    // cluster (older callers, saved values), so both conventions work.
    const wantDest = ((await resolveTransitDestinationCluster_(opts.destination)) ||
      String(opts.destination).trim()).toUpperCase();
    candidates = candidates.filter(l => l.destination.toUpperCase() === wantDest);

    // A destination can be fed by more than one Port -- an explicit port narrows
    // to the exact lane the UI's Port select (populatePortSelect_) resolved.
    // Without this, the "Default: slowest" fallback below silently picked
    // whichever port happened to have the highest totalEstDays among ALL of
    // them, not necessarily the one on screen. This is the fix for the
    // missing-LA-port bug (2026-08-20), and it is the reason the Destination and
    // Port dropdowns were split into two steps in the first place.
    if (opts.port) {
      const wantPort = String(opts.port).trim().toUpperCase();
      const byPort = candidates.filter(l => l.port.toUpperCase() === wantPort);
      if (byPort.length) candidates = byPort;
    }
  } else if (opts.portText) {
    const upperPort = String(opts.portText).toUpperCase().trim();
    if (!upperPort) return null;

    // Try the lane's actual Port column FIRST -- a single unambiguous field, and
    // exactly what the UI's Port select writes into portOfArrival. This must run
    // before the Port_Keyword alias search below: two different destinations can
    // legitimately share an alias (Ontario's "LA to Toronto (IPI)" lists
    // "Los Angeles" alongside the actual Los Angeles port's own keywords, since
    // both routes physically pass through LA), so an alias-only match can hit
    // more than one lane and fall through to "pick the slowest" -- which is
    // exactly how a Florida-bound "Los Angeles" declaration resolved to the much
    // slower Ontario/IPI lane, 68 days instead of 39, with no error and no
    // override, reproducing identically on every save (fixed 2026-08-21; see
    // SCHEMA §4G's port-collision CAUTION block).
    //
    // This step was missing from the port, so that bug was live again here.
    let byPort = candidates.filter(l => l.port.toUpperCase() === upperPort);

    if (!byPort.length) {
      byPort = candidates.filter(l => {
        if (!l.portKeyword) return false;
        return l.portKeyword.split(",").some(alias => alias.trim().toUpperCase() === upperPort);
      });
    }
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

/**
 * The literal-destination list for the Destination picker, each entry carrying
 * the Transit_Time cluster its numbers resolve to
 * (DELIVERY_DESTINATION_CLUSTERS). Delivery_Address rows with no mapping are
 * logged and skipped -- never fuzzy-matched, see the constant's comment. Any
 * lane-table cluster left with no literal destination pointing at it is
 * appended as its own entry (label = cluster name) so a cluster with real lanes
 * can never become unreachable from the UI if the sheet is missing a row.
 *
 * Parity with SRC/src/Service_Dates.js:798-842.
 *
 * @return {Promise<Array<{destination: string, label: string, cluster: string}>>}
 *     sorted by label.
 */
async function getDeliveryDestinationCatalog_() {
  const out = [];
  const seenClusters = {};
  try {
    const data = await SS_API.getSheetValues(`${DELIVERY_ADDRESS_SHEET}!A:B`);
    if (data) {
      const seenDest = {};
      for (let i = 1; i < data.length; i++) {
        const raw = String((data[i] && data[i][1]) || "").trim();
        if (!raw) continue;
        const key = raw.toUpperCase();
        if (seenDest[key]) continue;
        seenDest[key] = true;
        const hit = DELIVERY_DESTINATION_CLUSTERS[key];
        if (!hit) {
          logger.warn('getDeliveryDestinationCatalog_: Delivery_Address destination "' + raw +
            '" has no DELIVERY_DESTINATION_CLUSTERS mapping — left out of the Destination picker.');
          continue;
        }
        out.push({ destination: raw, label: hit.label || raw, cluster: hit.cluster });
        seenClusters[hit.cluster.toUpperCase()] = true;
      }
    } else {
      logger.warn("getDeliveryDestinationCatalog_: " + DELIVERY_ADDRESS_SHEET + " sheet not found.");
    }
  } catch (e) {
    logger.warn("getDeliveryDestinationCatalog_: " + e.message);
  }

  // Backfill: any cluster with real lanes but no literal destination above, so
  // it stays reachable even if Delivery_Address has no row for it yet.
  (await getTransitTimeTable_()).forEach(function(l) {
    const c = String(l.destination || "").trim();
    if (!c || seenClusters[c.toUpperCase()]) return;
    seenClusters[c.toUpperCase()] = true;
    out.push({ destination: c, label: c, cluster: c });
  });

  out.sort(function(a, b) { return a.label.localeCompare(b.label); });
  return out;
}

/**
 * Literal Delivery_Address destination (or a cluster name passed straight
 * through) -> canonical Transit_Time cluster. Case-insensitive. Returns the
 * canonical cluster string if `text` already matches a lane cluster, the mapped
 * cluster if it is a known literal destination, or null if it is neither --
 * callers that need a non-null fall back to the raw input.
 *
 * Parity with SRC/src/Service_Dates.js:849-861.
 *
 * @param {string} text
 * @return {Promise<?string>}
 */
async function resolveTransitDestinationCluster_(text) {
  const want = String(text || "").trim();
  if (!want) return null;
  const upper = want.toUpperCase();

  const lanes = await getTransitTimeTable_();
  for (let i = 0; i < lanes.length; i++) {
    if (String(lanes[i].destination || "").trim().toUpperCase() === upper) return lanes[i].destination;
  }
  const hit = DELIVERY_DESTINATION_CLUSTERS[upper];
  return hit ? hit.cluster : null;
}

/**
 * Client-callable -- the full lane table plus the configured peak window, once,
 * so the UI can build the cascading Transit Type -> Origin -> Destination ->
 * Port pickers without a round trip per dropdown change.
 *
 * `deliveryDestinations` was missing from this port; without it the Destination
 * dropdown has nothing to render since the 2026-08-27 switch to literal docks.
 * SCHEMA §4G.
 *
 * @return {Promise<Object>}
 */
async function getTransitLaneCatalog() {
  return {
    lanes: await getTransitTimeTable_(),
    peakWindow: await getPeakSeasonWindow_(),
    travelTypeLabels: TRAVEL_TYPE_LABELS,
    originLabels: ORIGIN_LABELS,
    deliveryDestinations: await getDeliveryDestinationCatalog_()
  };
}

/**
 * Client-callable, pure calculation (no sheet write) -- the detailed-lane
 * counterpart to estimateShippingWindow() above, used by the redesigned
 * Shipping Estimate calculator and the inline Readiness & ETA panel's live
 * preview. Explicit-selection calling convention (destination, not portText).
 *
 * `port` is the 5th parameter and was MISSING from this port, which is what
 * made the Destination/Port split pointless server-side. The client has always
 * passed six arguments (JS_Handlers.html:2773,3026). PHASE_3_NOTES.md F4.
 *
 * Parity with SRC/src/Service_Dates.js:885-920. SCHEMA §4G.
 *
 * @param {string} readyDateStr
 * @param {string} travelType
 * @param {string} origin
 * @param {string} destination literal dock name or a cluster.
 * @param {string} [port] entry port, disambiguating a multi-port destination.
 * @param {string} [loadType]
 * @return {Promise<Object>}
 */
async function estimateShippingWindowV2(readyDateStr, travelType, origin, destination, port, loadType) {
  try {
    const readyDate = parseDateCell_(readyDateStr);
    if (!readyDate) return { success: false, error: "Enter a valid ready-to-ship date." };
    if (!travelType || !origin || !destination) {
      return { success: false, error: "Select a transit type, origin, and destination." };
    }

    const lane = await findTransitLane_({
      travelType: travelType, origin: origin, destination: destination, port: port,
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

/**
 * Client-callable, pure calculation (no sheet write) -- the REVERSE of
 * estimateShippingWindowV2() above. Given a hard "must arrive by" date instead
 * of a ready-to-ship date, works backward through the same Transit_Time lane
 * (same findTransitLane_ narrowing, same slowest-wins default) to the latest
 * date the goods can leave the origin and still make it. Same calling
 * convention as V2 (explicit destination/port, not free-text portText).
 *
 * Season lookup is the one place this genuinely has to guess: findTransitLane_
 * picks Standard vs. Peak Season off the date it is handed, but here that is
 * the unknown being solved for. Approximates by first checking the season for
 * the arrive-by date itself, then re-resolving using the resulting ship-by
 * date's season if that lands in a different window -- one lane away from the
 * peak boundary this can be off by whatever the Standard/Peak day-count delta
 * is for that lane, and the basisNote says so explicitly when it happens.
 *
 * Parity with SRC/src/Service_Dates.js:942-997. SCHEMA §4G (NOT §8 Engine 4 --
 * that is the FedEx CSV batch estimator, a different thing; see
 * PHASE_4_NOTES.md).
 *
 * @param {string} arriveByDateStr
 * @param {string} travelType
 * @param {string} origin
 * @param {string} destination literal dock name or a cluster.
 * @param {string} [port]
 * @param {string} [loadType]
 * @return {Promise<Object>}
 */
async function estimateShipByDateV2(arriveByDateStr, travelType, origin, destination, port, loadType) {
  try {
    const arriveByDate = parseDateCell_(arriveByDateStr);
    if (!arriveByDate) return { success: false, error: "Enter a valid must-arrive-by date." };
    if (!travelType || !origin || !destination) {
      return { success: false, error: "Select a transit type, origin, and destination." };
    }

    let lane = await findTransitLane_({
      travelType: travelType, origin: origin, destination: destination, port: port,
      loadTypePreference: loadType, readyDate: arriveByDate
    });

    if (!lane || lane.totalEstDays === null) {
      return { success: false, error: "No transit-time lane found for that Origin / Transit Type / Destination combination." };
    }

    let shipByDate = addDays_(arriveByDate, -lane.totalEstDays);
    let seasonNote = "";

    // Re-check season using the ship-by date just derived -- if it falls in a
    // different Standard/Peak window than the arrive-by date did, re-resolve
    // against that lane and recompute once. Not iterated further; a lane whose
    // day-count delta is large enough to flip the season a second time is
    // already flagged via seasonNote below.
    const reLane = await findTransitLane_({
      travelType: travelType, origin: origin, destination: destination, port: port,
      loadTypePreference: loadType, readyDate: shipByDate
    });
    if (reLane && reLane.totalEstDays !== null && reLane.season !== lane.season) {
      lane = reLane;
      shipByDate = addDays_(arriveByDate, -lane.totalEstDays);
      seasonNote = " Note: this lane's Standard/Peak Season day-count differs, and the " +
        "computed ship-by date falls in a different season window than the arrival date — " +
        "using the " + lane.season + " figure for the ship-by date itself.";
    }

    return {
      success: true,
      arriveByDate: formatDateCell_(arriveByDate),
      shipByDate: formatDateCell_(shipByDate),
      totalDays: lane.totalEstDays,
      season: lane.season,
      loadType: lane.loadType,
      port: lane.port,
      destination: lane.destination,
      travelType: lane.travelType,
      isFedex: lane.travelType === "FEDEX",
      basisNote: lane.season + " season, " + lane.loadType + " (" + lane.totalEstDays + " total days: " +
        lane.collectionDays + " collection + " + lane.portToPortDays + " transit + " +
        lane.portDwellDays + " dwell + " + lane.customsDays + " customs + " + lane.deliveryDays + " delivery)." +
        seasonNote
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

async function pushEtaToTrelloDue_(cardId, etaDateObj) {
  const creds = trelloCreds_();
  if (!creds.key || !creds.token || !cardId || !etaDateObj) return { success: false, error: "Missing Trello credentials, card ID, or ETA date." };
  try {
    const url = "https://api.trello.com/1/cards/" + cardId + "?key=" + creds.key + "&token=" + creds.token;
    const res = await trelloFetch_(url, { 
      method: "put", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ due: etaDateObj.toISOString() })
    });
    if (!res.ok) {
        const txt = res.text;
        return { success: false, error: "Trello due-date write failed (" + res.code + "): " + txt };
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
    const res = await trelloFetch_(url, { 
      method: "post", 
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: commentText }) 
    });
    if (!res.ok) {
        const txt = res.text;
        return { success: false, error: "Trello comment post failed (" + res.code + "): " + txt };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

/**
 * Fetches a card's comments, newest first (Trello's default order for the
 * actions endpoint). Used by the sync-side backfill passes -- the webhook path
 * never needs this, since a commentCard webhook already carries the full
 * comment text in action.data.text with no extra call required.
 *
 * Returns [] on every failure rather than throwing: every caller is a
 * best-effort catch-up scan over many cards, and one unreachable card must not
 * abort the sweep.
 *
 * Parity with SRC/src/Service_Dates.js:1270-1285. Also unblocks
 * Shared_Classifiers' backfillIgnoreCommentsFromComments_, which has been
 * waiting on this function since Phase 2.
 *
 * @param {string} cardId
 * @return {Promise<Array<{text: string, date: string}>>}
 */
async function fetchCardComments_(cardId) {
  const creds = trelloCreds_();
  if (!creds.key || !creds.token || !cardId) return [];
  try {
    const url = "https://api.trello.com/1/cards/" + cardId +
      "/actions?filter=commentCard&limit=50&key=" + creds.key + "&token=" + creds.token;
    const res = await trelloFetch_(url, {}, { label: 'card comments' });
    if (!res.ok) {
      logger.warn("fetchCardComments_ non-200 for " + cardId + ": " + res.code);
      return [];
    }
    const actions = JSON.parse(res.text);
    return actions.map(function(a) { return { text: (a.data && a.data.text) || "", date: a.date }; });
  } catch (e) {
    logger.warn("fetchCardComments_ failed for " + cardId + ": " + e.message);
    return [];
  }
}

/**
 * Scans a card's comments (newest first) for the most recent parseable
 * declaration -- either a sailing-schedule comment (tried first per comment,
 * since it is real data rather than an estimate) or the portal's canonical
 * READY/PORT format. Used by the sync-side backfill for cards that don't have
 * one yet -- see backfillReadyPortFromComments_ below.
 *
 * Parity with SRC/src/Service_Dates.js:1297-1306.
 *
 * @param {string} cardId
 * @return {Promise<?Object>} {kind:'sailing', …} | {kind:'readyPort', …} | null
 */
async function findLatestReadyPortInfo_(cardId) {
  const comments = await fetchCardComments_(cardId);
  for (let i = 0; i < comments.length; i++) {
    const sailing = await parseSailingScheduleComment_(comments[i].text);
    if (sailing) { sailing.kind = 'sailing'; return sailing; }
    const parsed = await parseReadyPortComment_(comments[i].text);
    if (parsed) { parsed.kind = 'readyPort'; return parsed; }
  }
  return null;
}

/**
 * Resolves the Trello account behind the current TRELLO_KEY/TRELLO_TOKEN.
 *
 * Only meaningful if those credentials belong to a DEDICATED automation-only
 * account: that is what lets the webhook handler tell "the automation wrote
 * this due date" from "a human wrote it" by identity. On a personal login the
 * two are indistinguishable and the value-drift check
 * (detectMissedDueDateOverrides_) is what still catches an override.
 *
 * Parity with SRC/src/Service_Dates.js:1372-1384.
 *
 * @return {Promise<?{id: string, username: string, fullName: string}>}
 */
async function getTrelloMemberInfo_() {
  const creds = trelloCreds_();
  if (!creds.key || !creds.token) return null;
  try {
    const url = "https://api.trello.com/1/members/me?fields=id,username,fullName&key=" +
      creds.key + "&token=" + creds.token;
    const res = await trelloFetch_(url, {}, { label: 'member info' });
    if (!res.ok) return null;
    return JSON.parse(res.text);
  } catch (e) {
    logger.warn("getTrelloMemberInfo_ failed: " + e.message);
    return null;
  }
}

/**
 * One-off setup. Resolves the member ID behind the current credentials so the
 * webhook handler can compare an incoming due-date change's idMemberCreator
 * against it.
 *
 * DELIBERATE DEVIATION FROM SRC. The original ends with
 * `PropertiesService.getScriptProperties().setProperty("TRELLO_BOT_MEMBER_ID", …)`
 * -- it writes the answer back into its own configuration. There is no
 * equivalent here: config comes from `.env`, which the running function cannot
 * write, and PHASE_1_NOTES.md lists the write-back half of
 * TRELLO_BOT_MEMBER_ID in `config.RUNTIME_STATE_KEYS` precisely because it
 * needs a real store. So this RETURNS the member ID and tells the operator to
 * put it in config, rather than silently writing it somewhere nothing reads.
 *
 * Pointing this at the wrong account would make every one of your own manual
 * Trello edits look like "the bot did it" -- i.e. silently DISABLE override
 * detection instead of enabling it -- so the username and full name come back
 * alongside the ID for visual confirmation before you trust it.
 *
 * No route: this has no client call site in SRC (it is run by hand), and it is
 * a credentials-identifying call.
 *
 * Parity with SRC/src/Service_Dates.js:1396-1405, minus the write-back.
 *
 * @return {Promise<Object>}
 */
async function identifyTrelloBotAccount() {
  const member = await getTrelloMemberInfo_();
  if (!member || !member.id) {
    logger.error("identifyTrelloBotAccount: could not resolve a member for the current " +
      "TRELLO_KEY/TRELLO_TOKEN. Check functions/.env.");
    return {
      success: false,
      error: "Could not resolve a Trello member for the current TRELLO_KEY/TRELLO_TOKEN. " +
             "Check that both are set and still valid."
    };
  }
  logger.info("identifyTrelloBotAccount: TRELLO_BOT_MEMBER_ID should be set to " + member.id +
    " (" + (member.username || "?") + " / " + (member.fullName || "?") + ").");
  return {
    success: true,
    memberId: member.id,
    username: member.username,
    fullName: member.fullName,
    // Spelled out because this is the half SRC did automatically and this port
    // cannot: an operator who reads only `success:true` would think it was done.
    action: "Set TRELLO_BOT_MEMBER_ID=" + member.id + " in functions/.env and redeploy. " +
            "Confirm '" + (member.username || "?") + "' is the dedicated automation account, " +
            "NOT a personal login, before relying on override detection — pointing this at a " +
            "personal account silently disables it rather than enabling it."
  };
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

/**
 * ============================================================================
 * OVERRIDE DETECTION -- columns Q (lastAutoDue) and R (etaOverridden)
 * ============================================================================
 *
 * SCHEMA §4F: the ETA this system pushes into a Trello card's due date is
 * explicitly a PLACEHOLDER, and a real sailing schedule should always win. That
 * makes "did something other than us change this due date?" the question these
 * two columns exist to answer, and these are the helpers that read and set them.
 *
 * Each does its own full-sheet read+scan rather than sharing a cache with the
 * rest of this file -- these fire on rare events (a due-date edit, a comment),
 * not in a bulk loop, so the cost is negligible and it matches the find-by-cardId
 * pattern used throughout.
 *
 * Parity with SRC/src/Service_Dates.js:1510-1534.
 *
 * @param {string} cardId
 * @return {Promise<string>} the stored last-auto-pushed due date, or "".
 */
async function getLastAutoDueForCard_(cardId) {
  const data = await SS_API.getSheetValues("SHIPMENTS!A:S");
  if (!data) return "";
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][SHIPMENTS_COL.CARD_ID]).trim() === String(cardId).trim()) {
      return String(data[i][SHIPMENTS_COL.LAST_AUTO_DUE] || "").trim();
    }
  }
  return "";
}

/**
 * Flags a card's ETA as manually overridden, so resolveEtaAndBasis_ stops
 * recomputing over the top of it.
 *
 * @param {string} cardId
 * @return {Promise<void>}
 */
async function markEtaOverridden_(cardId) {
  const data = await SS_API.getSheetValues("SHIPMENTS!A:S");
  if (!data) return;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][SHIPMENTS_COL.CARD_ID]).trim() === String(cardId).trim()) {
      await SS_API.batchUpdateValues([
        { range: `SHIPMENTS!R${i + 1}`, values: [["MANUAL"]] }
      ]);
      return;
    }
  }
}

/**
 * Safety net for the periodic sync: catches a due-date change that arrived via
 * Trello but was missed by the webhook path (dropped delivery, debounce
 * collision with the automation's own echo, etc.). Compares each row's
 * freshly-synced Trello due date (column F, just rewritten by this sync's
 * earlier phases) against what this system itself last wrote there (lastAutoDue,
 * column Q); a mismatch on a row that isn't already flagged means something else
 * changed it since our last write, so this system backs off the same way the
 * webhook-side identity check would have.
 *
 * Value-only (no idMemberCreator available here without an extra API call per
 * card) -- the webhook path is the precise, real-time, identity-capable
 * detector; this is the coarser fallback for whatever it missed.
 *
 * CALL ORDER MATTERS: after the sync has rewritten column F for the cycle, and
 * BEFORE refreshAllShipmentDateStates(), so the override is visible to this
 * cycle's own ETA recomputation. Nothing calls it yet -- syncAllBoardsToShipments
 * Tab is unported -- so this is here ready for that, not wired in.
 *
 * Parity with SRC/src/Service_Dates.js:1741-1779.
 *
 * @return {Promise<{success: boolean, flagged?: number, error?: string}>}
 */
async function detectMissedDueDateOverrides_() {
  try {
    const data = await SS_API.getSheetValues("SHIPMENTS!A:S");
    if (!data) return { success: false, error: "SHIPMENTS sheet not found." };
    if (data.length < 2) return { success: true, flagged: 0 };

    let flagged = 0;
    const updates = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!String(row[SHIPMENTS_COL.CARD_ID] || "").trim()) continue;

      const alreadyOverridden =
        String(row[SHIPMENTS_COL.ETA_OVERRIDDEN] || "").trim().toUpperCase() === "MANUAL";
      if (alreadyOverridden) continue;

      const lastAutoDue = String(row[SHIPMENTS_COL.LAST_AUTO_DUE] || "").trim();
      if (!lastAutoDue) continue; // never pushed anything for this row -- nothing to drift from

      const currentScheduled = parseDateCell_(row[SHIPMENTS_COL.SCHEDULED_DATE]);
      const currentScheduledStr = currentScheduled ? formatDateCell_(currentScheduled) : "";
      if (currentScheduledStr && currentScheduledStr !== lastAutoDue) {
        updates.push({ range: `SHIPMENTS!R${i + 1}`, values: [["MANUAL"]] });
        flagged++;
        logger.info("detectMissedDueDateOverrides_: " + String(row[SHIPMENTS_COL.CARD_ID]).trim() +
          " due date drifted from lastAutoDue (" + lastAutoDue + " -> " + currentScheduledStr +
          ") without a matching webhook — marking overridden.");
      }
    }

    // One batched write instead of SRC's per-row setValue. Same result, and it
    // keeps a 400-row sweep to a single API call rather than 400.
    if (updates.length > 0) await SS_API.batchUpdateValues(updates);
    return { success: true, flagged: flagged };
  } catch (e) {
    logger.error("detectMissedDueDateOverrides_ failed", { error: e.message });
    return { success: false, error: e.toString() };
  }
}

/**
 * Sync-side safety net: for inbound rows with no readiness declaration captured
 * yet (dateState NO_DATES or blank), checks the card's Trello comments directly
 * via the API. The webhook path (commentCard) is the real-time route and needs
 * no extra API call; this exists for whatever it missed, or for cards where the
 * comment was posted before this feature existed.
 *
 * Scoped to NO_DATES rows only -- once a row has a captured readiness date,
 * corrections arrive via the webhook path or a fresh portal Save, not by
 * re-scanning every card's comments on every sync, which would cost one Trello
 * API call per card per sync for no benefit.
 *
 * Sequential, not Promise.all: each iteration issues a Trello call and may write
 * to the sheet, and the shared rate-limited transport is there to avoid a 429
 * storm, not to be fed one.
 *
 * Parity with SRC/src/Service_Dates.js:1793-1829.
 *
 * @return {Promise<{success: boolean, backfilled?: number, error?: string}>}
 */
async function backfillReadyPortFromComments_() {
  try {
    const data = await SS_API.getSheetValues("SHIPMENTS!A:S");
    if (!data) return { success: false, error: "SHIPMENTS sheet not found." };
    if (data.length < 2) return { success: true, backfilled: 0 };

    let backfilled = 0;
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const cardId = String(row[SHIPMENTS_COL.CARD_ID] || "").trim();
      const direction = String(row[SHIPMENTS_COL.DIRECTION] || "").trim();
      if (!cardId || direction.toUpperCase() !== "INBOUND") continue;

      const dateState = String(row[SHIPMENTS_COL.DATE_STATE] || "").trim().toUpperCase();
      if (dateState && dateState !== DATE_STATES.NO_DATES) continue; // already captured

      const found = await findLatestReadyPortInfo_(cardId);
      if (found && found.kind === 'sailing') {
        await applySailingScheduleDeclaration_(cardId, found.etdDate, found.portArrivalDate,
            found.portRaw, found.portGroup);
        backfilled++;
      } else if (found) {
        await applyReadyPortDeclaration_(cardId, found.readyDate, found.portRaw);
        backfilled++;
      }
    }
    logger.info("backfillReadyPortFromComments_: " + backfilled + " row(s) backfilled from comments.");
    return { success: true, backfilled: backfilled };
  } catch (e) {
    logger.error("backfillReadyPortFromComments_ failed", { error: e.message });
    return { success: false, error: e.toString() };
  }
}

/**
 * One-off setup -- adds the eight date headers to SHIPMENTS (K through R)
 * without touching any existing data, then runs a first full computation pass.
 * Safe to re-run.
 *
 * The Ready_To_Ship_Basis dropdown is not decoration: SRC's comment is explicit
 * that keeping the basis column to its closed value set AT ENTRY is the point --
 * "a dropdown prevents what a validator can only report". A free-typed basis
 * value falls outside RTS_BASES and computeShipmentDates_ silently rewrites it
 * to ESTIMATE on the next pass, losing a SUPPLIER_CONFIRMED the operator meant.
 *
 * No route, deliberately. This has no client call site in SRC (it is a manual
 * editor action), and it overwrites row 1 of SHIPMENTS -- not something to leave
 * one mistyped URL away from anyone with a session.
 *
 * Parity with SRC/src/Service_Dates.js:1837-1858.
 *
 * @return {Promise<Object>}
 */
async function setupShipmentDateColumns() {
  try {
    const sheetId = await SS_API.getSheetId("SHIPMENTS");

    const headers = ["Ready_To_Ship_Date", "Ready_To_Ship_Basis", "ETA_Date", "ETA_Basis",
      "Date_State", "Port_Of_Arrival", "Last_Auto_Due", "ETA_Overridden"];
    await SS_API.batchUpdateValues([
      { range: `SHIPMENTS!K1:R1`, values: [headers] }
    ]);

    await SS_API.batchUpdateSheet([
      // Bold the headers. SRC gets this from .setFontWeight("bold"); the values
      // API cannot set formatting, so it is a repeatCell request here.
      {
        repeatCell: {
          range: {
            sheetId: sheetId, startRowIndex: 0, endRowIndex: 1,
            startColumnIndex: SHIPMENTS_COL.RTS_DATE,
            endColumnIndex: SHIPMENTS_COL.ETA_OVERRIDDEN + 1
          },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: "userEnteredFormat.textFormat.bold"
        }
      },
      // The closed value set for Ready_To_Ship_Basis.
      {
        setDataValidation: {
          range: {
            sheetId: sheetId, startRowIndex: 1,
            startColumnIndex: SHIPMENTS_COL.RTS_BASIS,
            endColumnIndex: SHIPMENTS_COL.RTS_BASIS + 1
          },
          rule: {
            condition: {
              type: "ONE_OF_LIST",
              values: RTS_BASES.map(function(v) { return { userEnteredValue: v }; })
            },
            showCustomUi: true,
            strict: true
          }
        }
      }
    ]);

    logger.info("setupShipmentDateColumns: SHIPMENTS date columns K-R created. " +
      "Running first computation pass…");
    const result = await refreshAllShipmentDateStates();
    return { success: true, headers: headers, firstPass: result };
  } catch (e) {
    logger.error("setupShipmentDateColumns failed", { error: e.message });
    return { success: false, error: e.toString() };
  }
}

module.exports = {
  // Exported because Shared_Classifiers' backfillIgnoreCommentsFromComments_
  // needs the SHIPMENTS column map; SCHEMA section 3 is the contract for it.
  SHIPMENTS_COL,
  DATE_STATES,
  RTS_BASES,
  // --- the two client-callable estimators (SCHEMA §4G) ---------------------
  estimateShippingWindow,
  estimateShippingWindowV2,
  estimateShipByDateV2,
  getTransitLaneCatalog,
  // --- readiness / ETA -----------------------------------------------------
  updateShipmentReadiness,
  refreshAllShipmentDateStates,
  applySailingScheduleDeclaration_,
  applyReadyPortDeclaration_,
  parseReadyPortComment_,
  parseSailingScheduleComment_,
  computeShipmentDates_,
  // --- lane lookup ---------------------------------------------------------
  // findTransitLane_ and the two resolvers are exported for the parity harness
  // and for the sync/webhook functions that will need them.
  findTransitLane_,
  getPeakSeasonWindow_,
  isPeakSeasonForDate_,
  mapTransitModeToTravelType_,
  resolveTransitDestinationCluster_,
  getDeliveryDestinationCatalog_,
  clearTransitTimeCache,
  DELIVERY_DESTINATION_CLUSTERS,
  TRAVEL_TYPE_LABELS,
  ORIGIN_LABELS,
  // --- Trello comments -----------------------------------------------------
  // fetchCardComments_ is what unblocks Shared_Classifiers'
  // backfillIgnoreCommentsFromComments_ (blocked since Phase 2).
  fetchCardComments_,
  findLatestReadyPortInfo_,
  getTrelloMemberInfo_,
  identifyTrelloBotAccount,
  // --- override detection (columns Q/R) ------------------------------------
  getLastAutoDueForCard_,
  markEtaOverridden_,
  detectMissedDueDateOverrides_,
  backfillReadyPortFromComments_,
  // --- one-off setup -------------------------------------------------------
  setupShipmentDateColumns,
  // --- pure date helpers, exported for the parity harness ------------------
  parseDateCell_,
  formatDateCell_,
  addDays_,
  addBusinessDays_,
  leadTimeDaysForMode_
};
