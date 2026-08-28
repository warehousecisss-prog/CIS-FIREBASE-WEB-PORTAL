/**
 * ============================================================================
 * PARITY HARNESS -- Service_Conversions
 * ============================================================================
 * Runs SRC/src/Service_Conversions.js and the ported
 * functions/services/Service_Conversions.js against identical inputs and fails
 * on any output difference. Same shape and same reasoning as the
 * Shared_Classifiers and Service_Dates harnesses.
 *
 * WHAT THIS IS ACTUALLY CHECKING
 * ------------------------------
 * The whole point of this file is the 2026-08-26 fix, which the port had lost:
 * `findCaseConversion_` used to prefix-match the raw Inventory SKU, and since
 * 2026-08-11 receivePOCardItems() writes the NICKNAME into Inventory. A
 * nickname does not start with the supplier code, so the rule silently stopped
 * firing for everything received after that date -- no error, no log, the
 * put-away conversion just never happened.
 *
 * So the synthetic PRODUCT sheet below is built around that: `NT525S/2AMF` is
 * nicknamed "2 Alarm SMALL Scorpion Tag", which shares NO prefix with the
 * conversion rule at all. A port that skips the QB-name resolution returns null
 * for the nickname and the harness goes red. Verified by mutation, see
 * PHASE_4_NOTES.md.
 *
 * TWO STRUCTURAL DIFFERENCES the harness has to bridge:
 *
 *  1. SRC defines `getQbNameIndex_` INSIDE Service_Conversions.js and reads the
 *     PRODUCT sheet synchronously. The port moved it to Shared_Classifiers and
 *     split it into an async `primeQbNameIndex()` plus a sync cache read
 *     (PHASE_2_NOTES.md §1). Both are fed the same PRODUCT rows here, so the
 *     split has to produce identical answers or this fails.
 *  2. SRC relies on Apps Script's single global namespace, so
 *     Service_Conversions.js can call `canonicalNameKey_`/`namesMatch_` from
 *     Shared_Classifiers.js without importing anything. The sandbox reproduces
 *     that by evaluating BOTH files into ONE context, in load order.
 *
 * NOT COMPARED: `setupCaseConversions` (creates a sheet and writes to it) and
 * `reportConversionGap` (SRC streams to Logger.log; the port returns data --
 * a deliberate deviation, so there is nothing to compare). Both were reviewed
 * line-by-line against SRC instead, and PHASE_4_NOTES.md says so.
 *
 *   npm run test:parity:conversions
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..');
const srcConv = path.join(ROOT, 'SRC/src/Service_Conversions.js');
const srcShared = path.join(ROOT, 'SRC/src/Shared_Classifiers.js');
const portPath = path.join(ROOT, 'functions/services/Service_Conversions.js');

if (!fs.existsSync(srcConv)) {
  console.log('SKIP: ' + srcConv + ' not present (SRC/ is gitignored -- it lives on the ' +
              'porting machine only). Nothing to compare against.');
  process.exit(0);
}

/* ==========================================================================
 * The synthetic workbook -- one definition, fed to both sides.
 * ========================================================================== */

// CASE_CONVERSIONS: Unit_SKU_Prefix | Case_SKU | Units_Per_Case | Notes
// These are SRC's own seed rows (setupCaseConversions), so the harness is
// exercising the real table shape rather than an invented one.
const CASE_CONVERSIONS = [
  ['Unit_SKU_Prefix', 'Case_SKU', 'Units_Per_Case', 'Notes'],
  ['CIS NT510/2A S 12',  'Burlington 12" Siren Tag Case',   25,  '12" HD padlock tag'],
  ['CIS NT510-2/2A 3.5', 'Burlington 3.5" Siren Tag Case',  50,  'Called 5" on the floor'],
  ['CIS NT510/2A S 48',  'Burlington 48" Siren Tag Case',   20,  '48" HD padlock tag'],
  ['CIS ST-11 M',        'Burlington Milli Tag Case',       500, 'Milli / stick tag'],
  ['NT525S/2AMF',        'Burlington Scorpion Tag Case',    25,  'Small scorpion tag, 90cm'],
  // Unusable rows -- must be dropped silently by both sides, not acted on.
  ['CIS BROKEN',         '',                                10,  'no case sku'],
  ['',                   'Burlington Ghost Case',           10,  'no prefix'],
  ['CIS ZERO',           'Burlington Zero Case',            0,   'zero per case'],
  ['CIS NAN',            'Burlington NaN Case',             'x', 'unparseable']
];

// PRODUCT: Product ID (QB name) | Nickname.
// The scorpion rows are the point -- their nickname shares no prefix with the
// 'NT525S/2AMF' conversion rule, so only a QB-name resolution finds it.
const PRODUCT = [
  ['Product ID', 'Nickname'],
  ['NT525S/2AMF', '2 Alarm SMALL Scorpion Tag'],
  ['NT525S/2AMF-B', '2 Alarm SMALL Scorpion Tag'],
  ['CIS NT510-2/2A 3.5" cable (normal lock)', '3.5 Siren Tag'],
  ['CIS NT510/2A S 48" HD', '48 Siren Tag'],
  ['CIS ST-11 M Milli', 'Milli Tag'],
  ['CIS GEN6SR BB', 'Burlington Bar'],
  ['Burlington Scorpion Tag Case', 'Scorpion Case'],
  ['Burlington 3.5" Siren Tag Case', '3.5 Case'],
  ['V32', 'Verso Tag']
];

// Inventory, for nothing here but kept so the sandbox's sheet lookup is total.
const INVENTORY = [
  ['Location', 'SKU', 'Qty', 'Status', 'Type', 'Comment', 'Instance_ID'],
  ['ZONE-BUFFER', '2 Alarm SMALL Scorpion Tag', 5142, 'Open', 'None', '', 'i1'],
  ['SWH-A-01', 'Burlington Scorpion Tag Case', 538, 'Open', 'None', '', 'i2']
];

const WORKBOOK = {
  'CASE_CONVERSIONS': CASE_CONVERSIONS,
  'PRODUCT': PRODUCT,
  'Inventory': INVENTORY
};

/* ==========================================================================
 * SRC side -- Shared_Classifiers.js and Service_Conversions.js into ONE
 * context, reproducing Apps Script's single global namespace.
 * ========================================================================== */

/**
 * @param {Array<Array<*>>} rows
 * @return {Object} enough of a Sheet for these two files.
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
  Utilities: {sleep: () => {}, getUuid: () => 'uuid'},
  UrlFetchApp: {fetch: () => { throw new Error('no network in parity harness'); }},
  Session: {getActiveUser: () => ({getEmail: () => 'parity@test'})},
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => (WORKBOOK[name] ? fakeSheet(WORKBOOK[name]) : null),
      getSheets: () => []
    })
  },
  console, Intl,
  JSON, Math, String, Number, Object, Array, RegExp, Date, parseInt, parseFloat, isNaN, isFinite
};
vm.createContext(sandbox);
// Load order matters: Service_Conversions calls canonicalNameKey_/namesMatch_.
vm.runInContext(fs.readFileSync(srcShared, 'utf8'), sandbox, {filename: srcShared});
vm.runInContext(fs.readFileSync(srcConv, 'utf8'), sandbox, {filename: srcConv});

/* ==========================================================================
 * Port side -- stub SS_API with the same workbook before requiring anything.
 * ========================================================================== */

/**
 * @param {string} range e.g. "CASE_CONVERSIONS!A2:C", "PRODUCT!A:B".
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

  // "A2:C" / "B2:B" -- a column span with a starting row.
  const withRow = spec.match(/^([A-Z]+)(\d+):([A-Z]+)(\d*)$/);
  if (withRow) {
    const a = toIdx(withRow[1]);
    const b = toIdx(withRow[3]);
    const from = Number(withRow[2]) - 1;
    return rows.slice(from).map((r) => r.slice(a, b + 1));
  }

  // "A:B" -- a bare column span.
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
 * @param {string} name
 * @param {Function} srcFn synchronous, from the sandbox.
 * @param {Function} portFn async, from the port.
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

// The SKU strings an Inventory row can actually hold, in all three vocabularies
// the 2026-08-11 / 2026-08-28 changes left behind.
const SKUS = [
  null, '', '   ',
  // raw supplier / QB names (the pre-2026-08-11 shape)
  'CIS NT510/2A S 12" HD',
  'CIS NT510-2/2A 3.5" cable (normal lock)',
  'CIS NT510/2A S 48" HD',
  'CIS ST-11 M Milli',
  'NT525S/2AMF',
  'NT525S/2AMF-B',
  // NICKNAMES (the post-2026-08-11 shape) -- these are the ones that only
  // resolve via the PRODUCT index. The scorpion nickname shares no prefix with
  // its rule at all.
  '2 Alarm SMALL Scorpion Tag',
  '3.5 Siren Tag',
  '48 Siren Tag',
  'Milli Tag',
  // case SKUs as they sit on the floor
  'Burlington Scorpion Tag Case',
  'Burlington 3.5" Siren Tag Case',
  'Burlington 48" Siren Tag Case',
  'Burlington Milli Tag Case',
  'Burlington 12" Siren Tag Case',
  // the folded form the 2026-08-28 name rewrite produced
  'Burlington Scorpion Tag Case (Burlington Scorpion Tag Case (25 units per 1 case))',
  // the cap-truncated 3.5" form
  'Burlington 3.5" Siren Tag Case (Burlington 3.5" Siren Tag Case (50 units per 1 ca...',
  // products with deliberately NO case rule
  'CIS GEN6SR BB', 'Burlington Bar', 'V32', 'Verso Tag',
  // near-misses and junk
  'burlington scorpion tag case', 'NT525', 'Scorpion', 'unknown sku'
];

const LOCATIONS = [
  null, '', 'ZONE-BUFFER', 'zone-buffer', '  ZONE-BUFFER  ', 'SWH-A-01', 'ZONE-STAGED', 'RTF-01'
];

const QTYS = [null, '', 0, -5, 1, 17, 24, 25, 26, 49, 50, 500, 999, 5142, 20000, '250', 'abc', 1.5];

const QTY_UNITS = ['units', 'cases', null, '', 'nonsense'];

/* ---- run ---------------------------------------------------------------- */

/**
 * @return {Promise<void>}
 */
async function main() {
  await cmp('isBufferLocation_', sandbox.isBufferLocation_, port.isBufferLocation, one(LOCATIONS));

  await cmp('getCaseConversions_', sandbox.getCaseConversions_, port.getCaseConversions, [[]]);

  // THE headline: nickname -> QB name -> rule prefix.
  await cmp('findCaseConversion_', sandbox.findCaseConversion_, port.findCaseConversion, one(SKUS));

  await cmp('resolveUnitsPerCase_', sandbox.resolveUnitsPerCase_, port.resolveUnitsPerCase_, one(SKUS));

  const breakdownArgs = [];
  SKUS.forEach((s) => {
    QTYS.forEach((q) => {
      QTY_UNITS.forEach((u) => breakdownArgs.push([s, q, u]));
    });
  });
  await cmp('caseBreakdown_', sandbox.caseBreakdown_, port.caseBreakdown_, breakdownArgs);
  await cmp('formatQtyWithCases_', sandbox.formatQtyWithCases_, port.formatQtyWithCases_,
      breakdownArgs);

  const planArgs = [];
  LOCATIONS.forEach((from) => {
    LOCATIONS.forEach((to) => {
      SKUS.forEach((s) => {
        planArgs.push([from, to, s, 5142]);
      });
    });
  });
  // A narrower cross-product over quantities, so the arg list stays sane.
  SKUS.forEach((s) => {
    QTYS.forEach((q) => planArgs.push(['ZONE-BUFFER', 'SWH-A-01', s, q]));
  });
  await cmp('planCaseConversion_', sandbox.planCaseConversion_, port.planCaseConversion, planArgs);

  console.log('\nran ' + checks + ' comparisons across ' + covered.size + ' functions');
  if (failures.length === 0) {
    console.log('SERVICE_CONVERSIONS PARITY OK — every output identical to SRC\n');
  } else {
    console.log('\n' + failures.length + ' DIFFERENCE(S):\n');
    failures.slice(0, 30).forEach((f) => console.log('  ' + f));
    if (failures.length > 30) console.log('  … and ' + (failures.length - 30) + ' more');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
