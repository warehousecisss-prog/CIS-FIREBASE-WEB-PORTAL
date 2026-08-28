/**
 * PO ingest -- the PDF upload path in TrelloInjector.html.
 *
 * `/po-ingest` is one of the three endpoints frontend/src/api.js already calls
 * and which 404'd until now, so the path is fixed by that existing contract
 * rather than chosen. Its body is `{base64Data, fileName}`, which is exactly
 * what processUploadedPOFile(payload) takes.
 */

const express = require('express');

const Service_PO_Ingest = require('../../services/Service_PO_Ingest');
const {runMutation, notImplemented} = require('../wrappers');

const router = express.Router();

// SRC: TrelloInjector.html:707
//   `.processUploadedPOFile({ base64Data: base64Data, fileName: file.name })`
// Frontend: frontend/src/api.js `processUploadedPOFile` -> POST /po-ingest.
//
// A mutation rather than a read despite "just parsing a PDF": it resolves SKUs
// against the live catalogs and the caller treats its output as authoritative
// for what then gets injected onto a Trello card.
router.post('/po-ingest', runMutation('PO ingest', (req) => Service_PO_Ingest.processUploadedPOFile(req.body)));

// SRC: TrelloInjector.html:570
//   `.reresolvePOForVendor(window.currentParsedPOData, brandId, vendorName)`.
router.post('/po-ingest/reresolve', runMutation('Re-resolve PO for vendor', (req) => {
  const {parsedPO, brandId, vendorName} = req.body;
  return Service_PO_Ingest.reresolvePOForVendor(parsedPO, brandId, vendorName);
}));

// SRC: TrelloInjector.html:834
//   `.emailPOPdfToSupplier({base64Data, fileName, poNumber, toEmail, ccEmail})`.
router.post('/po-ingest/email-supplier', notImplemented(
    'emailPOPdfToSupplier',
    'Service_PO_Ingest parity -- emailPOPdfToSupplier is unported (PORT_AUDIT.md). Service_Email.sendPONotification is a different, port-only nodemailer wrapper and is NOT a drop-in substitute'));

module.exports = router;
