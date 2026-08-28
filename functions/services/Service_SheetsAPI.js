const {google} = require('googleapis');
const logger = require('firebase-functions/logger');
const config = require('../config');

/**
 * ============================================================================
 * SHEETS API V4 BATCH OPERATIONS (PORTED FOR NODE.JS)
 * ============================================================================
 * Centralized helpers to interact with the Google Sheets API
 * for drastically improved read/write performance.
 *
 * Ported from SRC/src/Service_SheetsAPI.js. The Apps Script original reached
 * the API through the Advanced Sheets Service (`Sheets.Spreadsheets.*`); here
 * it is googleapis with Application Default Credentials. The request shapes,
 * and in particular the write options, are deliberately identical -- see the
 * comments on batchUpdateValues and batchAppendRows.
 */

let sheetsClient = null;

/**
 * @return {Promise<Object>} lazily-created, process-cached Sheets client.
 */
async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  // Application Default Credentials, supplied by the Cloud Functions runtime.
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const authClient = await auth.getClient();
  sheetsClient = google.sheets({version: 'v4', auth: authClient});
  return sheetsClient;
}

/**
 * The operational workbook's ID.
 *
 * The Apps Script original (SRC:11-19) could fall back to
 * SpreadsheetApp.getActiveSpreadsheet() because the script is container-bound.
 * Cloud Functions has no bound spreadsheet, so BATCH_SHEET_ID is mandatory and
 * a missing value throws here rather than returning a placeholder string that
 * every subsequent read and write would then 404 against.
 *
 * @return {string} spreadsheet ID.
 */
function getSpreadsheetId() {
  return config.require('BATCH_SHEET_ID');
}

/**
 * Cache of tab title -> sheet metadata for the operational workbook.
 * Populated once per process by loadSheetMetadata_(); gids are stable for the
 * life of a tab, and a cold start re-reads them.
 * @type {Object<string, {sheetId: number, title: string, index: number}>|null}
 */
let sheetMetaByTitle = null;

/**
 * @param {boolean} [force] refetch even when the cache is warm.
 * @return {Promise<Object>} title -> metadata map.
 */
async function loadSheetMetadata_(force) {
  if (sheetMetaByTitle && !force) return sheetMetaByTitle;

  const spreadsheetId = getSpreadsheetId();
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    // Only the tab index -- no cell data, so this stays a cheap call.
    fields: 'sheets.properties(sheetId,title,index)'
  });

  const map = {};
  (response.data.sheets || []).forEach((s) => {
    const props = s.properties || {};
    if (props.title === undefined) return;
    map[props.title] = {
      sheetId: props.sheetId,
      title: props.title,
      index: props.index
    };
  });

  sheetMetaByTitle = map;
  return sheetMetaByTitle;
}

const SS_API = {
  getSpreadsheetId: getSpreadsheetId,

  /**
   * Resolves a tab's real metadata, including its numeric gid.
   *
   * This exists because every delete path used to pass a hardcoded
   * `sheetId: 0`. Gid 0 is whichever tab was created first, NOT necessarily
   * `Inventory` -- so a wrong gid deletes rows out of the wrong tab, silently
   * and irreversibly. See PORT_AUDIT C4.
   *
   * Throws when the tab does not exist. There is deliberately no fallback: any
   * default here is a guess, and the failure mode of a guessed gid is
   * destroyed data in an unrelated tab.
   *
   * @param {string} sheetName tab title, e.g. "Inventory".
   * @return {Promise<{sheetId: number, title: string, index: number}>}
   */
  getSheetMetadata: async function(sheetName) {
    let meta = await loadSheetMetadata_(false);
    if (!meta[sheetName]) {
      // A tab added since this process started up is the benign explanation;
      // refetch once before giving up.
      meta = await loadSheetMetadata_(true);
    }
    if (!meta[sheetName]) {
      throw new Error(
          'Sheet tab "' + sheetName + '" not found in spreadsheet ' + getSpreadsheetId() +
          '. Known tabs: ' + Object.keys(meta).join(', ') + '.');
    }
    return meta[sheetName];
  },

  /**
   * @param {string} sheetName tab title.
   * @return {Promise<number>} the tab's numeric gid.
   */
  getSheetId: async function(sheetName) {
    return (await SS_API.getSheetMetadata(sheetName)).sheetId;
  },

  /** Drops the cached tab metadata. For tests and for post-tab-creation paths. */
  clearSheetMetadataCache: function() {
    sheetMetaByTitle = null;
  },

  /**
   * Applies multiple value updates in a single network request.
   *
   * valueInputOption is deliberately "RAW", not "USER_ENTERED". Everything
   * written through here is free text that originated in Trello -- pallet
   * comments, PO checklist descriptions, entity names. USER_ENTERED runs each
   * value through Sheets' own parser, so a checklist item literally named
   * "-3M SLIDE" or a comment "=2 pallets short" is stored as a formula and
   * renders as #NAME? forever, and a leading apostrophe is silently stripped.
   * Nothing in this codebase writes an intentional formula through SS_API
   * (there is not a single setFormula() call, nor any "=..." literal), so RAW
   * costs nothing. See AUDIT_2026-08-24.md B1 and PORT_AUDIT C1.
   *
   * @param {Array<{range: string, values: Array<Array<*>>}>} updates
   * @return {Promise<void>}
   */
  batchUpdateValues: async function(updates) {
    if (!updates || updates.length === 0) return;

    const spreadsheetId = getSpreadsheetId();
    const sheets = await getSheetsClient();

    const resource = {
      valueInputOption: 'RAW',
      data: updates
    };

    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        resource
      });
    } catch (e) {
      logger.error('SS_API.batchUpdateValues Error:', e);
      throw e;
    }
  },

  /**
   * Appends multiple rows to a specific sheet in a single request.
   *
   * Two non-obvious options, both required and both matching SRC:59-89:
   *
   *  - insertDataOption "INSERT_ROWS". The API default is OVERWRITE, and the
   *    "!A1" range makes Sheets table-detect downward from the top. A single
   *    blank row anywhere in Inventory truncates the detected table there, so
   *    an OVERWRITE append lands mid-sheet and destroys live rows below it.
   *    INSERT_ROWS always inserts instead of overwriting. See
   *    AUDIT_2026-08-24.md B2.
   *  - valueInputOption "RAW", for the same reason as batchUpdateValues above.
   *
   * @param {string} sheetName e.g., "Inventory"
   * @param {Array<Array<*>>} rows 2D array of values
   * @return {Promise<void>}
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
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource
      });
    } catch (e) {
      logger.error('SS_API.batchAppendRows Error:', e);
      throw e;
    }
  },

  /**
   * Deletes multiple rows simultaneously.
   * @param {number} sheetId The numeric gid of the tab -- resolve it with
   *     SS_API.getSheetId(name), never a literal.
   * @param {Array<number>} rowIndices 1-based row indices to delete
   * @return {Promise<void>}
   */
  batchDeleteRows: async function(sheetId, rowIndices) {
    if (!rowIndices || rowIndices.length === 0) return;

    if (typeof sheetId !== 'number' || !Number.isInteger(sheetId) || sheetId < 0) {
      throw new Error(
          'SS_API.batchDeleteRows: sheetId must be a resolved numeric gid (got ' +
          JSON.stringify(sheetId) + '). Use SS_API.getSheetId("<tab>").');
    }

    // Sort descending to prevent shifting indices from affecting subsequent deletions
    const sortedIndices = [...new Set(rowIndices)].sort((a, b) => b - a);

    const requests = sortedIndices.map((rowNum) => {
      return {
        deleteDimension: {
          range: {
            sheetId: sheetId,
            dimension: 'ROWS',
            startIndex: rowNum - 1, // 0-based inclusive
            endIndex: rowNum // 0-based exclusive
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
        resource: batchUpdateRequest
      });
    } catch (e) {
      logger.error('SS_API.batchDeleteRows Error:', e);
      throw e;
    }
  },

  /**
   * Reads all values from a specific sheet.
   * @param {string} range e.g., "CUSTOMER_REGISTRY!A:G"
   * @return {Promise<Array<Array<*>>>}
   */
  getSheetValues: async function(range) {
    const spreadsheetId = getSpreadsheetId();
    const sheets = await getSheetsClient();
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range
      });
      return response.data.values || [];
    } catch (e) {
      logger.error('SS_API.getSheetValues Error:', e);
      throw e;
    }
  }
};

module.exports = SS_API;
