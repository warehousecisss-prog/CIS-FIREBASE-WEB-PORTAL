// Shared firebase-admin initialisation. Required first, and for its side
// effect: auth.js and anything else that touches the Admin SDK depends on the
// app already existing.
require("./admin");

const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const express = require('express');
const cors = require('cors');

const config = require("./config");
const {attachIdentity, requireAuth} = require("./auth");
const { sendPONotification } = require("./services/Service_Email");
const Webhook = require("./services/Service_Webhook");
const { claimWebhookEvent, webhookEventKey_ } = require("./webhook_dedupe");

const app = express();
// TODO: origin:true reflects any origin. Fine while every route is bearer-token
// gated (a cross-origin page cannot read another origin's ID token), but tighten
// to the Hosting domain before this carries anything cookie-authenticated.
app.use(cors({ origin: true }));

// 10mb, not the 100kb default. /po-ingest carries a base64-encoded PO PDF
// (TrelloInjector.html reads the file with FileReader.readAsDataURL and posts
// the payload), and the default limit would reject a scanned multi-page PO
// with a 413 whose body says nothing about size.
app.use(express.json({ limit: '10mb' }));

// One warning line naming any required key with no value, emitted on the first
// request rather than at module load. The emulator (and `firebase deploy`) load
// this file once in a discovery pass to enumerate exports, and that pass runs
// WITHOUT the .env injected -- warning there reported all four required keys
// missing on a fully-populated .env, which is exactly the kind of false alarm
// that teaches people to ignore warnings. Still not a throw: see config.js.
let configWarningLogged = false;
app.use((req, res, next) => {
  if (!configWarningLogged) {
    configWarningLogged = true;
    config.logMissingRequired();
  }
  next();
});

// Verify the bearer token if one is present, then require an identity on every
// route below. Enforcement is reject-with-401, per the 2026-08-28 auth decision;
// AUTH_DISABLED=true bypasses it under the emulator only.
//
// These two stay on the app rather than moving into the routers: an
// app.use() here cannot be forgotten by a new route module, whereas a
// per-router requireAuth is one omission away from an open mutation endpoint.
app.use(attachIdentity);
app.use(requireAuth);

/**
 * Who the backend thinks you are. Exists so the auth wiring can be verified
 * end-to-end without performing a mutation.
 */
app.get('/me', (req, res) => {
  res.set('X-CIS-Route-Kind', 'read');
  res.json({
    success: true,
    email: req.auth.email,
    name: req.auth.name,
    emulatorBypass: !!req.auth.bypassed
  });
});

// Every other route. See functions/http/routes/index.js for the registry and
// PHASE_3_NOTES.md for the full call inventory.
app.use(require('./http/routes'));

// Anything that reaches here matched no route. Answering JSON (rather than
// Express's default HTML "Cannot POST /whatever" page) means the client's
// error path gets a parseable body for a 404 the same as for a 422, so a
// mistyped path reads as a mistyped path instead of a JSON parse error.
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'No route for ' + req.method + ' ' + req.path + '.'
  });
});

// Express's own error handler answers 500 with an HTML stack page, and for a
// body-parser failure (malformed JSON, or a payload over the limit above) it
// never reaches the wrappers at all. Same JSON envelope as everything else.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled error in the Express app', { error: err.message, stack: err.stack });
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({
    success: false,
    error: err.message || 'Unhandled server error.'
  });
});

exports.api = onRequest(app);

exports.triggerEmailNotification = onRequest(async (request, response) => {
  if (request.method !== 'POST') {
    return response.status(405).send("Method Not Allowed");
  }

  // Same identity gate as the Express app. This entry point is its own
  // onRequest function, so it does not inherit app.use() above.
  await new Promise((resolve) => attachIdentity(request, response, resolve));
  if (response.headersSent) return undefined;
  if (!request.auth || !request.auth.email) {
    return response.status(401).json({
      success: false,
      error: 'Authentication required. Sign in with your work Google account.'
    });
  }

  const { to, cc, type, poData } = request.body;
  if (!to || !type || !poData) {
    return response.status(400).send("Missing required fields: to, type, poData");
  }

  const result = await sendPONotification(to, cc, type, poData);
  if (result.success) {
    response.status(200).send(result);
  } else {
    response.status(500).send(result);
  }
});

/**
 * The Trello webhook endpoint (SCHEMA section 13).
 *
 * Its own onRequest function, NOT part of the Express app above: Trello sends
 * no Firebase ID token, so it must not pass through requireAuth. It
 * authenticates by signature instead.
 *
 * ANSWERS 2xx FOR EVERYTHING IT HANDLES ITSELF, including on failure. Cloud
 * Functions could return 500 and get a Trello retry -- a genuine capability the
 * original lacked -- but Trello DELETES a webhook after sustained failures, and
 * losing the registration is a bigger outage than losing one event (which the
 * scheduled sync picks up anyway). So the original's contract is kept: swallow,
 * and write the raw payload to the durable Webhook_Errors tab for replay.
 * Revisit only with a deliberate decision about that trade.
 *
 * ONE EXCEPTION, and it is not ours to control: a body that is not valid JSON
 * is rejected with a 400 by the Functions runtime's own body parser, before
 * this handler is entered at all (verified against the emulator). That is
 * arguably the better outcome anyway -- a malformed body means a truncated or
 * corrupted delivery, which a retry can actually fix, unlike the failures
 * above -- but it does mean the "always 2xx" contract has a hole, and a
 * malformed payload is NOT captured to Webhook_Errors. Stated rather than
 * assumed away.
 */
exports.trelloWebhook = onRequest(async (req, res) => {
  // Trello validates a new webhook with HEAD, and re-validates with GET.
  if (req.method === 'HEAD' || req.method === 'GET') {
    return res.status(200).send('Trello Webhook Active');
  }
  if (req.method !== 'POST') {
    return res.status(200).send('OK - Ignored');
  }

  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';

  try {
    const verdict = Webhook.verifyTrelloSignature(req);
    if (!verdict.ok) {
      logger.warn('Rejected webhook: ' + verdict.reason);
      await Webhook.logWebhookError_('Rejected: ' + verdict.reason, rawBody, '');
      return res.status(200).send('REJECTED - Unauthorized');
    }
    if (!verdict.enforced) {
      logger.warn('Trello webhook signature NOT verified (TRELLO_API_SECRET unset). ' +
        'This endpoint currently accepts any POST. See config.js.');
    }

    if (!rawBody) return res.status(200).send('OK - No Data');

    const payload = JSON.parse(rawBody);
    const action = payload.action;

    if (!action || !action.data || !action.data.card) {
      return res.status(200).send('OK - Ignored');
    }

    const cardId = action.data.card.id;

    // De-bounce IDENTICAL repeats only. Keyed on the EVENT, never the card --
    // SCHEMA invariant #43, see functions/webhook_dedupe.js.
    const eventKey = webhookEventKey_(cardId, action);
    const claim = await claimWebhookEvent(eventKey);
    if (!claim.isNew) return res.status(200).send('OK - Duplicate');

    // Deliberately NOT wrapped in the inventory lease. This reads SHIPMENTS and
    // makes Trello calls; holding a write lock across that would block the
    // floor's inventory writes for the duration, and the event-keyed de-bounce
    // above is what prevents duplicate processing. Same reasoning SRC records
    // for not taking a LockService lock here.
    const result = await Webhook.processWebhookPayload(payload);

    return res.status(200).send('OK - ' + result.handled);
  } catch (error) {
    logger.error('Webhook Error: ' + error.toString(), { stack: error.stack });
    await Webhook.logWebhookError_(
        error && error.stack ? error.stack : String(error), rawBody, '');
    return res.status(200).send('ERROR');
  }
});

/**
 * The 4-board master sync (SCHEMA section 7, "Writer 1").
 *
 * `timeoutSeconds` is NOT the default. The default for a scheduled function is
 * 60 seconds, which this cannot finish in -- a full 4-board pull plus the
 * rollup engine, the archive/prune pass and the whole date pipeline behind it.
 * 540s (9 minutes) sits just above Service_Sync's own 8-minute internal budget,
 * so the function's own budget is what stops a long run, gracefully and with a
 * complete board list, rather than the platform killing it mid-write.
 *
 * The internal budget is the load-bearing half: a board that did not finish its
 * card list is excluded from pruning, because "not seen this run" would
 * otherwise be read as "deleted from Trello" and archive live shipments.
 */
exports.scheduledSync = onSchedule(
    {schedule: "every 1 hours", timeoutSeconds: 540, memory: "512MiB"},
    async (event) => {
      const result = await require('./services/Service_Sync')
          .syncAllBoardsToShipmentsTab();
      if (!result.success) {
        // Throwing marks the scheduled run as failed, which is what surfaces it
        // in Cloud Scheduler and in any alerting built on it. The sync has
        // already logged the detail.
        throw new Error('Scheduled sync failed: ' + result.error);
      }
    });
