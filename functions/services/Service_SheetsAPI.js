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
   * Sends raw `spreadsheets.batchUpdate` requests -- the structural/formatting
   * half of the Sheets API that `spreadsheets.values.*` cannot reach:
   * `repeatCell` (formatting), `setDataValidation` (dropdowns), `updateCells`,
   * `appendCells`, `deleteDimension`.
   *
   * Deliberately thin, and deliberately NOT a general escape hatch from the
   * rules the other methods enforce. Two things to know before using it:
   *
   *  - **It bypasses `valueInputOption: "RAW"`.** `updateCells`/`appendCells`
   *    carry their own per-cell `userEnteredValue`, and a string put in there
   *    is parsed by Sheets exactly as USER_ENTERED would (AUDIT B1: a checklist
   *    item named "-3M SLIDE" becomes a formula and renders #NAME? forever).
   *    Write VALUES through `batchUpdateValues`; use this for structure.
   *  - **One call is atomic.** Every request in the array applies or none does,
   *    which is the property AUDIT B3 (`commitAtomic`, the assembly write path)
   *    needs and which four sequential `values.*` calls cannot provide.
   *
   * @param {Array<Object>} requests Sheets API `Request` objects.
   * @return {Promise<Object>} the API's batchUpdate reply.
   */
  batchUpdateSheet: async function(requests) {
    if (!requests || requests.length === 0) return null;

    const spreadsheetId = getSpreadsheetId();
    const sheets = await getSheetsClient();

    try {
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: { requests: requests }
      });
      return response.data;
    } catch (e) {
      logger.error('SS_API.batchUpdateSheet Error:', e);
      throw e;
    }
  },

  /**
   * "A1" or "A1:D1" (with or without a "Tab!" prefix) -> a Sheets GridRange.
   * Internal to commitAtomic.
   *
   * @param {string} a1
   * @param {number} sheetId
   * @return {Object} GridRange.
   */
  _a1ToGridRange: function(a1, sheetId) {
    const bang = String(a1).lastIndexOf('!');
    const cells = bang === -1 ? String(a1) : String(a1).slice(bang + 1);
    const parts = cells.split(':');
    const parse = (ref) => {
      const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim());
      if (!m) throw new Error("SS_API._a1ToGridRange: unsupported range '" + a1 + "'");
      const letters = m[1].toUpperCase();
      let col = 0;
      for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
      return {col: col - 1, row: parseInt(m[2], 10) - 1};
    };
    const start = parse(parts[0]);
    const end = parts.length > 1 ? parse(parts[1]) : start;
    return {
      sheetId: sheetId,
      startRowIndex: Math.min(start.row, end.row),
      endRowIndex: Math.max(start.row, end.row) + 1,
      startColumnIndex: Math.min(start.col, end.col),
      endColumnIndex: Math.max(start.col, end.col) + 1
    };
  },

  /**
   * One value -> one Sheets CellData.
   *
   * `updateCells`/`appendCells` carry a typed `userEnteredValue` rather than
   * going through `valueInputOption`, so the RAW-vs-USER_ENTERED rule that
   * `batchUpdateValues` enforces does not apply here -- the type is stated
   * explicitly instead, which is stronger. A string stays a string: it is put
   * in `stringValue`, never parsed, so the AUDIT B1 hazard (a checklist item
   * named "-3M SLIDE" becoming a formula) cannot occur.
   *
   * A Date THROWS rather than being coerced. Sheets stores dates as serial
   * numbers, and writing one through updateCells without also setting a
   * numberFormat renders a bare `45000` in the cell forever. Every value routed
   * through commitAtomic is Inventory text/numbers; the Audit_Log rows that do
   * carry `new Date()` are written separately, outside the atomic set. This
   * throws loudly if that ever changes.
   *
   * Parity with SRC/src/Service_SheetsAPI.js:188-206.
   *
   * @param {*} v
   * @return {Object} CellData.
   */
  _toCellData: function(v) {
    if (v === null || v === undefined) return {userEnteredValue: {stringValue: ''}};
    if (Object.prototype.toString.call(v) === '[object Date]') {
      throw new Error('SS_API.commitAtomic: Date values are not supported — ' +
        'write date columns with batchAppendRows/batchUpdateValues instead.');
    }
    if (typeof v === 'number') {
      if (!isFinite(v)) {
        throw new Error('SS_API.commitAtomic: refusing to write a non-finite number (' + v + ').');
      }
      return {userEnteredValue: {numberValue: v}};
    }
    if (typeof v === 'boolean') return {userEnteredValue: {boolValue: v}};
    return {userEnteredValue: {stringValue: String(v)}};
  },

  /**
   * Applies updates, appends and deletes to Inventory as ONE atomic
   * `spreadsheets.batchUpdate`. AUDIT_2026-08-24.md B3.
   *
   * WHY THIS EXISTS. Every assembly write path used to commit through three or
   * four SEPARATE API calls, and a quota error or a timeout landing between two
   * of them corrupted inventory in a way nothing reported:
   *
   *  - `explodeAssembly` / `explodePartialHub` committed the restores (update +
   *    append) BEFORE the delete. Failing in between left the components
   *    restored AND the assembly rows still standing — **inventory silently
   *    doubled**.
   *  - `buildHardAssembly` was the mirror image: it deleted the consumed
   *    component rows in one call and minted the new assembly rows in a later
   *    one. Failing in between **destroyed the stock outright**.
   *
   * One batchUpdate is applied by the API as all-or-nothing, which is the only
   * thing that closes that window. It is a different guarantee from the write
   * lease in functions/lock.js and neither replaces the other: the lease stops
   * two writers interleaving, this stops ONE writer half-finishing.
   *
   * ORDERING IS LOAD-BEARING. Requests are emitted updates -> appends ->
   * deletes, and deletes are sorted DESCENDING. A delete shifts every row below
   * it up by one, so an ascending delete list invalidates its own later indices,
   * and a delete emitted before an append would shift the append's target.
   *
   * Parity with SRC/src/Service_SheetsAPI.js:232-286.
   *
   * @param {{updates: Array<{range: string, values: Array<Array<*>>}>,
   *          appends: Array<{sheetId: number, rows: Array<Array<*>>}>,
   *          deletes: Array<{sheetId: number, rowIndices: Array<number>}>}} ops
   * @param {number} defaultSheetId gid for A1 ranges that carry no tab name.
   * @return {Promise<number>} how many requests were sent.
   */
  commitAtomic: async function(ops, defaultSheetId) {
    const requests = [];
    const self = SS_API;

    (ops.updates || []).forEach(function(upd) {
      if (!upd || !upd.values || upd.values.length === 0) return;
      requests.push({
        updateCells: {
          range: self._a1ToGridRange(upd.range, defaultSheetId),
          rows: upd.values.map(function(row) {
            return {values: row.map(function(v) { return self._toCellData(v); })};
          }),
          fields: 'userEnteredValue'
        }
      });
    });

    (ops.appends || []).forEach(function(app) {
      if (!app || !app.rows || app.rows.length === 0) return;
      requests.push({
        appendCells: {
          sheetId: app.sheetId,
          rows: app.rows.map(function(row) {
            return {values: row.map(function(v) { return self._toCellData(v); })};
          }),
          fields: 'userEnteredValue'
        }
      });
    });

    (ops.deletes || []).forEach(function(del) {
      if (!del || !del.rowIndices || del.rowIndices.length === 0) return;
      const sorted = [...new Set(del.rowIndices)].sort(function(a, b) { return b - a; });
      sorted.forEach(function(rowNum) {
        requests.push({
          deleteDimension: {
            range: {
              sheetId: del.sheetId,
              dimension: 'ROWS',
              startIndex: rowNum - 1,
              endIndex: rowNum
            }
          }
        });
      });
    });

    if (requests.length === 0) return 0;

    const spreadsheetId = getSpreadsheetId();
    const sheets = await getSheetsClient();
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {requests: requests}
      });
    } catch (e) {
      logger.error('SS_API.commitAtomic Error (' + requests.length + ' requests)', {
        error: e.message
      });
      throw e;
    }
    return requests.length;
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
