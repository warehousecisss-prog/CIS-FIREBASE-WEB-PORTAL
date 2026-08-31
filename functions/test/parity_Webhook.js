/**
 * ============================================================================
 * PARITY HARNESS -- processWebhookPayload (SCHEMA.md Section 13)
 * ============================================================================
 * The real-time half of the SHIPMENTS pipeline. One Trello card event in, one
 * SHIPMENTS row out. It shares its status-assignment block with the scheduled
 * sync BY HAND rather than by shared code -- SCHEMA §13 says so explicitly --
 * so a drift here desynchronises the two writers and the same card starts
 * flipping between statuses depending on which one touched it last.
 *
 * COMPARES WHAT IT WRITES, NOT WHAT IT RETURNS.
 * --------------------------------------------
 * SRC returns nothing. Both sides get recording fakes and the op streams are
 * diffed:
 *
 *   - the row upsert: update-in-place (with its range) or append, cell for cell
 *   - the idempotency skip -- an unchanged row must emit NO write at all
 *   - the archive path: the Shipment_History append AND the SHIPMENTS delete
 *   - every Trello call (checklist fetch, ignore-label add/remove)
 *   - the readiness side-effects (sailing / READY-PORT / ETA override), which
 *     must fire even when the A-J data is byte-identical
 *
 * Normalisation is declared in `canon*()` and is mechanical: SRC's
 * `getRange().setValues()` / `appendRow()` / `deleteRow()` vs the port's
 * `SS_API.batchUpdateValues` / `batchAppendRows` / `batchDeleteRows` map to the
 * same intent. Cell values, ordering and call counts are compared raw.
 *
 * TWO THINGS ARE NORMALISED, both unavoidable:
 *  - **Timestamps.** SRC writes a live `new Date()`; the port writes
 *    `.toISOString()` (a Date cannot pass through the Sheets API cleanly).
 *    Both become `<ts>`.
 *  - **Readiness side-effects** are recorded as intent
 *    (`{op:'readiness', fn, args}`) rather than as their own sheet writes.
 *    Those functions live in Service_Dates, which has its own 45,850-comparison
 *    harness; what THIS harness is responsible for is that the webhook calls
 *    them, with the right arguments, in the right order, and -- critically --
 *    that it still calls them on an event whose A-J data has not changed.
 *
 *   npm run test:parity:webhook
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..');
const srcShared = path.join(ROOT, 'SRC/src/Shared_Classifiers.js');
const srcSync = path.join(ROOT, 'SRC/src/syncAllBoardsToShipmentsTab.js');
const srcWebhook = path.join(ROOT, 'SRC/src/Webhook_Receiver.js');

if (!fs.existsSync(srcWebhook)) {
  console.log('SKIP: ' + srcWebhook + ' not present (SRC/ is gitignored -- it lives on the ' +
              'porting machine only). Nothing to compare against.');
  process.exit(0);
}

const BOARD_DEFAULTS = {
  INBOUND_PO_BOARD_ID: '649c805bad63086ff6689611',
  INBOUND_NICOLE_BOARD_ID: '64c286cd0d581563f72d58c0',
  BURLINGTON_OUTBOUND_BOARD_ID: '649c7dd6690130fe8ef3689a',
  OUTBOUND_BOARD_ID: '66bcf93dd63eecdb2d4e91e7'
};
Object.keys(BOARD_DEFAULTS).forEach((k) => { process.env[k] = BOARD_DEFAULTS[k]; });
process.env.TRELLO_KEY = 'PARITY_KEY';
process.env.TRELLO_TOKEN = 'PARITY_TOKEN';

const REGISTRY = [
  {Parent_Account: 'RTF', Brand_ID: 'RTF', Brand_Name: 'RTF Global',
    Regex_Aliases: 'RTF|TJXC', Target_Board_ID: 'INBOUND_PO_BOARD_ID',
    Warehouse_Type: 'RTF Global', Handling_Type: 'Direct Drop Ship'},
  {Parent_Account: 'BURLINGTON', Brand_ID: 'BURL', Brand_Name: 'Burlington',
    Regex_Aliases: 'BURLINGTON', Target_Board_ID: 'BURLINGTON_OUTBOUND_BOARD_ID',
    Warehouse_Type: 'Local Warehouse', Handling_Type: 'Warehouse'}
];

/** Checklists the fake Trello API returns, keyed by card id. */
const CHECKLISTS_BY_CARD = {
  'card-full': [{checkItems: [{name: 'A | QTY: 0 | RCVD: 5', state: 'complete'},
    {name: 'B | QTY: 0 | RCVD: 2', state: 'complete'}]}],
  'card-partial': [{checkItems: [{name: 'A | QTY: 3 | RCVD: 2', state: 'complete'},
    {name: 'B | QTY: 5 | RCVD: 0', state: 'incomplete'}]}],
  'card-empty': [{checkItems: []}],
  'card-new-inb': [{checkItems: [{name: 'X | QTY: 9 | RCVD: 0', state: 'incomplete'}]}]
};

/* ==========================================================================
 * Workbook
 * ========================================================================== */

const S = (cardId, direction, board, entity, mode, due, list, items, trk, rollup) =>
  [cardId, direction, board, entity, mode, due, list, items, trk, rollup];

/** @return {Object} a fresh workbook. */
function freshWorkbook() {
  return {
    'SHIPMENTS': [
      ['Card ID', 'Direction', 'Board Source', 'Entity', 'Transit Mode',
        'Scheduled Date', 'List Status', 'Line Items', 'Master Tracking', 'Rollup Status'],
      S('card-full', 'Inbound', 'Purchase Orders', 'CIS PO 3584 - TJXC Sloth',
          'Standard / Ground', '', 'IN TRANSIT', 'old items', '', 'PENDING'),
      S('card-partial', 'Inbound', 'Purchase Orders', 'CIS PO 1 - Local',
          'Standard / Ground', '', 'IN TRANSIT', 'old items', '', 'RECEIVED'),
      S('card-empty', 'Inbound', 'Purchase Orders', 'CIS PO 2',
          'Standard / Ground', '', 'IN TRANSIT', 'old', '', 'PENDING'),
      S('card-out', 'Outbound', 'Shipping Schedule', 'MAR #1670',
          'Standard / Ground', '', 'TO BE SHIPPED', 'old', '', 'PENDING PACK'),
      S('card-close', 'Inbound', 'Purchase Orders', 'CIS PO 9 - Local goods',
          'Ocean Freight', '08/01/2026', 'IN TRANSIT', 'A | QTY: 0 | RCVD: 3', '999000000001', 'ON THE WAY'),
      S('card-close-nl', 'Inbound', 'Purchase Orders', 'CIS PO 10 - RTF GLOBAL',
          'Ocean Freight', '08/01/2026', 'IN TRANSIT', 'B | QTY: 0 | RCVD: 1', '', 'ON THE WAY'),
      S('card-close-out', 'Outbound', 'Shipping Schedule', 'MAR #99',
          'Standard / Ground', '', 'SHIPPED', 'x', '', 'SHIPPED'),
      // A row whose stored data already matches what the payload will produce,
      // for the idempotency-skip case.
      S('card-same', 'Outbound', 'Shipping Schedule', 'MAR #1671',
          'Standard / Ground', '', 'TO BE SHIPPED',
          '--- SHIPMENT LINE ITEMS ---\n • Widget', '', 'PENDING PACK'),
      // The same, but INBOUND -- so a comment event on it produces byte-
      // identical A-J data AND is supposed to fire a readiness side-effect.
      // This is the row that proves SCHEMA §4F's ordering constraint: the
      // readiness handling must run BEFORE the idempotency early-return, or a
      // comment-only webhook silently never fires it.
      S('card-same-inb', 'Inbound', 'Purchase Orders', 'CIS PO 5 - Steady',
          'Standard / Ground', '', 'IN TRANSIT',
          'No specific shipping line items listed.', '', 'ON THE WAY'),
      // A SHORT row -- blank from column E onward, so the Sheets API returns it
      // with 4 entries and the port must pad it. Its cells are written verbatim
      // into Shipment_History when the card closes, so without padding they go
      // in as undefined/null where SRC writes "". See Service_Rollup porting
      // note 6.
      ['card-short', 'Inbound', 'Purchase Orders', 'CIS PO 6 - Short']
    ],
    'Shipment_History': [
      ['Date Archived', 'Card ID', 'Direction', 'Board Source', 'Entity / Store',
        'Transit Mode', 'Scheduled Date', 'List Status', 'Line Items',
        'Master Tracking #', 'Rollup Status'],
      ['2026-08-01', 'card-already-archived', 'Inbound', 'Purchase Orders',
        'X', '', '', '', '', '', 'RECEIVED']
    ]
  };
}

let WORKBOOK = freshWorkbook();

/* ==========================================================================
 * Payload builders
 * ========================================================================== */

const BOARD_PO = {id: BOARD_DEFAULTS.INBOUND_PO_BOARD_ID, name: 'Purchase Orders'};
const BOARD_OUT = {id: BOARD_DEFAULTS.OUTBOUND_BOARD_ID, name: 'Shipping Schedule'};
const BOARD_BURL = {id: BOARD_DEFAULTS.BURLINGTON_OUTBOUND_BOARD_ID, name: 'Burlington Shipping Schedule'};

/**
 * @param {Object} o
 * @return {Object} a Trello webhook payload.
 */
function payload(o) {
  return {
    action: {
      id: o.actionId || 'act-1',
      type: o.type || 'updateCard',
      date: o.date || '2026-08-30T12:00:00.000Z',
      idMemberCreator: o.member || 'member-human',
      data: Object.assign({
        board: o.board || BOARD_PO,
        card: o.card
      }, o.list === null ? {} : {list: o.list || {id: 'l1', name: 'IN TRANSIT'}},
      o.old ? {old: o.old} : {},
      o.text !== undefined ? {text: o.text} : {})
    }
  };
}

const CARD = (id, extra) => Object.assign({
  id: id, name: 'CIS PO 3584 - TJXC Sloth', desc: '', labels: [], closed: false
}, extra || {});

/* ==========================================================================
 * Recording + normalisation
 * ========================================================================== */

let recorded = [];

const canonUpdate = (range, values) => ({op: 'updateRow', range: range, values: values});
const canonAppend = (sheet, rows) => ({op: 'appendRows', sheet: sheet, rows: rows});
const canonDelete = (sheet, rowNumbers) => ({op: 'deleteRows', sheet: sheet, rows: rowNumbers});
const canonReadiness = (fn, args) => ({op: 'readiness', fn: fn, args: args});

function canonTrello(url, method) {
  return {
    op: 'trello',
    method: String(method || 'get').toLowerCase(),
    url: String(url).replace(/key=[^&]*/, 'key=K').replace(/token=[^&]*/, 'token=T')
  };
}

/** Shared Trello responder. */
function trelloRespond(url, method) {
  const cl = String(url).match(/\/cards\/([^/]+)\/checklists/);
  if (cl) return {code: 200, text: JSON.stringify(CHECKLISTS_BY_CARD[cl[1]] || [])};
  const labelsGet = String(url).match(/\/cards\/([^/]+)\/labels/);
  if (labelsGet && String(method || 'get').toLowerCase() === 'get') {
    return {code: 200, text: JSON.stringify([])};
  }
  if (labelsGet) return {code: 200, text: JSON.stringify({id: 'lbl-new', name: 'PORTAL: IGNORE'})};
  return {code: 200, text: '{}'};
}

/* ==========================================================================
 * SRC side
 * ========================================================================== */

/**
 * @param {string} name
 * @param {Array<Array<*>>} rows
 * @return {Object}
 */
function fakeSheet(name, rows) {
  const width = Math.max(10, rows.reduce((m, r) => Math.max(m, r.length), 0));
  return {
    getLastRow: () => rows.length,
    getLastColumn: () => width,
    getDataRange: () => ({getValues: () => rows.map((r) => {
      const c = r.slice();
      while (c.length < width) c.push('');
      return c;
    })}),
    getRange: function(row, col, numRows, numCols) {
      return {
        getValues: () => {
          const out = [];
          for (let r = 0; r < (numRows || 1); r++) {
            const src = rows[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < (numCols || 1); c++) {
              const v = src[col - 1 + c];
              line.push(v === undefined ? '' : v);
            }
            out.push(line);
          }
          return out;
        },
        setValues: (values) => {
          // Apps Script has no "append" primitive for a ranged write, so SRC
          // appends by computing `getLastRow() + 1` and setValues()-ing there
          // (archiveClosedCardNow_ does exactly this for Shipment_History).
          // The port reaches the same end through SS_API.batchAppendRows.
          // Normalise a write that starts at the first empty row into an
          // append, so the two line up.
          //
          // This is deliberately narrow: ONLY a write starting exactly one row
          // past the last data row counts. A write at row 5 of a 10-row sheet
          // stays an update, so a port that overwrote a live row instead of
          // appending would still show as a difference.
          if (row === rows.length + 1) {
            recorded.push(canonAppend(name, values.map((v) => v.slice())));
            return;
          }
          const colLetter = String.fromCharCode(64 + col);
          const endLetter = String.fromCharCode(64 + col + (numCols || 1) - 1);
          recorded.push(canonUpdate(
              `${name}!${colLetter}${row}:${endLetter}${row + (numRows || 1) - 1}`,
              values.map((v) => v.slice())));
        },
        setFontWeight: function() { return this; },
        setBackground: function() { return this; },
        setFontColor: function() { return this; }
      };
    },
    appendRow: (row) => { recorded.push(canonAppend(name, [row.slice()])); },
    deleteRow: (r) => { recorded.push(canonDelete(name, [r])); },
    setFrozenRows: () => {}
  };
}

const sandbox = {
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => {
        if (k === 'TRELLO_KEY') return 'PARITY_KEY';
        if (k === 'TRELLO_TOKEN') return 'PARITY_TOKEN';
        if (k === 'TRELLO_BOT_MEMBER_ID') return sandboxBotId;
        return BOARD_DEFAULTS[k] || null;
      },
      setProperty: () => {}
    })
  },
  Logger: {log: () => {}},
  Utilities: {
    sleep: () => {},
    getUuid: () => 'SRC-UUID',
    formatDate: (d, tz, fmt) => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(d);
      const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
      return `${g('month')}/${g('day')}/${g('year')}`;
    }
  },
  // A working recorder, not a thrower: SRC's applyIgnoreDeclaration_ calls
  // UrlFetchApp.fetch DIRECTLY (not through trelloFetch_), so a throwing stub
  // made it return null and the .ignore scenarios tested nothing. See the
  // matching note on the port's global fetch stub below.
  UrlFetchApp: {
    fetch: (url, opts) => {
      const method = (opts && opts.method) || 'get';
      recorded.push(canonTrello(url, method));
      const res = trelloRespond(url, method);
      return {
        getResponseCode: () => res.code,
        getContentText: () => res.text
      };
    }
  },
  Session: {
    getActiveUser: () => ({getEmail: () => 'session-user@example.com'}),
    getEffectiveUser: () => ({getEmail: () => 'session-user@example.com'}),
    getScriptTimeZone: () => 'America/New_York'
  },
  CacheService: {getScriptCache: () => ({get: () => null, put: () => {}, remove: () => {}})},
  MailApp: {sendEmail: () => {}},
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => (WORKBOOK[n] ? fakeSheet(n, WORKBOOK[n]) : null),
      insertSheet: (n) => { WORKBOOK[n] = []; return fakeSheet(n, WORKBOOK[n]); },
      getSheets: () => [],
      getSpreadsheetTimeZone: () => 'America/New_York',
      getUrl: () => 'https://sheets.example/parity'
    })
  },
  ContentService: {createTextOutput: (t) => ({text: t})},
  getCustomerRegistry: () => REGISTRY,
  // SRC keeps trelloCreds_ in Service_Dates.js, which this sandbox does not
  // load. Without it, applyIgnoreDeclaration_ throws a ReferenceError into its
  // own catch and returns null -- so SRC made no label calls at all and the
  // .ignore scenarios compared "nothing happened" against "nothing happened".
  trelloCreds_: () => ({key: 'PARITY_KEY', token: 'PARITY_TOKEN'}),
  console, Intl,
  JSON, Math, String, Number, Object, Array, RegExp, Date, Set, Map,
  parseInt, parseFloat, isNaN, isFinite
};
let sandboxBotId = null;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(srcShared, 'utf8'), sandbox, {filename: srcShared});
vm.runInContext(fs.readFileSync(srcSync, 'utf8'), sandbox, {filename: srcSync});
vm.runInContext(fs.readFileSync(srcWebhook, 'utf8'), sandbox, {filename: srcWebhook});

// AFTER the loads -- see the same note in parity_Rollup.js. Shared_Classifiers
// declares its own top-level trelloFetch_, which would overwrite a stub
// assigned beforehand.
sandbox.trelloFetch_ = (url, opts) => {
  const method = (opts && opts.method) || 'get';
  recorded.push(canonTrello(url, method));
  const res = trelloRespond(url, method);
  return {
    ok: res.code >= 200 && res.code < 300,
    code: res.code, text: res.text,
    error: null,
    getResponseCode: () => res.code,
    getContentText: () => res.text
  };
};

// The readiness side-effects live in Service_Dates on the port side and in the
// Apps Script global namespace on SRC's. Record the INTENT on both sides -- see
// the header for why this is the right boundary.
//
// The two comment PARSERS are async in the port (classifyPortGroup_ reads a
// sheet) and synchronous in SRC, so `cmp` resolves the port's answer for this
// scenario's comment text FIRST and hands SRC the resolved value through these
// fixtures. What this harness asserts is therefore which BRANCH the webhook
// takes for a given comment, not the parser's own correctness -- and note the
// parsers are absent from parity_Service_Dates.js too, so they have no direct
// SRC comparison anywhere. Recorded as a coverage gap in PHASE_5_NOTES.md
// rather than papered over.
let sailingFixture = null;
let readyPortFixture = null;
sandbox.parseSailingScheduleComment_ = () => sailingFixture;
sandbox.parseReadyPortComment_ = () => readyPortFixture;
sandbox.applySailingScheduleDeclaration_ = (...a) => {
  recorded.push(canonReadiness('applySailingScheduleDeclaration_', a));
};
sandbox.applyReadyPortDeclaration_ = (...a) => {
  recorded.push(canonReadiness('applyReadyPortDeclaration_', a));
};
sandbox.markEtaOverridden_ = (...a) => {
  recorded.push(canonReadiness('markEtaOverridden_', a));
};
sandbox.getLastAutoDueForCard_ = () => lastAutoDueFixture;
sandbox.warmLogisticsDashboardCache = () => {};
let lastAutoDueFixture = '';

/* ==========================================================================
 * Port side
 * ========================================================================== */

/**
 * Sheets-API range reader. Reproduces the trailing-empty omission -- the
 * hazard Service_Rollup's porting note 6 documents.
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
  const toIdx = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  };
  const colSpan = spec.match(/^([A-Z]+):([A-Z]+)$/);
  let out = rows.map((r) => r.slice());
  if (colSpan) {
    const a = toIdx(colSpan[1]);
    const b = toIdx(colSpan[2]);
    out = rows.map((r) => r.slice(a, b + 1));
  }
  return out.map((r) => {
    const c = r.slice();
    while (c.length > 0 && (c[c.length - 1] === '' || c[c.length - 1] === undefined)) c.pop();
    return c;
  });
}

const ssApiPath = require.resolve(path.join(ROOT, 'functions/services/Service_SheetsAPI.js'));
require.cache[ssApiPath] = {
  id: ssApiPath, filename: ssApiPath, loaded: true, exports: {
    getSpreadsheetId: () => 'parity-sheet',
    getSheetValues: async (range) => resolveRange(range),
    batchUpdateValues: async (updates) => {
      updates.forEach((u) => recorded.push(canonUpdate(u.range, u.values.map((v) => v.slice()))));
    },
    batchAppendRows: async (sheet, rows) => {
      recorded.push(canonAppend(sheet, rows.map((r) => r.slice())));
    },
    // Recorded EXACTLY as passed. SS_API.batchDeleteRows takes 1-based sheet
    // row numbers, which is what SRC's deleteRow() takes too, so no adjustment
    // is correct here.
    //
    // An earlier version of this stub "helpfully" did `i => i + 1`, which made
    // the numbers line up and hid a genuine off-by-one in the port (it was
    // passing a body index + 1, so it would have deleted the row ABOVE the
    // archived one -- losing a live shipment). A recorder that massages values
    // to match is worse than no recorder: it converts a caught bug into a
    // passing test. Mirror the real API, always.
    batchDeleteRows: async (gid, rowNumbers) => {
      recorded.push(canonDelete('SHIPMENTS', rowNumbers.slice()));
    },
    getSheetId: async () => 111,
    getSheetMetadata: async (n) => ({sheetId: 111, title: n})
  }
};

// Stub the TRANSPORT, not the module's exported trelloFetch_.
//
// Patching `require.cache[...].exports.trelloFetch_` looks equivalent and is
// not: a CommonJS module's internal calls resolve against its own module scope,
// never through its exports object. `applyIgnoreDeclaration_` calls the real
// `trelloFetch_` no matter what the exports say, so an exports-level stub left
// it reaching for the network, failing, and returning null -- while SRC's
// equivalent (UrlFetchApp.fetch, also unstubbed) failed and returned null too.
// Both sides broke identically, the diff stayed empty, and the .ignore
// scenarios were silently proving nothing. Global `fetch` is the real boundary
// and every path goes through it.
global.fetch = async (url, params) => {
  const method = (params && params.method) || 'get';
  recorded.push(canonTrello(url, method));
  const res = trelloRespond(url, method);
  return {
    status: res.code,
    ok: res.code >= 200 && res.code < 300,
    text: async () => res.text,
    headers: {get: () => null}
  };
};

const readPath = require.resolve(path.join(ROOT, 'functions/services/Service_Read.js'));
require.cache[readPath] = {
  id: readPath, filename: readPath, loaded: true, exports: {
    getCustomerRegistry: async () => REGISTRY,
    warmLogisticsDashboardCache: async () => {}
  }
};

const portDates = require(path.join(ROOT, 'functions/services/Service_Dates.js'));
const datesPath = require.resolve(path.join(ROOT, 'functions/services/Service_Dates.js'));
require.cache[datesPath].exports = Object.assign({}, portDates, {
  applySailingScheduleDeclaration_: async (...a) => {
    recorded.push(canonReadiness('applySailingScheduleDeclaration_', a));
  },
  applyReadyPortDeclaration_: async (...a) => {
    recorded.push(canonReadiness('applyReadyPortDeclaration_', a));
  },
  markEtaOverridden_: async (...a) => {
    recorded.push(canonReadiness('markEtaOverridden_', a));
  },
  getLastAutoDueForCard_: async () => lastAutoDueFixture
});

const portWebhook = require(path.join(ROOT, 'functions/services/Service_Webhook.js'));

/* ==========================================================================
 * Comparison
 * ========================================================================== */

let checks = 0;
const failures = [];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/;

/**
 * @param {*} v
 * @return {*}
 */
function normalise(v) {
  if (v === null || v === undefined) return v;
  if (Object.prototype.toString.call(v) === '[object Date]') return '<ts>';
  if (Array.isArray(v)) return v.map(normalise);
  if (typeof v === 'object') {
    const out = {};
    Object.keys(v).forEach((k) => { out[k] = normalise(v[k]); });
    return out;
  }
  if (typeof v === 'string' && ISO_RE.test(v)) return '<ts>';
  return v;
}

/**
 * @param {*} v
 * @return {string}
 */
function j(v) {
  return JSON.stringify(v, (k, val) => (val === undefined ? '<undefined>' : val), 1);
}

/**
 * @param {string} label
 * @param {Object} pl the webhook payload.
 * @param {Object} [opts] {botId, lastAutoDue}
 * @return {Promise<void>}
 */
async function cmp(label, pl, opts) {
  checks++;
  sandboxBotId = (opts && opts.botId) || null;
  lastAutoDueFixture = (opts && opts.lastAutoDue) || '';
  if (opts && opts.botId) process.env.TRELLO_BOT_MEMBER_ID = opts.botId;
  else delete process.env.TRELLO_BOT_MEMBER_ID;

  WORKBOOK = freshWorkbook();
  const snapshot = JSON.parse(JSON.stringify(WORKBOOK));

  // Resolve the async parsers up front so the synchronous SRC side can be
  // handed the same answers. See the fixture note above.
  const commentText = (pl.action.data && pl.action.data.text) || '';
  sailingFixture = await portDates.parseSailingScheduleComment_(commentText);
  readyPortFixture = await portDates.parseReadyPortComment_(commentText);

  recorded = [];
  try {
    sandbox.processWebhookPayload(JSON.parse(JSON.stringify(pl)));
  } catch (e) {
    recorded.push({op: 'THREW', message: e.message});
  }
  const srcOps = normalise(recorded);

  WORKBOOK = JSON.parse(JSON.stringify(snapshot));
  recorded = [];
  try {
    await portWebhook.processWebhookPayload(JSON.parse(JSON.stringify(pl)), REGISTRY);
  } catch (e) {
    recorded.push({op: 'THREW', message: e.message});
  }
  const portOps = normalise(recorded);

  if (j(srcOps) !== j(portOps)) {
    failures.push(label + '\n    SRC :\n' + j(srcOps) + '\n    PORT:\n' + j(portOps));
  }
}

/* ==========================================================================
 * Scenarios
 * ========================================================================== */

/**
 * @return {Promise<void>}
 */
async function main() {
  // ---- list skip ---------------------------------------------------------
  await cmp('skipped list: NEEDED AS OF TODAY',
      payload({card: CARD('card-full'), list: {id: 'l', name: 'NEEDED AS OF TODAY'}}));
  await cmp('skipped list: GENERAL LEDGER',
      payload({card: CARD('card-full'), list: {id: 'l', name: 'general ledger'}}));
  await cmp('no list data at all -- must NOT be skipped',
      payload({card: CARD('card-full'), list: null, type: 'updateCheckItemStateOnCard'}));

  // ---- direction resolution ----------------------------------------------
  await cmp('inbound board resolves to Inbound + raw card name as entity',
      payload({card: CARD('card-full'), board: BOARD_PO}));
  await cmp('outbound board resolves to Outbound + store extraction',
      payload({card: CARD('card-out', {name: 'MAR 1670'}), board: BOARD_OUT,
        list: {id: 'l', name: 'TO BE SHIPPED'}}));
  await cmp('burlington board, desc bullets',
      payload({card: CARD('card-out', {name: 'Burlington Store 12',
        desc: '- 500 RF Labels\n* Milli x2'}), board: BOARD_BURL,
      list: {id: 'l', name: 'TO BE SHIPPED'}}));
  await cmp('unknown board falls back to the name-sniff guess',
      payload({card: CARD('card-full'), board: {id: 'nope', name: 'Some Receiving Board'}}));
  await cmp('unknown board with no inbound/receiving in the name -> Outbound',
      payload({card: CARD('card-full'), board: {id: 'nope', name: 'Random Board'}}));

  // ---- rollup status assignment ------------------------------------------
  await cmp('fully-checked inbound checklist -> RECEIVED',
      payload({card: CARD('card-full'), type: 'updateCheckItemStateOnCard'}));
  await cmp('partially-checked inbound checklist -> Partially Received',
      payload({card: CARD('card-partial'), type: 'updateCheckItemStateOnCard'}));
  await cmp('empty checklist, in-transit list -> ON THE WAY',
      payload({card: CARD('card-empty'), list: {id: 'l', name: 'OCEAN FREIGHT'}}));
  await cmp('tracking in the description -> ON THE WAY',
      payload({card: CARD('card-empty', {desc: 'Tracking 794644790553'})}));
  await cmp('completed list, inbound, not fully packed -> DELIVERED',
      payload({card: CARD('card-empty'), list: {id: 'l', name: 'Delivered'}}));
  await cmp('completed list, inbound, fully packed -> RECEIVED',
      payload({card: CARD('card-full'), list: {id: 'l', name: 'Delivered'}}));
  await cmp('received list, inbound -> RECEIVED',
      payload({card: CARD('card-empty'), list: {id: 'l', name: 'RECEIVED'}}));
  await cmp('outbound in a shipped list -> SHIPPED',
      payload({card: CARD('card-out', {name: 'MAR 1670'}), board: BOARD_OUT,
        list: {id: 'l', name: 'Shipped'}}));

  // A Check* event on an OUTBOUND card must still fetch checklists -- SCHEMA
  // §13 calls this out explicitly ("UNLESS the webhook action type itself
  // contains Check"). Without it an outbound card's packed state never updates
  // from a checklist tick.
  await cmp('Check* event on an OUTBOUND card still fetches checklists',
      payload({card: CARD('card-out', {name: 'MAR 1670'}), board: BOARD_OUT,
        list: {id: 'l', name: 'TO BE SHIPPED'}, type: 'updateCheckItemStateOnCard'}));

  // Due dates are formatted in the workbook's zone (America/New_York), not the
  // container's. An evening-UTC due lands on the PREVIOUS calendar day in New
  // York -- the exact off-by-one SRC's parseTrelloDate() comment documents.
  await cmp('due date in the evening UTC formats to the New York calendar day',
      payload({card: CARD('card-empty', {due: '2026-09-02T02:00:00.000Z'})}));
  await cmp('due date mid-morning UTC (same day either way)',
      payload({card: CARD('card-empty', {due: '2026-09-02T14:00:00.000Z'})}));

  // ---- the rank guard ----------------------------------------------------
  await cmp('rank guard: fresh status ranks lower than stored -> stored preserved',
      payload({card: CARD('card-partial'), list: {id: 'l', name: 'IN TRANSIT'},
        type: 'updateCheckItemStateOnCard'}));

  // ---- idempotency -------------------------------------------------------
  await cmp('unchanged row emits NO write',
      payload({card: CARD('card-same', {name: 'MAR 1671', desc: '• Widget'}),
        board: BOARD_OUT, list: {id: 'l', name: 'TO BE SHIPPED'}}));

  // ---- append path -------------------------------------------------------
  await cmp('new card appends',
      payload({card: CARD('card-new-inb', {name: 'CIS PO 7 - New'}), board: BOARD_PO}));
  await cmp('new card in a Received list is NOT appended',
      payload({card: CARD('card-new-inb', {name: 'CIS PO 7 - New'}), board: BOARD_PO,
        list: {id: 'l', name: 'RECEIVED'}}));
  await cmp('new card in a Delivered list IS appended (SCHEMA #10)',
      payload({card: CARD('card-new-inb', {name: 'CIS PO 7 - New'}), board: BOARD_PO,
        list: {id: 'l', name: 'Delivered'}}));

  // ---- card closed -------------------------------------------------------
  await cmp('closed local inbound card -> archived as RECEIVED',
      payload({card: CARD('card-close', {closed: true}), old: {closed: false}}));
  await cmp('closed non-local inbound card -> archived as DELIVERED',
      payload({card: CARD('card-close-nl', {name: 'CIS PO 10 - RTF GLOBAL', closed: true}),
        old: {closed: false}}));
  await cmp('closed outbound card -> archived as DELIVERED',
      payload({card: CARD('card-close-out', {name: 'MAR 99', closed: true}),
        board: BOARD_OUT, old: {closed: false}}));
  await cmp('closed card not in SHIPMENTS -> no-op',
      payload({card: CARD('card-ghost', {closed: true}), old: {closed: false}}));
  // Archiving a SHORT row: its blank trailing cells must reach Shipment_History
  // as "" (what Apps Script pads them to), not as undefined/null.
  await cmp('closed card whose SHIPMENTS row is short (trailing cells omitted)',
      payload({card: CARD('card-short', {name: 'CIS PO 6 - Short', closed: true}),
        old: {closed: false}}));
  await cmp('old.closed present but card.closed false -> normal update, not archive',
      payload({card: CARD('card-full', {closed: false}), old: {closed: true}}));

  // ---- ignore comments ---------------------------------------------------
  await cmp('.ignore comment adds the label',
      payload({card: CARD('card-full'), type: 'commentCard', text: '.ignore'}));
  await cmp('.unignore comment removes the label',
      payload({card: CARD('card-full'), type: 'commentCard', text: '.unignore'}));
  await cmp('unrelated comment does nothing',
      payload({card: CARD('card-full'), type: 'commentCard', text: 'please ignore the mess'}));
  await cmp('.ignore on an OUTBOUND card also fires (both directions)',
      payload({card: CARD('card-out', {name: 'MAR 1670'}), board: BOARD_OUT,
        list: {id: 'l', name: 'TO BE SHIPPED'}, type: 'commentCard', text: '.ignore'}));

  // ---- readiness side-effects (inbound only) ------------------------------
  await cmp('sailing-schedule comment takes priority over READY/PORT',
      payload({card: CARD('card-full'), type: 'commentCard',
        text: 'ETD 08/12/2026\nETA port (Vancouver) 09/02/2026'}));
  await cmp('READY/PORT comment',
      payload({card: CARD('card-full'), type: 'commentCard',
        text: 'READY 08/12/2026 PORT Vancouver'}));
  // SCHEMA §4F's ordering constraint, stated as a test: this row's A-J data is
  // byte-identical to what the payload produces, so the write is skipped -- and
  // the readiness side-effect must fire ANYWAY. If the readiness block is ever
  // moved below the idempotency return, this is the scenario that goes red.
  await cmp('READY/PORT comment on an UNCHANGED inbound row still fires',
      payload({card: CARD('card-same-inb', {name: 'CIS PO 5 - Steady'}),
        type: 'commentCard', text: 'READY 08/12/2026 PORT Vancouver'}));
  await cmp('sailing comment on an UNCHANGED inbound row still fires',
      payload({card: CARD('card-same-inb', {name: 'CIS PO 5 - Steady'}),
        type: 'commentCard',
        text: 'ETD 08/12/2026\nETA port (Vancouver) 09/02/2026'}));

  await cmp('READY/PORT comment on an OUTBOUND card does NOT fire',
      payload({card: CARD('card-out', {name: 'MAR 1670'}), board: BOARD_OUT,
        list: {id: 'l', name: 'TO BE SHIPPED'}, type: 'commentCard',
        text: 'READY 08/12/2026 PORT Vancouver'}));

  // ---- due-date override detection ---------------------------------------
  await cmp('due changed by a human, no bot id -> ETA_OVERRIDDEN',
      payload({card: CARD('card-full', {due: '2026-09-01T16:00:00.000Z'}),
        old: {due: '2026-08-01T16:00:00.000Z'}}),
      {lastAutoDue: '08/15/2026'});
  await cmp('due matches lastAutoDue -> our own echo, no override',
      payload({card: CARD('card-full', {due: '2026-09-01T16:00:00.000Z'}),
        old: {due: '2026-08-01T16:00:00.000Z'}}),
      {lastAutoDue: '09/01/2026'});
  await cmp('due changed BY the bot account -> no override',
      payload({card: CARD('card-full', {due: '2026-09-01T16:00:00.000Z'}),
        old: {due: '2026-08-01T16:00:00.000Z'}, member: 'bot-123'}),
      {botId: 'bot-123', lastAutoDue: ''});
  await cmp('due changed by a human WITH a bot account configured -> override',
      payload({card: CARD('card-full', {due: '2026-09-01T16:00:00.000Z'}),
        old: {due: '2026-08-01T16:00:00.000Z'}, member: 'member-human'}),
      {botId: 'bot-123', lastAutoDue: ''});

  console.log('\nran ' + checks + ' scenario comparisons');
  if (failures.length === 0) {
    console.log('WEBHOOK PARITY OK — identical row writes, archives, Trello calls ' +
      'and readiness side-effects on every scenario\n');
  } else {
    console.log('\n' + failures.length + ' DIFFERENCE(S):\n');
    failures.slice(0, 3).forEach((f) => console.log('  ' + f + '\n'));
    if (failures.length > 3) console.log('  … and ' + (failures.length - 3) + ' more');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
