/**
 * Shipment readiness / ETA (Service_Dates) and the FedEx tracking calls.
 *
 * `/shipment` is one of the three paths frontend/src/api.js already calls and
 * which 404'd until now, so its path is fixed by that contract. It maps to
 * updateShipmentReadiness -- the Readiness & ETA panel's write in
 * JS_Handlers.html:2837, which is the only "update a shipment" server call the
 * original makes.
 */

const express = require('express');
const logger = require('firebase-functions/logger');

const Service_Dates = require('../../services/Service_Dates');
const Service_Write = require('../../services/Service_Write');
const {runQuery, runMutation, notImplemented} = require('../wrappers');

const router = express.Router();

/* ------------------------------------------------------------------ reads */

// SRC precompiles this into Index.html as window._serverTransitLaneCatalog
// (Service_Router.js:78). There is no server-side templating in the SPA, so
// the cascading Ship Date -> Transit Type -> Origin -> Destination -> Port
// dropdowns (JS_Handlers.html:2338 getTransitCatalog_) need a real endpoint.
router.get('/shipping/transit-lane-catalog', runQuery('Transit lane catalog', () => Service_Dates.getTransitLaneCatalog()));

/* -------------------------------------------------------------- mutations */

// SRC: JS_Handlers.html:2837
//   `.updateShipmentReadiness(cardId, dateStr, basisEl.value, resolvedPort)`.
// Frontend: frontend/src/api.js `updateShipment` -> POST /shipment.
router.post('/shipment', runMutation('Update shipment readiness', (req) => {
  const {cardId, rtsDate, rtsBasis, portOfArrival} = req.body;
  return Service_Dates.updateShipmentReadiness(cardId, rtsDate, rtsBasis, portOfArrival);
}));

// SRC: JS_Handlers.html:2773,3026
//   `.estimateShippingWindowV2(readyDateStr, travelType, origin, destination,
//                              port, loadType)`
//
// A pure calculation with no sheet write, but POST rather than GET: the six
// fields are a form submission, and putting a free-text destination and port
// in a query string puts them in every access log for no benefit.
//
// PARITY GAP: the ported service signature is 5-arg and has no `port`. Its
// findTransitLane_ is missing SRC's opts.port narrowing block AND
// resolveTransitDestinationCluster_, so a destination fed by more than one
// port silently resolves to whichever lane the slowest-wins default picks --
// exactly the bug SRC's comment at JS_Handlers.html:2322 says the Destination/
// Port split was introduced to fix. Restoring it is Service_Dates parity
// (Phase 4), not route work, so the route takes `port`, refuses to pretend it
// was honoured, and says so out loud. See PHASE_3_NOTES.md finding F4.
router.post('/shipping/estimate-window', runMutation('Estimate shipping window', (req) => {
  const {readyDateStr, travelType, origin, destination, port, loadType} = req.body;
  if (port) {
    logger.warn('estimateShippingWindowV2: `port` was supplied but the ported service ' +
      'does not narrow by it (Service_Dates parity gap, PORT_AUDIT.md). The returned ' +
      'lane may be for a different port of the same destination.', {port, destination});
  }
  return Service_Dates.estimateShippingWindowV2(readyDateStr, travelType, origin, destination, loadType);
}));

// SRC: JS_Handlers.html:3024
//   `.estimateShipByDateV2(dateStr, type, origin, dest, port, load)`.
router.post('/shipping/estimate-ship-by', notImplemented(
    'estimateShipByDateV2',
    'Service_Dates parity -- SCHEMA §8 Engine 4, the reverse (must-arrive-by -> latest ship date) calculation, is unported (PORT_AUDIT.md)'));

// SRC: JS_Handlers.html:1910 `.stageBulkFedExTrackingNumbers(stagedOrders)`.
router.post('/fedex/stage-tracking', runMutation('Stage FedEx tracking numbers', (req) => {
  return Service_Write.stageBulkFedExTrackingNumbers(req.body.stagedItems);
}));

// SRC: JS_Handlers.html:5767,5953 `.markFedExChildDeliveredInSheet(tracking)`.
router.post('/fedex/mark-child-delivered', runMutation('Mark FedEx child delivered', (req) => {
  return Service_Write.markFedExChildDeliveredInSheet(req.body.tracking);
}));

/* --------------------------------------- unported: Fedex_Master_Script.js */

const FEDEX_WAITING_ON =
  'Fedex_Master_Script.js (31KB) is not ported at all -- see PORT_AUDIT.md, "Not ported at all"';

// SRC: JS_Handlers.html:1690,1752
//   `.batchCalculateTransitTimes(parsedLocations, nextIndex, originZip, country)`.
router.post('/fedex/batch-transit-times', notImplemented('batchCalculateTransitTimes', FEDEX_WAITING_ON));

// SRC: JS_Handlers.html:1960 `.getEstimatorOriginZip()`.
router.get('/fedex/estimator-origin-zip', notImplemented('getEstimatorOriginZip', FEDEX_WAITING_ON));

// SRC: JS_Handlers.html:1561 `.getEstimatorRtfOriginZip()`.
router.get('/fedex/estimator-rtf-origin-zip', notImplemented('getEstimatorRtfOriginZip', FEDEX_WAITING_ON));

module.exports = router;
