/**
 * ============================================================================
 * PARITY HARNESS -- the two aging-anchor derivations
 * ============================================================================
 * `buildAgingData_` (Service_Read.js) and `resolveOriginalArrivalDate`
 * (Service_Write.js) are the only two places the portal decides HOW OLD the
 * stock in a location is. Everything the heatmap colours, and every dwell-clock
 * figure an operator sees, comes out of these two functions reading Audit_Log.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Both were wrong in this port, in ways that produce no error and no log line
 * -- a location simply reads as "unknown age" forever. Found 2026-08-28 while
 * porting Service_Conversions:
 *
 *  1. **`EXPLODE_ASSEMBLY` is a string nothing ever writes.** Both functions
 *     listed it as a valid anchor. Every explode path in Service_Assembly.js
 *     logs `EXPLODE_RESTORE` (:183, :200, :209), which is what SRC lists. So
 *     every component row an explode returned to the floor had no anchor at all.
 *  2. **`SPLIT_IN` was missing from both lists**, even though this port's own
 *     copy of splitInventoryRow's comment says it had to be added to both. The
 *     comment was ported; the code was not. A location holding only split-off
 *     rows had no anchor either.
 *  3. **`resolveOriginalArrivalDate` used a two-way substring test** where SRC
 *     uses `namesMatch_`. SRC's comment: matching a sibling in the same product
 *     family (T25-SCREW vs T25-SCREWDRIVER) donated the WRONG lot's date.
 *  4. **The carried-date branch checked `MOVE_IN` only**, so even a recognised
 *     `SPLIT_IN` row would have reset the dwell clock to the moment of the
 *     split instead of inheriting the lot's true arrival.
 *
 * SCHEMA invariant #69 is about exactly this class of failure: it records that
 * an earlier version of the identity fix would have shipped a 20-anchor
 * regression invisibly, "each affected location simply reading 'unknown age'
 * on the heatmap for no reason a user could see". Prose is not enough to hold
 * that; this file executes it.
 *
 * The corpus below is built so each of the four bugs produces a visible
 * difference. Verified by mutation -- see PHASE_4_NOTES.md.
 *
 *   npm run test:parity:aging
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..');
const srcShared = path.join(ROOT, 'SRC/src/Shared_Classifiers.js');
const srcRead = path.join(ROOT, 'SRC/src/Service_Read.js');
const srcWrite = path.join(ROOT, 'SRC/src/Service_Write.js');
// Needed even though nothing here is about conversions: SRC defines
// getQbNameIndex_ inside Service_Conversions.js, and Shared_Classifiers'
// productIdentityKey_ -- which namesMatch_ consults FIRST -- reaches it through
// Apps Script's single global namespace. Without this file loaded, SRC's
// namesMatch_ silently degrades to plain-key comparison and stops resolving
// nicknames, which would make the port look wrong when it is right.
const srcConv = path.join(ROOT, 'SRC/src/Service_Conversions.js');

if (!fs.existsSync(srcWrite)) {
  console.log('SKIP: ' + srcWrite + ' not present (SRC/ is gitignored -- it lives on the ' +
              'porting machine only). Nothing to compare against.');
  process.exit(0);
}

/* ==========================================================================
 * The synthetic workbook
 * ========================================================================== */

const T = (d) => new Date(d).toISOString();

// Audit_Log: A timestamp | B location | C sku | D action | E delta | F newQty
//            | G operator | H carried original-arrival date
const AUDIT_LOG = [
  ['Timestamp', 'Location', 'SKU', 'Action', 'Delta', 'New Qty', 'Operator', 'Original_Arrival'],

  // --- a normal arrival, then a move that carries the original date --------
  [T('2026-01-05'), 'SWH-A-01', 'V32', 'PO_RECEIVED', 100, 100, 'op@x', ''],
  [T('2026-03-10'), 'SWH-B-02', 'V32', 'MOVE_IN', 100, 100, 'op@x', T('2026-01-05')],
  [T('2026-03-10'), 'SWH-A-01', 'V32', 'MOVE_OUT', -100, 0, 'op@x', ''],

  // --- SPLIT_IN: the whole point of bug (2) and (4).
  //     A location whose ONLY row is a split-off one. If SPLIT_IN is not a
  //     valid action this location has no anchor at all; if the carried-date
  //     branch ignores SPLIT_IN, its clock resets to 2026-04-01 instead of
  //     inheriting 2026-01-05.
  [T('2026-04-01'), 'SWH-C-03', 'V32', 'SPLIT_IN', 40, 40, 'op@x', T('2026-01-05')],
  [T('2026-04-01'), 'SWH-B-02', 'V32', 'SPLIT_OUT', -40, 60, 'op@x', ''],

  // --- EXPLODE_RESTORE: bug (1). A component returned to the floor by an
  //     explode. Listed as EXPLODE_ASSEMBLY in the port, which nothing writes.
  [T('2026-05-02'), 'SWH-D-04', 'T25-SCREW', 'EXPLODE_RESTORE', 12, 12, 'op@x', ''],

  // --- the sibling trap: bug (3). Two products in one family, in ONE
  //     location. A two-way substring test matches T25-SCREW against
  //     T25-SCREWDRIVER and donates the wrong lot's date.
  [T('2026-02-01'), 'SWH-E-05', 'T25-SCREW', 'STOW', 50, 50, 'op@x', ''],
  [T('2026-06-01'), 'SWH-E-05', 'T25-SCREWDRIVER', 'STOW', 5, 5, 'op@x', ''],

  // --- more of the same family, reversed order, to catch a one-way fix -----
  [T('2026-02-15'), 'SWH-F-06', 'T25-SCREWDRIVER', 'STOW', 9, 9, 'op@x', ''],
  [T('2026-07-01'), 'SWH-F-06', 'T25-SCREW', 'ADD', 3, 12, 'op@x', ''],

  // --- CONVERT_IN, INITIAL_STOW ------------------------------------------
  [T('2026-01-20'), 'SWH-G-07', 'Burlington Scorpion Tag Case', 'CONVERT_IN', 205, 205, 'op@x', ''],
  [T('2026-01-02'), 'SWH-H-08', 'V32', 'INITIAL_STOW', 10, 10, 'op@x', ''],

  // --- actions that must NEVER anchor -------------------------------------
  [T('2026-08-01'), 'SWH-A-01', 'V32', 'SET_TOTAL', 0, 7, 'op@x', ''],
  [T('2026-08-02'), 'SWH-A-01', 'V32', 'REMOVE', -1, 6, 'op@x', ''],
  [T('2026-08-03'), 'SWH-A-01', 'V32', 'VERIFIED', 0, 6, 'op@x', ''],
  [T('2026-08-04'), 'SWH-A-01', 'V32', 'CONVERT_OUT', -6, 0, 'op@x', ''],

  // --- a blank SKU: must not act as a wildcard anchor ---------------------
  [T('2026-08-05'), 'SWH-I-09', '', 'ADD', 5, 5, 'op@x', ''],
  [T('2026-08-06'), 'SWH-I-09', '   ', 'STOW', 5, 5, 'op@x', ''],

  // --- a carried date that is junk (the timestamp itself stays valid; an
  //     unparseable TIMESTAMP is its own case, see BAD_TIMESTAMP_ROW below) --
  [T('2026-08-07'), 'SWH-J-10', 'V32', 'STOW', 1, 1, 'op@x', ''],
  [T('2026-08-08'), 'SWH-J-10', 'V32', 'MOVE_IN', 1, 1, 'op@x', 'also not a date'],

  // --- the nickname / QB-name pair, so namesMatch_'s identity resolution is
  //     actually exercised rather than just its literal comparison.
  [T('2026-02-10'), 'SWH-K-11', 'NT525S/2AMF', 'PO_RECEIVED', 500, 500, 'op@x', ''],
  [T('2026-09-01'), 'SWH-K-11', '2 Alarm SMALL Scorpion Tag', 'MOVE_IN', 100, 600, 'op@x', T('2026-02-10')]
];

const PRODUCT = [
  ['Product ID', 'Nickname'],
  ['NT525S/2AMF', '2 Alarm SMALL Scorpion Tag'],
  ['V32', 'Verso Tag'],
  ['T25-SCREW', 'Screw'],
  ['T25-SCREWDRIVER', 'Screwdriver']
];

/**
 * One row with an unparseable TIMESTAMP, held out of the shared corpus above
 * because it is the one input where SRC and the port genuinely disagree -- and
 * where the port is right. Asserted separately at the end of main() rather than
 * dropped, so the divergence is recorded and pinned instead of hidden.
 *
 * SRC (Service_Read.js:635-637):
 *
 *     let parsedDate = ... new Date(Date.parse(rawTimestamp));
 *     if (parsedDate) {                      // an Invalid Date is TRUTHY
 *       const entry = { date: parsedDate.toISOString(), ... };   // RangeError
 *
 * `new Date('garbage').toISOString()` throws `RangeError: Invalid time value`,
 * which escapes the forEach into buildAgingData_'s `catch (e) { return {}; }`.
 * So in the original, ONE malformed timestamp anywhere in Audit_Log blanks the
 * ENTIRE aging map -- every location on the heatmap reads "unknown age", with
 * no error surfaced anywhere. The port guards with `!isNaN(getTime())` and
 * skips just that row.
 */
const BAD_TIMESTAMP_ROW = ['not a date', 'SWH-J-10', 'V32', 'STOW', 1, 1, 'op@x', ''];

const WORKBOOK = {
  'Audit_Log': AUDIT_LOG,
  'PRODUCT': PRODUCT
};

/* ==========================================================================
 * SRC side
 * ========================================================================== */

/**
 * @param {Array<Array<*>>} rows
 * @return {Object}
 */
function fakeSheet(rows) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    getDataRange: () => ({getValues: () => rows.map((r) => r.slice())}),
    getLastRow: () => rows.length,
    getLastColumn: () => width,
    getRange: function(row, col, numRows, numCols) {
      if (numRows === undefined) {
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

const sandbox = {
  PropertiesService: {
    getScriptProperties: () => ({getProperty: () => null, setProperty: () => {}})
  },
  Logger: {log: () => {}},
  Utilities: {
    sleep: () => {},
    getUuid: () => 'uuid',
    formatDate: (d) => d.toISOString()
  },
  UrlFetchApp: {fetch: () => { throw new Error('no network in parity harness'); }},
  Session: {getActiveUser: () => ({getEmail: () => 'parity@test'})},
  CacheService: {
    getScriptCache: () => ({get: () => null, put: () => {}, remove: () => {}})
  },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => (WORKBOOK[name] ? fakeSheet(WORKBOOK[name]) : null),
      getSheets: () => [],
      getSpreadsheetTimeZone: () => 'UTC'
    })
  },
  console, Intl,
  JSON, Math, String, Number, Object, Array, RegExp, Date, Set, Map,
  parseInt, parseFloat, isNaN, isFinite
};
vm.createContext(sandbox);
// One namespace, load order as Apps Script concatenates them.
vm.runInContext(fs.readFileSync(srcShared, 'utf8'), sandbox, {filename: srcShared});
vm.runInContext(fs.readFileSync(srcConv, 'utf8'), sandbox, {filename: srcConv});
vm.runInContext(fs.readFileSync(srcRead, 'utf8'), sandbox, {filename: srcRead});
vm.runInContext(fs.readFileSync(srcWrite, 'utf8'), sandbox, {filename: srcWrite});

/* ==========================================================================
 * Port side
 * ========================================================================== */

/**
 * @param {string} range
 * @return {Array<Array<*>>}
 */
function resolveRange(range) {
  const bang = String(range).indexOf('!');
  const tab = bang === -1 ? range : range.slice(0, bang);
  const spec = bang === -1 ? '' : range.slice(bang + 1);
  const rows = WORKBOOK[tab];
  if (!rows) throw new Error(tab + ' sheet not found');

  const toIdx = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  };
  const colSpan = spec.match(/^([A-Z]+):([A-Z]+)$/);
  if (colSpan) {
    const a = toIdx(colSpan[1]);
    const b = toIdx(colSpan[2]);
    return rows.map((r) => r.slice(a, b + 1));
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
    getSheetMetadata: async () => ({sheetId: 0}),
    getSheetId: async () => 0,
    clearSheetMetadataCache: () => {}
  }
};

const portRead = require(path.join(ROOT, 'functions/services/Service_Read.js'));
const portWrite = require(path.join(ROOT, 'functions/services/Service_Write.js'));

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
 * @param {string} name
 * @param {Function} srcFn
 * @param {Function} portFn
 * @param {Array<Array<*>>} argSets
 * @return {Promise<void>}
 */
async function cmp(name, srcFn, portFn, argSets) {
  covered.add(name);
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

const LOCATIONS = [
  'SWH-A-01', 'SWH-B-02', 'SWH-C-03', 'SWH-D-04', 'SWH-E-05', 'SWH-F-06',
  'SWH-G-07', 'SWH-H-08', 'SWH-I-09', 'SWH-J-10', 'SWH-K-11', 'NOWHERE', '', null
];

const SKUS = [
  'V32', 'Verso Tag', 'T25-SCREW', 'T25-SCREWDRIVER', 'NT525S/2AMF',
  '2 Alarm SMALL Scorpion Tag', 'Burlington Scorpion Tag Case',
  'v32', '  V32  ', 'T25', 'SCREW', '', null, 'unknown'
];

/**
 * @return {Promise<void>}
 */
async function main() {
  // The whole map in one shot -- covers every location and every action class.
  await cmp('buildAgingData_', sandbox.buildAgingData_, portRead.buildAgingData_, [[]]);

  // Every location x SKU pair, which is where the sibling trap and the
  // carried-date branch both live.
  const pairs = [];
  LOCATIONS.forEach((loc) => SKUS.forEach((sku) => pairs.push([loc, sku])));
  await cmp('resolveOriginalArrivalDate_', sandbox.resolveOriginalArrivalDate_,
      portWrite.resolveOriginalArrivalDate, pairs);

  // --- the one deliberate divergence, pinned rather than hidden -----------
  // See BAD_TIMESTAMP_ROW. Injected last so nothing above is affected.
  AUDIT_LOG.push(BAD_TIMESTAMP_ROW);
  checks++;
  const srcWithBad = sandbox.buildAgingData_();
  const portWithBad = await portRead.buildAgingData_();
  if (Object.keys(srcWithBad).length !== 0) {
    failures.push('BAD_TIMESTAMP divergence: expected SRC to blank the whole map ' +
      '(its documented RangeError path), got ' + Object.keys(srcWithBad).length + ' location(s). ' +
      'If SRC has been fixed upstream, delete BAD_TIMESTAMP_ROW and fold the row back ' +
      'into AUDIT_LOG.');
  } else if (Object.keys(portWithBad).length < 9) {
    failures.push('BAD_TIMESTAMP divergence: the port should skip only the malformed row, ' +
      'but it returned ' + Object.keys(portWithBad).length + ' location(s).');
  } else {
    console.log('\n  deliberate divergence, verified:');
    console.log('    one unparseable Audit_Log timestamp ->');
    console.log('      SRC : {} (whole aging map lost — RangeError swallowed by its catch)');
    console.log('      PORT: ' + Object.keys(portWithBad).length +
      ' locations (skips the bad row only)');
  }

  console.log('\nran ' + checks + ' comparisons across ' + covered.size + ' functions');
  if (failures.length === 0) {
    console.log('AGING PARITY OK — every output identical to SRC, ' +
      'plus 1 deliberate divergence verified\n');
  } else {
    console.log('\n' + failures.length + ' DIFFERENCE(S):\n');
    failures.slice(0, 25).forEach((f) => console.log('  ' + f));
    if (failures.length > 25) console.log('  … and ' + (failures.length - 25) + ' more');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
