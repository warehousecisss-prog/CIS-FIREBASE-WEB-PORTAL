/**
 * ============================================================================
 * PARITY HARNESS -- evaluateRollupStatuses (SCHEMA.md Section 7)
 * ============================================================================
 * SCHEMA calls Section 7 "the most critical section", and this engine is the
 * whole of it: the rollup status in SHIPMENTS column J decides what every
 * shipment looks like on the dashboard, and two automations fire off it -- a
 * stakeholder email plus a Trello `dueComplete`, and a card list-move. The
 * 2026-08-26 incident in SCHEMA §7 is what a mistake here costs: one card
 * generated HUNDREDS of duplicate "PO Delivered in Full" emails.
 *
 * SO THIS COMPARES WHAT IT DOES, NOT WHAT IT RETURNS.
 * ---------------------------------------------------
 * SRC returns nothing at all (it is a void function that logs), so a return
 * comparison is not even available -- which is just as well, because it would
 * prove nothing. Both sides are given recording fakes for every side effect
 * they can have, and the two recordings are diffed:
 *
 *   - the single column-J write, cell for cell
 *   - every Trello call, method and URL
 *   - the notification email, recipients / subject / body
 *
 * Both recordings are normalised into one canonical op stream, because the two
 * sides reach the same effect through different APIs (SRC:
 * `getRange(2,10,n,1).setValues()`, `MailApp.sendEmail`; port:
 * `SS_API.batchUpdateValues`, `Service_Email.sendMail`). The normalisation is
 * mechanical and declared in `canon*()` below -- it maps API shape to intent
 * and nothing else. Cell values, ordering, and call counts are compared raw.
 *
 * ONE DELIBERATE DIVERGENCE is asserted rather than hidden -- see
 * `checkKnownDivergence()` at the bottom: with no stakeholder address
 * configured, SRC falls back to `Session.getActiveUser().getEmail()` and the
 * port skips the email with a loud error. A scheduled Cloud Function has no
 * session user and the Phase 1 auth decision forbids inventing one. Every
 * other scenario configures FEDEX_STAKEHOLDER so both sides take the same path.
 *
 *   npm run test:parity:rollup
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..');
const srcShared = path.join(ROOT, 'SRC/src/Shared_Classifiers.js');
const srcRollup = path.join(ROOT, 'SRC/src/evaluateRollupStatuses.js');

if (!fs.existsSync(srcRollup)) {
  console.log('SKIP: ' + srcRollup + ' not present (SRC/ is gitignored -- it lives on the ' +
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

/* ==========================================================================
 * The synthetic workbook.
 * ========================================================================== */

// SHIPMENTS columns A-J:
//   0 cardId | 1 direction | 2 boardSource | 3 entity | 4 transitMode
//   5 scheduledDate | 6 listStatus | 7 lineItems | 8 masterTracking | 9 rollup
const R = (cardId, direction, board, entity, list, trk, rollup) =>
  [cardId, direction, board, entity, 'Standard / Ground', '08/10/2026', list, 'items', trk, rollup];

const REGISTRY = [
  {Parent_Account: 'DROPCO', Brand_ID: 'DC', Brand_Name: 'DropCo',
    Regex_Aliases: 'DROPCO|DROP\\s*CO', Target_Board_ID: 'INBOUND_PO_BOARD_ID',
    Warehouse_Type: 'RTF Global', Handling_Type: 'Direct Drop Ship'},
  {Parent_Account: 'LOCALCO', Brand_ID: 'LC', Brand_Name: 'LocalCo',
    Regex_Aliases: 'LOCALCO', Target_Board_ID: 'INBOUND_PO_BOARD_ID',
    Warehouse_Type: 'Local Warehouse', Handling_Type: 'Warehouse'},
  // A malformed alias: must be logged and skipped, never abort the scan.
  {Parent_Account: 'BROKEN', Brand_ID: 'BK', Brand_Name: 'Broken',
    Regex_Aliases: '[unclosed', Target_Board_ID: 'INBOUND_PO_BOARD_ID',
    Warehouse_Type: '', Handling_Type: 'Direct Drop Ship'},
  // Reached only after the broken row above -- proves the scan continued.
  {Parent_Account: 'LATEDROP', Brand_ID: 'LD', Brand_Name: 'LateDrop',
    Regex_Aliases: 'LATEDROP', Target_Board_ID: 'INBOUND_PO_BOARD_ID',
    Warehouse_Type: '', Handling_Type: 'Direct Drop Ship'}
];

const CONFIG_WITH_STAKEHOLDER = [
  ['Key', 'Value'],
  ['SOMETHING_ELSE', 'ignored'],
  ['FEDEX_STAKEHOLDER', 'ops@example.com, boss@example.com'],
  ['STAKEHOLDER_EMAILS', 'receiving@example.com']
];

/** @return {Object} a fresh workbook. */
function freshWorkbook() {
  const SHIPMENTS = [
    ['Card ID', 'Direction', 'Board Source', 'Entity', 'Transit Mode',
      'Scheduled Date', 'List Status', 'Line Items', 'Master Tracking', 'Rollup Status'],

    // ---- Case A: no master tracking. Status preserved, every tally bucket. --
    R('c-a-pending', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '', 'PENDING'),
    R('c-a-blank', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '', ''),
    R('c-a-received', 'Inbound', 'Purchase Orders', 'ACME', 'RECEIVED', '', 'RECEIVED'),
    R('c-a-delivfull', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '', 'Delivered in Full'),
    R('c-a-oldlabel', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '', 'Received and Drops Off'),
    R('c-a-partpack', 'Outbound', 'Shipping Schedule', 'MAR 1670', 'TO BE SHIPPED', '', 'PARTIAL PACK'),
    R('c-a-partrcpt', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '', 'PARTIAL RECEIPT'),
    R('c-a-partdeliv', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '', 'Partially Delivered'),
    R('c-a-ontheway', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '', 'ON THE WAY'),
    R('c-a-shipped', 'Outbound', 'Shipping Schedule', 'MAR 1670', 'SHIPPED', '', 'SHIPPED'),
    R('c-a-intransit', 'Outbound', 'Shipping Schedule', 'MAR 1670', 'IN TRANSIT', '', 'IN TRANSIT'),
    R('c-a-exception', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '', 'EXCEPTION'),
    R('c-a-nonsense', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '', 'wat'),
    // tracking that cleans down to nothing -- still Case A
    R('c-a-junktrk', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', 'N/A', 'PENDING'),

    // ---- Case B: tracking, no discovered boxes ------------------------------
    R('c-b-manual', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '999000000001', 'RECEIVED'),
    R('c-b-listrcv', 'Inbound', 'Purchase Orders', 'ACME', 'RECEIVED', '999000000002', 'PENDING'),
    R('c-b-partial', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '999000000003', 'Partially Received'),
    R('c-b-listpart', 'Inbound', 'Purchase Orders', 'ACME', 'PARTIAL RECEIPT', '999000000004', 'PENDING'),
    R('c-b-plain', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '999000000005', 'PENDING'),

    // ---- Case C: all boxes delivered ---------------------------------------
    // fresh delivery -> Delivered in Full + automation
    R('c-c-fresh', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '100000000001', 'ON THE WAY'),
    // already manually received -> preserved, NO automation
    R('c-c-manual', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '100000000002', 'RECEIVED'),
    // drop-ship by Parent_Account -> COMPLETE
    R('c-c-dropacct', 'Inbound', 'Purchase Orders', 'DROPCO', 'IN TRANSIT', '100000000003', 'ON THE WAY'),
    // drop-ship by Brand_ID
    R('c-c-dropid', 'Inbound', 'Purchase Orders', 'DC', 'IN TRANSIT', '100000000004', 'ON THE WAY'),
    // drop-ship by Regex_Aliases
    R('c-c-dropregex', 'Inbound', 'Purchase Orders', 'Drop Co Warehouse', 'IN TRANSIT', '100000000005', 'ON THE WAY'),
    // non-drop-ship registry brand -> Delivered in Full, not COMPLETE
    R('c-c-localco', 'Inbound', 'Purchase Orders', 'LOCALCO', 'IN TRANSIT', '100000000006', 'ON THE WAY'),
    // matches only AFTER the malformed-regex row -> proves the scan continued
    R('c-c-latedrop', 'Inbound', 'Purchase Orders', 'LATEDROP', 'IN TRANSIT', '100000000007', 'ON THE WAY'),
    // list says delivered -> isManualReceived via classifyListStatus
    R('c-c-listdeliv', 'Inbound', 'Purchase Orders', 'ACME', 'DELIVERED', '100000000008', 'ON THE WAY'),

    // ---- Case C: partial delivery ------------------------------------------
    R('c-c-part', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '200000000001', 'ON THE WAY'),
    // the DELIVERED -> Partially Delivered anti-pattern: must NOT downgrade
    R('c-c-partman', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '200000000002', 'DELIVERED'),

    // ---- Case C: nothing delivered yet -------------------------------------
    R('c-c-none', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '300000000001', 'PENDING'),
    R('c-c-nonercv', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '300000000002', 'RECEIVED'),
    R('c-c-nonepart', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '300000000003', 'Partially Received'),

    // ---- Case C: exception outranks everything ------------------------------
    R('c-c-exc', 'Inbound', 'Purchase Orders', 'ACME', 'IN TRANSIT', '400000000001', 'ON THE WAY'),
    R('c-c-excrcv', 'Inbound', 'Purchase Orders', 'ACME', 'RECEIVED', '400000000002', 'RECEIVED'),

    // ---- board-freshness automation ----------------------------------------
    // Outbound, TO BE SHIPPED, real carrier scan -> move to Shipped
    R('c-m-scan', 'Outbound', 'Shipping Schedule', 'MAR 1670', 'TO BE SHIPPED', '500000000001', 'PENDING PACK'),
    // same board again -> proves the per-board list lookup is cached, not repeated
    R('c-m-scan2', 'Outbound', 'Shipping Schedule', 'MAR 1671', 'TO BE SHIPPED', '500000000002', 'PENDING PACK'),
    // only pre-transit statuses -> NO move
    R('c-m-pretrans', 'Outbound', 'Shipping Schedule', 'MAR 1672', 'TO BE SHIPPED', '500000000003', 'PENDING PACK'),
    // exception -> NO move
    R('c-m-exc', 'Outbound', 'Shipping Schedule', 'MAR 1673', 'TO BE SHIPPED', '500000000004', 'PENDING PACK'),
    // Inbound in a TO BE SHIPPED list -> NO move (Outbound only)
    R('c-m-inbound', 'Inbound', 'Purchase Orders', 'ACME', 'TO BE SHIPPED', '500000000005', 'PENDING'),
    // a board with no Shipped-classified list -> skipped, logged
    R('c-m-noboard', 'Outbound', 'Burlington Shipping Schedule', 'Burlington Store 12', 'TO BE SHIPPED', '500000000006', 'PENDING PACK'),
    // a board name not in the matrix at all -> skipped
    R('c-m-unknown', 'Outbound', 'Some Other Board', 'X 99', 'TO BE SHIPPED', '500000000007', 'PENDING PACK'),

    // ---- shape edge cases ---------------------------------------------------
    // a numeric-looking entity and a float tracking number out of Sheets
    ['c-e-float', 'Inbound', 'Purchase Orders', 0, 'Standard / Ground', '', 'IN TRANSIT', 'x', '100000000001.0', 'ON THE WAY'],
    // a row blank from column G onward -- the Sheets API omits trailing empties
    ['c-e-short', 'Inbound', 'Purchase Orders', 'SHORTY', 'Standard / Ground', ''],
    // a completely empty trailing row
    ['']
  ];

  // MPS Backend: master | child | status
  const MPS_BACKEND = [
    ['Master', 'Child', 'Status', 'Last Checked'],
    // all delivered
    ['100000000001', 'b1', 'Delivered - 08/05/2026'],
    ['100000000001', 'b2', 'DELIVERED'],
    ['100000000002', 'b1', 'Delivered'],
    ['100000000003', 'b1', 'Delivered'],
    ['100000000004', 'b1', 'Delivered'],
    ['100000000005', 'b1', 'Delivered'],
    ['100000000006', 'b1', 'Delivered'],
    ['100000000007', 'b1', 'Delivered'],
    ['100000000008', 'b1', 'Delivered'],
    // partial
    ['200000000001', 'b1', 'Delivered'],
    ['200000000001', 'b2', 'In Transit'],
    ['200000000002', 'b1', 'Delivered'],
    ['200000000002', 'b2', 'In Transit'],
    // none delivered
    ['300000000001', 'b1', 'In Transit'],
    ['300000000002', 'b1', 'In Transit'],
    ['300000000003', 'b1', 'In Transit'],
    // exceptions -- one per keyword the tree recognises
    ['400000000001', 'b1', 'Delivery Exception'],
    ['400000000001', 'b2', 'Delivered'],
    ['400000000002', 'b1', 'ADDRESS CORRECTION'],
    // board-freshness
    ['500000000001', 'b1', 'In Transit'],
    ['500000000002', 'b1', 'At destination sort facility'],
    ['500000000003', 'b1', 'Shipment information sent to FedEx'],
    ['500000000003', 'b2', 'Label Created'],
    ['500000000004', 'b1', 'In Transit'],
    ['500000000004', 'b2', 'DELAY'],
    ['500000000005', 'b1', 'In Transit'],
    ['500000000006', 'b1', 'In Transit'],
    ['500000000007', 'b1', 'In Transit'],
    // a blank master -- must be skipped, not keyed as ""
    ['', 'b9', 'In Transit']
  ];

  return {
    'SHIPMENTS': SHIPMENTS,
    'MPS Backend': MPS_BACKEND,
    'Config': CONFIG_WITH_STAKEHOLDER.map((r) => r.slice())
  };
}

let WORKBOOK = freshWorkbook();

/** Trello board list fixtures, keyed by board id. */
const BOARD_LISTS = {
  [BOARD_DEFAULTS.OUTBOUND_BOARD_ID]: [
    {id: 'list-tbs', name: 'TO BE SHIPPED'},
    {id: 'list-shipped', name: 'Shipped'},
    {id: 'list-delivered', name: 'Delivered'}
  ],
  // deliberately has NO list that classifies isShipped && !isToBeShipped
  [BOARD_DEFAULTS.BURLINGTON_OUTBOUND_BOARD_ID]: [
    {id: 'list-b-tbs', name: 'TO BE SHIPPED'},
    {id: 'list-b-done', name: 'Done'}
  ]
};

/* ==========================================================================
 * Recording + normalisation
 * ========================================================================== */

let recorded = [];

/** Canonical op for the one column-J write. */
const canonStatusWrite = (firstRow, values) =>
  ({op: 'writeStatusColumn', firstRow: firstRow, values: values});

/** Canonical op for a Trello call. Credentials are identical on both sides. */
function canonTrello(url, method) {
  return {
    op: 'trello',
    method: String(method || 'get').toLowerCase(),
    url: String(url).replace(/key=[^&]*/, 'key=K').replace(/token=[^&]*/, 'token=T')
  };
}

/** Canonical op for the notification email. */
const canonEmail = (to, subject, body) =>
  ({op: 'email', to: String(to), subject: String(subject), body: String(body)});

/** Shared Trello responder for both sides. */
function trelloRespond(url) {
  const listsMatch = String(url).match(/\/boards\/([^/]+)\/lists/);
  if (listsMatch) {
    const lists = BOARD_LISTS[listsMatch[1]];
    if (!lists) return {code: 404, text: 'no such board'};
    return {code: 200, text: JSON.stringify(lists)};
  }
  return {code: 200, text: '{}'};
}

/* ==========================================================================
 * SRC side
 * ========================================================================== */

/**
 * @param {string} name
 * @param {Array<Array<*>>} rows
 * @return {Object} an Apps Script Sheet stand-in.
 */
function fakeSheet(name, rows) {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    getLastRow: () => rows.length,
    getLastColumn: () => width,
    getDataRange: () => ({getValues: () => rows.map((r) => r.slice())}),
    getRange: function(row, col, numRows, numCols) {
      return {
        // Apps Script pads every row to numCols with "" -- reproduced here,
        // because that padding is exactly what the port has to imitate on top
        // of the Sheets API. See Service_Rollup's porting note 6.
        getValues: () => {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const src = rows[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < numCols; c++) {
              const v = src[col - 1 + c];
              line.push(v === undefined ? '' : v);
            }
            out.push(line);
          }
          return out;
        },
        setValues: (values) => {
          recorded.push(canonStatusWrite(row, values.map((v) => v.slice())));
        }
      };
    }
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
  Utilities: {sleep: () => {}},
  UrlFetchApp: {fetch: () => { throw new Error('no network in parity harness'); }},
  Session: {
    getActiveUser: () => ({getEmail: () => 'session-user@example.com'}),
    getEffectiveUser: () => ({getEmail: () => 'session-user@example.com'}),
    getScriptTimeZone: () => 'America/New_York'
  },
  CacheService: {getScriptCache: () => ({get: () => null, put: () => {}, remove: () => {}})},
  MailApp: {
    sendEmail: (opts) => {
      recorded.push(canonEmail(opts.to, opts.subject, opts.htmlBody));
    }
  },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: (name) => (WORKBOOK[name] ? fakeSheet(name, WORKBOOK[name]) : null),
      getSheets: () => [],
      getSpreadsheetTimeZone: () => 'America/New_York',
      getUrl: () => 'https://sheets.example/parity'
    }),
    flush: () => {}
  },
  // SRC reaches this as a global from another file in the Apps Script project.
  getCustomerRegistry: () => REGISTRY,
  console, Intl,
  JSON, Math, String, Number, Object, Array, RegExp, Date, Set, Map,
  parseInt, parseFloat, isNaN, isFinite
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(srcShared, 'utf8'), sandbox, {filename: srcShared});
vm.runInContext(fs.readFileSync(srcRollup, 'utf8'), sandbox, {filename: srcRollup});

// AFTER the loads, not before: Shared_Classifiers.js declares its own top-level
// `function trelloFetch_`, which in a VM context overwrites anything of that
// name already on the sandbox. Assigning first meant SRC silently used its real
// transport, hit `UrlFetchApp.fetch` ("no network in parity harness"), swallowed
// the failure in its own try/catch, and recorded NOTHING -- so SRC appeared to
// make no Trello calls at all while the port correctly made seven. Same
// ordering rule the assembly harness follows for its recording SS_API.
sandbox.trelloFetch_ = (url, opts) => {
  const method = (opts && opts.method) || 'get';
  recorded.push(canonTrello(url, method));
  const res = trelloRespond(url);
  return {
    ok: res.code >= 200 && res.code < 300,
    code: res.code,
    text: res.text,
    error: res.code >= 300 ? 'HTTP ' + res.code : null,
    getResponseCode: () => res.code,
    getContentText: () => res.text
  };
};

/* ==========================================================================
 * Port side
 * ========================================================================== */

/**
 * Translates a Sheets API range like "SHIPMENTS!A:J" into rows from WORKBOOK,
 * omitting trailing empty cells exactly as `values.get` does -- that omission
 * is the hazard porting note 6 is about, so the harness must reproduce it
 * rather than hand the port a conveniently rectangular grid.
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
  // Trailing-empty omission, as the real API does.
  return out.map((r) => {
    const copy = r.slice();
    while (copy.length > 0 && (copy[copy.length - 1] === '' || copy[copy.length - 1] === undefined)) {
      copy.pop();
    }
    return copy;
  });
}

const ssApiPath = require.resolve(path.join(ROOT, 'functions/services/Service_SheetsAPI.js'));
require.cache[ssApiPath] = {
  id: ssApiPath, filename: ssApiPath, loaded: true, exports: {
    getSpreadsheetId: () => 'parity-sheet',
    getSheetValues: async (range) => resolveRange(range),
    batchUpdateValues: async (updates) => {
      updates.forEach((u) => {
        const m = String(u.range).match(/!([A-Z]+)(\d+):/);
        recorded.push(canonStatusWrite(m ? Number(m[2]) : 0, u.values.map((v) => v.slice())));
      });
    },
    batchAppendRows: async () => {},
    batchDeleteRows: async () => {},
    getSheetId: async () => 111,
    getSheetMetadata: async (n) => ({sheetId: 111, title: n})
  }
};

const emailPath = require.resolve(path.join(ROOT, 'functions/services/Service_Email.js'));
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true, exports: {
    sendMail: async (msg) => {
      recorded.push(canonEmail(msg.to, msg.subject, msg.html));
      return {success: true};
    },
    sendPONotification: async () => ({success: true}),
    sendWithAttachments: async () => ({success: true})
  }
};

// Patch only trelloFetch_ on the real Shared_Classifiers, leaving every
// classifier it exports genuinely under test.
const sharedPath = require.resolve(path.join(ROOT, 'functions/services/Shared_Classifiers.js'));
const realShared = require(sharedPath);
require.cache[sharedPath].exports = Object.assign({}, realShared, {
  trelloFetch_: async (url, opts) => {
    const method = (opts && opts.method) || 'get';
    recorded.push(canonTrello(url, method));
    const res = trelloRespond(url);
    return {
      ok: res.code >= 200 && res.code < 300,
      code: res.code,
      text: res.text,
      error: res.code >= 300 ? 'HTTP ' + res.code : null,
      getResponseCode: () => res.code,
      getContentText: () => res.text
    };
  }
});

// Service_Read is required lazily by the port only when no registry is passed.
const readPath = require.resolve(path.join(ROOT, 'functions/services/Service_Read.js'));
require.cache[readPath] = {
  id: readPath, filename: readPath, loaded: true, exports: {
    getCustomerRegistry: async () => REGISTRY
  }
};

const portRollup = require(path.join(ROOT, 'functions/services/Service_Rollup.js'));

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
 * Runs one scenario on both sides and diffs the recorded op stream.
 *
 * Each row of the column-J write is counted as its own comparison -- that is
 * what is actually being asserted, one status decision per shipment -- plus one
 * for the op stream as a whole (which is what catches a missing email or an
 * extra Trello call).
 *
 * @param {string} label
 * @param {Function} mutate applied to a fresh workbook before the run.
 * @param {Array<Object>} [registry] defaults to REGISTRY. Fed to SRC through
 *     its `getCustomerRegistry` global and to the port through its argument,
 *     so both sides see the same registry on every scenario.
 * @param {string|null} [expectPortRecipient] when supplied, this scenario is
 *     one of the documented stakeholder-resolution divergences: email ops are
 *     excluded from the main diff and asserted separately -- SRC must mail the
 *     session user, the port must mail exactly this recipient (`null` meaning
 *     it must send nothing). Everything else -- every status cell, every Trello
 *     call -- must still match exactly, which is the whole point: differing on
 *     who gets notified must not change anything the engine actually does.
 * @return {Promise<void>}
 */
async function cmpRun(label, mutate, registry, expectPortRecipient) {
  if (registry === undefined) registry = REGISTRY;
  WORKBOOK = freshWorkbook();
  if (mutate) mutate(WORKBOOK);
  const snapshot = JSON.parse(JSON.stringify(WORKBOOK));

  sandbox.getCustomerRegistry = () => registry;

  recorded = [];
  try { sandbox.evaluateRollupStatuses(); } catch (e) {
    recorded.push({op: 'THREW', message: e.message});
  }
  const srcOps = recorded;

  WORKBOOK = JSON.parse(JSON.stringify(snapshot));
  recorded = [];
  try { await portRollup.evaluateRollupStatuses(registry); } catch (e) {
    recorded.push({op: 'THREW', message: e.message});
  }
  const portOps = recorded;

  const srcWrite = srcOps.find((o) => o.op === 'writeStatusColumn');
  const rowCount = srcWrite ? srcWrite.values.length : 0;
  checks += rowCount + 1;

  if (expectPortRecipient !== undefined) {
    checks++;
    const srcEmails = srcOps.filter((o) => o.op === 'email');
    const portEmails = portOps.filter((o) => o.op === 'email');
    const srcOk = srcEmails.length === 1 && srcEmails[0].to === 'session-user@example.com';
    const portOk = expectPortRecipient === null
      ? portEmails.length === 0
      : portEmails.length === 1 && portEmails[0].to === expectPortRecipient;
    // The body and subject must still be built identically -- only the
    // recipient is licensed to differ.
    const bodyOk = expectPortRecipient === null || (srcEmails[0] && portEmails[0] &&
        srcEmails[0].subject === portEmails[0].subject &&
        srcEmails[0].body === portEmails[0].body);
    if (!srcOk || !portOk || !bodyOk) {
      failures.push(label + ' — the documented stakeholder-resolution divergence did NOT hold:' +
        '\n    SRC emails (expected exactly 1, to the session user): ' + j(srcEmails) +
        '\n    PORT emails (expected ' +
        (expectPortRecipient === null ? 'none' : '1, to ' + expectPortRecipient) + '): ' +
        j(portEmails) +
        (bodyOk ? '' : '\n    subject/body differ, which this divergence does NOT license'));
    }
    // Everything else must still be identical.
    const strip = (ops) => ops.filter((o) => o.op !== 'email');
    if (j(strip(srcOps)) !== j(strip(portOps))) {
      failures.push(label + ' — statuses/Trello calls differ, which the email ' +
        'divergence does NOT license\n    SRC :\n' + j(strip(srcOps)) +
        '\n    PORT:\n' + j(strip(portOps)));
    }
    return;
  }

  if (j(srcOps) !== j(portOps)) {
    // Point at the first differing status cell when there is one -- far more
    // readable than diffing two 40-row arrays by eye.
    const portWrite = portOps.find((o) => o.op === 'writeStatusColumn');
    let detail = '';
    if (srcWrite && portWrite) {
      for (let i = 0; i < Math.max(srcWrite.values.length, portWrite.values.length); i++) {
        const a = j(srcWrite.values[i]);
        const b = j(portWrite.values[i]);
        if (a !== b) {
          const cardId = (snapshot.SHIPMENTS[i + 1] || [])[0];
          detail = `\n    first differing row: sheet row ${i + 2} (card "${cardId}")` +
                   `\n      SRC : ${a}\n      PORT: ${b}`;
          break;
        }
      }
    }
    failures.push(label + detail + '\n    SRC OPS :\n' + j(srcOps) + '\n    PORT OPS:\n' + j(portOps));
  }
}

/* ==========================================================================
 * The one known, deliberate divergence
 * ========================================================================== */

/**
 * The port's fallback chain ends in "skip the email", so the harness must also
 * prove that skipping it does not cost the actual work -- the status write and
 * the Trello `dueComplete` calls still have to happen. `cmpRun`'s
 * divergence branch already asserts the two op streams match once emails are
 * stripped, but "matches SRC" would also be satisfied if BOTH sides did
 * nothing, so this asserts the positive directly.
 *
 * @return {Promise<void>}
 */
async function checkWorkSurvivesMissingStakeholder() {
  checks++;
  WORKBOOK = freshWorkbook();
  WORKBOOK['Config'] = [['Key', 'Value'], ['UNRELATED', 'x']];

  recorded = [];
  await portRollup.evaluateRollupStatuses(REGISTRY);

  const wrote = recorded.find((o) => o.op === 'writeStatusColumn');
  const dueCompleteCalls = recorded.filter(
      (o) => o.op === 'trello' && o.method === 'put' && /\/cards\/[^?]+\?key=/.test(o.url));
  const sentNothing = recorded.filter((o) => o.op === 'email').length === 0;

  if (!wrote || wrote.values.length === 0 || dueCompleteCalls.length === 0 || !sentNothing) {
    failures.push('with no stakeholder configured, the port must still write statuses and ' +
      'call Trello, and must send no email:\n' +
      '    status write: ' + (wrote ? wrote.values.length + ' row(s)' : 'NONE') +
      '\n    dueComplete calls: ' + dueCompleteCalls.length +
      '\n    emails sent: ' + (sentNothing ? 0 : 'some'));
  }
}

/* ==========================================================================
 * Scenarios
 * ========================================================================== */

/**
 * @return {Promise<void>}
 */
async function main() {
  await cmpRun('full workbook -- every branch of the decision tree', null);

  await cmpRun('MPS Backend tab absent entirely (discovery never ran)', (wb) => {
    delete wb['MPS Backend'];
  });

  await cmpRun('MPS Backend present but empty (rows cleared)', (wb) => {
    wb['MPS Backend'] = [['Master', 'Child', 'Status', 'Last Checked']];
  });

  await cmpRun('SHIPMENTS header only -- nothing to evaluate', (wb) => {
    wb['SHIPMENTS'] = [wb['SHIPMENTS'][0]];
  });

  // The three documented stakeholder-resolution divergences. In every one, the
  // status column and every Trello call must still match SRC exactly.
  await cmpRun('no Config tab at all', (wb) => {
    delete wb['Config'];
  }, undefined, null);

  await cmpRun('Config tab present but no stakeholder key', (wb) => {
    wb['Config'] = [['Key', 'Value'], ['UNRELATED', 'x']];
  }, undefined, null);

  // STAKEHOLDER_EMAILS is the port's documented second choice; SRC does not
  // consult it and falls through to the session user instead.
  await cmpRun('Config with STAKEHOLDER_EMAILS but no FEDEX_STAKEHOLDER', (wb) => {
    wb['Config'] = [['Key', 'Value'], ['STAKEHOLDER_EMAILS', 'receiving@example.com']];
  }, undefined, 'receiving@example.com');

  await cmpRun('every box delivered across the whole board', (wb) => {
    wb['MPS Backend'] = [['Master', 'Child', 'Status']].concat(
        wb['SHIPMENTS'].slice(1)
            .map((r) => String(r[8] || '').replace(/[^0-9]/g, ''))
            .filter((t) => t)
            .map((t) => [t, 'b1', 'Delivered']));
  });

  await cmpRun('every box in exception', (wb) => {
    wb['MPS Backend'] = [['Master', 'Child', 'Status']].concat(
        wb['SHIPMENTS'].slice(1)
            .map((r) => String(r[8] || '').replace(/[^0-9]/g, ''))
            .filter((t) => t)
            .map((t) => [t, 'b1', 'Delivery Exception']));
  });

  // Registry variations: the drop-ship carve-out is the only thing that turns
  // "Delivered in Full" into "COMPLETE", so its absence must be visible.
  await cmpRun('empty registry -- no drop-ship resolution possible', null, []);

  await cmpRun('registry with ONLY the malformed-regex row', null, [REGISTRY[2]]);

  await checkWorkSurvivesMissingStakeholder();

  console.log('\nran ' + checks + ' comparisons across 11 scenarios ' +
    '(3 of them the verified stakeholder-resolution divergence)');
  if (failures.length === 0) {
    console.log('ROLLUP PARITY OK — identical status writes, Trello calls and ' +
      'notifications on every scenario\n');
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
