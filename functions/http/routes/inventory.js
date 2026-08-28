/**
 * Inventory reads and the drawer mutations.
 *
 * Mirrors the server calls JS_Handlers.html makes through window.runMutation:
 * Qty / - / + / SET / status / comment / split / move / remove. Argument order
 * on every route below is taken from the CLIENT call site in SRC, not from the
 * port's own signature -- twice in this port the two had drifted (see
 * PHASE_3_NOTES.md).
 */

const express = require('express');
const logger = require('firebase-functions/logger');

const Service_Read = require('../../services/Service_Read');
const Service_Write = require('../../services/Service_Write');
const {runQuery, runMutation} = require('../wrappers');

const router = express.Router();

/* ------------------------------------------------------------------ reads */

// SRC: JS_Store.html:163 `.getAllInventory()`.
//
// Returns getAllInventory()'s array verbatim. The previous version of this
// route injected an `agingDays` PROPERTY onto each row, which is an Array --
// and JSON.stringify drops non-index properties on arrays, so that value has
// never once reached the browser. SRC does not do this either: JS_Store.html
// fetches getAgingData() as its own call and the render layer joins the two.
// Hence /inventory/aging below. See PHASE_3_NOTES.md finding F7.
router.get('/inventory', runQuery('Inventory', () => Service_Read.getAllInventory()));

// SRC: JS_Handlers.html:6194 `.getInventoryTotals()`.
router.get('/inventory/totals', runQuery('Inventory totals', () => Service_Read.getInventoryTotals()));

// SRC: JS_Store.html:174 `.getAgingData()`.
router.get('/inventory/aging', runQuery('Aging data', () => Service_Read.getAgingData()));

// SRC: JS_Store.html:186 `.getSkuLastUpdatedMap()`.
router.get('/inventory/sku-last-updated', runQuery('SKU last-updated map', () => Service_Read.getSkuLastUpdatedMap()));

/* -------------------------------------------------------------- mutations */

// SRC: JS_Handlers.html:4130 `.setTotalStock(locId, sku, cleanVal)`;
//      JS_State.html:117 `.setTotalStock(loc, sku, q)`.
router.post('/inventory/set-total', runMutation('Set total stock', (req) => {
  const {locId, sku, newQty, instanceOrRowId} = req.body;
  return Service_Write.setTotalStock(locId, sku, newQty, instanceOrRowId, req);
}));

// SRC: JS_Handlers.html:4128 `.setTotalStockByRow(rowIdx, locId, sku, cleanVal)`.
// Kept as its own route rather than folded into the one above: the row-indexed
// twin re-reads the row and refuses on a data mismatch, and collapsing the two
// would make it ambiguous at the call site which guard is in force.
router.post('/inventory/set-total-by-row', runMutation('Set total stock by row', (req) => {
  const {rowIdx, locId, sku, newQty} = req.body;
  return Service_Write.setTotalStockByRow(rowIdx, locId, sku, newQty, req);
}));

// SRC: JS_Handlers.html:4213 `.updateStock(locId, sku, adj)`.
router.post('/inventory/update-stock', runMutation('Adjust stock', (req) => {
  const {locId, sku, adjustment, instanceOrRowId} = req.body;
  return Service_Write.updateStock(locId, sku, adjustment, instanceOrRowId, req);
}));

// SRC: JS_Handlers.html:4211 `.updateInventoryByRow(rowIdx, locId, sku, adj)`.
router.post('/inventory/update-stock-by-row', runMutation('Adjust stock by row', (req) => {
  const {rowIdx, locId, sku, adjustment} = req.body;
  return Service_Write.updateInventoryByRow(rowIdx, locId, sku, adjustment, req);
}));

// SRC: JS_Handlers.html:5039,5302 `.addNewItemToLocation(locId, sku, qty)`.
router.post('/inventory/add-item', runMutation('Add item to location', (req) => {
  const {locId, sku, initialQty} = req.body;
  return Service_Write.addNewItemToLocation(locId, sku, initialQty, req);
}));

// SRC: JS_Handlers.html:4095 `.updateInventoryField(locId, sku, fieldType, value, rowIdx)`.
router.post('/inventory/update-field', runMutation('Update inventory field', (req) => {
  const {locId, sku, fieldType, value, instanceOrRowId} = req.body;
  return Service_Write.updateInventoryField(locId, sku, fieldType, value, instanceOrRowId, req);
}));

// SRC: JS_Handlers.html:4387 `.updatePalletComment(locId, sku, text)`.
router.post('/inventory/comment', runMutation('Update pallet comment', (req) => {
  const {locId, sku, commentText, instanceOrRowId} = req.body;
  return Service_Write.updatePalletComment(locId, sku, commentText, instanceOrRowId, req);
}));

// No client call site in SRC (the drawer routes status changes through
// updateInventoryField), but it is an exported Service_Write mutation with the
// same modifySheetRow contract, and leaving it unreachable would mean the next
// caller invents a second way in. Reachable, and documented as unused today.
router.post('/inventory/reserve', runMutation('Reserve pallet', (req) => {
  const {locId, sku, statusString, instanceOrRowId} = req.body;
  return Service_Write.reservePallet(locId, sku, statusString, instanceOrRowId, req);
}));

// SRC: JS_Handlers.html:4511
//   `.moveInventoryItem(fromLoc, toLoc, sku, qty, isHubMove, instanceId,
//                       isKnownFloorCoordinate(toLoc))`
// That 7th argument is clientAssertsKnownCoordinate -- the client has checked
// the destination against the SVG-scraped slot list, so a coordinate with no
// Inventory row yet is a real empty slot rather than a typo. The port had
// dropped it; see PHASE_3_NOTES.md finding F1.
router.post('/inventory/move', runMutation('Move inventory item', (req) => {
  const {fromLoc, toLoc, sku, moveQty, isHubMove, instanceOrRowId, clientAssertsKnownCoordinate} = req.body;
  return Service_Write.moveInventoryItem(
      fromLoc, toLoc, sku, moveQty, isHubMove, instanceOrRowId, clientAssertsKnownCoordinate, req);
}));

// SRC: JS_Handlers.html:4575
//   `.moveHubGroup(fromLoc, toLoc, instanceIds, isKnownFloorCoordinate(toLoc))`.
router.post('/inventory/move-hub-group', runMutation('Move hub group', (req) => {
  const {fromLoc, toLoc, instanceIds, clientAssertsKnownCoordinate} = req.body;
  return Service_Write.moveHubGroup(fromLoc, toLoc, instanceIds, clientAssertsKnownCoordinate, req);
}));

// SRC: JS_Handlers.html:4161 `.splitInventoryRow(rowIdx, locId, sku, val, newStatus)`.
router.post('/inventory/split', runMutation('Split inventory row', (req) => {
  const {rowIdx, locId, sku, splitQty, newStatus} = req.body;
  return Service_Write.splitInventoryRow(rowIdx, locId, sku, splitQty, newStatus, req);
}));

// SRC: JS_Handlers.html:4965 `.removeItemFromLocation(locId, sku, instanceId)`.
router.post('/inventory/remove', runMutation('Remove item from location', (req) => {
  const {locId, sku, instanceOrRowId} = req.body;
  return Service_Write.removeItemFromLocation(locId, sku, instanceOrRowId, req);
}));

// Housekeeping sweep. No SRC client call site (it is a menu/maintenance action
// there), exposed here so it is reachable without a second entry point.
router.post('/inventory/clean-vacant-rows', runMutation('Clean up vacant rows', () => {
  logger.info('cleanUpVacantRows invoked from the route layer');
  return Service_Write.cleanUpVacantRows();
}));

module.exports = router;
