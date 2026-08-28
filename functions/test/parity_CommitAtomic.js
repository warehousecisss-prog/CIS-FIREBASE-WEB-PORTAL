/**
 * ============================================================================
 * PARITY HARNESS -- SS_API.commitAtomic
 * ============================================================================
 * `commitAtomic` is the whole of AUDIT_2026-08-24.md B3. It turns an assembly
 * write from three or four separate Sheets calls — where a quota error or a
 * timeout in between doubles or destroys inventory — into ONE `batchUpdate`
 * the API applies all-or-nothing.
 *
 * `parity_Service_Assembly.js` proves the assembly paths hand it the right
 * `ops`, but it STUBS this function, so nothing there covers what it does with
 * them. That matters, because two things inside it are load-bearing and neither
 * is visible from the outside:
 *
 *  1. **Request order: updates -> appends -> deletes.** An append lands at the
 *     end of the sheet, so it must be emitted before any delete; a delete
 *     emitted first shifts the rows the append and the updates were computed
 *     against.
 *  2. **Deletes must be DESCENDING and de-duplicated.** Deleting row 5 shifts
 *     row 9 up to row 8, so an ascending list invalidates its own later
 *     indices — it silently deletes the wrong rows.
 *
 * Plus the cell encoding: a string must stay a string (`stringValue`, never
 * parsed — AUDIT B1), a non-finite number must be refused rather than written,
 * and a Date must throw rather than landing in the sheet as a bare serial
 * number like `45000`.
 *
 * Both sides are driven with identical `ops` and the emitted `requests` array
 * is diffed. SRC reaches the API through the Advanced Sheets Service global
 * (`Sheets.Spreadsheets.batchUpdate`); the port through googleapis. Both are
 * stubbed at that boundary, so the REAL request-building code runs on both
 * sides.
 *
 *   npm run test:parity:commit
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..');
const srcApi = path.join(ROOT, 'SRC/src/Service_SheetsAPI.js');

if (!fs.existsSync(srcApi)) {
  console.log('SKIP: ' + srcApi + ' not present (SRC/ is gitignored -- it lives on the ' +
              'porting machine only). Nothing to compare against.');
  process.exit(0);
}

/* ==========================================================================
 * SRC side -- stub the Advanced Sheets Service global.
 * ========================================================================== */

let srcRequests = null;
const sandbox = {
  PropertiesService: {
    getScriptProperties: () => ({getProperty: (k) => (k === 'BATCH_SHEET_ID' ? 'parity-sheet' : null)})
  },
  SpreadsheetApp: {getActiveSpreadsheet: () => { throw new Error('not bound'); }},
  Logger: {log: () => {}},
  Sheets: {
    Spreadsheets: {
      batchUpdate: (body) => { srcRequests = body.requests; return {}; },
      Values: {
        batchUpdate: () => ({}),
        append: () => ({}),
        get: () => ({values: []})
      }
    }
  },
  console, JSON, Math, String, Number, Object, Array, RegExp, Date, Set,
  parseInt, parseFloat, isNaN, isFinite
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(srcApi, 'utf8'), sandbox, {filename: srcApi});
// SRC declares `const SS_API = {...}` at the top level of the script. Unlike a
// `function` declaration, a top-level `const` goes into the context's global
// LEXICAL scope, not onto the global object — so `sandbox.SS_API` is undefined
// and it has to be lifted across explicitly.
vm.runInContext('globalThis.__SS_API = SS_API;', sandbox, {filename: 'lift'});
const srcApiObj = sandbox.__SS_API;

/* ==========================================================================
 * Port side -- stub googleapis so the real module loads and the real
 * commitAtomic runs.
 * ========================================================================== */

let portRequests = null;
const googleapisPath = require.resolve('googleapis');
require.cache[googleapisPath] = {
  id: googleapisPath, filename: googleapisPath, loaded: true, exports: {
    google: {
      auth: {GoogleAuth: function() { this.getClient = async () => ({}); }},
      sheets: () => ({
        spreadsheets: {
          batchUpdate: async (req) => { portRequests = req.resource.requests; return {data: {}}; },
          get: async () => ({data: {sheets: []}}),
          values: {
            batchUpdate: async () => ({data: {}}),
            append: async () => ({data: {}}),
            get: async () => ({data: {values: []}})
          }
        }
      })
    }
  }
};
process.env.BATCH_SHEET_ID = process.env.BATCH_SHEET_ID || 'parity-sheet';

const portApi = require(path.join(ROOT, 'functions/services/Service_SheetsAPI.js'));

/* ==========================================================================
 * Comparison
 * ========================================================================== */

let checks = 0;
const failures = [];

/**
 * @param {*} v
 * @return {string}
 */
function j(v) {
  return JSON.stringify(v, (k, val) => (val === undefined ? '<undefined>' : val), 1);
}

/**
 * @param {string} label
 * @param {Object} ops
 * @param {number} defaultSheetId
 * @return {Promise<void>}
 */
async function cmp(label, ops, defaultSheetId) {
  checks++;
  srcRequests = null;
  portRequests = null;

  let srcErr = null;
  let portErr = null;
  try { srcApiObj.commitAtomic(ops, defaultSheetId); } catch (e) { srcErr = e.message; }
  try { await portApi.commitAtomic(ops, defaultSheetId); } catch (e) { portErr = e.message; }

  if (String(srcErr) !== String(portErr)) {
    failures.push(label + ' — THROWN ERROR\n    SRC : ' + srcErr + '\n    PORT: ' + portErr);
    return;
  }
  if (j(srcRequests) !== j(portRequests)) {
    failures.push(label + ' — EMITTED REQUESTS\n    SRC :\n' + j(srcRequests) +
      '\n    PORT:\n' + j(portRequests));
  }
}

/* ---- scenarios ---------------------------------------------------------- */

const INV = 111;

/**
 * @return {Promise<void>}
 */
async function main() {
  await cmp('empty ops', {}, INV);

  await cmp('a single cell update',
      {updates: [{range: 'Inventory!C5', values: [[42]]}]}, INV);

  await cmp('a multi-cell range update',
      {updates: [{range: 'Inventory!B7:G7', values: [['WIDGET', 12, 'Open', 'None', '', 'uuid-1']]}]}, INV);

  await cmp('a range with no tab prefix (defaultSheetId applies)',
      {updates: [{range: 'C5', values: [[1]]}]}, INV);

  await cmp('a two-letter column',
      {updates: [{range: 'Inventory!AA3', values: [['x']]}]}, INV);

  await cmp('appends only',
      {appends: [{sheetId: INV, rows: [['SWH-A-01', 'WIDGET', 5, 'Open', 'None', '', 'u1']]}]}, INV);

  // THE ordering case: updates, appends and deletes together.
  await cmp('updates + appends + deletes together', {
    updates: [{range: 'Inventory!C5', values: [[3]]}, {range: 'Inventory!C9', values: [[7]]}],
    appends: [{sheetId: INV, rows: [['SWH-B-01', 'PART', 1, 'Open', 'None', '', 'u2']]}],
    deletes: [{sheetId: INV, rowIndices: [5, 12, 9]}]
  }, INV);

  // Deletes must come out descending and de-duplicated.
  await cmp('deletes ascending with duplicates',
      {deletes: [{sheetId: INV, rowIndices: [2, 2, 10, 4, 10, 7]}]}, INV);

  await cmp('deletes already descending',
      {deletes: [{sheetId: INV, rowIndices: [10, 7, 4, 2]}]}, INV);

  // Cell encoding.
  await cmp('mixed cell types',
      {appends: [{sheetId: INV, rows: [['text', 12, 0, -3.5, true, false, null, undefined, '']]}]}, INV);

  await cmp('a string that looks like a formula stays a string (AUDIT B1)',
      {appends: [{sheetId: INV, rows: [['=2 pallets short', '-3M SLIDE', "'leading apostrophe"]]}]}, INV);

  // A numeric-looking STRING must stay a string. Sheets reads come back as
  // text, so a SKU like "0012" or a qty already stringified must not be
  // silently retyped — "0012" written as a number renders as 12 and the leading
  // zeros are gone for good.
  await cmp('numeric-looking strings stay strings',
      {appends: [{sheetId: INV, rows: [['12', '0012', '3.50', '-7', '1e3', ' 42 ', '0']]}]}, INV);

  await cmp('a non-finite number is refused',
      {updates: [{range: 'Inventory!C5', values: [[NaN]]}]}, INV);

  await cmp('Infinity is refused',
      {updates: [{range: 'Inventory!C5', values: [[Infinity]]}]}, INV);

  await cmp('a Date throws rather than writing a serial number',
      {appends: [{sheetId: INV, rows: [[new Date('2026-01-05T00:00:00Z'), 'x']]}]}, INV);

  await cmp('an unsupported range shape throws',
      {updates: [{range: 'Inventory!C:C', values: [[1]]}]}, INV);

  await cmp('empty sub-arrays are skipped, not emitted',
      {updates: [{range: 'Inventory!C5', values: []}],
        appends: [{sheetId: INV, rows: []}],
        deletes: [{sheetId: INV, rowIndices: []}]}, INV);

  console.log('\nran ' + checks + ' comparisons of SS_API.commitAtomic');
  if (failures.length === 0) {
    console.log('COMMIT_ATOMIC PARITY OK — identical batchUpdate requests on every scenario\n');
  } else {
    console.log('\n' + failures.length + ' DIFFERENCE(S):\n');
    failures.slice(0, 6).forEach((f) => console.log('  ' + f + '\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
