/**
 * ============================================================================
 * PARITY HARNESS -- Service_Dates
 * ============================================================================
 * Runs SRC/src/Service_Dates.js and the ported functions/services/Service_Dates.js
 * against identical inputs and fails on any output difference. Same shape and
 * same reasoning as test/parity_Shared_Classifiers.js: "I ported it carefully"
 * is not evidence.
 *
 * WHAT MAKES THESE COMPARABLE
 * ---------------------------
 * Most of Service_Dates is not pure -- it reads Transit_Time, Delivery_Address,
 * Config and SHIPMENTS. But it reads them through exactly two boundaries:
 * `SpreadsheetApp` on the SRC side and `SS_API` on the port side. Stub both
 * with the SAME synthetic workbook and everything above that line becomes
 * deterministic and directly comparable -- which covers the functions that
 * actually matter here: findTransitLane_, estimateShippingWindowV2,
 * estimateShipByDateV2, computeShipmentDates_, the two catalogs.
 *
 * That is the whole point. The Phase 3 finding F4 (`estimateShippingWindowV2`
 * lost its `port` parameter; findTransitLane_ lost the port-narrowing block,
 * the destination-cluster resolution and the exact-Port-first match in the
 * portText path) is precisely the class of bug that reads fine and answers
 * differently, and the synthetic lane table below is built to expose each one:
 *
 *   - Ontario (GTA) is fed by four ports of very different speeds, so a lookup
 *     that ignores `port` silently returns the slowest.
 *   - The "LA to Toronto (IPI)" lane carries "Los Angeles" in its Port_Keyword
 *     alongside the real Los Angeles port's own keywords -- the exact 2026-08-21
 *     port-collision bug (SCHEMA §4G's CAUTION block), where a Florida-bound
 *     "Los Angeles" declaration resolved to the far slower Ontario/IPI lane.
 *   - Peak-Season rows exist for some lanes and not others, so the
 *     "skip the season filter rather than return nothing" rule is exercised.
 *
 * SRC/src is the original Apps Script repo. It is gitignored here and lives on
 * the porting machine only, so this SKIPS rather than fails when it is absent.
 *
 *   npm run test:parity:dates
 *
 * NOT COMPARED, and why: anything that writes (applyReadyPortDeclaration_,
 * updateShipmentReadiness, setupShipmentDateColumns) or that makes a Trello
 * call (fetchCardComments_, findLatestReadyPortInfo_, getTrelloMemberInfo_,
 * postReadyPortComment_, pushEtaToTrelloDue_). Comparing those means asserting
 * on mock call sequences rather than on answers, which is a test of the mock.
 * They are reviewed line-by-line against SRC instead, and PHASE_4_NOTES.md says
 * so rather than implying this file covers them.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..');
const srcPath = path.join(ROOT, 'SRC/src/Service_Dates.js');
const portPath = path.join(ROOT, 'functions/services/Service_Dates.js');

if (!fs.existsSync(srcPath)) {
  console.log('SKIP: ' + srcPath + ' not present (SRC/ is gitignored -- it lives on the ' +
              'porting machine only). Nothing to compare against.');
  process.exit(0);
}

/* ==========================================================================
 * The synthetic workbook -- one definition, fed to both sides.
 * ========================================================================== */

// Transit_Time columns A..N, then O/P carrying the peak-season window.
// A Origin | B Destination | C Travel_Type | D Load_Type | E Season | F Port |
// G Port_Keyword | H Collection | I PortToPort | J Dwell | K Customs |
// L Delivery | M Parent_Account | N Total_Est_Days || O Peak_Start | P Peak_End
const TRANSIT_TIME = [
  ['Origin', 'Destination', 'Travel_Type', 'Load_Type', 'Season', 'Port', 'Port_Keyword',
    'Collection_Days', 'Port_to_Port_Days', 'Port_Dwell_Days', 'Customs_Days', 'Delivery_Days',
    'Parent_Account', 'Total_Est_Days', 'Peak_Start_Date', 'Peak_End_Date'],

  // --- Ontario (GTA): four entry ports, deliberately very different speeds --
  ['China', 'Ontario (GTA)', 'OCEAN', 'FCL', 'Standard', 'Vancouver',
    'Vancouver, YVR', 5, 22, 4, 3, 5, 'TJX', 39, '08/15/2026', '11/15/2026'],
  ['China', 'Ontario (GTA)', 'OCEAN', 'LCL', 'Standard', 'Vancouver',
    'Vancouver, YVR', 5, 22, 8, 3, 5, 'TJX', 43, '', ''],
  ['China', 'Ontario (GTA)', 'OCEAN', 'FCL', 'Peak Season', 'Vancouver',
    'Vancouver, YVR', 7, 27, 6, 3, 5, 'TJX', 48, '', ''],
  ['China', 'Ontario (GTA)', 'OCEAN', 'FCL', 'Standard', 'Prince Rupert',
    'Prince Rupert, YPR', 5, 30, 7, 4, 7, 'TJX', 53, '', ''],
  // The collision lane: it lists Los Angeles among its aliases because the
  // route physically passes through LA, but it is an ONTARIO lane.
  ['China', 'Ontario (GTA)', 'OCEAN', 'FCL', 'Standard', 'LA to Toronto (IPI)',
    'Los Angeles, LA, LAX, Longbeach', 5, 24, 10, 4, 25, 'TJX', 68, '', ''],
  ['China', 'Ontario (GTA)', 'OCEAN', 'FCL', 'Standard', 'Montreal',
    'Montreal, Halifax, YUL', 5, 28, 5, 4, 3, 'TJX', 45, '', ''],

  // --- Florida (US East): the real Los Angeles port -----------------------
  ['China', 'Florida (US East)', 'OCEAN', 'FCL', 'Standard', 'Los Angeles',
    'Los Angeles, LA, LAX, Long Beach, Longbeach', 5, 20, 5, 4, 5, 'CIS', 39, '', ''],
  ['China', 'Florida (US East)', 'OCEAN', 'FCL', 'Peak Season', 'Los Angeles',
    'Los Angeles, LA, LAX, Long Beach, Longbeach', 6, 26, 7, 4, 5, 'CIS', 48, '', ''],
  ['China', 'Florida (US East)', 'AIR', 'AIR', 'Standard', 'Miami',
    'Miami, MIA', 2, 3, 1, 1, 2, 'CIS', 9, '', ''],

  // --- Alberta: single port, Standard only --------------------------------
  ['China', 'Alberta (Edmonton)', 'OCEAN', 'FCL', 'Standard', 'Vancouver',
    'Vancouver, YVR', 5, 22, 4, 3, 9, 'TJX', 43, '', ''],

  // --- Victoria (AU) ------------------------------------------------------
  ['China', 'Victoria (AU)', 'OCEAN', 'FCL', 'Standard', 'Melbourne',
    'Melbourne, MEL', 5, 26, 4, 5, 4, 'CREDO', 44, '', ''],

  // --- FEDEX: Standard rows ONLY. Exercises "skip the season filter rather
  //     than return nothing" when a Peak-Season ready date is supplied.
  ['CIS (Florida)', 'Ontario (GTA)', 'FEDEX', 'Ground', 'Standard', 'Buffalo',
    'Buffalo, BUF', 1, 3, 0, 1, 1, 'CIS', 6, '', ''],
  ['CIS (Florida)', 'Ontario (GTA)', 'FEDEX', 'IP', 'Standard', 'Buffalo',
    'Buffalo, BUF', 1, 1, 0, 1, 1, 'CIS', 4, '', ''],

  // --- TRUCKING: the Travel_Type this port's TRAVEL_TYPE_LABELS was missing -
  ['CIS (Florida)', 'Ontario (GTA)', 'TRUCKING', 'FTL', 'Standard', 'Detroit',
    'Detroit, DTW', 1, 2, 0, 1, 1, 'CIS', 5, '', ''],

  // --- A lane with a blank Total_Est_Days (must be skipped by slowest-wins) -
  ['China', 'Ontario (GTA)', 'AIR', 'AIR', 'Standard', 'Toronto Pearson',
    'Toronto, YYZ', 2, 4, 1, 2, 2, 'TJX', '', '', ''],

  // --- A junk row: no origin. getTransitTimeTable_ must drop it ------------
  ['', 'Ontario (GTA)', 'OCEAN', 'FCL', 'Standard', 'Nowhere', '', 1, 1, 1, 1, 1, '', 5, '', '']
];

// Delivery_Address: col A is whatever, col B is the Destination.
const DELIVERY_ADDRESS = [
  ['Address', 'Destination'],
  ['1 Main St, Orangeville ON', 'RTF'],
  ['9 Depot Rd, Bolton ON', 'CAVALIER (RTF STORAGE)'],
  ['60 Dock Way, Brampton ON', 'TJX Canada Distribution Center (TDC)'],
  ['100 Bunzl Rd, Burlington ON', 'BUNZL Canada Burlington 60604'],
  ['5 Edmonton Trail, Edmonton AB', 'BUNZL Canada CH TJX Edmonton 61611'],
  ['22 Waverley Rd, Mount Waverley VIC', 'CREDO'],
  ['3 Stuart Ave, Stuart FL', 'CIS Security Solutions'],
  ['duplicate row, same dock', 'RTF'],
  // Unmapped: must be LOGGED AND SKIPPED, never fuzzy-matched.
  ['77 Unknown Way, Nowhere', 'SOME NEW DOCK NOBODY MAPPED'],
  ['', '']
];

// Config: portLabel | legName | value  (drives getPortGroups_)
const CONFIG = [
  ['Port', 'Leg', 'Days'],
  ['Miami', 'ESTIMATED DEPARTURE', '5'],
  ['Miami', 'PORT TO PORT', '35'],
  ['Miami', 'CLEARANCE, DELIVERY', '7'],
  ['Long Beach', 'ESTIMATED DEPARTURE', '5'],
  ['Long Beach', 'PORT TO PORT', '20'],
  ['Long Beach', 'CLEARANCE, DELIVERY', '14'],
  ['Los Angeles', 'ESTIMATED DEPARTURE', '5'],
  ['Los Angeles', 'PORT TO PORT', '20'],
  ['Los Angeles', 'CLEARANCE, DELIVERY', '14'],
  ['Rotterdam', 'ESTIMATED DEPARTURE', 'not a number'],
  ['Rotterdam', 'PORT TO PORT', '12']
];

const WORKBOOK = {
  'Transit_Time': TRANSIT_TIME,
  'Delivery_Address': DELIVERY_ADDRESS,
  'Config': CONFIG
};

/* ==========================================================================
 * SRC side -- a fake SpreadsheetApp over WORKBOOK.
 * ========================================================================== */

/**
 * @param {Array<Array<*>>} rows
 * @return {Object} something SRC's SpreadsheetApp calls are happy with.
 */
function fakeSheet(rows) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    getDataRange: () => ({getValues: () => rows.map((r) => r.slice())}),
    getLastRow: () => rows.length,
    getLastColumn: () => width,
    getRange: function(row, col, numRows, numCols) {
      if (numRows === undefined) {
        // getRange(row, col) -> single cell
        return {getValue: () => (rows[row - 1] ? rows[row - 1][col - 1] : undefined)};
      }
      const out = [];
      for (let r = row; r < row + numRows; r++) {
        const line = [];
        for (let c = col; c < col + numCols; c++) {
          line.push(rows[r - 1] ? rows[r - 1][c - 1] : undefined);
        }
        out.push(line);
      }
      return {getValues: () => out, setValues: () => {}, setFontWeight: () => {}};
    }
  };
}

/**
 * SRC's formatDateCell_ is
 * `Utilities.formatDate(date, ss.getSpreadsheetTimeZone(), "MM/dd/yyyy")` --
 * it formats in the SPREADSHEET's timezone, where the port formats in the
 * container's (see the port's own comment on that function).
 *
 * The harness deliberately pins the fake spreadsheet's timezone to the process
 * timezone. Otherwise this would be comparing Java's SimpleDateFormat against
 * Node's Date across two zones, which tests the harness, not the port. What is
 * under test here is the date ARITHMETIC and the lane logic on top of it.
 *
 * Implemented via Intl rather than by copying the port's line, so it is an
 * independent implementation of the same spec and a port-side mistake still
 * shows up.
 */
const PROCESS_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * @param {Date} date
 * @param {string} tz
 * @param {string} fmt only "MM/dd/yyyy" is implemented.
 * @return {string}
 */
function utilitiesFormatDate(date, tz, fmt) {
  if (fmt !== 'MM/dd/yyyy') {
    throw new Error('parity harness implements only MM/dd/yyyy, got ' + fmt);
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return get('month') + '/' + get('day') + '/' + get('year');
}

const srcLog = [];
const sandbox = {
  PropertiesService: {
    getScriptProperties: () => ({getProperty: () => null, setProperty: () => {}})
  },
  Logger: {log: (m) => srcLog.push(String(m))},
  Utilities: {
    sleep: () => {},
    getUuid: () => 'uuid',
    formatDate: utilitiesFormatDate
  },
  UrlFetchApp: {fetch: () => { throw new Error('no network in parity harness'); }},
  Session: {getActiveUser: () => ({getEmail: () => 'parity@test'})},
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => (WORKBOOK[name] ? fakeSheet(WORKBOOK[name]) : null),
      getSheets: () => [],
      getSpreadsheetTimeZone: () => PROCESS_TZ
    })
  },
  console, Intl,
  JSON, Math, String, Number, Object, Array, RegExp, Date, parseInt, parseFloat, isNaN, isFinite
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(srcPath, 'utf8'), sandbox, {filename: srcPath});

/* ==========================================================================
 * Port side -- stub SS_API with the same workbook before requiring the module.
 * ========================================================================== */

/**
 * Resolves an A1 range against WORKBOOK the way the real Sheets API would, for
 * the four shapes Service_Dates asks for: "Tab!A:N", "Tab!A:B", "Tab!1:2" and
 * "Tab!A:S".
 *
 * @param {string} range
 * @return {Array<Array<*>>}
 */
function resolveRange(range) {
  const bang = String(range).indexOf('!');
  const tab = bang === -1 ? range : range.slice(0, bang);
  const spec = bang === -1 ? '' : range.slice(bang + 1);
  const rows = WORKBOOK[tab];
  if (!rows) throw new Error(tab + ' sheet not found');

  const colSpan = spec.match(/^([A-Z]+):([A-Z]+)$/);
  if (colSpan) {
    const toIdx = (s) => {
      let n = 0;
      for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
      return n - 1;
    };
    const a = toIdx(colSpan[1]);
    const b = toIdx(colSpan[2]);
    return rows.map((r) => r.slice(a, b + 1));
  }

  const rowSpan = spec.match(/^(\d+):(\d+)$/);
  if (rowSpan) {
    return rows.slice(Number(rowSpan[1]) - 1, Number(rowSpan[2])).map((r) => r.slice());
  }

  return rows.map((r) => r.slice());
}

const ssApiPath = require.resolve(path.join(ROOT, 'functions/services/Service_SheetsAPI.js'));
require.cache[ssApiPath] = {
  id: ssApiPath, filename: ssApiPath, loaded: true, exports: {
    getSheetValues: async (range) => resolveRange(range),
    batchUpdateValues: async () => {},
    batchAppendRows: async () => {},
    batchUpdateSheet: async () => ({}),
    getSheetId: async () => 0
  }
};

const port = require(portPath);

/* ==========================================================================
 * Comparison
 * ========================================================================== */

let checks = 0;
const failures = [];
const covered = new Set();

/**
 * @param {*} v
 * @return {string}
 */
function j(v) {
  return JSON.stringify(v, (k, val) => (val === undefined ? '<undefined>' : val));
}

/**
 * @param {string} name label, used in failure output.
 * @param {Function} srcFn the SRC (synchronous) function.
 * @param {Function} portFn the ported (async) function.
 * @param {Array<Array<*>>} argSets
 * @return {Promise<void>}
 */
async function cmp(name, srcFn, portFn, argSets) {
  covered.add(name.replace(/\s*\[.*\]$/, ''));
  if (typeof srcFn !== 'function') {
    failures.push(name + ': not found in SRC sandbox');
    return;
  }
  if (typeof portFn !== 'function') {
    failures.push(name + ': not exported by the port');
    return;
  }
  for (const args of argSets) {
    checks++;
    let a;
    let b;
    try { a = j(srcFn.apply(null, args)); } catch (e) { a = 'THREW: ' + e.message; }
    try { b = j(await portFn.apply(null, args)); } catch (e) { b = 'THREW: ' + e.message; }
    if (a !== b) {
      failures.push(name + '(' + j(args) + ')\n    SRC : ' + a + '\n    PORT: ' + b);
    }
  }
}

const one = (arr) => arr.map((x) => [x]);

/* ---- corpora ------------------------------------------------------------ */

const DATE_CELLS = [
  null, '', 0, '  ', 'not a date', '08/15/2026', '1/2/2026', '12/31/2026',
  '2026-08-15', 'August 15, 2026', new Date(2026, 7, 15), new Date('nonsense'),
  '13/45/2026', '02/30/2026'
];

const READY_DATES = [
  '01/15/2026', // Standard
  '09/01/2026', // inside the Aug 15 - Nov 15 peak window
  '08/15/2026', // exactly the window's first day
  '11/15/2026', // exactly the window's last day
  '11/16/2026', // one day after
  '12/20/2026'
];

const TRAVEL_TYPES = [null, '', 'OCEAN', 'ocean', 'AIR', 'FEDEX', 'TRUCKING', 'NOPE'];
const ORIGINS = [null, '', 'China', 'china', 'CIS (Florida)', 'Mars'];
const DESTINATIONS = [
  null, '', 'Ontario (GTA)', 'ontario (gta)', 'Florida (US East)', 'Alberta (Edmonton)',
  // literal Delivery_Address docks -- these MUST resolve back to their cluster
  'RTF', 'BUNZL Canada Burlington 60604', 'CREDO', 'CIS Security Solutions',
  'TJX Canada Distribution Center (TDC)', 'SOME NEW DOCK NOBODY MAPPED'
];
const PORTS = [
  undefined, null, '', 'Vancouver', 'Prince Rupert', 'LA to Toronto (IPI)',
  'Montreal', 'Los Angeles', 'Buffalo', 'Nowhere'
];
const LOAD_TYPES = [undefined, null, '', 'FCL', 'LCL', 'Ground', 'IP', 'FTL', 'NOPE'];

const PORT_TEXTS = [
  null, '', 'Vancouver', 'VANCOUVER', 'Los Angeles', 'LA', 'LAX', 'Longbeach',
  'Long Beach', 'Prince Rupert', 'Montreal', 'Halifax', 'Miami', 'YVR',
  'Shipping via Los Angeles', 'unknown port', 'LA to Toronto (IPI)'
];

const TRANSIT_MODES = [
  null, '', 'Ocean Freight', 'sea', 'AIR', 'FedEx', 'UPS Ground', 'Truck Lines',
  'Standard / Ground', 'nonsense'
];

/* ---- SHIPMENTS rows for computeShipmentDates_ ---------------------------- */
// [cardId, direction, board, entity, transitMode, scheduled, listStatus,
//  lineItems, masterTracking, rollup, rtsDate, rtsBasis, etaDate, etaBasis,
//  dateState, portOfArrival, lastAutoDue, etaOverridden]
const SHIPMENT_ROWS = [
  ['c1', 'Inbound', 'B', 'TJX', 'Ocean Freight', '', 'OCEAN FREIGHT', 'x', '', '',
    '01/15/2026', 'ESTIMATE', '', '', '', 'Vancouver', '', ''],
  ['c2', 'Inbound', 'B', 'TJX', 'Ocean Freight', '', 'OCEAN FREIGHT', 'x', '', '',
    '09/01/2026', 'ESTIMATE', '', '', '', 'Vancouver', '', ''],
  // The port-collision case: Florida-bound, declared as "Los Angeles".
  ['c3', 'Inbound', 'B', 'CIS', 'Ocean Freight', '', 'OCEAN FREIGHT', 'x', '', '',
    '01/15/2026', 'SUPPLIER_CONFIRMED', '', '', '', 'Los Angeles', '', ''],
  // Free-text that only matches via a Port_Keyword alias.
  ['c4', 'Inbound', 'B', 'CIS', 'Ocean Freight', '', 'OCEAN FREIGHT', 'x', '', '',
    '01/15/2026', 'ESTIMATE', '', '', '', 'Shipping via Longbeach', '', ''],
  // No lane match at all -> falls back to the Config port-group math.
  ['c5', 'Inbound', 'B', 'CIS', 'Ocean Freight', '', 'OCEAN FREIGHT', 'x', '', '',
    '01/15/2026', 'ESTIMATE', '', '', '', 'Miami', '', ''],
  // No port at all -> generic transit-mode lead time.
  ['c6', 'Inbound', 'B', 'CIS', 'Air Freight', '', 'AIR FREIGHT', 'x', '', '',
    '01/15/2026', 'ESTIMATE', '', '', '', '', '', ''],
  // ARRIVED: both dates freeze.
  ['c7', 'Inbound', 'B', 'CIS', 'Ocean Freight', '02/20/2026', 'DELIVERED', 'x', '', 'DELIVERED',
    '01/15/2026', 'ACTUAL', '', '', '', 'Vancouver', '', ''],
  // IN_TRANSIT: has a master tracking number.
  ['c8', 'Inbound', 'B', 'CIS', 'FedEx', '02/01/2026', 'IN TRANSIT', 'x', '794123456789', '',
    '01/15/2026', 'ESTIMATE', '', '', '', 'Buffalo', '', ''],
  // NO_DATES.
  ['c9', 'Inbound', 'B', 'CIS', 'Ocean Freight', '', 'OCEAN FREIGHT', 'x', '', '',
    '', '', '', '', '', '', '', ''],
  // Overridden -> CONFIRMED, our math must not win.
  ['c10', 'Inbound', 'B', 'CIS', 'Ocean Freight', '03/03/2026', 'OCEAN FREIGHT', 'x', '', '',
    '01/15/2026', 'ESTIMATE', '', '', '', 'Vancouver', '01/01/2026', 'MANUAL'],
  // Existing CARRIER basis is sticky.
  ['c11', 'Inbound', 'B', 'CIS', 'Ocean Freight', '', 'OCEAN FREIGHT', 'x', '', '',
    '01/15/2026', 'ESTIMATE', '04/04/2026', 'CARRIER', '', 'Vancouver', '', ''],
  // No RTS but a scheduled date -> SUPPLIER.
  ['c12', 'Inbound', 'B', 'CIS', 'Ocean Freight', '05/05/2026', 'OCEAN FREIGHT', 'x', '', '',
    '', '', '', '', '', 'Vancouver', '', ''],
  // Bogus basis -> normalised.
  ['c13', 'Inbound', 'B', 'CIS', 'Ocean Freight', '', 'OCEAN FREIGHT', 'x', '', '',
    '01/15/2026', 'WHATEVER', '', '', '', 'Vancouver', '', '']
];

/* ---- run ---------------------------------------------------------------- */

/**
 * @return {Promise<void>}
 */
async function main() {
  // --- pure helpers -------------------------------------------------------
  await cmp('parseDateCell_', sandbox.parseDateCell_, port.parseDateCell_, one(DATE_CELLS));
  // Invalid Date is deliberately excluded, and it is the one input where the
  // two genuinely differ: SRC's Utilities.formatDate THROWS on it, the port
  // returns "". Unreachable in practice (every caller passes a parseDateCell_
  // result, which is null for anything unparseable) and "" is the safer of the
  // two answers for a value headed into a sheet cell -- see the port's comment.
  await cmp('formatDateCell_', sandbox.formatDateCell_, port.formatDateCell_,
      one([null, '', 0, new Date(2026, 7, 15), new Date(2026, 0, 2), new Date(2026, 11, 31),
        new Date(2026, 1, 28), new Date(2027, 0, 1)]));
  await cmp('addDays_', sandbox.addDays_, port.addDays_,
      [[new Date(2026, 0, 15), 0], [new Date(2026, 0, 15), 39], [new Date(2026, 0, 15), -39],
        [new Date(2026, 11, 20), 20], [new Date(2026, 2, 1), -60]]);
  await cmp('addBusinessDays_', sandbox.addBusinessDays_, port.addBusinessDays_,
      [[new Date(2026, 0, 15), 0], [new Date(2026, 0, 15), 5], [new Date(2026, 0, 16), 1],
        [new Date(2026, 0, 17), 1], [new Date(2026, 0, 18), 1], [new Date(2026, 0, 15), 14]]);
  await cmp('leadTimeDaysForMode_', sandbox.leadTimeDaysForMode_, port.leadTimeDaysForMode_,
      one(TRANSIT_MODES));
  await cmp('mapTransitModeToTravelType_', sandbox.mapTransitModeToTravelType_,
      port.mapTransitModeToTravelType_, one(TRANSIT_MODES));

  // --- sheet-backed, now deterministic ------------------------------------
  await cmp('getPeakSeasonWindow_', sandbox.getPeakSeasonWindow_, port.getPeakSeasonWindow_, [[]]);
  await cmp('isPeakSeasonForDate_', sandbox.isPeakSeasonForDate_, port.isPeakSeasonForDate_,
      one(READY_DATES.map((d) => new Date(d)).concat([null])));
  await cmp('resolveTransitDestinationCluster_', sandbox.resolveTransitDestinationCluster_,
      port.resolveTransitDestinationCluster_, one(DESTINATIONS));
  await cmp('getDeliveryDestinationCatalog_', sandbox.getDeliveryDestinationCatalog_,
      port.getDeliveryDestinationCatalog_, [[]]);
  await cmp('getTransitLaneCatalog', sandbox.getTransitLaneCatalog,
      port.getTransitLaneCatalog, [[]]);

  // --- findTransitLane_: the explicit-selection convention ----------------
  const laneOptsExplicit = [];
  ['OCEAN', 'FEDEX', 'TRUCKING', 'AIR'].forEach((tt) => {
    ['China', 'CIS (Florida)'].forEach((o) => {
      DESTINATIONS.forEach((d) => {
        PORTS.forEach((p) => {
          laneOptsExplicit.push([{
            travelType: tt, origin: o, destination: d, port: p,
            readyDate: new Date('01/15/2026')
          }]);
        });
      });
    });
  });
  await cmp('findTransitLane_ [explicit]', sandbox.findTransitLane_, port.findTransitLane_,
      laneOptsExplicit);

  // Peak-season round, and the loadTypePreference tiebreak.
  const laneOptsSeasonal = [];
  READY_DATES.forEach((rd) => {
    LOAD_TYPES.forEach((lt) => {
      ['Ontario (GTA)', 'Florida (US East)', 'RTF'].forEach((d) => {
        laneOptsSeasonal.push([{
          travelType: 'OCEAN', origin: 'China', destination: d,
          loadTypePreference: lt, readyDate: new Date(rd)
        }]);
      });
      laneOptsSeasonal.push([{
        travelType: 'FEDEX', origin: 'CIS (Florida)', destination: 'Ontario (GTA)',
        loadTypePreference: lt, readyDate: new Date(rd)
      }]);
    });
  });
  await cmp('findTransitLane_ [seasonal]', sandbox.findTransitLane_, port.findTransitLane_,
      laneOptsSeasonal);

  // --- findTransitLane_: the free-text portText convention ----------------
  // This is the block that had lost its exact-Port-first step. The
  // "Los Angeles" entries are the 2026-08-21 collision bug.
  const laneOptsPortText = [];
  PORT_TEXTS.forEach((pt) => {
    TRANSIT_MODES.forEach((tm) => {
      laneOptsPortText.push([{
        portText: pt,
        travelType: sandbox.mapTransitModeToTravelType_(tm),
        readyDate: new Date('01/15/2026')
      }]);
    });
  });
  await cmp('findTransitLane_ [portText]', sandbox.findTransitLane_, port.findTransitLane_,
      laneOptsPortText);

  // --- the two client-callable estimators ---------------------------------
  const estimatorArgs = [];
  READY_DATES.concat(['', null, 'garbage']).forEach((d) => {
    TRAVEL_TYPES.forEach((tt) => {
      ORIGINS.forEach((o) => {
        ['Ontario (GTA)', 'RTF', 'Florida (US East)', '', null].forEach((dest) => {
          PORTS.forEach((p) => {
            estimatorArgs.push([d, tt, o, dest, p, undefined]);
          });
        });
      });
    });
  });
  // A smaller cross-product with load types, so the arg list stays sane.
  LOAD_TYPES.forEach((lt) => {
    READY_DATES.forEach((d) => {
      PORTS.forEach((p) => {
        estimatorArgs.push([d, 'OCEAN', 'China', 'Ontario (GTA)', p, lt]);
      });
    });
  });

  await cmp('estimateShippingWindowV2', sandbox.estimateShippingWindowV2,
      port.estimateShippingWindowV2, estimatorArgs);
  await cmp('estimateShipByDateV2', sandbox.estimateShipByDateV2,
      port.estimateShipByDateV2, estimatorArgs);

  // --- the older port-group estimator (v1) --------------------------------
  const v1Args = [];
  READY_DATES.concat(['', null]).forEach((d) => {
    PORT_TEXTS.forEach((p) => {
      v1Args.push([d, p, 'Ocean Freight']);
    });
  });
  await cmp('estimateShippingWindow', sandbox.estimateShippingWindow,
      port.estimateShippingWindow, v1Args);

  // --- the state machine over real-shaped SHIPMENTS rows ------------------
  await cmp('computeShipmentDates_', sandbox.computeShipmentDates_, port.computeShipmentDates_,
      one(SHIPMENT_ROWS));

  // --- report -------------------------------------------------------------
  console.log('\nran ' + checks + ' comparisons across ' + covered.size + ' functions');
  if (failures.length === 0) {
    console.log('SERVICE_DATES PARITY OK — every output identical to SRC\n');
  } else {
    console.log('\n' + failures.length + ' DIFFERENCE(S):\n');
    failures.slice(0, 40).forEach((f) => console.log('  ' + f));
    if (failures.length > 40) console.log('  … and ' + (failures.length - 40) + ' more');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
