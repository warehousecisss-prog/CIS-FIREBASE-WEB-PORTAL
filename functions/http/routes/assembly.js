/**
 * Assembly build / explode.
 *
 * Both mutations write Audit_Log via getActiveUserEmail(context), so `req`
 * goes through as the last argument.
 */

const express = require('express');

const Service_Assembly = require('../../services/Service_Assembly');
const {runMutation} = require('../wrappers');

const router = express.Router();

// SRC: JS_Handlers.html:4017 `.buildHardAssembly(locId, parentSku, buildQty, payload)`.
router.post('/assembly/build', runMutation('Build assembly', (req) => {
  const {locId, parentSku, buildQty, bulkAllocationsPayload} = req.body;
  return Service_Assembly.buildHardAssembly(locId, parentSku, buildQty, bulkAllocationsPayload, req);
}));

// SRC: JS_Handlers.html:4041 `.explodeAssembly(locId, sku, qty)`.
// The service's 4th parameter (instanceId) defaults to null and has no SRC
// client call site that passes it; accepted here so a caller that does have an
// instance id is not forced to go around the route.
router.post('/assembly/explode', runMutation('Explode assembly', (req) => {
  const {locId, sku, qty, instanceId} = req.body;
  return Service_Assembly.explodeAssembly(locId, sku, qty, instanceId === undefined ? null : instanceId, req);
}));

// SRC: JS_Handlers.html:4078 `.explodePartialHub(locId, pId, requested)`.
//
// Partial explode of ONE Master Hub card at ONE location. Answered 501 until
// Phase 4 Unit E, which landed it together with commitInventoryMutation_ and
// SS_API.commitAtomic (AUDIT B3) -- they were always going to land together or
// not at all, since this path is exactly the one whose non-atomic commit could
// double inventory.
router.post('/assembly/explode-partial-hub', runMutation('Explode partial hub', (req) => {
  const {locId, pId, kitsToExplode} = req.body;
  return Service_Assembly.explodePartialHub(locId, pId, kitsToExplode, req);
}));

module.exports = router;
