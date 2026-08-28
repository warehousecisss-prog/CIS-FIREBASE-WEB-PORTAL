/**
 * ============================================================================
 * PARITY HARNESS -- Service_Assembly
 * ============================================================================
 * The assembly write paths are the highest-consequence code in the port: a
 * mistake here does not show a wrong number, it CREATES or DESTROYS stock.
 * AUDIT_2026-08-24.md B3 is about exactly that — `explodeAssembly` committing
 * its restores before its delete (inventory doubles) and `buildHardAssembly`
 * deleting components before minting the assembly (inventory vanishes).
 *
 * SO THIS COMPARES WHAT THEY WRITE, NOT WHAT THEY RETURN.
 * ------------------------------------------------------
 * Both sides return `{success:true}` on the happy path, which proves nothing.
 * What matters is the exact stream of Sheets operations each one issues. Both
 * sides are therefore given a RECORDING `SS_API` — SRC through the global it
 * already probes for (`typeof SS_API !== 'undefined'`), the port through a
 * require.cache stub — and the two recordings are diffed.
 *
 * A match means: same cell updates, same appended rows, same deleted row
 * indices, same order, same single atomic call. That is the property B3 is
 * about, and it cannot be faked by a function that merely returns success.
 *
 * TWO THINGS ARE NORMALISED before comparing, both unavoidable:
 *
 *  - **UUIDs.** Both sides mint fresh ones (`Utilities.getUuid()` /
 *    `crypto.randomUUID()`). They are replaced with `<uuid-N>` in order of
 *    first appearance, so a uuid reused across two rows still has to be reused
 *    identically on both sides — the structural relationship is preserved, only
 *    the literal value is dropped.
 *  - **Timestamps.** SRC's Audit_Log rows carry a live `new Date()`; the port
 *    writes `new Date().toISOString()`. Both become `<ts>`. This is a known,
 *    documented deviation (the port writes ISO strings so its log rows can pass
 *    through `commitAtomic`'s `_toCellData`, which refuses Dates); the harness
 *    records it rather than pretending the two are identical.
 *
 * `findEffectiveQtyPer_` is pure and is compared directly.
 *
 *   npm run test:parity:assembly
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..');
const srcShared = path.join(ROOT, 'SRC/src/Shared_Classifiers.js');
const srcAsm = path.join(ROOT, 'SRC/src/Service_Assembly.js');

if (!fs.existsSync(srcAsm)) {
  console.log('SKIP: ' + srcAsm + ' not present (SRC/ is gitignored -- it lives on the ' +
              'porting machine only). Nothing to compare against.');
  process.exit(0);
}

/* ==========================================================================
 * The synthetic workbook. Rebuilt fresh for every case -- both sides mutate
 * their own in-memory copy of the sheet as they plan, so a shared one would
 * leak state between cases.
 * ========================================================================== */

const SYS = (o) => '_SYS_' + JSON.stringify(o);

/** @return {Object} a fresh workbook. */
function freshWorkbook() {
  // Assemblies: Parent | Component | Qty_Per | Type
  const ASSEMBLIES = [
    ['Parent', 'Component', 'Qty_Per', 'Type'],
    ['KIT-100', 'SLEEVE', 4, 'Bulk'],
    ['KIT-100', 'SCREW', 8, 'Affixed'],
    ['KIT-100', 'SUBKIT-A', 1, 'Bulk'],
    // nested one level: SUBKIT-A itself has components
    ['SUBKIT-A', 'PIN', 3, 'Affixed'],
    ['SUBKIT-A', 'CLIP', 2, 'Bulk'],
    // a self-referencing row -- findEffectiveQtyPer_'s `visited` guard
    ['LOOP-1', 'LOOP-1', 2, 'Bulk'],
    ['LOOP-1', 'WIDGET', 5, 'Bulk'],
    // a zero ratio, which must be skipped rather than dividing by zero
    ['KIT-200', 'ZERO-PART', 0, 'Bulk'],
    ['KIT-200', 'SLEEVE', 2, 'Bulk']
  ];

  // Inventory: Location | SKU | Qty | Status | Type | Comment | Instance_ID
  const INVENTORY = [
    ['Location', 'SKU', 'Qty', 'Status', 'Type', 'Comment', 'Instance_ID'],
    // plain stock used by buildHardAssembly
    ['SWH-A-01', 'SCREW', 500, 'Open', 'None', '', 'inv-screw-a'],
    ['SWH-A-01', 'SLEEVE', 200, 'Open', 'None', '', 'inv-sleeve-a'],
    ['SWH-A-02', 'SLEEVE', 40, 'Open', 'None', '', 'inv-sleeve-b'],
    ['SWH-A-02', 'PIN', 90, 'Open', 'None', '', 'inv-pin-b'],
    // a location holding exactly one item, so the vacate-vs-delete branch fires
    ['SWH-B-01', 'CLIP', 10, 'Open', 'None', '', 'inv-clip-solo'],
    // a location with two items, so the delete branch fires instead
    ['SWH-B-02', 'CLIP', 10, 'Open', 'None', '', 'inv-clip-b2'],
    ['SWH-B-02', 'WIDGET', 7, 'Open', 'None', '', 'inv-widget-b2'],
    // a Vacant row for the restore path to reuse
    ['SWH-C-01', 'Vacant', 0, 'Open', 'None', '', 'inv-vacant-c'],

    // --- an existing built assembly, for the explode paths ------------------
    // Frame at SWH-D-01, 10 kits
    ['SWH-D-01', 'KIT-100', 10, 'Open', 'None',
      SYS({ t: 'F', cIds: ['hub-piece-1', 'hub-piece-2'] }), 'frame-1'],
    // its bulk pieces, spread across TWO locations -- the whole point of
    // explodePartialHub is that it touches only the one it is given
    ['SWH-D-01', 'KIT-100', 40, 'Open', 'None',
      SYS({ t: 'B', pId: 'frame-1', pSku: 'KIT-100', cSku: 'SLEEVE' }), 'hub-piece-1'],
    ['SWH-E-01', 'KIT-100', 10, 'Open', 'None',
      SYS({ t: 'B', pId: 'frame-1', pSku: 'KIT-100', cSku: 'SUBKIT-A' }), 'hub-piece-2'],
    // plain stock at the hub location, so a restore merges rather than appends
    ['SWH-D-01', 'SLEEVE', 5, 'Open', 'None', '', 'inv-sleeve-d'],

    // --- a second build whose pieces are ALL at one location ---------------
    ['SWH-F-01', 'KIT-100', 4, 'Open', 'None',
      SYS({ t: 'F', cIds: ['hub2-piece-1'] }), 'frame-2'],
    ['SWH-F-01', 'KIT-100', 16, 'Open', 'None',
      SYS({ t: 'B', pId: 'frame-2', pSku: 'KIT-100', cSku: 'SLEEVE' }), 'hub2-piece-1'],

    // --- a malformed _SYS_ blob: must be skipped, not crash ----------------
    ['SWH-G-01', 'KIT-100', 1, 'Open', 'None', '_SYS_{"t":"B"', 'broken-1']
  ];

  // Present because SRC's commitInventoryMutation_ gates its log append on
  // `logSheet` being non-null (`ss.getSheetByName("Audit_Log")`). Without this
  // tab SRC silently writes no Audit_Log rows and the port looks wrong for
  // writing them. Never read — the append is recorded, not resolved.
  const AUDIT_LOG = [
    ['Timestamp', 'Location', 'SKU', 'Action', 'Delta', 'New Qty', 'Operator']
  ];

  return { 'Assemblies': ASSEMBLIES, 'Inventory': INVENTORY, 'Audit_Log': AUDIT_LOG };
}

let WORKBOOK = freshWorkbook();

/* ==========================================================================
 * Recording SS_API -- the comparison surface.
 * ========================================================================== */

let recorded = [];

/** @return {Object} an SS_API that records instead of writing. */
function recordingSsApi() {
  return {
    getSpreadsheetId: () => 'parity-sheet',
    getSheetMetadata: async (name) => ({ sheetId: name === 'Inventory' ? 111 : 222, title: name }),
    getSheetId: async (name) => (name === 'Inventory' ? 111 : 222),
    clearSheetMetadataCache: () => {},
    getSheetValues: async (range) => resolveRange(range),
    commitAtomic: async (ops, defaultSheetId) => {
      recorded.push({ call: 'commitAtomic', ops: ops, defaultSheetId: defaultSheetId });
      return 1;
    },
    batchUpdateValues: async (updates) => {
      recorded.push({ call: 'batchUpdateValues', updates: updates });
    },
    batchAppendRows: async (sheetName, rows) => {
      recorded.push({ call: 'batchAppendRows', sheetName: sheetName, rows: rows });
    },
    batchDeleteRows: async (sheetId, rowIndices) => {
      recorded.push({ call: 'batchDeleteRows', sheetId: sheetId, rowIndices: rowIndices });
    },
    batchUpdateSheet: async () => ({})
  };
}

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

/* ==========================================================================
 * SRC side
 * ========================================================================== */

/**
 * @param {Array<Array<*>>} rows
 * @return {Object}
 */
function fakeSheet(rows, sheetId) {
  return {
    getSheetId: () => sheetId,
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    getRange: function(row, col, numRows, numCols) {
      if (numRows === undefined) {
        return {
          getValue: () => (rows[row - 1] ? rows[row - 1][col - 1] : undefined),
          setValue: () => {}
        };
      }
      return { getValues: () => [], setValues: () => {}, setFontWeight: () => {} };
    },
    deleteRow: () => {},
    appendRow: () => {}
  };
}

let uuidCounter = 0;
const sandbox = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
  Logger: { log: () => {} },
  Utilities: { sleep: () => {}, getUuid: () => 'SRC-UUID-' + (++uuidCounter) },
  UrlFetchApp: { fetch: () => { throw new Error('no network in parity harness'); } },
  Session: { getActiveUser: () => ({ getEmail: () => 'parity@test' }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => (WORKBOOK[name]
        ? fakeSheet(WORKBOOK[name], name === 'Inventory' ? 111 : 222)
        : null),
      getSheets: () => []
    })
  },
  console, Intl,
  JSON, Math, String, Number, Object, Array, RegExp, Date, Set, Map,
  parseInt, parseFloat, isNaN, isFinite
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(srcShared, 'utf8'), sandbox, { filename: srcShared });
vm.runInContext(fs.readFileSync(srcAsm, 'utf8'), sandbox, { filename: srcAsm });

// SRC's commitInventoryMutation_ probes for a global SS_API; give it the
// recorder so its real commit path runs and is observed.
sandbox.SS_API = recordingSsApi();

/* ==========================================================================
 * Port side
 * ========================================================================== */

const ssApiPath = require.resolve(path.join(ROOT, 'functions/services/Service_SheetsAPI.js'));
require.cache[ssApiPath] = {
  id: ssApiPath, filename: ssApiPath, loaded: true, exports: recordingSsApi()
};

// The write lease would otherwise reach for Firestore. Give it a fake store so
// the harness exercises the assembly logic, not the lock (which has its own
// contract test).
const lock = require(path.join(ROOT, 'functions/lock.js'));
let leaseDoc = null;
lock.__setStoreForTests({
  tryAcquire: async (meta) => {
    if (leaseDoc) return { acquired: false, heldBy: leaseDoc.label };
    leaseDoc = { token: meta.token, label: meta.label, expiresAt: Date.now() + 60000 };
    return { acquired: true };
  },
  release: async (token) => {
    if (leaseDoc && leaseDoc.token === token) leaseDoc = null;
    return { released: true, wasExpired: false };
  },
  peek: async () => leaseDoc
});

// getActiveUserEmail(context) throws without an identity; the routes pass the
// Express req, so the harness passes the same shape.
const CONTEXT = { auth: { email: 'parity@test' } };

const portAsm = require(path.join(ROOT, 'functions/services/Service_Assembly.js'));

/* ==========================================================================
 * Normalisation + comparison
 * ========================================================================== */

const UUID_RE = /^(?:SRC-UUID-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/;

/**
 * Replaces freshly-minted UUIDs with stable placeholders (preserving reuse) and
 * timestamps with `<ts>`. See the header for why each is unavoidable.
 *
 * @param {*} v
 * @param {Object} seen uuid -> placeholder, carried across one recording.
 * @return {*}
 */
function normalise(v, seen) {
  if (v === null || v === undefined) return v;
  if (Object.prototype.toString.call(v) === '[object Date]') return '<ts>';
  if (Array.isArray(v)) return v.map((x) => normalise(x, seen));
  if (typeof v === 'object') {
    const out = {};
    Object.keys(v).sort().forEach((k) => { out[k] = normalise(v[k], seen); });
    return out;
  }
  if (typeof v === 'string') {
    if (ISO_RE.test(v)) return '<ts>';
    if (UUID_RE.test(v)) {
      if (!seen[v]) seen[v] = '<uuid-' + (Object.keys(seen).length + 1) + '>';
      return seen[v];
    }
    // uuids also appear embedded in _SYS_ blobs
    return v.replace(/SRC-UUID-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        (m) => {
          if (!seen[m]) seen[m] = '<uuid-' + (Object.keys(seen).length + 1) + '>';
          return seen[m];
        });
  }
  return v;
}

let checks = 0;
const failures = [];
const covered = new Set();

/**
 * @param {*} v
 * @return {string}
 */
function j(v) {
  return JSON.stringify(v, (k, val) => (val === undefined ? '<undefined>' : val), 1);
}

/**
 * Runs one scenario on both sides and diffs the recorded Sheets operations.
 *
 * @param {string} label
 * @param {Function} runSrc () => result, synchronous.
 * @param {Function} runPort () => Promise<result>.
 * @return {Promise<void>}
 */
async function cmpWrites(label, runSrc, runPort) {
  covered.add(label.split(' ')[0]);
  checks++;

  WORKBOOK = freshWorkbook();
  uuidCounter = 0;
  recorded = [];
  let srcResult;
  try { srcResult = runSrc(); } catch (e) { srcResult = 'THREW: ' + e.message; }
  const srcOps = normalise(recorded, {});
  const srcRet = normalise(srcResult, {});

  WORKBOOK = freshWorkbook();
  recorded = [];
  let portResult;
  try { portResult = await runPort(); } catch (e) { portResult = 'THREW: ' + e.message; }
  const portOps = normalise(recorded, {});
  const portRet = normalise(portResult, {});

  if (j(srcRet) !== j(portRet)) {
    failures.push(label + ' — RETURN VALUE\n    SRC : ' + j(srcRet) + '\n    PORT: ' + j(portRet));
  }
  if (j(srcOps) !== j(portOps)) {
    failures.push(label + ' — SHEETS OPERATIONS\n    SRC :\n' + j(srcOps) +
      '\n    PORT:\n' + j(portOps));
  }
}

/**
 * @param {string} name
 * @param {Function} srcFn
 * @param {Function} portFn
 * @param {Array<Array<*>>} argSets
 */
function cmpPure(name, srcFn, portFn, argSets) {
  covered.add(name);
  argSets.forEach((args) => {
    checks++;
    let a;
    let b;
    // `visited` is mutated by the call. Each side gets its own, or the second
    // one starts with everything already marked visited and returns null for
    // everything — which looks exactly like a broken port and is not.
    const fresh = () => args.map((x) => (x instanceof Set ? new Set() : x));
    try { a = j(srcFn.apply(null, fresh())); } catch (e) { a = 'THREW: ' + e.message; }
    try { b = j(portFn.apply(null, fresh())); } catch (e) { b = 'THREW: ' + e.message; }
    if (a !== b) {
      failures.push(name + '(' + JSON.stringify(args.slice(1, 4)) + ')\n' +
        '    SRC : ' + a + '\n    PORT: ' + b);
    }
  });
}

/* ==========================================================================
 * Scenarios
 * ========================================================================== */

/**
 * @return {Promise<void>}
 */
async function main() {
  // ---- findEffectiveQtyPer_, pure ---------------------------------------
  const recipe = freshWorkbook()['Assemblies'].slice(1).map((r) => ({
    parent: r[0], component: r[1], qtyPer: Number(r[2]) || 1, type: r[3]
  }));
  const pureArgs = [
    [recipe, 'KIT-100', 'SLEEVE', 1, new Set()],
    [recipe, 'KIT-100', 'SCREW', 1, new Set()],
    [recipe, 'KIT-100', 'PIN', 1, new Set()],       // nested one level: 1*1*3
    [recipe, 'KIT-100', 'CLIP', 1, new Set()],      // nested: 1*1*2
    [recipe, 'KIT-100', 'NOPE', 1, new Set()],
    [recipe, 'KIT-100', 'SLEEVE', 5, new Set()],    // multiplier carried down
    [recipe, 'SUBKIT-A', 'PIN', 1, new Set()],
    [recipe, 'LOOP-1', 'WIDGET', 1, new Set()],     // the self-reference guard
    [recipe, 'LOOP-1', 'LOOP-1', 1, new Set()],
    [recipe, 'KIT-200', 'ZERO-PART', 1, new Set()], // qtyPer 0 -> skipped
    [recipe, 'KIT-200', 'SLEEVE', 1, new Set()],
    [recipe, 'UNKNOWN', 'SLEEVE', 1, new Set()],
    [[], 'KIT-100', 'SLEEVE', 1, new Set()]
  ];
  cmpPure('findEffectiveQtyPer_', sandbox.findEffectiveQtyPer_,
      portAsm.findEffectiveQtyPer_, pureArgs);

  // ---- buildHardAssembly -------------------------------------------------
  const buildCases = [
    ['plain build, bulk from one location',
      'SWH-A-01', 'KIT-100', 2, JSON.stringify({ SLEEVE: { 'SWH-A-01': 8 } })],
    ['build draining a solo-item location (vacate branch)',
      'SWH-A-01', 'KIT-100', 1, JSON.stringify({ CLIP: { 'SWH-B-01': 10 } })],
    ['build draining a multi-item location (delete branch)',
      'SWH-A-01', 'KIT-100', 1, JSON.stringify({ CLIP: { 'SWH-B-02': 10 } })],
    ['build with bulk split across two locations',
      'SWH-A-01', 'KIT-100', 2, JSON.stringify({ SLEEVE: { 'SWH-A-01': 4, 'SWH-A-02': 4 } })],
    ['build with no recipe', 'SWH-A-01', 'NO-SUCH-KIT', 1, null],
    ['build with qty 0', 'SWH-A-01', 'KIT-100', 0, null],
    ['build with a malformed payload', 'SWH-A-01', 'KIT-100', 1, '{not json'],
    ['build with no bulk payload at all', 'SWH-A-01', 'KIT-100', 1, null]
  ];
  for (const [label, loc, sku, qty, payload] of buildCases) {
    await cmpWrites('buildHardAssembly — ' + label,
        () => sandbox.buildHardAssembly(loc, sku, qty, payload),
        () => portAsm.buildHardAssembly(loc, sku, qty, payload, CONTEXT));
  }

  // ---- explodeAssembly ---------------------------------------------------
  const explodeCases = [
    ['full explode of an existing frame', 'SWH-D-01', 'KIT-100', 10, 'frame-1'],
    ['explode by location+sku with no instance id', 'SWH-F-01', 'KIT-100', 4, null],
    ['explode a frame that does not exist', 'SWH-Z-99', 'KIT-100', 1, null],
    ['explode qty 0', 'SWH-D-01', 'KIT-100', 0, 'frame-1']
  ];
  for (const [label, loc, sku, qty, inst] of explodeCases) {
    await cmpWrites('explodeAssembly — ' + label,
        () => sandbox.explodeAssembly(loc, sku, qty, inst),
        () => portAsm.explodeAssembly(loc, sku, qty, inst, CONTEXT));
  }

  // ---- explodePartialHub -------------------------------------------------
  const partialCases = [
    ['partial explode, children remain elsewhere', 'SWH-D-01', 'frame-1', 5],
    ['partial explode draining this pallet entirely', 'SWH-D-01', 'frame-1', 10],
    ['the last pallet — folds into a full explode', 'SWH-F-01', 'frame-2', 4],
    ['fewer kits than available', 'SWH-F-01', 'frame-2', 1],
    ['more kits than available', 'SWH-F-01', 'frame-2', 99],
    ['zero kits', 'SWH-F-01', 'frame-2', 0],
    ['missing build reference', 'SWH-F-01', '', 1],
    ['unknown build reference', 'SWH-F-01', 'no-such-frame', 1],
    ['nothing to explode at this location', 'SWH-A-01', 'frame-1', 1]
  ];
  for (const [label, loc, pId, kits] of partialCases) {
    await cmpWrites('explodePartialHub — ' + label,
        () => sandbox.explodePartialHub(loc, pId, kits),
        () => portAsm.explodePartialHub(loc, pId, kits, CONTEXT));
  }

  console.log('\nran ' + checks + ' comparisons across ' + covered.size + ' functions');
  if (failures.length === 0) {
    console.log('SERVICE_ASSEMBLY PARITY OK — identical Sheets operations and return ' +
      'values on every scenario\n');
  } else {
    console.log('\n' + failures.length + ' DIFFERENCE(S):\n');
    failures.slice(0, 6).forEach((f) => console.log('  ' + f + '\n'));
    if (failures.length > 6) console.log('  … and ' + (failures.length - 6) + ' more');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
