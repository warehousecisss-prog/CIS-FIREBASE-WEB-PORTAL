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

exports.scheduledSync = onSchedule("every 1 hours", async (event) => {
  logger.info("Scheduled sync running!");
});
