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
const Service_Read = require("./services/Service_Read");

const app = express();
// TODO: origin:true reflects any origin. Fine while every route is bearer-token
// gated (a cross-origin page cannot read another origin's ID token), but tighten
// to the Hosting domain before this carries anything cookie-authenticated.
app.use(cors({ origin: true }));
app.use(express.json());

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
app.use(attachIdentity);
app.use(requireAuth);

/**
 * Who the backend thinks you are. Exists so the auth wiring can be verified
 * end-to-end without performing a mutation.
 */
app.get('/me', (req, res) => {
  res.json({
    success: true,
    email: req.auth.email,
    name: req.auth.name,
    emulatorBypass: !!req.auth.bypassed
  });
});

app.get('/inventory', async (req, res) => {
  try {
    const inv = await Service_Read.getAllInventory();
    const agingData = await Service_Read.getAgingData();

    // Inject aging data into the array so frontend can read it
    if (inv && Array.isArray(inv)) {
      inv.forEach(row => {
        const loc = String(row[0] || '').trim().toUpperCase();
        if (agingData[loc] && agingData[loc].length > 0) {
          const firstEntry = agingData[loc][0];
          const diffTime = Math.abs(new Date() - new Date(firstEntry.date));
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          row.agingDays = diffDays;
        } else {
          row.agingDays = 0;
        }
      });
    }
    res.json(inv);
  } catch (error) {
    logger.error('Error fetching inventory:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/logistics-dashboard', async (req, res) => {
  try {
    const data = await Service_Read.getLogisticsDashboardData();
    res.json(data);
  } catch (error) {
    logger.error('Error fetching logistics dashboard data:', error);
    res.status(500).send('Internal Server Error');
  }
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
