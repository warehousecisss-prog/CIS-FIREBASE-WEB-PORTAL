/**
 * Boot reads and reference data -- the three calls initNetworkSync() makes
 * (JS_Network.html), the logistics dashboard, and the catalog lookups the
 * Trello injector needs before it can render anything.
 *
 * All GET. None of these write.
 */

const express = require('express');

const Service_Read = require('../../services/Service_Read');
const Service_Assembly = require('../../services/Service_Assembly');
const {runQuery, notImplemented} = require('../wrappers');

const router = express.Router();

// SRC: JS_Store.html:232 `.getLogisticsDashboardData()`.
router.get('/logistics-dashboard', runQuery('Logistics dashboard', () => Service_Read.getLogisticsDashboardData()));

// SRC: JS_Network.html:11 `.getProductMap()` -- boot read 1 of 3.
router.get('/products/map', runQuery('Product map', () => Service_Read.getProductMap()));

// Not called from the client in SRC (getProductMap covers the datalist), but
// exported by the service and cheap to expose beside its sibling.
router.get('/products/list', runQuery('Product list', () => Service_Read.getProductList()));

// SRC: JS_Network.html:24 `.getAssemblyData()` -- boot read 2 of 3.
router.get('/assembly/data', runQuery('Assembly data', () => Service_Assembly.getAssemblyData()));

// SRC: JS_Network.html:28, JS_Render_Core.html:198
//      `.getHeatmapWindowThresholds()` -- boot read 3 of 3.
router.get('/heatmap-thresholds', runQuery('Heatmap thresholds', () => Service_Read.getHeatmapWindowThresholds()));

// SRC: TrelloInjector.html:538 `.getCustomerRegistry()`.
router.get('/customer-registry', runQuery('Customer registry', () => Service_Read.getCustomerRegistry()));

// SRC: TrelloInjector.html:863 `.getSkuCatalog()`.
router.get('/sku-catalog', runQuery('SKU catalog', () => Service_Read.getSkuCatalog()));

// No SRC client call site (the brand catalog is consumed server-side by
// Service_PO_Ingest), exposed for the injector's brand picker.
router.get('/brand-item-catalog', runQuery('Brand item catalog', () => Service_Read.getBrandItemCatalog()));

// SRC: JS_Handlers.html:5045, JS_State.html:204 `.fetchPrecompiledHtsData()`.
router.get('/hts/precompiled', runQuery('HTS tariff matrix', () => Service_Read.fetchPrecompiledHtsData()));

// SRC: JS_Handlers.html:5087 `.syncLocalHtsCacheWithGovernment()`.
router.post('/hts/sync', notImplemented(
    'syncLocalHtsCacheWithGovernment',
    'updateHtsDataSheet.js + checkFederalRegisterForTariffChanges.js are not ported (PORT_AUDIT.md, "Not ported at all")'));

// SRC: Index.html renders `<?= getInjectorUrl() ?>` into the toolbar button.
// The Apps Script version asks ScriptApp for its own deployment URL; the port
// derives the origin from the request, so the req has to reach the service.
router.get('/injector-url', runQuery('Injector URL', (req) => Service_Read.getInjectorUrl(req)));

module.exports = router;
