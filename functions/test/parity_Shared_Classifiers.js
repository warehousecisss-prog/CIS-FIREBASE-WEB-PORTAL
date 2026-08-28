/**
 * ============================================================================
 * PARITY HARNESS -- Shared_Classifiers
 * ============================================================================
 * Runs SRC/src/Shared_Classifiers.js and the ported
 * functions/services/Shared_Classifiers.js against identical inputs and fails
 * on any output difference.
 *
 * The point is that "I ported it carefully" is not evidence. These functions
 * are pure, so the original can simply be executed alongside the port and the
 * two answers compared -- which catches the class of porting mistake that
 * reads correctly and behaves differently (a dropped negation, a regex flag,
 * an ordering dependency like getRollupRank_'s PARTIAL-before-DELIVERED check).
 *
 * SRC/src is the original Apps Script repo. It is gitignored here and lives on
 * the porting machine only, so this SKIPS rather than fails when it is absent.
 *
 *   npm run test:parity
 *
 * Two rounds are run for the name-matching helpers: once with the PRODUCT
 * identity index empty, once with it populated. That second round is the one
 * that matters -- SRC reads the PRODUCT sheet synchronously inside
 * productIdentityKey_ and Node cannot, so the port splits the load into an
 * async primeQbNameIndex() plus a sync cache read. The round proves the split
 * did not change any answer.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..');
const srcPath = path.join(ROOT, 'SRC/src/Shared_Classifiers.js');
const portPath = path.join(ROOT, 'functions/services/Shared_Classifiers.js');

if (!fs.existsSync(srcPath)) {
  console.log('SKIP: ' + srcPath + ' not present (SRC/ is gitignored -- it lives on the ' +
              'porting machine only). Nothing to compare against.');
  process.exit(0);
}

// ---- board IDs the port's config will resolve to (defaults) ----------------
const BOARD_DEFAULTS = {
  INBOUND_PO_BOARD_ID: '649c805bad63086ff6689611',
  INBOUND_NICOLE_BOARD_ID: '64c286cd0d581563f72d58c0',
  BURLINGTON_OUTBOUND_BOARD_ID: '649c7dd6690130fe8ef3689a',
  OUTBOUND_BOARD_ID: '66bcf93dd63eecdb2d4e91e7'
};

// A small PRODUCT index, used identically on both sides.
const QB_INDEX = {};

const sandbox = {
  PropertiesService: {
    getScriptProperties: () => ({getProperty: (k) => BOARD_DEFAULTS[k] || null})
  },
  Logger: {log: () => {}},
  Utilities: {sleep: () => {}},
  UrlFetchApp: {fetch: () => { throw new Error('no network in parity harness'); }},
  SpreadsheetApp: {getActiveSpreadsheet: () => { throw new Error('no sheet'); }},
  getQbNameIndex_: () => QB_INDEX,
  trelloCreds_: () => ({key: 'k', token: 't'}),
  console,
  JSON, Math, String, Number, Object, Array, RegExp, Date, parseInt, isFinite
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(srcPath, 'utf8'), sandbox, {filename: srcPath});

// ---- load the port --------------------------------------------------------
process.env.INBOUND_PO_BOARD_ID = BOARD_DEFAULTS.INBOUND_PO_BOARD_ID;
const port = require(portPath);

// ---- corpora --------------------------------------------------------------
const LIST_NAMES = [
  '', null, 'TO BE SHIPPED', 'To Be Packed', 'RECEIVED', 'Delivered', 'DELIVERED ✅',
  'SHIPPED', 'DONE', 'COMPLETED', 'Complete', 'IN TRANSIT', 'ARCHIVED/DELETED',
  'Archived/Deleted', 'OCEAN FREIGHT', 'AIR FREIGHT', 'FEDEX', 'UPS Ground',
  'TRUCK LINES', 'NEEDED AS OF TODAY', 'GENERAL LEDGER', 'ocean freight - in transit'
];

const STATUSES = [
  '', null, 'PENDING', 'PARTIALLY RECEIVED', 'PARTIALLY DELIVERED', 'RECEIVED',
  'DELIVERED', 'Delivered in Full', 'DONE', 'COMPLETE', 'CLOSED', 'ON THE WAY',
  'IN TRANSIT', 'SHIPPED', 'PACKED', 'PENDING PACK', 'STAGED / PACKING', 'nonsense'
];

const SUMMARIES = [
  '', null, 'No specific shipping line items listed.',
  'WIDGET A | QTY: 0 | RCVD: 12',
  'WIDGET A | QTY: 5 | RCVD: 2',
  'WIDGET A | QTY: 0 | RCVD: 12\nWIDGET B | QTY: 0 | RCVD: 3',
  'WIDGET A | QTY: 0 | RCVD: 12\nWIDGET B | QTY: 4 | RCVD: 0',
  '[PORTAL_IGNORED]\nWIDGET A | QTY: 0 | RCVD: 1',
  'no line items here at all'
];

const TRANSIT_TEXTS = [
  '', null, 'OCEAN FREIGHT', 'sea freight', 'AIR', 'airfreight', 'FEDEX', 'ups',
  'TRUCK', 'GROUND', 'Standard', 'OCEAN and AIR', 'GROUND + FEDEX'
];

const REGISTRY = [
  {Regex_Aliases: 'BURLINGTON|BURL', Warehouse_Type: 'Local Warehouse', Target_Board_ID: 'INBOUND_PO_BOARD_ID'},
  {Regex_Aliases: 'TJX\\s*CANADA|TJXC', Warehouse_Type: 'RTF Global', Target_Board_ID: 'INBOUND_PO_BOARD_ID,OUTBOUND_BOARD_ID'},
  {Regex_Aliases: '[unclosed', Warehouse_Type: 'Broken', Target_Board_ID: 'INBOUND_PO_BOARD_ID'},
  {Regex_Aliases: 'AEO', Warehouse_Type: '', Target_Board_ID: 'OUTBOUND_BOARD_ID'},
  {Regex_Aliases: '', Warehouse_Type: 'X', Target_Board_ID: 'INBOUND_PO_BOARD_ID'}
];

const ENTITIES = ['', null, 'BURLINGTON', 'TJX CANADA', 'AEO', 'RTF GLOBAL', 'Australia', 'AUS', 'Nordstrom', 'TJXC'];

const NAMES = [
  '', null, 'V32', 'V32-BATTERY', 'T25-SCREW', 'T25-SCREWDRIVER',
  'SMART PL 48 AM', 'SMART PL 48 AM SLIDE',
  '[CIS 019 (SS Ink Pin 19mm)] INK PIN', '[ITEM] Hand typed thing', '[] bare',
  'CIS NT510/2AF (2-alarm RF padlock tag, 3.5"',
  'CIS NT510/2AF (2-alarm RF padlock tag, 3.5"cable (normal lock))',
  'A'.repeat(81) + '...', 'A'.repeat(81) + '... plus more',
  'short...', '  spaced   out   name  ', 'ink pin', 'INK PIN'
];

const PRODUCT_MAP_UPPER = {
  'CIS 019 (SS INK PIN 19MM)': {productId: 'CIS 019 (SS Ink Pin 19mm)', nickname: 'Ink Pin 19mm'},
  'V32': {productId: 'V32', nickname: 'Verso Tag'},
  'NONICK': {productId: 'NoNick', nickname: ''}
};

const SYS_BLOBS = [
  null, '', 'plain comment', 'comment _SYS_', 'comment _SYS_   ',
  'c _SYS_{"t":"B","n":3}', 'c _SYS_{"t":"B"', 'c _SYS_"juststring"',
  'c _SYS_null', 'c _SYS_[1,2]', 'c _SYS_{}', '_SYS_{"t":"C"}'
];

const LABEL_SETS = [
  null, [], [{name: 'PORTAL: IGNORE'}], [{name: 'portal:ignore'}],
  [{name: 'PORTAL : IGNORE'}], [{name: 'TJX CANADA'}, {name: 'PORTAL: IGNORE'}],
  [{name: 'RTF GLOBAL'}, {name: 'AUS'}], [{name: ''}], [{}]
];

const CHECKLIST_SETS = [
  [], [{checkItems: []}],
  [{checkItems: [{name: 'WIDGET A | QTY: 5 | RCVD: 0'}]}],
  [{checkItems: [{name: 'A'}, {name: 'B'}]}, {checkItems: [{name: 'C'}]}]
];

const URLS = [
  '', null, 'https://api.trello.com/1/cards/x/labels?key=SECRETKEY&token=SECRETTOKEN',
  'https://api.trello.com/1/x?token=abc&key=def&other=1'
];

// ---- comparison -----------------------------------------------------------
let checks = 0;
const failures = [];

function j(v) {
  return JSON.stringify(v, (k, val) => (val === undefined ? '<undefined>' : val));
}

function cmp(name, srcFn, portFn, argSets) {
  if (typeof srcFn !== 'function') {
    failures.push(`${name}: not found in SRC sandbox`);
    return;
  }
  if (typeof portFn !== 'function') {
    failures.push(`${name}: not exported by the port`);
    return;
  }
  argSets.forEach((args) => {
    checks++;
    let a; let b;
    try { a = j(srcFn.apply(null, args)); } catch (e) { a = 'THREW: ' + e.message; }
    try { b = j(portFn.apply(null, args)); } catch (e) { b = 'THREW: ' + e.message; }
    if (a !== b) {
      failures.push(`${name}(${j(args)})\n    SRC : ${a}\n    PORT: ${b}`);
    }
  });
}

const one = (arr) => arr.map((x) => [x]);
const pairs = (a, b) => {
  const out = [];
  a.forEach((x) => b.forEach((y) => out.push([x, y])));
  return out;
};

cmp('classifyListStatus', sandbox.classifyListStatus, port.classifyListStatus, one(LIST_NAMES));
cmp('isFullyReceivedFromSummaryServer_', sandbox.isFullyReceivedFromSummaryServer_,
    port.isFullyReceivedFromSummaryServer_, one(SUMMARIES));
cmp('getRollupRank_', sandbox.getRollupRank_, port.getRollupRank_,
    pairs(['Inbound', 'Outbound', 'Other'], STATUSES));
cmp('resolveTransitModeFromText_', sandbox.resolveTransitModeFromText_,
    port.resolveTransitModeFromText_, one(TRANSIT_TEXTS));
cmp('isKnownBrandLabel_', sandbox.isKnownBrandLabel_, port.isKnownBrandLabel_,
    ENTITIES.map((e) => [e, REGISTRY]).concat(ENTITIES.map((e) => [e, []])));
cmp('classifyInboundOrderOriginServer_', sandbox.classifyInboundOrderOriginServer_,
    port.classifyInboundOrderOriginServer_,
    pairs(ENTITIES, SUMMARIES).map(([e, s]) => [e, s, REGISTRY])
        .concat(ENTITIES.map((e) => [e, '', null])));
cmp('isCardIgnored_', sandbox.isCardIgnored_, port.isCardIgnored_, one(LABEL_SETS));
cmp('formatInboundLineItems', sandbox.formatInboundLineItems, port.formatInboundLineItems,
    pairs(CHECKLIST_SETS, LABEL_SETS));
cmp('parseIgnoreComment_', sandbox.parseIgnoreComment_, port.parseIgnoreComment_,
    one(['', null, '.ignore', '.IGNORE', '  .ignore  ', '.unignore', '.Unignore',
      'please ignore this', '.ignore me', 'ignore']));
cmp('canonicalNameKey_', sandbox.canonicalNameKey_, port.canonicalNameKey_, one(NAMES));
cmp('productIdentityKey_', sandbox.productIdentityKey_, port.productIdentityKey_, one(NAMES));
cmp('namesMatch_', sandbox.namesMatch_, port.namesMatch_, pairs(NAMES, NAMES));
cmp('splitProductIdFromDesc_', sandbox.splitProductIdFromDesc_, port.splitProductIdFromDesc_, one(NAMES));
cmp('resolveCanonicalItemName_', sandbox.resolveCanonicalItemName_, port.resolveCanonicalItemName_,
    NAMES.map((n) => [n, PRODUCT_MAP_UPPER]).concat(NAMES.map((n) => [n, null])));
cmp('resolveCanonicalProductId_', sandbox.resolveCanonicalProductId_, port.resolveCanonicalProductId_,
    NAMES.map((n) => [n, PRODUCT_MAP_UPPER]).concat(NAMES.map((n) => [n, null])));
cmp('parseSysBlob_', sandbox.parseSysBlob_, port.parseSysBlob_,
    SYS_BLOBS.map((b) => [b, 'Inventory row 42']));
cmp('trelloRedactUrl_', sandbox.trelloRedactUrl_, port.trelloRedactUrl_, one(URLS));
cmp('getBoardMatrix_', sandbox.getBoardMatrix_, port.getBoardMatrix_, [[]]);
cmp('resolveBoardById_', sandbox.resolveBoardById_, port.resolveBoardById_,
    one([null, '', '649c805bad63086ff6689611', '66bcf93dd63eecdb2d4e91e7', 'unknown-board', '  649c7dd6690130fe8ef3689a  ']));

// ---- second round: with the PRODUCT identity index POPULATED ---------------
// This is the case the port had to restructure for: SRC reads the PRODUCT sheet
// synchronously inside productIdentityKey_, the port cannot, so the load is
// split into an async primeQbNameIndex() + a sync cache read. Verify the split
// produces byte-identical answers to SRC when the index actually has content.
const PRODUCT_ROWS = [
  ['Product ID', 'Nickname'],
  ['CIS 019 (SS Ink Pin 19mm)', 'Ink Pin 19mm'],
  ['V32', 'Verso Tag'],
  ['V32-BATTERY', 'Verso Battery'],
  ['SMART PL 48 AM', 'Smart Slide'],
  ['NT525S/2AMF', '2 Alarm SMALL Scorpion Tag']
];

const seeded = {};
for (let i = 1; i < PRODUCT_ROWS.length; i++) {
  const pid = String(PRODUCT_ROWS[i][0] || '').trim();
  const nick = String(PRODUCT_ROWS[i][1] || '').trim();
  seeded[sandbox.canonicalNameKey_(pid)] = pid;
  if (nick) seeded[sandbox.canonicalNameKey_(nick)] = pid;
}
Object.keys(seeded).forEach((k) => { QB_INDEX[k] = seeded[k]; });

// Stub the port's Sheets read so primeQbNameIndex() loads the same rows.
const ssApiPath = require.resolve(path.join(ROOT, 'functions/services/Service_SheetsAPI.js'));
require.cache[ssApiPath] = {
  id: ssApiPath, filename: ssApiPath, loaded: true, exports: {
    getSheetValues: async () => PRODUCT_ROWS
  }
};

const EXTRA_NAMES = NAMES.concat([
  'Verso Tag', 'VERSO TAG', 'Ink Pin 19mm', 'NT525S/2AMF',
  '2 Alarm SMALL Scorpion Tag', 'Smart Slide', 'Verso Battery'
]);

port.primeQbNameIndex(true).then(() => {
  cmp('productIdentityKey_ [primed]', sandbox.productIdentityKey_, port.productIdentityKey_,
      one(EXTRA_NAMES));
  cmp('namesMatch_ [primed]', sandbox.namesMatch_, port.namesMatch_, pairs(EXTRA_NAMES, EXTRA_NAMES));
  report();
});

function report() {

console.log(`\nran ${checks} comparisons across 19 functions`);
if (failures.length === 0) {
  console.log('PARITY OK — every output identical to SRC\n');
} else {
  console.log(`\n${failures.length} DIFFERENCE(S):\n`);
  failures.slice(0, 40).forEach((f) => console.log('  ' + f));
  process.exitCode = 1;
}
}
