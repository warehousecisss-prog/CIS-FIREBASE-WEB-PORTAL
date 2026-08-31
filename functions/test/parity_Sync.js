/**
 * ============================================================================
 * PARITY HARNESS -- syncAllBoardsToShipmentsTab (SCHEMA.md Section 7, Writer 1)
 * ============================================================================
 * The scheduled full-board pull, plus the two functions that remove finished
 * rows from SHIPMENTS. Between them they decide, every cycle, what the whole
 * dashboard is made of.
 *
 * COMPARES WHAT IT WRITES, NOT WHAT IT RETURNS -- same approach as the rollup
 * and webhook harnesses. Both sides get recording fakes and the op streams are
 * diffed: row updates, appends, row removals, and the Shipment_History appends.
 *
 * ONE DELIBERATE DIVERGENCE, and it is the reason this harness matters most:
 * ------------------------------------------------------------------------
 * SRC removes SHIPMENTS rows by rewriting columns A-J -- on an EIGHTEEN-column
 * (A-R) sheet. Columns K-R hold the entire readiness/ETA state machine, and
 * they are never moved, so every row below an archived one keeps ANOTHER
 * shipment's ETA data. The port deletes whole rows instead.
 *
 * That divergence is asserted explicitly (`compactionDivergence`), not hidden:
 * SRC must emit the A-J clear-and-rewrite, the port must emit an equivalent
 * whole-row delete, and the SET OF SURVIVING CARD IDS MUST BE IDENTICAL. The
 * last part is what proves the fix changes only column alignment and not which
 * shipments live or die.
 *
 * TIMESTAMPS are normalised to `<ts>` (SRC writes a live Date, the port writes
 * an ISO string -- a Date cannot pass cleanly through the Sheets API).
 *
 *   npm run test:parity:sync
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..');
const srcShared = path.join(ROOT, 'SRC/src/Shared_Classifiers.js');
const srcSync = path.join(ROOT, 'SRC/src/syncAllBoardsToShipmentsTab.js');

if (!fs.existsSync(srcSync)) {
  console.log('SKIP: ' + srcSync + ' not present (SRC/ is gitignored -- it lives on the ' +
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
  {Parent_Account: 'TJX', Brand_ID: 'TJX', Brand_Name: 'TJX',
    Regex_Aliases: 'TJX', Target_Board_ID: 'BURLINGTON_OUTBOUND_BOARD_ID',
    Warehouse_Type: 'Local Warehouse', Handling_Type: 'Warehouse'}
];

/* ==========================================================================
 * Workbook -- SHIPMENTS is built at its REAL 18-column width, which is the
 * whole point: a 10-column fixture could not show the K-R desync at all.
 * ========================================================================== */

/**
 * @param {Array<*>} aj columns A-J
 * @param {string} tag a marker written into K and R, so a desync is visible.
 * @return {Array<*>} an 18-wide row.
 */
function row18(aj, tag) {
  const r = aj.slice();
  while (r.length < 10) r.push('');
  // K..R: rtsDate, rtsBasis, etaDate, etaBasis, dateState, port, lastAutoDue, overridden
  return r.concat([
    tag + '-RTS', 'ESTIMATE', tag + '-ETA', 'DERIVED',
    'RTS_ESTIMATED', tag + '-PORT', tag + '-DUE', 'FALSE'
  ]);
}

const SHIP_HEADER = [
  'Card ID', 'Direction', 'Board Source', 'Entity', 'Transit Mode',
  'Scheduled Date', 'List Status', 'Line Items', 'Master Tracking', 'Rollup Status',
  'RTS Date', 'RTS Basis', 'ETA Date', 'ETA Basis', 'Date State',
  'Port of Arrival', 'Last Auto Due', 'ETA Overridden'
];

/** @return {Object} a fresh workbook. */
function freshWorkbook() {
  return {
    'SHIPMENTS': [
      SHIP_HEADER,
      // --- inbound, archivable three different ways -----------------------
      row18(['s-rcvd', 'Inbound', 'Purchase Orders', 'CIS PO 1 - Local', 'Ocean Freight',
        '08/01/2026', 'IN TRANSIT', 'A | QTY: 2 | RCVD: 1', '', 'RECEIVED'], 'K1'),
      row18(['s-nonlocal', 'Inbound', 'Purchase Orders', 'CIS PO 2 - RTF GLOBAL',
        'Ocean Freight', '08/01/2026', 'IN TRANSIT', 'B | QTY: 1 | RCVD: 0', '',
        'DELIVERED'], 'K2'),
      row18(['s-fullrcvd', 'Inbound', 'Purchase Orders', 'CIS PO 3 - Local', 'Ocean Freight',
        '08/01/2026', 'IN TRANSIT', 'C | QTY: 0 | RCVD: 7', '', 'DELIVERED'], 'K3'),
      // --- inbound that must NOT be archived ------------------------------
      row18(['s-keep-inb', 'Inbound', 'Purchase Orders', 'CIS PO 4 - Local', 'Ocean Freight',
        '08/01/2026', 'IN TRANSIT', 'D | QTY: 5 | RCVD: 0', '', 'DELIVERED'], 'K4'),
      row18(['s-keep-pend', 'Inbound', 'Nicole POs', 'CIS PO 5', 'Ocean Freight',
        '08/01/2026', 'IN TRANSIT', 'E | QTY: 5 | RCVD: 0', '', 'PENDING'], 'K5'),
      // --- outbound ---------------------------------------------------------
      row18(['s-out-deliv', 'Outbound', 'Shipping Schedule', 'MAR #1', 'Standard / Ground',
        '08/01/2026', 'SHIPPED', 'x', '', 'DELIVERED'], 'K6'),
      row18(['s-out-tbs', 'Outbound', 'Shipping Schedule', 'MAR #2', 'Standard / Ground',
        '08/01/2026', 'TO BE SHIPPED', 'x', '', 'PENDING PACK'], 'K7'),
      row18(['s-out-keep', 'Outbound', 'Burlington Shipping Schedule', 'Burlington Store 9',
        'Standard / Ground', '08/01/2026', 'TO BE SHIPPED', 'x', '', 'PARTIAL PACK'], 'K8'),
      // --- a row whose card has vanished from a fully-processed board -----
      row18(['s-vanished', 'Outbound', 'Shipping Schedule', 'MAR #3', 'Standard / Ground',
        '08/01/2026', 'TO BE SHIPPED', 'x', '', 'PENDING PACK'], 'K9'),
      // --- a row on a board that will NOT finish -- must never be pruned ---
      row18(['s-unfinished', 'Inbound', 'Nicole POs', 'CIS PO 6', 'Ocean Freight',
        '08/01/2026', 'IN TRANSIT', 'F | QTY: 1 | RCVD: 0', '', 'PENDING'], 'K10'),
      // --- a SHORT row: blank from column G onward, so the Sheets API returns
      // it truncated and the port must pad it. It archives on its list alone,
      // so its (missing) trailing cells reach Shipment_History -- as "" if
      // padded, as undefined if not. Deliberately NOT built by row18().
      ['s-short', 'Outbound', 'Shipping Schedule', 'MAR #7', '', '', 'SHIPPED']
    ],
    'Shipment_History': [
      ['Date Archived', 'Card ID', 'Direction', 'Board Source', 'Entity / Store',
        'Transit Mode', 'Scheduled Date', 'List Status', 'Line Items',
        'Master Tracking #', 'Rollup Status'],
      ['2026-08-01', 'already-archived', 'Inbound', 'Purchase Orders', 'X',
        '', '', '', '', '', 'RECEIVED']
    ],
    'Multi Piece Tracking': [
      ['Store', 'Store #', 'Direction', 'Master Trk #', 'Discovery'],
      ['MAR', '1', 'Outbound', '999000000001', '']
    ]
  };
}

let WORKBOOK = freshWorkbook();

/* ==========================================================================
 * Recording
 * ========================================================================== */

let recorded = [];

const canonUpdate = (range, values) => ({op: 'updateRow', range: range, values: values});
const canonAppend = (sheet, rows) => ({op: 'appendRows', sheet: sheet, rows: rows});
const canonClear = (range) => ({op: 'clearRange', range: range});
const canonDelete = (sheet, rows) => ({op: 'deleteRows', sheet: sheet, rows: rows});

/* ==========================================================================
 * SRC side
 * ========================================================================== */

/**
 * @param {string} name
 * @param {Array<Array<*>>} rows
 * @return {Object}
 */
function fakeSheet(name, rows) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const pad = (r, n) => {
    const c = (r || []).slice(0, n);
    while (c.length < n) c.push('');
    return c;
  };
  return {
    getLastRow: () => rows.length,
    getLastColumn: () => width,
    getDataRange: () => ({getValues: () => rows.map((r) => pad(r, width))}),
    getRange: function(row, col, numRows, numCols) {
      const nR = numRows === undefined ? 1 : numRows;
      const nC = numCols === undefined ? 1 : numCols;
      return {
        getValues: () => {
          const out = [];
          for (let r = 0; r < nR; r++) {
            const src = rows[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < nC; c++) {
              const v = src[col - 1 + c];
              line.push(v === undefined ? '' : v);
            }
            out.push(line);
          }
          return out;
        },
        // Records AND APPLIES. A recorder that does not mutate is not a sheet:
        // the sync runs archive and then prune against the SAME tab, and if the
        // first pass's removal is invisible to the second, the two sides drift
        // for reasons that have nothing to do with the port. Applying also
        // makes the final sheet -- including columns K-R -- directly
        // inspectable, which is the whole point of this harness.
        setValues: (values) => {
          const a = String.fromCharCode(64 + col);
          const b = String.fromCharCode(64 + col + nC - 1);
          if (row === rows.length + 1) {
            recorded.push(canonAppend(name, values.map((v) => v.slice())));
            values.forEach((v) => rows.push(v.slice()));
            return;
          }
          recorded.push(canonUpdate(`${name}!${a}${row}:${b}${row + nR - 1}`,
              values.map((v) => v.slice())));
          values.forEach((v, r) => {
            const target = rows[row - 1 + r] || (rows[row - 1 + r] = []);
            for (let c = 0; c < nC; c++) target[col - 1 + c] = v[c];
          });
        },
        clearContent: () => {
          const a = String.fromCharCode(64 + col);
          const b = String.fromCharCode(64 + col + nC - 1);
          recorded.push(canonClear(`${name}!${a}${row}:${b}${row + nR - 1}`));
          for (let r = 0; r < nR; r++) {
            const target = rows[row - 1 + r];
            if (!target) continue;
            for (let c = 0; c < nC; c++) target[col - 1 + c] = '';
          }
        },
        setNumberFormat: () => {},
        setFontWeight: function() { return this; },
        setBackground: function() { return this; },
        setFontColor: function() { return this; }
      };
    },
    appendRow: (r) => { recorded.push(canonAppend(name, [r.slice()])); rows.push(r.slice()); },
    deleteRow: (r) => { recorded.push(canonDelete(name, [r])); rows.splice(r - 1, 1); },
    setFrozenRows: () => {}
  };
}

const sandbox = {
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => {
        if (k === 'TRELLO_KEY') return 'PARITY_KEY';
        if (k === 'TRELLO_TOKEN') return 'PARITY_TOKEN';
        return BOARD_DEFAULTS[k] || null;
      },
      setProperty: () => {}
    })
  },
  Logger: {log: () => {}},
  Utilities: {
    sleep: () => {},
    formatDate: (d) => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(d);
      const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
      return `${g('month')}/${g('day')}/${g('year')}`;
    }
  },
  Session: {
    getActiveUser: () => ({getEmail: () => 'x@y.z'}),
    getScriptTimeZone: () => 'America/New_York'
  },
  CacheService: {getScriptCache: () => ({get: () => null, put: () => {}})},
  MailApp: {sendEmail: () => {}},
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => (WORKBOOK[n] ? fakeSheet(n, WORKBOOK[n]) : null),
      insertSheet: (n) => { WORKBOOK[n] = []; return fakeSheet(n, WORKBOOK[n]); },
      getSpreadsheetTimeZone: () => 'America/New_York',
      getUrl: () => 'https://sheets.example/parity'
    }),
    flush: () => {}
  },
  getCustomerRegistry: () => REGISTRY,
  trelloCreds_: () => ({key: 'PARITY_KEY', token: 'PARITY_TOKEN'}),
  // The pipeline steps the sync CALLS. Each has its own harness (rollup) or is
  // Service_Dates' (which has a 45,850-comparison one); what matters here is
  // that the sync invokes them, in order. Recorded as intent on both sides.
  evaluateRollupStatuses: () => { recorded.push({op: 'pipeline', fn: 'evaluateRollupStatuses'}); },
  detectMissedDueDateOverrides_: () => { recorded.push({op: 'pipeline', fn: 'detectMissedDueDateOverrides_'}); },
  backfillReadyPortFromComments_: () => { recorded.push({op: 'pipeline', fn: 'backfillReadyPortFromComments_'}); },
  refreshAllShipmentDateStates: () => { recorded.push({op: 'pipeline', fn: 'refreshAllShipmentDateStates'}); },
  warmLogisticsDashboardCache: () => { recorded.push({op: 'pipeline', fn: 'warmLogisticsDashboardCache'}); },
  console, Intl,
  JSON, Math, String, Number, Object, Array, RegExp, Date, Set, Map,
  parseInt, parseFloat, isNaN, isFinite
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(srcShared, 'utf8'), sandbox, {filename: srcShared});
vm.runInContext(fs.readFileSync(srcSync, 'utf8'), sandbox, {filename: srcSync});

// After the loads -- see the same note in parity_Rollup.js.
sandbox.UrlFetchApp = {
  fetch: (url) => {
    const r = trelloRespond(url);
    return {getResponseCode: () => r.code, getContentText: () => r.text};
  },
  fetchAll: (reqs) => reqs.map((rq) => {
    const r = trelloRespond(rq.url);
    return {getResponseCode: () => r.code, getContentText: () => r.text};
  })
};

/* ==========================================================================
 * Trello fixtures -- shared by both sides
 * ========================================================================== */

let TRELLO = {};

/** @return {Object} fresh Trello fixtures. */
function freshTrello() {
  return {
    lists: {
      [BOARD_DEFAULTS.INBOUND_PO_BOARD_ID]: [
        {id: 'po-l1', name: 'IN TRANSIT'}, {id: 'po-l2', name: 'Delivered'},
        {id: 'po-skip', name: 'NEEDED AS OF TODAY'}
      ],
      [BOARD_DEFAULTS.INBOUND_NICOLE_BOARD_ID]: [{id: 'nic-l1', name: 'IN TRANSIT'}],
      [BOARD_DEFAULTS.BURLINGTON_OUTBOUND_BOARD_ID]: [{id: 'burl-l1', name: 'TO BE SHIPPED'}],
      [BOARD_DEFAULTS.OUTBOUND_BOARD_ID]: [
        {id: 'out-l1', name: 'TO BE SHIPPED'}, {id: 'out-l2', name: 'Shipped'}
      ]
    },
    cards: {
      [BOARD_DEFAULTS.INBOUND_PO_BOARD_ID]: [
        // existing row, unchanged status
        {id: 's-keep-inb', name: 'CIS PO 4 - Local', desc: '', due: '2026-08-01T16:00:00.000Z',
          idList: 'po-l1', labels: [], checklists: [{checkItems: [{name: 'D | QTY: 5 | RCVD: 0', state: 'incomplete'}]}], actions: []},
        // NEW card -> append
        {id: 'c-new-inb', name: 'CIS PO 99 - Brand New', desc: 'Tracking 794644790553',
          due: '2026-08-15T16:00:00.000Z', idList: 'po-l1', labels: [], checklists: [], actions: []},
        // card in a SKIPPED list
        {id: 'c-skipped', name: 'CIS PO 100', desc: '', due: null, idList: 'po-skip',
          labels: [], checklists: [], actions: []},
        // fully-checked checklist -> RECEIVED
        {id: 'c-full', name: 'CIS PO 101 - Done', desc: '', due: null, idList: 'po-l1',
          labels: [], checklists: [{checkItems: [{name: 'z', state: 'complete'}]}], actions: []},
        // tracking harvested from a COMMENT, not the description
        {id: 'c-comment-trk', name: 'CIS PO 102', desc: '', due: null, idList: 'po-l1',
          labels: [], checklists: [],
          actions: [{data: {text: 'tracking is 888777666555'}}]},
        // existing row whose stored rollup outranks the recompute (rank guard)
        {id: 's-rcvd', name: 'CIS PO 1 - Local', desc: '', due: '2026-08-01T16:00:00.000Z',
          idList: 'po-l1', labels: [],
          checklists: [{checkItems: [{name: 'A | QTY: 2 | RCVD: 1', state: 'incomplete'}]}], actions: []},
        // Already in Shipment_History and NOT in SHIPMENTS -- must NOT be
        // re-appended, or every archived shipment reappears on the next sync.
        {id: 'already-archived', name: 'CIS PO 77 - Done long ago', desc: '', due: null,
          idList: 'po-l1', labels: [], checklists: [], actions: []},
        // In a "Delivered" list with a 100%-complete checklist. These boards
        // have no "Received" list, so isFullyPacked is the receiving-complete
        // signal -- RECEIVED, not DELIVERED. This is the PO 3503/3562 case.
        {id: 'c-deliv-full', name: 'CIS PO 103 - Delivered+checked', desc: '', due: null,
          idList: 'po-l2', labels: [],
          checklists: [{checkItems: [{name: 'q | QTY: 0 | RCVD: 4', state: 'complete'}]}], actions: []},
        // Same list, checklist NOT complete -> stays DELIVERED (the other side
        // of the same branch).
        {id: 'c-deliv-part', name: 'CIS PO 104 - Delivered only', desc: '', due: null,
          idList: 'po-l2', labels: [],
          checklists: [{checkItems: [{name: 'r | QTY: 4 | RCVD: 0', state: 'incomplete'}]}], actions: []}
      ],
      [BOARD_DEFAULTS.INBOUND_NICOLE_BOARD_ID]: [
        {id: 's-keep-pend', name: 'CIS PO 5', desc: '', due: '2026-08-01T16:00:00.000Z',
          idList: 'nic-l1', labels: [], checklists: [], actions: []},
        {id: 's-unfinished', name: 'CIS PO 6', desc: '', due: '2026-08-01T16:00:00.000Z',
          idList: 'nic-l1', labels: [], checklists: [], actions: []}
      ],
      [BOARD_DEFAULTS.BURLINGTON_OUTBOUND_BOARD_ID]: [
        // NOT a known brand -> gets renamed "Burlington Store <name>"
        {id: 'c-burl-plain', name: '4477', desc: '', due: null, idList: 'burl-l1',
          labels: [], checklists: [], actions: []},
        // starts with STORE -> "Burlington <name>"
        {id: 'c-burl-store', name: 'Store 88', desc: '', due: null, idList: 'burl-l1',
          labels: [], checklists: [], actions: []},
        // a registry brand -> left alone
        {id: 'c-burl-tjx', name: 'TJX multi-store', desc: '', due: null, idList: 'burl-l1',
          labels: [], checklists: [], actions: []},
        // a legacy-keyword brand -> left alone
        {id: 'c-burl-aeo', name: 'AEO rollout', desc: '', due: null, idList: 'burl-l1',
          labels: [], checklists: [], actions: []},
        {id: 's-out-keep', name: 'Burlington Store 9', desc: '', due: '2026-08-01T16:00:00.000Z',
          idList: 'burl-l1', labels: [], checklists: [], actions: []}
      ],
      [BOARD_DEFAULTS.OUTBOUND_BOARD_ID]: [
        {id: 's-out-tbs', name: 'MAR 2', desc: '', due: '2026-08-01T16:00:00.000Z',
          idList: 'out-l1', labels: [], checklists: [], actions: []},
        {id: 's-out-deliv', name: 'MAR 1', desc: '', due: '2026-08-01T16:00:00.000Z',
          idList: 'out-l2', labels: [], checklists: [], actions: []}
        // NOTE: s-vanished is deliberately absent -> pruned
      ]
    },
    // Per-card lookups used by resolveVanishedCardStatusesBatch_
    cardLookup: {
      's-vanished': {closed: true, idBoard: BOARD_DEFAULTS.OUTBOUND_BOARD_ID}
    }
  };
}

/**
 * @param {string} url
 * @return {{code: number, text: string}}
 */
function trelloRespond(url) {
  const u = String(url);
  let m = u.match(/\/boards\/([^/]+)\/lists/);
  if (m) {
    const l = TRELLO.lists[m[1]];
    return l ? {code: 200, text: JSON.stringify(l)} : {code: 404, text: 'no board'};
  }
  m = u.match(/\/boards\/([^/]+)\/cards/);
  if (m) {
    const c = TRELLO.cards[m[1]];
    return c ? {code: 200, text: JSON.stringify(c)} : {code: 404, text: 'no board'};
  }
  m = u.match(/\/cards\/([^?]+)\?/);
  if (m) {
    const info = TRELLO.cardLookup[m[1]];
    return info ? {code: 200, text: JSON.stringify(info)} : {code: 404, text: 'gone'};
  }
  return {code: 200, text: '{}'};
}

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
  let out = rows.map((r) => r.slice());
  if (colSpan) {
    const a = toIdx(colSpan[1]);
    const b = toIdx(colSpan[2]);
    out = rows.map((r) => r.slice(a, b + 1));
  }
  // The Sheets API omits trailing empty cells.
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
    // Records AND APPLIES, for the same reason as the SRC fake above.
    batchUpdateValues: async (updates) => {
      updates.forEach((u) => {
        recorded.push(canonUpdate(u.range, u.values.map((v) => v.slice())));
        const m = String(u.range).match(/^([^!]+)!([A-Z]+)(\d+)/);
        if (!m) return;
        const sheet = WORKBOOK[m[1]];
        if (!sheet) return;
        const toIdx = (s) => {
          let n = 0;
          for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
          return n - 1;
        };
        const startCol = toIdx(m[2]);
        const startRow = Number(m[3]) - 1;
        u.values.forEach((v, r) => {
          const target = sheet[startRow + r] || (sheet[startRow + r] = []);
          v.forEach((cell, c) => { target[startCol + c] = cell; });
        });
      });
    },
    batchAppendRows: async (sheet, rows) => {
      recorded.push(canonAppend(sheet, rows.map((r) => r.slice())));
      if (!WORKBOOK[sheet]) WORKBOOK[sheet] = [];
      rows.forEach((r) => WORKBOOK[sheet].push(r.slice()));
    },
    batchDeleteRows: async (gid, rowNumbers) => {
      recorded.push(canonDelete('SHIPMENTS', rowNumbers.slice()));
      // Descending, so earlier deletions do not shift later indices -- the same
      // thing SS_API.batchDeleteRows does before issuing its requests.
      [...new Set(rowNumbers)].sort((a, b) => b - a)
          .forEach((n) => WORKBOOK.SHIPMENTS.splice(n - 1, 1));
    },
    // The number-format call is infrastructure, not a data write; SRC's
    // setNumberFormat is a no-op in the fake sheet above, so neither side
    // records it.
    batchUpdateSheet: async () => ({}),
    getSheetId: async () => 111,
    getSheetMetadata: async (n) => ({sheetId: 111, title: n})
  }
};

// Transport stub -- the real boundary, so module-internal calls are covered
// too. See the note in parity_Webhook.js about why patching exports is not
// enough.
global.fetch = async (url) => {
  const r = trelloRespond(url);
  return {status: r.code, ok: r.code < 300, text: async () => r.text, headers: {get: () => null}};
};

const readPath = require.resolve(path.join(ROOT, 'functions/services/Service_Read.js'));
require.cache[readPath] = {
  id: readPath, filename: readPath, loaded: true, exports: {
    getCustomerRegistry: async () => REGISTRY,
    warmLogisticsDashboardCache: async () => {
      recorded.push({op: 'pipeline', fn: 'warmLogisticsDashboardCache'});
    }
  }
};

const rollupPath = require.resolve(path.join(ROOT, 'functions/services/Service_Rollup.js'));
require.cache[rollupPath] = {
  id: rollupPath, filename: rollupPath, loaded: true, exports: {
    evaluateRollupStatuses: async () => {
      recorded.push({op: 'pipeline', fn: 'evaluateRollupStatuses'});
      return {success: true, counts: {}};
    }
  }
};

const datesPath = require.resolve(path.join(ROOT, 'functions/services/Service_Dates.js'));
require.cache[datesPath] = {
  id: datesPath, filename: datesPath, loaded: true, exports: {
    detectMissedDueDateOverrides_: async () => {
      recorded.push({op: 'pipeline', fn: 'detectMissedDueDateOverrides_'});
    },
    backfillReadyPortFromComments_: async () => {
      recorded.push({op: 'pipeline', fn: 'backfillReadyPortFromComments_'});
    },
    refreshAllShipmentDateStates: async () => {
      recorded.push({op: 'pipeline', fn: 'refreshAllShipmentDateStates'});
    }
  }
};

const portSync = require(path.join(ROOT, 'functions/services/Service_Sync.js'));

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
 * Splits an op stream into the row-removal ops (which are EXPECTED to differ --
 * see the header) and everything else (which must not).
 *
 * ORDER-AWARE, and it has to be. SRC's compaction is a `clearRange` of
 * `SHIPMENTS!A2:J<last>` immediately followed by an `updateRow` of
 * `SHIPMENTS!A2:J<survivors>` -- but the sync ALSO issues ordinary per-row
 * updates like `SHIPMENTS!A2:J2` on its normal path, which look identical to a
 * pattern match. A first version classified those as compaction and reported a
 * difference that did not exist. Only an A2:J write that FOLLOWS a clear is the
 * compaction partner.
 *
 * @param {Array<Object>} ops
 * @return {{removal: Array<Object>, rest: Array<Object>,
 *           compactionRewrite: ?Object, sawClear: boolean,
 *           deletedRows: Array<number>}}
 */
function splitRemoval(ops) {
  const removal = [];
  const rest = [];
  let sawClear = false;
  let awaitingRewrite = false;
  let compactionRewrite = null;
  const deletedRows = [];

  ops.forEach((o) => {
    if (o.op === 'clearRange' && /^SHIPMENTS!A2:J/.test(o.range)) {
      sawClear = true;
      awaitingRewrite = true;
      removal.push(o);
      return;
    }
    if (awaitingRewrite && o.op === 'updateRow' && /^SHIPMENTS!A2:J/.test(o.range)) {
      awaitingRewrite = false;
      compactionRewrite = o;
      removal.push(o);
      return;
    }
    if (o.op === 'deleteRows') {
      o.rows.forEach((n) => deletedRows.push(n));
      removal.push(o);
      return;
    }
    rest.push(o);
  });

  return {
    removal: removal, rest: rest, compactionRewrite: compactionRewrite,
    sawClear: sawClear, deletedRows: deletedRows
  };
}

/**
 * The card ids left on SHIPMENTS, read from the resulting sheet rather than
 * reconstructed from the op stream. The fakes apply their writes, so this is
 * simply what the tab now contains.
 *
 * @param {Array<Array<*>>} sheet
 * @return {Array<string>}
 */
function survivingCardIds(sheet) {
  return sheet.slice(1).map((r) => String((r || [])[0] || '').trim()).filter((x) => x);
}

/**
 * For each surviving card, does its readiness/ETA block (columns K-R) still
 * belong to it?
 *
 * The fixture stamps a per-row tag into K, P and Q (`K3-RTS`, `K3-PORT`,
 * `K3-DUE`), so a row that has kept another shipment's ETA data is directly
 * visible. This is the concrete demonstration of the bug SRC's A-J compaction
 * causes -- and of the port's fix.
 *
 * @param {Array<Array<*>>} sheet
 * @param {Array<Array<*>>} before the SHIPMENTS rows before the run.
 * @return {{intact: Array<string>, desynced: Array<string>}}
 */
function readinessAlignment(sheet, before) {
  // cardId -> the K-column tag it started with.
  const originalTag = {};
  before.slice(1).forEach((r) => {
    const id = String((r || [])[0] || '').trim();
    if (id) originalTag[id] = String((r || [])[10] || '');
  });

  const intact = [];
  const desynced = [];
  sheet.slice(1).forEach((r) => {
    const id = String((r || [])[0] || '').trim();
    if (!id) return;
    // A card appended during this run legitimately has no K-R block yet --
    // Service_Dates fills it on the next refresh. Only rows that HAD one can
    // have lost it.
    if (!Object.prototype.hasOwnProperty.call(originalTag, id)) return;
    const nowTag = String((r || [])[10] || '');
    if (nowTag === originalTag[id]) intact.push(id);
    else desynced.push(id + ' (has ' + (nowTag || '<blank>') + ', should have ' +
      (originalTag[id] || '<blank>') + ')');
  });
  return {intact: intact, desynced: desynced};
}

/**
 * @param {string} label
 * @param {Function} runSrc
 * @param {Function} runPort
 * @param {Function} [mutate]
 * @return {Promise<void>}
 */
async function cmpRun(label, runSrc, runPort, mutate) {
  checks++;
  WORKBOOK = freshWorkbook();
  TRELLO = freshTrello();
  if (mutate) mutate(WORKBOOK, TRELLO);
  const snapshot = JSON.parse(JSON.stringify(WORKBOOK));
  const before = snapshot.SHIPMENTS;

  recorded = [];
  try { runSrc(); } catch (e) { recorded.push({op: 'THREW', message: e.message}); }
  const srcOps = normalise(recorded);
  const srcSheet = JSON.parse(JSON.stringify(WORKBOOK.SHIPMENTS));

  WORKBOOK = JSON.parse(JSON.stringify(snapshot));
  TRELLO = freshTrello();
  if (mutate) mutate(WORKBOOK, TRELLO);
  recorded = [];
  try { await runPort(); } catch (e) { recorded.push({op: 'THREW', message: e.message}); }
  const portOps = normalise(recorded);
  const portSheet = JSON.parse(JSON.stringify(WORKBOOK.SHIPMENTS));

  const s = splitRemoval(srcOps);
  const p = splitRemoval(portOps);

  if (j(s.rest) !== j(p.rest)) {
    failures.push(label + ' — non-removal operations differ\n    SRC :\n' + j(s.rest) +
      '\n    PORT:\n' + j(p.rest));
  }

  // The divergence, asserted rather than skipped: the two removal MECHANISMS
  // differ, the set of surviving shipments must not.
  const srcSurvivors = survivingCardIds(srcSheet);
  const portSurvivors = survivingCardIds(portSheet);
  checks++;
  if (j(srcSurvivors.slice().sort()) !== j(portSurvivors.slice().sort())) {
    failures.push(label + ' — the two removal strategies kept DIFFERENT rows, which the ' +
      'compaction divergence does NOT license\n    SRC keeps : ' + j(srcSurvivors) +
      '\n    PORT keeps: ' + j(portSurvivors));
  }

  // And each side used the strategy it is supposed to. This is what stops the
  // harness passing vacuously if the port ever reverted to A-J compaction.
  if (s.removal.length > 0) {
    checks++;
    const srcIsCompaction = s.sawClear;
    const portIsDelete = p.deletedRows.length > 0 &&
      p.removal.every((o) => o.op === 'deleteRows');
    if (!srcIsCompaction || !portIsDelete) {
      failures.push(label + ' — removal strategies are not the documented pair ' +
        '(SRC A-J compaction vs port whole-row delete)\n    SRC :\n' + j(s.removal) +
        '\n    PORT:\n' + j(p.removal));
    }
  }

  // THE POINT OF THE DIVERGENCE: after the port runs, every surviving shipment
  // must still own its own K-R readiness/ETA block. (SRC's alignment is
  // reported separately by the bug demonstration in main(), not asserted here
  // -- SRC failing this is the bug, not a regression.)
  checks++;
  const portAlign = readinessAlignment(portSheet, before);
  if (portAlign.desynced.length > 0) {
    failures.push(label + ' — PORT left ' + portAlign.desynced.length +
      ' surviving row(s) carrying another shipment\'s readiness/ETA data:\n      ' +
      portAlign.desynced.join('\n      '));
  }

  return {srcSheet: srcSheet, portSheet: portSheet, before: before};
}

/* ==========================================================================
 * Scenarios
 * ========================================================================== */

/**
 * @return {Promise<void>}
 */
async function main() {
  const demo = await cmpRun('archiveCompletedShipments — all three inbound routes + outbound',
      () => sandbox.archiveCompletedShipments(),
      () => portSync.archiveCompletedShipments(REGISTRY));

  await cmpRun('archiveCompletedShipments — nothing to archive',
      () => sandbox.archiveCompletedShipments(),
      () => portSync.archiveCompletedShipments(REGISTRY),
      (wb) => {
        wb.SHIPMENTS = [SHIP_HEADER, row18(['keep', 'Inbound', 'Purchase Orders',
          'CIS PO x', 'Ocean Freight', '', 'IN TRANSIT', 'a | QTY: 5 | RCVD: 0', '',
          'PENDING'], 'KK')];
      });

  await cmpRun('archiveCompletedShipments — every row archivable',
      () => sandbox.archiveCompletedShipments(),
      () => portSync.archiveCompletedShipments(REGISTRY),
      (wb) => {
        wb.SHIPMENTS = [SHIP_HEADER,
          row18(['a1', 'Inbound', 'Purchase Orders', 'X', '', '', 'RECEIVED', '', '', 'RECEIVED'], 'A1'),
          row18(['a2', 'Outbound', 'Shipping Schedule', 'Y', '', '', 'SHIPPED', '', '', 'DELIVERED'], 'A2')];
      });

  await cmpRun('archiveCompletedShipments — a card already in history is not re-appended',
      () => sandbox.archiveCompletedShipments(),
      () => portSync.archiveCompletedShipments(REGISTRY),
      (wb) => {
        wb.SHIPMENTS = [SHIP_HEADER,
          row18(['already-archived', 'Inbound', 'Purchase Orders', 'X', '', '',
            'RECEIVED', '', '', 'RECEIVED'], 'AA')];
      });

  const liveByBoard = () => ({
    'Shipping Schedule': new Set(['s-out-tbs', 's-out-deliv']),
    'Purchase Orders': new Set(['s-rcvd', 's-keep-inb']),
    'Nicole POs': new Set(['s-keep-pend', 's-unfinished']),
    'Burlington Shipping Schedule': new Set(['s-out-keep'])
  });

  await cmpRun('pruneDeletedShipmentCards_ — one vanished card, board fully processed',
      () => sandbox.pruneDeletedShipmentCards_(liveByBoard(),
          new Set(['Shipping Schedule', 'Purchase Orders', 'Nicole POs',
            'Burlington Shipping Schedule'])),
      () => portSync.pruneDeletedShipmentCards_(liveByBoard(),
          new Set(['Shipping Schedule', 'Purchase Orders', 'Nicole POs',
            'Burlington Shipping Schedule']), REGISTRY));

  await cmpRun('pruneDeletedShipmentCards_ — only the fully-processed board is pruned',
      () => sandbox.pruneDeletedShipmentCards_(liveByBoard(), new Set(['Purchase Orders'])),
      () => portSync.pruneDeletedShipmentCards_(liveByBoard(),
          new Set(['Purchase Orders']), REGISTRY));

  await cmpRun('pruneDeletedShipmentCards_ — no boards processed at all',
      () => sandbox.pruneDeletedShipmentCards_(liveByBoard(), new Set()),
      () => portSync.pruneDeletedShipmentCards_(liveByBoard(), new Set(), REGISTRY));

  await cmpRun('pruneDeletedShipmentCards_ — vanished card is genuinely deleted (404)',
      () => sandbox.pruneDeletedShipmentCards_(liveByBoard(),
          new Set(['Shipping Schedule'])),
      () => portSync.pruneDeletedShipmentCards_(liveByBoard(),
          new Set(['Shipping Schedule']), REGISTRY),
      (wb, tr) => { delete tr.cardLookup['s-vanished']; });

  await cmpRun('pruneDeletedShipmentCards_ — vanished card moved to an untracked board',
      () => sandbox.pruneDeletedShipmentCards_(liveByBoard(),
          new Set(['Shipping Schedule'])),
      () => portSync.pruneDeletedShipmentCards_(liveByBoard(),
          new Set(['Shipping Schedule']), REGISTRY),
      (wb, tr) => { tr.cardLookup['s-vanished'] = {closed: false, idBoard: 'some-other-board'}; });

  // ---- the full sync, end to end ----------------------------------------
  // The main loop: board fetch, per-card recompute, the rank guard, the
  // Burlington rename, the list skip, tracking harvest into Multi Piece
  // Tracking, and the pipeline call ORDER (SCHEMA §4F requires
  // detectMissedDueDateOverrides_ between the sync's own write and
  // refreshAllShipmentDateStates).
  await cmpRun('syncAllBoardsToShipmentsTab — full run across all four boards',
      () => sandbox.syncAllBoardsToShipmentsTab(),
      () => portSync.syncAllBoardsToShipmentsTab());

  await cmpRun('syncAllBoardsToShipmentsTab — a board whose fetch fails is skipped',
      () => sandbox.syncAllBoardsToShipmentsTab(),
      () => portSync.syncAllBoardsToShipmentsTab(),
      (wb, tr) => { delete tr.cards[BOARD_DEFAULTS.OUTBOUND_BOARD_ID]; });

  await cmpRun('syncAllBoardsToShipmentsTab — an empty SHIPMENTS tab',
      () => sandbox.syncAllBoardsToShipmentsTab(),
      () => portSync.syncAllBoardsToShipmentsTab(),
      (wb) => { wb.SHIPMENTS = [SHIP_HEADER]; });

  await cmpRun('syncAllBoardsToShipmentsTab — every board returns no cards',
      () => sandbox.syncAllBoardsToShipmentsTab(),
      () => portSync.syncAllBoardsToShipmentsTab(),
      (wb, tr) => { Object.keys(tr.cards).forEach((k) => { tr.cards[k] = []; }); });

  // ---- the bug, demonstrated rather than asserted ------------------------
  // Not a pass/fail check: SRC failing this IS the bug. Printed so the claim in
  // PHASE_5_NOTES.md is backed by output anyone can reproduce.
  const srcAlign = readinessAlignment(demo.srcSheet, demo.before);
  const portAlign = readinessAlignment(demo.portSheet, demo.before);
  console.log('\n--- readiness/ETA alignment after archiving 4 of 10 shipments ---');
  console.log('  SRC  (A-J compaction) : ' + srcAlign.intact.length + ' intact, ' +
    srcAlign.desynced.length + ' carrying ANOTHER shipment\'s ETA data');
  srcAlign.desynced.forEach((d) => console.log('      ' + d));
  console.log('  PORT (whole-row delete): ' + portAlign.intact.length + ' intact, ' +
    portAlign.desynced.length + ' desynced');

  console.log('\nran ' + checks + ' comparisons across 13 scenarios');
  if (failures.length === 0) {
    console.log('SYNC PARITY OK — identical writes, identical surviving rows, and the ' +
      'documented A-J-compaction divergence verified\n');
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
