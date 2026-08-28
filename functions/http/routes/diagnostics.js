/**
 * Diagnostics and the RXO test harness.
 *
 * `/diagnostics` is one of the three paths frontend/src/api.js already calls
 * and which 404'd until now.
 */

const express = require('express');

const Service_Diagnostics = require('../../services/Service_Diagnostics');
const Service_Write = require('../../services/Service_Write');
const Service_Validate = require('../../services/Service_Validate');
const {runQuery, runMutation, notImplemented} = require('../wrappers');

const router = express.Router();

// SRC: JS_Diagnostics.html:288
//   `.submitDiagnosticReport({note, env, store, bootIssues, events})`.
// Frontend: frontend/src/api.js `submitDiagnosticReport` -> POST /diagnostics.
//
// `req` still goes through as context even though this is the ONE service that
// uses getActiveUserEmailOrNull rather than the throwing accessor -- a crash
// report should still land when the caller's session has expired
// (PHASE_1_NOTES.md, C5). Passing req means it is attributed whenever it can be.
router.post('/diagnostics', runMutation('Submit diagnostic report', (req) => {
  return Service_Diagnostics.submitDiagnosticReport(req.body, req);
}));

// SRC: JS_Handlers.html:5346 `.logDisplayDiagnostic(w, h, ua)`.
// Kept off /diagnostics so a viewport-telemetry ping cannot be confused with
// an operator-filed crash report.
router.post('/diagnostics/display', runMutation('Log display diagnostic', (req) => {
  const {width, height, userAgent} = req.body;
  return Service_Write.logDisplayDiagnostic(width, height, userAgent);
}));

// No SRC client call site -- validateRegistrySheets is a menu action there.
// Exposed as a read: it writes its findings to a results tab, but from the
// caller's point of view it answers a question rather than changing state.
router.get('/diagnostics/validate-registries', runQuery('Validate registry sheets', () => Service_Validate.validateRegistrySheets()));

/* ------------------------------------------------- RXO test harness (RXO_Test.html) */

const RXO_WAITING_ON =
  'Service_RXO parity -- getRxoConfigStatus, rxoRunDiagnostics, rxoTestShipmentLookup and rxoAuthProbe_ are unported (PORT_AUDIT.md). The ported Service_RXO exports the three live lookups (getRxoShipmentDetails / getRxoOrderStatus / getRxoCustomerInvoices) plus rxoTestHarness, none of which the RXO test page calls';

// SRC: RXO_Test.html:292 `.getRxoConfigStatus()`.
router.get('/rxo/config-status', notImplemented('getRxoConfigStatus', RXO_WAITING_ON));

// SRC: RXO_Test.html:264 `.rxoRunDiagnostics()`.
router.post('/rxo/diagnostics', notImplemented('rxoRunDiagnostics', RXO_WAITING_ON));

// SRC: RXO_Test.html:284 `.rxoTestShipmentLookup(idType, idValue)`.
router.post('/rxo/shipment-lookup', notImplemented('rxoTestShipmentLookup', RXO_WAITING_ON));

module.exports = router;
