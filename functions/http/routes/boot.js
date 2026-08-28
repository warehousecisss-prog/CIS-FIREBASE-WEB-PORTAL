/**
 * GET /boot -- the SPA replacement for Apps Script's precompiled page load.
 *
 * WHY THIS ROUTE EXISTS
 * ---------------------
 * The original does not fetch its boot data. `Service_Router.js:70-78` calls
 * precompileDataset_() nine times and inlines the JSON straight into
 * Index.html, where it lands as window._serverInventory, _serverProductMap and
 * so on. Those globals are read all over JS_Render_UI / JS_Handlers, and
 * JS_Diagnostics.html ships window._serverBootIssues with every crash report.
 *
 * Firebase Hosting serves a static bundle, so there is no template pass to
 * inline anything into. Without this route the SPA would either make nine
 * separate round trips before it can paint, or -- worse -- each view would
 * fetch its own slice and they would disagree with each other.
 *
 * It is a faithful port of precompileDataset_, not a new idea: the same nine
 * getters, the same fallback values, and the same "one failure degrades to its
 * fallback and is recorded in bootIssues rather than taking the whole boot
 * down" behaviour. Everything here is also available on its own route (see
 * catalog.js / inventory.js / shipping.js); this is the batched form.
 */

const express = require('express');
const logger = require('firebase-functions/logger');

const Service_Read = require('../../services/Service_Read');
const Service_Assembly = require('../../services/Service_Assembly');
const Service_Dates = require('../../services/Service_Dates');
const {runQuery} = require('../wrappers');

const router = express.Router();

/**
 * Port of Service_Router.js:264 precompileDataset_. One dataset failing is a
 * degraded boot, not a failed one -- the operator gets a portal with an empty
 * SKU datalist and a visible reason, rather than a blank page.
 *
 * @param {string} name dataset label, as it appears in bootIssues.
 * @param {Function} getter async () => value.
 * @param {*} fallbackValue what to serve if the getter throws or returns null.
 * @param {Array<string>} issues collector, mirroring BOOT_ISSUES_.
 * @return {Promise<*>} the dataset, or its fallback.
 */
async function precompile(name, getter, fallbackValue, issues) {
  try {
    const value = await getter();
    // `|| fallbackValue` matches SRC exactly. It also covers the port's
    // getAllInventory returning null on read failure where SRC rethrows
    // (PHASE_3_NOTES.md finding F6) -- but silently, so the null case is
    // recorded here rather than passing as an empty warehouse.
    if (value === undefined || value === null) {
      issues.push("precompile '" + name + "' returned no data; using the fallback");
      return fallbackValue;
    }
    return value;
  } catch (e) {
    logger.warn("Precompile failed for '" + name + "'", {error: e.message});
    issues.push("precompile '" + name + "' failed: " + e.message);
    return fallbackValue;
  }
}

router.get('/boot', runQuery('Boot dataset', async (req) => {
  const issues = [];

  // Sequential, not Promise.all. These getters share SS_API's per-process
  // sheet-metadata cache and several of them read overlapping ranges of the
  // same spreadsheet; firing nine concurrent Sheets reads from a cold
  // container is the fastest way to meet a 429, and Shared_Classifiers'
  // backoff only covers Trello.
  const inventory = await precompile('inventory', () => Service_Read.getAllInventory(), [], issues);
  const productMap = await precompile('productMap', () => Service_Read.getProductMap(), {}, issues);
  const assemblyData = await precompile('assemblyData', () => Service_Assembly.getAssemblyData(), [], issues);
  const agingData = await precompile('agingData', () => Service_Read.getAgingData(), {}, issues);
  const skuLastUpdated = await precompile('skuLastUpdated', () => Service_Read.getSkuLastUpdatedMap(), {}, issues);
  const heatmapBounds = await precompile('heatmapBounds', () => Service_Read.getHeatmapWindowThresholds(), [30, 60], issues);
  const customerRegistry = await precompile('customerRegistry', () => Service_Read.getCustomerRegistry(), [], issues);
  const brandCatalog = await precompile('brandCatalog', () => Service_Read.getBrandItemCatalog(), [], issues);
  const transitLaneCatalog = await precompile('transitLaneCatalog', () => Service_Dates.getTransitLaneCatalog(),
      {lanes: [], peakWindow: null, travelTypeLabels: {}, originLabels: {}, deliveryDestinations: []}, issues);

  if (issues.length) {
    logger.warn('Boot dataset served with issues', {count: issues.length, issues});
  }

  return {
    success: true,
    // Matches window._serverBuildVersion (Index.html:31). K_REVISION is the
    // Cloud Run revision name the function is deployed as; absent under the
    // emulator, where "emulator" is the honest answer.
    buildVersion: process.env.K_REVISION || 'emulator',
    operator: req.auth ? req.auth.email : null,
    bootIssues: issues,
    inventory,
    productMap,
    assemblyData,
    agingData,
    skuLastUpdated,
    heatmapBounds,
    customerRegistry,
    brandCatalog,
    transitLaneCatalog
  };
}));

module.exports = router;
