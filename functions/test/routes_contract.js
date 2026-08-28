/**
 * ============================================================================
 * ROUTE CONTRACT TEST -- `npm run test:routes`
 * ============================================================================
 *
 * Two things are checked, and they fail for different reasons:
 *
 * PART A -- COVERAGE. Every server function the original's client HTML invokes
 * has exactly one route, at the method and path recorded below. The list is
 * not hand-written from memory: it was extracted by taking every top-level
 * `function name(...)` declared in SRC/src/*.js and finding which of them the
 * client actually calls (google.script.run chains, runQuery/runMutation
 * closures, and Index.html's `<?= ... ?>` scriptlets). 64 functions. If a
 * future change renames a path, this test names the SRC call site that breaks.
 *
 * PART B -- THE WRAPPER CONTRACT. A real HTTP server over the real
 * functions/http/wrappers.js, driven with fake services, asserting the four
 * rules the wrapper exists to enforce -- above all that a service returning
 * `{success:false}` produces a non-2xx carrying that exact string, and never a
 * 200 and never a flattened "Internal Server Error".
 *
 * No new dependencies: express is already a runtime dependency and the server
 * is driven with Node's own fetch.
 */

const assert = require('assert');
const http = require('http');
const express = require('express');

const {runMutation, runQuery, notImplemented, REFUSED_STATUS} = require('../http/wrappers');

let failures = 0;
let checks = 0;

/**
 * @param {string} label what is being asserted.
 * @param {Function} fn the assertion body.
 */
function check(label, fn) {
  checks++;
  try {
    fn();
  } catch (e) {
    failures++;
    console.error('  FAIL  ' + label + '\n        ' + e.message);
  }
}

/* ==========================================================================
 * PART A -- coverage
 * ========================================================================== */

// srcFunction -> 'METHOD /path', or null when the route is a deliberate 501
// because the underlying service is not ported. The 501 entries still have to
// EXIST -- a 404 is indistinguishable from a typo in the path, which sends
// whoever hits it looking in the wrong place.
const CONTRACT = {
  // --- boot reads (JS_Network.html initNetworkSync + JS_Store.html fetchers)
  getProductMap: 'GET /products/map',
  getAssemblyData: 'GET /assembly/data',
  getHeatmapWindowThresholds: 'GET /heatmap-thresholds',
  getAllInventory: 'GET /inventory',
  getAgingData: 'GET /inventory/aging',
  getSkuLastUpdatedMap: 'GET /inventory/sku-last-updated',
  getTodayAudits: 'GET /audits/today',
  getLogisticsDashboardData: 'GET /logistics-dashboard',

  // --- inventory / drawer mutations (JS_Handlers.html)
  setTotalStock: 'POST /inventory/set-total',
  setTotalStockByRow: 'POST /inventory/set-total-by-row',
  updateStock: 'POST /inventory/update-stock',
  updateInventoryByRow: 'POST /inventory/update-stock-by-row',
  addNewItemToLocation: 'POST /inventory/add-item',
  updateInventoryField: 'POST /inventory/update-field',
  updatePalletComment: 'POST /inventory/comment',
  moveInventoryItem: 'POST /inventory/move',
  moveHubGroup: 'POST /inventory/move-hub-group',
  splitInventoryRow: 'POST /inventory/split',
  removeItemFromLocation: 'POST /inventory/remove',
  getInventoryTotals: 'GET /inventory/totals',

  // --- audit
  getAuditWorklist: 'GET /audits/worklist',
  processAuditAction: 'POST /audits/action',
  bulkVerifyAuditLocations: 'POST /audits/bulk-verify',
  markAuditComplete: 'POST /audits/complete',

  // --- assembly
  buildHardAssembly: 'POST /assembly/build',
  explodeAssembly: 'POST /assembly/explode',
  explodePartialHub: 'POST /assembly/explode-partial-hub',

  // --- Trello injector (TrelloInjector.html)
  getTrelloBoards: 'GET /trello/boards',
  getTrelloLists: 'GET /trello/boards/:boardId/lists',
  getTrelloBoardLabels: 'GET /trello/boards/:boardId/labels',
  getInboundPoBoardLabels: 'GET /trello/inbound-po-board/labels',
  getTrelloCardsByList: 'GET /trello/lists/:listId/cards',
  getCardLabels: 'GET /trello/cards/:cardId/labels',
  getExistingCardChecklist: 'GET /trello/cards/:cardId/checklist',
  getCardShippingReference: 'GET /trello/cards/:cardId/shipping-reference',
  createTrelloCard: 'POST /trello/cards',
  moveTrelloCard: 'POST /trello/cards/move',
  updateCardLabels: 'POST /trello/cards/labels',
  setCardShippingReference: 'POST /trello/cards/shipping-reference',
  findOrCreatePOCardAndInject: 'POST /trello/po-card/find-or-create',
  injectPOChecklist: 'POST /trello/po-card/inject-checklist',
  getCustomerRegistry: 'GET /customer-registry',
  getSkuCatalog: 'GET /sku-catalog',
  getInjectorUrl: 'GET /injector-url',

  // --- receiving / outbound
  receivePOCardItems: 'POST /receiving/po-card-items',
  processPackedOutboundCard: 'POST /outbound/process-packed-card',

  // --- PO ingest
  processUploadedPOFile: 'POST /po-ingest',
  reresolvePOForVendor: 'POST /po-ingest/reresolve',
  emailPOPdfToSupplier: 'POST /po-ingest/email-supplier', // 501

  // --- shipping dates / FedEx
  updateShipmentReadiness: 'POST /shipment',
  estimateShippingWindowV2: 'POST /shipping/estimate-window',
  estimateShipByDateV2: 'POST /shipping/estimate-ship-by',
  stageBulkFedExTrackingNumbers: 'POST /fedex/stage-tracking',
  markFedExChildDeliveredInSheet: 'POST /fedex/mark-child-delivered',
  batchCalculateTransitTimes: 'POST /fedex/batch-transit-times', // 501
  getEstimatorOriginZip: 'GET /fedex/estimator-origin-zip', // 501
  getEstimatorRtfOriginZip: 'GET /fedex/estimator-rtf-origin-zip', // 501

  // --- HTS
  fetchPrecompiledHtsData: 'GET /hts/precompiled',
  syncLocalHtsCacheWithGovernment: 'POST /hts/sync', // 501

  // --- diagnostics / RXO
  submitDiagnosticReport: 'POST /diagnostics',
  logDisplayDiagnostic: 'POST /diagnostics/display',
  getRxoConfigStatus: 'GET /rxo/config-status', // 501
  rxoRunDiagnostics: 'POST /rxo/diagnostics', // 501
  rxoTestShipmentLookup: 'POST /rxo/shipment-lookup' // 501
};

// Paths the SPA already hard-codes in frontend/src/api.js. These 404'd before
// Phase 3 and are the acceptance criterion, so they get their own assertion
// rather than only being covered transitively.
const FRONTEND_PATHS = [
  'GET /inventory',
  'GET /logistics-dashboard',
  'POST /shipment',
  'POST /po-ingest',
  'POST /diagnostics'
];

/**
 * @param {Object} router an Express router.
 * @return {Set<string>} every registered 'METHOD /path'.
 */
function registeredRoutes(router) {
  const out = new Set();
  const walk = (layer) => {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.add(method.toUpperCase() + ' ' + layer.route.path);
      }
    } else if (layer.handle && layer.handle.stack) {
      layer.handle.stack.forEach(walk);
    }
  };
  router.stack.forEach(walk);
  return out;
}

console.log('PART A -- route coverage');
const registered = registeredRoutes(require('../http/routes'));

for (const [srcFn, route] of Object.entries(CONTRACT)) {
  check(srcFn + '() -> ' + route, () => {
    assert.ok(registered.has(route),
        'no route registered for ' + route + ' (SRC client calls ' + srcFn + '())');
  });
}

for (const route of FRONTEND_PATHS) {
  check('frontend/src/api.js calls ' + route, () => {
    assert.ok(registered.has(route), route + ' is not registered; frontend/src/api.js would 404');
  });
}

console.log('  ' + Object.keys(CONTRACT).length + ' SRC client calls mapped, ' +
  registered.size + ' routes registered');

/* ==========================================================================
 * PART B -- the wrapper contract, over real HTTP
 * ========================================================================== */

const app = express();
app.use(express.json());
// Stand in for attachIdentity so the wrapper's operator logging has something
// to read, exactly as it would behind requireAuth.
app.use((req, res, next) => {
  req.auth = {email: 'contract-test@localhost', bypassed: true};
  next();
});

app.post('/t/refused-error', runMutation('Refused with error', () => ({
  success: false,
  error: 'Row not found for SWH-A-01/WIDGET-X-100. The pallet may have been moved or deleted by another station.'
})));

app.post('/t/refused-message', runMutation('Refused with message', () => ({
  success: false,
  message: 'Missing Trello credentials.'
})));

app.post('/t/refused-partial', runMutation('Refused with extra fields', () => ({
  success: false,
  error: 'Trello sync incomplete.',
  trelloSynced: false,
  failedItems: ['LINE-1', 'LINE-7']
})));

app.post('/t/refused-blank', runMutation('Refused with no text', () => ({success: false})));

app.post('/t/undefined', runMutation('Returns undefined', () => undefined));

app.post('/t/throws', runMutation('Throws', () => {
  throw new Error('Could not read the Inventory sheet: quota exceeded');
}));

app.post('/t/ok', runMutation('Succeeds', () => ({success: true, written: 1})));

app.get('/t/read-refused', runQuery('Read refused', () => ({
  success: false,
  message: 'No Board ID provided.'
})));

app.get('/t/read-ok', runQuery('Read ok', () => [['SWH-A-01', 'WIDGET-X-100', 12]]));

// Named after a call that is still genuinely unported. estimateShipByDateV2
// used to stand here; it landed in Phase 4 Unit B, and a fixture naming a
// function that now works reads as a stale test.
app.post('/t/unported', notImplemented('explodePartialHub', 'Service_Assembly parity'));

const server = http.createServer(app);

/**
 * @param {string} method HTTP method.
 * @param {string} path route path.
 * @return {Promise<{status: number, kind: string, body: Object}>}
 */
async function call(method, path) {
  const port = server.address().port;
  const res = await fetch('http://127.0.0.1:' + port + path, {
    method,
    headers: {'Content-Type': 'application/json'},
    body: method === 'POST' ? '{}' : undefined
  });
  return {
    status: res.status,
    kind: res.headers.get('x-cis-route-kind'),
    body: await res.json()
  };
}

server.listen(0, '127.0.0.1', async () => {
  console.log('\nPART B -- wrapper contract');
  const transcript = [];

  const rowNotFound =
    'Row not found for SWH-A-01/WIDGET-X-100. The pallet may have been moved or deleted by another station.';

  const refusedError = await call('POST', '/t/refused-error');
  transcript.push(['POST /t/refused-error', refusedError]);
  check('{success:false, error} -> non-2xx', () => {
    assert.strictEqual(refusedError.status, REFUSED_STATUS);
    assert.ok(refusedError.status < 200 || refusedError.status >= 300, 'must not be 2xx');
  });
  check('{success:false, error} -> the service text VERBATIM', () => {
    assert.strictEqual(refusedError.body.error, rowNotFound);
  });
  check('{success:false, error} -> success stays false in the body', () => {
    assert.strictEqual(refusedError.body.success, false);
  });

  const refusedMessage = await call('POST', '/t/refused-message');
  transcript.push(['POST /t/refused-message', refusedMessage]);
  check('{success:false, message} -> normalised into error, not lost', () => {
    assert.strictEqual(refusedMessage.status, REFUSED_STATUS);
    assert.strictEqual(refusedMessage.body.error, 'Missing Trello credentials.');
  });

  const partial = await call('POST', '/t/refused-partial');
  transcript.push(['POST /t/refused-partial', partial]);
  check('a refusal keeps the service\'s other fields', () => {
    assert.strictEqual(partial.body.trelloSynced, false);
    assert.deepStrictEqual(partial.body.failedItems, ['LINE-1', 'LINE-7']);
  });

  const blank = await call('POST', '/t/refused-blank');
  transcript.push(['POST /t/refused-blank', blank]);
  check('{success:false} with no text -> a real message, never an empty error', () => {
    assert.strictEqual(blank.status, REFUSED_STATUS);
    assert.ok(blank.body.error && blank.body.error.length > 10, 'error was empty');
  });

  const undef = await call('POST', '/t/undefined');
  transcript.push(['POST /t/undefined', undef]);
  check('a mutation returning undefined is a 500, never a 200 (AUDIT A1)', () => {
    assert.strictEqual(undef.status, 500);
    assert.strictEqual(undef.body.success, false);
    assert.ok(/nothing was written/i.test(undef.body.error), undef.body.error);
  });

  const threw = await call('POST', '/t/throws');
  transcript.push(['POST /t/throws', threw]);
  check('a throw is a 500 carrying the real message, not "Internal Server Error"', () => {
    assert.strictEqual(threw.status, 500);
    assert.ok(/quota exceeded/.test(threw.body.error), threw.body.error);
    assert.ok(!/^Internal Server Error/.test(threw.body.error));
  });

  const ok = await call('POST', '/t/ok');
  transcript.push(['POST /t/ok', ok]);
  check('a success is a 200 with the service result', () => {
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.written, 1);
  });
  check('mutations are labelled X-CIS-Route-Kind: mutation', () => {
    assert.strictEqual(ok.kind, 'mutation');
  });

  const readRefused = await call('GET', '/t/read-refused');
  transcript.push(['GET /t/read-refused', readRefused]);
  check('a read returning {success:false} is also non-2xx', () => {
    assert.strictEqual(readRefused.status, REFUSED_STATUS);
    assert.strictEqual(readRefused.body.error, 'No Board ID provided.');
  });

  const readOk = await call('GET', '/t/read-ok');
  transcript.push(['GET /t/read-ok', readOk]);
  check('reads are labelled X-CIS-Route-Kind: read', () => {
    assert.strictEqual(readOk.kind, 'read');
    assert.strictEqual(readOk.status, 200);
  });

  const unported = await call('POST', '/t/unported');
  transcript.push(['POST /t/unported', unported]);
  check('an unported call is a 501 naming what it waits on', () => {
    assert.strictEqual(unported.status, 501);
    assert.strictEqual(unported.body.notImplemented, true);
    assert.ok(/Service_Assembly parity/.test(unported.body.error));
    assert.ok(/explodePartialHub/.test(unported.body.error));
  });

  console.log('\n  transcript:');
  for (const [label, res] of transcript) {
    console.log('    ' + label.padEnd(26) + ' -> ' + res.status + '  ' +
      JSON.stringify(res.body).slice(0, 150));
  }

  server.close();
  console.log('\n' + checks + ' checks, ' + failures + ' failures');
  if (failures) {
    console.error('ROUTE CONTRACT FAILED');
    process.exit(1);
  }
  console.log('ROUTE CONTRACT OK');
});
