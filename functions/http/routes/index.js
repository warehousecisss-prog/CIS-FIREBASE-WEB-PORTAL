/**
 * Route registry. Every server call the SPA makes is reachable through exactly
 * one of the routers below.
 *
 * The contract these implement is not a guess: it was extracted from SRC by
 * listing every top-level function declared in SRC/src/*.js and finding which
 * of them the client HTML actually invokes (google.script.run chains,
 * runQuery/runMutation closures, and Index.html's `<?= ... ?>` scriptlets).
 * That is 64 distinct server functions. The full inventory, with the SRC call
 * site and the port status of each, is in PHASE_3_NOTES.md.
 *
 * Mounted flat rather than under per-domain prefixes: `/inventory` and
 * `/logistics-dashboard` are already live paths the SPA calls, and `/shipment`,
 * `/po-ingest` and `/diagnostics` are already spelled out in
 * frontend/src/api.js. Prefixing would have broken all five for the sake of
 * tidiness.
 *
 * Reads are GET, mutations are POST, and every response carries an
 * `X-CIS-Route-Kind: read|mutation|unimplemented` header.
 */

const express = require('express');

const router = express.Router();

router.use(require('./boot'));
router.use(require('./catalog'));
router.use(require('./inventory'));
router.use(require('./audit'));
router.use(require('./assembly'));
router.use(require('./trello'));
router.use(require('./po'));
router.use(require('./shipping'));
router.use(require('./diagnostics'));

module.exports = router;
