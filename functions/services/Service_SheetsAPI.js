const { google } = require('googleapis');
const logger = require('firebase-functions/logger');

/**
 * ============================================================================
 * SHEETS API V4 BATCH OPERATIONS (PORTED FOR NODE.JS)
 * ============================================================================
 * Centralized helpers to interact with the Google Sheets API
 * for drastically improved read/write performance.
 */

// In a real Firebase environment, you'd use Application Default Credentials or a Service Account key.
// Here we set up a lazy-loaded auth client.
let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  
  // Uses Application Default Credentials (e.g., from the Firebase environment)
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  
  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

function getSpreadsheetId() {
  // In Firebase, configuration is often stored in process.env or Firebase config.
  const explicitId = process.env.BATCH_SHEET_ID || "PLACEHOLDER_SHEET_ID";
  if (!explicitId || explicitId === "PLACEHOLDER_SHEET_ID") {
    logger.warn("BATCH_SHEET_ID is not set in environment variables.");
  }
  return explicitId;
}

const SS_API = {
  /**
   * Applies multiple value updates in a single network request.
   * @param {Array<{range: string, values: Array<Array<any>>}>} updates
   */
  batchUpdateValues: async function(updates) {
    if (!updates || updates.length === 0) return;
    
    const spreadsheetId = getSpreadsheetId();
    const sheets = await getSheetsClient();
    
    const resource = {
      valueInputOption: "USER_ENTERED",
      data: updates
    };
    
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        resource,
      });
    } catch (e) {
      logger.error("SS_API.batchUpdateValues Error:", e);
      throw e;
    }
  },

  /**
   * Appends multiple rows to a specific sheet in a single request.
   * @param {string} sheetName e.g., "Inventory"
   * @param {Array<Array<any>>} rows 2D array of values
   */
  batchAppendRows: async function(sheetName, rows) {
    if (!rows || rows.length === 0) return;
    
    const spreadsheetId = getSpreadsheetId();
    const sheets = await getSheetsClient();
    
    const resource = {
      values: rows
    };
    
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        resource,
      });
    } catch (e) {
      logger.error("SS_API.batchAppendRows Error:", e);
      throw e;
    }
  },

  /**
   * Deletes multiple rows simultaneously. 
   * @param {number} sheetId The numeric ID of the sheet (e.g., sheet.getSheetId())
   * @param {Array<number>} rowIndices 1-based row indices to delete
   */
  batchDeleteRows: async function(sheetId, rowIndices) {
    if (!rowIndices || rowIndices.length === 0) return;
    
    // Sort descending to prevent shifting indices from affecting subsequent deletions
    const sortedIndices = [...new Set(rowIndices)].sort((a, b) => b - a);
    
    const requests = sortedIndices.map(rowNum => {
      return {
        deleteDimension: {
          range: {
            sheetId: sheetId,
            dimension: "ROWS",
            startIndex: rowNum - 1, // 0-based inclusive
            endIndex: rowNum        // 0-based exclusive
          }
        }
      };
    });

    const spreadsheetId = getSpreadsheetId();
    const sheets = await getSheetsClient();
    
    const batchUpdateRequest = {
      requests: requests
    };

    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: batchUpdateRequest,
      });
    } catch (e) {
      logger.error("SS_API.batchDeleteRows Error:", e);
      throw e;
    }
  },

  /**
   * Reads all values from a specific sheet.
   * @param {string} range e.g., "CUSTOMER_REGISTRY!A:G"
   * @returns {Promise<Array<Array<any>>>}
   */
  getSheetValues: async function(range) {
    const spreadsheetId = getSpreadsheetId();
    const sheets = await getSheetsClient();
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });
      return response.data.values || [];
    } catch (e) {
      logger.error("SS_API.getSheetValues Error:", e);
      throw e;
    }
  }
};

module.exports = SS_API;
