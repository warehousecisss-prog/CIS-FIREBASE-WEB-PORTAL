/**
 * ============================================================================
 * RUNTIME CONFIGURATION
 * ============================================================================
 * Single source of truth for every value the Apps Script original pulled from
 * PropertiesService.getScriptProperties(). Nothing else in functions/ should
 * read process.env directly.
 *
 * Where the values come from
 * --------------------------
 * The Firebase CLI auto-loads `functions/.env` (and `functions/.env.<projectId>`)
 * into process.env for both `firebase emulators:start` and `firebase deploy`.
 * That is the whole mechanism -- there is no functions.config() usage and no
 * Secret Manager binding yet. Moving the `secret: true` keys below into Secret
 * Manager (defineSecret) is a deploy-topology change and is deliberately NOT
 * done here; see PHASE_1_NOTES.md.
 *
 * Why validation is lazy
 * ----------------------
 * Cloud Functions loads this module during deploy-time analysis and at every
 * cold start, including for functions that touch none of these keys. Throwing
 * at module load would break `firebase deploy` and stop the emulator from
 * booting. So: nothing throws on require. `get()` returns the default (or
 * undefined) and `require()` throws at the point of use, naming the key.
 * `logMissingRequired()` prints one warning line at cold start.
 *
 * Every key below was found by grepping SRC/src for PropertiesService
 * .getProperty(...). Keys marked "port-only" have no Apps Script ancestor --
 * they exist because the Node runtime needs something Apps Script got for free.
 */

const logger = require('firebase-functions/logger');

/**
 * @typedef {Object} ConfigSpec
 * @property {boolean}  [required]  missing => require() throws, and it is named
 *                                  in the cold-start warning
 * @property {*}        [default]   value used when the env var is absent; only
 *                                  set where the original had a hardcoded ||
 *                                  fallback, so behaviour matches SRC exactly
 * @property {string[]} [aliases]   alternate env names, checked in order after
 *                                  the primary
 * @property {boolean}  [secret]    credential -- never log the value
 * @property {string}   desc        what it is / who reads it
 */

/** @type {Object<string, ConfigSpec>} */
const SPEC = {
  // --- Google Sheets -------------------------------------------------------
  BATCH_SHEET_ID: {
    required: true,
    desc: 'Spreadsheet ID of the operational workbook. SRC: Service_SheetsAPI.js:12. ' +
          'Apps Script could fall back to the bound SpreadsheetApp.getActiveSpreadsheet(); ' +
          'Cloud Functions has no bound spreadsheet, so this is mandatory here.'
  },

  // --- Trello credentials --------------------------------------------------
  TRELLO_KEY: {
    required: true, secret: true,
    aliases: ['TRELLO_API_KEY'],
    desc: 'Trello API key. SRC reads TRELLO_KEY everywhere except Service_Write.js:1565, ' +
          'which tries TRELLO_API_KEY first. Both names are accepted here.'
  },
  TRELLO_TOKEN: {
    required: true, secret: true,
    aliases: ['TRELLO_API_TOKEN'],
    desc: 'Trello API token. Same dual-name story as TRELLO_KEY (SRC Service_Write.js:1566).'
  },
  TRELLO_ORG_ID: {
    default: '649c7882ed36c7969285c5d3',
    desc: 'Trello organisation ID. SRC: Webhook_Receiver.js:643.'
  },
  TRELLO_BOT_MEMBER_ID: {
    desc: 'Member ID of the dedicated automation Trello account, written by ' +
          'identifyTrelloBotAccount(). Optional by design: when unset, the ETA-override ' +
          'detector falls back to value comparison against lastAutoDue (SCHEMA 4F). ' +
          'NOTE: the original SETS this property at runtime -- see RUNTIME_STATE_KEYS.'
  },

  // --- Trello board / list IDs (SCHEMA section 2) --------------------------
  INBOUND_PO_BOARD_ID: {
    default: '649c805bad63086ff6689611',
    desc: 'Board: Purchase Orders (inbound). SRC: Service_Read.js:1396, Shared_Classifiers.js:50.'
  },
  INBOUND_NICOLE_BOARD_ID: {
    default: '64c286cd0d581563f72d58c0',
    desc: 'Board: Nicole POs (inbound). SRC: Shared_Classifiers.js:51.'
  },
  BURLINGTON_OUTBOUND_BOARD_ID: {
    default: '649c7dd6690130fe8ef3689a',
    desc: 'Board: Burlington Shipping Schedule (outbound). SRC: Shared_Classifiers.js:52, ' +
          'pushOutboundToShippingSchedule.js:173.'
  },
  OUTBOUND_BOARD_ID: {
    default: '66bcf93dd63eecdb2d4e91e7',
    desc: 'Board: Shipping Schedule (outbound). SRC: Shared_Classifiers.js:53.'
  },
  BURLINGTON_OUTBOUND_TO_BE_SHIPPED: {
    default: '649c7dd664d470bbe01f6fc2',
    desc: 'List ID within the Burlington board that outbound cards are pushed into. ' +
          'SRC: pushOutboundToShippingSchedule.js:286.'
  },

  // --- External spreadsheets ----------------------------------------------
  BURLINGTON_SHEET_SYNC: {
    default: '10l6c37PE54MWug1C1HQEUtz1dP-s5x2btHDGcxNI2JM',
    desc: 'File ID of the external Burlington Orders workbook. ' +
          'SRC: pushOutboundToShippingSchedule.js:92,112,160. SCHEMA section 10.'
  },

  // --- FedEx ---------------------------------------------------------------
  // SRC/src/Fedex_Master_Script.js:12-13 names the Track API credentials just
  // CLIENT_ID / CLIENT_SECRET. Those names are far too generic for a process
  // environment shared with the Firebase runtime, so the FEDEX_-prefixed names
  // are primary here and the bare ones are accepted as aliases for a
  // lift-and-shift of the existing Script Properties. See .env.example.
  FEDEX_CLIENT_ID: {
    secret: true, aliases: ['CLIENT_ID'],
    desc: 'FedEx Track API OAuth client ID. SRC: Fedex_Master_Script.js:12 ("CLIENT_ID").'
  },
  FEDEX_CLIENT_SECRET: {
    secret: true, aliases: ['CLIENT_SECRET'],
    desc: 'FedEx Track API OAuth client secret. SRC: Fedex_Master_Script.js:13 ("CLIENT_SECRET").'
  },
  FEDEX_RATES_KEY: {
    secret: true,
    desc: 'FedEx Rates API OAuth key -- separate credential from the Track API. ' +
          'SRC: Fedex_Master_Script.js:80. SCHEMA section 8.'
  },
  FEDEX_RATES_SECRET: {
    secret: true,
    desc: 'FedEx Rates API OAuth secret. SRC: Fedex_Master_Script.js:81.'
  },
  FEDEX_ACCOUNT: {
    default: '000000000', aliases: ['FEDEX_ACCOUNT_NUMBER'],
    desc: 'FedEx account number. SRC: Fedex_Master_Script.js:554 tries FEDEX_ACCOUNT then ' +
          'FEDEX_ACCOUNT_NUMBER then "000000000". The placeholder default is preserved so ' +
          'the Rates API rejects it loudly per-row rather than failing silently (SCHEMA section 8).'
  },
  CIS_ZIPCODE: {
    default: '34997',
    desc: 'Origin ZIP for rate/transit lookups. SRC: Fedex_Master_Script.js:710,767.'
  },

  // --- RXO -----------------------------------------------------------------
  RXO_CLIENT_ID: { secret: true, desc: 'RXO OAuth client ID. SRC: Service_RXO.js:72,300.' },
  RXO_CLIENT_SECRET: { secret: true, desc: 'RXO OAuth client secret. SRC: Service_RXO.js:73,301.' },
  RXO_API_KEY: { secret: true, desc: 'RXO API key. SRC: Service_RXO.js:74,302.' },
  RXO_SCOPE: { desc: 'RXO OAuth scope. SRC: Service_RXO.js:75,303.' },
  RXO_PARTNER_CODE: { desc: 'RXO partnerIdentifierCode query param. SRC: Service_RXO.js:76,304.' },
  RXO_DRY_RUN: {
    default: 'false',
    desc: 'String "true" suppresses real RXO calls. SRC: Service_RXO.js:59 compares === "true".'
  },

  // --- Webhook -------------------------------------------------------------
  WEBHOOK_HOP_SECRET: {
    secret: true,
    desc: 'Shared secret for the Render -> backend webhook hop, compared constant-time. ' +
          'SRC: Webhook_Receiver.js:93. Optional BY DESIGN -- when unset the check is ' +
          'skipped entirely, because enabling it before Render sends ?k= would silently ' +
          'drop every webhook, and a dropped webhook is unrecoverable (SCHEMA 63, AUDIT D2).'
  },

  // --- HTS / tariff tooling (low priority, not yet ported) ------------------
  HTS_FILE_ID: {
    desc: 'Drive file ID of the government HTS reference. SRC: updateHtsDataSheet.js (SCHEMA 19).'
  },
  GLOBAL_SURCHARGE_RATE: {
    default: '0.00',
    desc: 'Section 301/232 surcharge rate. SRC: updateHtsDataSheet.js:32.'
  },

  // --- OneDrive sync (low priority, not yet ported) ------------------------
  AZURE_CLIENT_ID: { secret: true, desc: 'SRC: OneDrive_Graph_Sync.gs.js:22.' },
  AZURE_CLIENT_SECRET: { secret: true, desc: 'SRC: OneDrive_Graph_Sync.gs.js:23.' },
  ONEDRIVE_DRIVE_ID: {
    desc: 'SRC: OneDrive_Graph_Sync.gs.js:127. Known broken upstream -- the discovery step ' +
          'writes _1/_2 suffixed names that this never reads (SCHEMA section 19).'
  },
  ONEDRIVE_ITEM_ID: {
    desc: 'SRC: OneDrive_Graph_Sync.gs.js:128. Same suffix mismatch.'
  },

  // --- Auth (port-only) ----------------------------------------------------
  ALLOWED_EMAIL_DOMAINS: {
    required: true,
    desc: 'port-only. Comma-separated Google Workspace domains allowed to call the API, ' +
          'e.g. "cisfl.com". Replaces the implicit trust boundary Apps Script got from ' +
          'running inside a Google login. Required so the allowlist can never be empty by ' +
          'accident -- use ALLOWED_EMAILS alongside it for individual exceptions.'
  },
  ALLOWED_EMAILS: {
    default: '',
    desc: 'port-only. Comma-separated individual addresses allowed in addition to ' +
          'ALLOWED_EMAIL_DOMAINS. Optional.'
  },
  AUTH_DISABLED: {
    default: 'false',
    desc: 'port-only. "true" bypasses token verification -- HONOURED ONLY under the ' +
          'Functions emulator (FUNCTIONS_EMULATOR === "true"). Ignored in deployed code, ' +
          'so leaving it set cannot open production.'
  },
  DEV_OPERATOR_EMAIL: {
    default: 'emulator-operator@localhost',
    desc: 'port-only. Identity attributed to Audit_Log rows when AUTH_DISABLED is honoured ' +
          'in the emulator, so local writes are visibly non-production.'
  },

  // --- Email (port-only; the original used MailApp/GmailApp) ---------------
  SMTP_HOST: {
    desc: 'port-only. SMTP host for Service_Email. Apps Script used MailApp, which needs no config.'
  },
  SMTP_PORT: { default: '587', desc: 'port-only. SMTP port.' },
  SMTP_USER: { secret: true, desc: 'port-only. SMTP username.' },
  SMTP_PASS: { secret: true, desc: 'port-only. SMTP password.' },
  PORTAL_BASE_URL: {
    desc: 'port-only. Public origin the SPA is served from, e.g. ' +
          '"https://cis-warehouse-portal.web.app". Used by ' +
          'Service_Read.getInjectorUrl(), which in Apps Script could just ask ' +
          'the runtime (ScriptApp.getService().getUrl()); Cloud Functions has no ' +
          'equivalent. Optional -- when unset the origin is derived from the ' +
          'incoming request instead.'
  },
  SMTP_FROM: {
    default: 'Warehouse Portal <noreply@warehouse-portal.com>',
    desc: 'port-only. From header for outbound notifications.'
  }
};

/**
 * Runtime state that LOOKS like config but is not, and must not live in .env:
 * the original WRITES these back with setProperty, so they need a real store
 * (Firestore) when the owning script is ported.
 *
 *   TRELLO_BOT_MEMBER_ID      written by identifyTrelloBotAccount() (Service_Dates)
 *   WEBHOOK_ERRORS_LAST_ROW   Webhook_Receiver.js:175, alertOnWebhookErrors cursor
 *   FR_WATCH_SEEN_DOCS        checkFederalRegisterForTariffChanges.js:47
 *   LAST_SYNCED_MODIFIED_TIME OneDrive_Graph_Sync.gs.js:149
 *
 * TRELLO_BOT_MEMBER_ID is also in SPEC above because it is read as config too;
 * the write-back half has no home yet.
 */
const RUNTIME_STATE_KEYS = [
  'TRELLO_BOT_MEMBER_ID',
  'WEBHOOK_ERRORS_LAST_ROW',
  'FR_WATCH_SEEN_DOCS',
  'LAST_SYNCED_MODIFIED_TIME'
];

function readRaw(name) {
  const spec = SPEC[name];
  if (!spec) {
    throw new Error('config: unknown key "' + name + '". Add it to SPEC in functions/config.js.');
  }
  const candidates = [name].concat(spec.aliases || []);
  for (const candidate of candidates) {
    const raw = process.env[candidate];
    if (raw !== undefined && String(raw).trim() !== '') return String(raw).trim();
  }
  return undefined;
}

/**
 * Value or default. Never throws for a missing value -- use require() where the
 * call site genuinely cannot proceed without it.
 * @param {string} name
 * @return {string|undefined}
 */
function get(name) {
  const raw = readRaw(name);
  if (raw !== undefined) return raw;
  return SPEC[name].default;
}

/**
 * Value, or a thrown error naming the key. This is the accessor for anything
 * that would otherwise write a placeholder into a real sheet.
 * @param {string} name
 * @return {string}
 */
function requireValue(name) {
  const value = get(name);
  if (value === undefined || value === '') {
    throw new Error(
        'Missing required configuration "' + name + '". Set it in functions/.env ' +
        '(see functions/.env.example). ' + SPEC[name].desc);
  }
  return value;
}

/**
 * @param {string} name
 * @return {boolean} true when the key resolves to something non-empty.
 */
function has(name) {
  const value = get(name);
  return value !== undefined && value !== '';
}

/**
 * @param {string} name
 * @return {boolean} config value parsed as a boolean ("true"/"1"/"yes").
 */
function flag(name) {
  return /^(true|1|yes)$/i.test(String(get(name) || ''));
}

/**
 * @param {string} name
 * @return {Array<string>} comma-separated config value split into trimmed items.
 */
function list(name) {
  return String(get(name) || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
}

/** @return {Array<string>} names of required keys with no value. */
function missingRequired() {
  return Object.keys(SPEC).filter((name) => SPEC[name].required && !has(name));
}

/**
 * One warning line at cold start. Deliberately a warning and not a throw -- see
 * the module header. Never prints values.
 * @return {Array<string>} the missing key names.
 */
function logMissingRequired() {
  const missing = missingRequired();
  if (missing.length > 0) {
    logger.warn(
        'Missing required configuration: ' + missing.join(', ') +
        '. Requests that need these keys will fail with an explicit error. ' +
        'See functions/.env.example.');
  }
  return missing;
}

/** @return {Array<Object>} key names + descriptions, no values. */
function describe() {
  return Object.keys(SPEC).map((name) => ({
    name,
    required: !!SPEC[name].required,
    secret: !!SPEC[name].secret,
    hasValue: has(name),
    usesDefault: readRaw(name) === undefined && SPEC[name].default !== undefined,
    desc: SPEC[name].desc
  }));
}

module.exports = {
  SPEC,
  RUNTIME_STATE_KEYS,
  get,
  require: requireValue,
  has,
  flag,
  list,
  missingRequired,
  logMissingRequired,
  describe
};
