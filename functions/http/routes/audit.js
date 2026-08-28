/**
 * The wall-to-wall audit flow (SCHEMA §, JS_Handlers.html's audit view).
 *
 * Every mutation here appends to Audit_Log, so `req` MUST reach the service as
 * its `context` argument -- that is what getActiveUserEmail() reads for the
 * operator column. A route that forgot it would throw rather than write an
 * unattributed row, which is the intended failure (functions/auth.js).
 */

const express = require('express');

const Service_Read = require('../../services/Service_Read');
const Service_Write = require('../../services/Service_Write');
const {runQuery, runMutation} = require('../wrappers');

const router = express.Router();

// SRC: JS_Store.html:242 `.getTodayAudits()`.
router.get('/audits/today', runQuery("Today's audits", () => Service_Read.getTodayAudits()));

// SRC: JS_Handlers.html:3306 `.getAuditWorklist()`.
router.get('/audits/worklist', runQuery('Audit worklist', () => Service_Read.getAuditWorklist()));

// SRC: JS_Handlers.html:3399,3697 `.processAuditAction(locId, sku, finalQty)`.
router.post('/audits/action', runMutation('Audit action', (req) => {
  const {locId, sku, newQty} = req.body;
  return Service_Write.processAuditAction(locId, sku, newQty, req);
}));

// SRC: JS_Handlers.html:3452 `.bulkVerifyAuditLocations(pairs)`.
router.post('/audits/bulk-verify', runMutation('Bulk verify audit locations', (req) => {
  return Service_Write.bulkVerifyAuditLocations(req.body.pairs, req);
}));

// SRC: JS_Handlers.html:3469 `.markAuditComplete(sku)`.
router.post('/audits/complete', runMutation('Mark audit complete', (req) => {
  return Service_Write.markAuditComplete(req.body.targetSku);
}));

module.exports = router;
