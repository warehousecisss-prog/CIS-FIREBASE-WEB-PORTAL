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
// `port` is now honoured. Phase 3 shipped this route with a logger.warn saying
// the ported service dropped the parameter (F4); Phase 4 Unit B restored it,
// along with findTransitLane_'s port-narrowing block and
// resolveTransitDestinationCluster_, so the warning is gone.
router.post('/shipping/estimate-window', runMutation('Estimate shipping window', (req) => {
  const {readyDateStr, travelType, origin, destination, port, loadType} = req.body;
  return Service_Dates.estimateShippingWindowV2(
      readyDateStr, travelType, origin, destination, port, loadType);
}));

// SRC: JS_Handlers.html:3024
//   `.estimateShipByDateV2(dateStr, type, origin, dest, port, load)`.
//
// The reverse calculation: a hard must-arrive-by date -> the latest date the
// goods can leave the origin. Same lane narrowing and same slowest-wins default
// as estimate-window above. SCHEMA §4G. Answered 501 until Phase 4 Unit B.
router.post('/shipping/estimate-ship-by', runMutation('Estimate ship-by date', (req) => {
  const {arriveByDateStr, travelType, origin, destination, port, loadType} = req.body;
  return Service_Dates.estimateShipByDateV2(
      arriveByDateStr, travelType, origin, destination, port, loadType);
}));

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
