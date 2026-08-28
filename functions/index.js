const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const express = require('express');
const cors = require('cors');

const { sendPONotification } = require("./services/Service_Email");
const Service_Read = require("./services/Service_Read");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

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
