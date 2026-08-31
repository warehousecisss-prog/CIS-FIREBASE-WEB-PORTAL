const crypto = require('crypto');
const logger = require('firebase-functions/logger');
const SS_API = require('./Service_SheetsAPI');
const {
  resolveBoardById_,
  classifyListStatus,
  getRollupRank_,
  resolveTransitMode,
  harvestFedExTrackingNumber,
  extractStoreInfo,
  formatInboundLineItems,
  formatOutboundLineItems,
  classifyInboundOrderOriginServer_,
  parseIgnoreComment_,
  applyIgnoreDeclaration_,
  trelloCreds_,
  trelloFetch_
} = require('./Shared_Classifiers');

/**
 * ============================================================================
 * TRELLO WEBHOOK HANDLER (SCHEMA.md Section 13)
 * ============================================================================
 * Ported from SRC/src/Webhook_Receiver.js.
 *
 * The real-time half of the SHIPMENTS pipeline. A card changes on Trello ->
 * this updates that ONE row, in seconds, instead of waiting up to an hour for
 * the scheduled sync to notice.
 *
 * It handles five things, and the order they run in is load-bearing:
 *   1. card closed/archived   -> archive the row to Shipment_History NOW
 *   2. ".ignore"/".unignore"  -> flip the PORTAL: IGNORE label (both directions)
 *   3. sailing-schedule and READY/PORT comments, and due-date overrides
 *      (inbound only) -- these MUST run before the A-J idempotency check
 *      below, because a comment-only or due-date-only event produces
 *      byte-identical A-J data and would otherwise never fire
 *   4. recompute the row's ten A-J columns
 *   5. upsert, then warm the dashboard cache
 *
 * ----------------------------------------------------------------------------
 * PORTING NOTES -- what necessarily changed, and what deliberately did not
 * ----------------------------------------------------------------------------
 *
 * 1. **The Render.com proxy is gone (user decision, Phase 5).** SRC could not
 *    verify Trello's signature: Trello signs an HMAC over the callback URL and
 *    the body, and Apps Script's `doPost(e)` cannot read request headers at
 *    all. So the original bounced every webhook through a free Render server
 *    and authenticated only that hop, with a shared `?k=` secret. Cloud
 *    Functions reads headers, so `verifyTrelloSignature()` below checks
 *    Trello's real signature directly and the proxy -- a sleeping free-tier
 *    server on the critical path, pinged every 5 minutes to keep it awake --
 *    is removed entirely. `WEBHOOK_HOP_SECRET` and `keepRenderAwake()` go with
 *    it.
 *
 * 2. **The de-bounce moved from CacheService to Firestore**, in
 *    `functions/webhook_dedupe.js`. Same 20s TTL, same event-hash key. See
 *    that file's header, and DO NOT re-key it on the card (SCHEMA #43).
 *
 * 3. **`processWebhookPayload` is unchanged in substance.** Every branch,
 *    every comparison and the whole rollup-status block are ported verbatim,
 *    because SCHEMA §13 says this block is kept in sync with the scheduled
 *    sync's equivalent BY HAND, not by shared code -- so a "tidier" version
 *    here silently desynchronises the two writers.
 *
 * 4. **Rows are padded to full width on read** (`padRows_`), for the reason
 *    documented at length in Service_Rollup.js's porting note 6: Apps Script
 *    pads a row to the requested column count, the Sheets API omits trailing
 *    empty cells, and unguarded indexing therefore yields the string
 *    "undefined" instead of "".
 *
 * 5. **`alertOnWebhookErrors` is NOT ported.** It is a daily digest of the
 *    Webhook_Errors tab, and it exists in SRC only because Apps Script cannot
 *    return a non-200 status -- so a failed webhook was invisible unless
 *    something mailed you about it. Cloud Functions logs errors to Cloud
 *    Logging, where alerting is a platform feature rather than a mail loop
 *    this code has to run. The durable Webhook_Errors tab IS still written
 *    (see logWebhookError_), because its real value is keeping the raw payload
 *    for replay, which no amount of logging gives you.
 * ============================================================================
 */

/**
 * Verifies Trello's webhook signature.
 *
 * Trello signs `base64(HMAC-SHA1(apiSecret, rawBody + callbackURL))` and sends
 * it as the `x-trello-webhook` header. This is the check the original could
 * never perform: Apps Script's `doPost(e)` has no header access at all, which
 * is the entire reason SRC bounced every webhook through a Render.com proxy and
 * authenticated only that hop with a shared `?k=` secret (AUDIT D2).
 *
 * INERT UNTIL CONFIGURED, deliberately -- the same reasoning SRC's
 * isAuthorizedWebhookHop_ applied, and for a sharper reason here: Trello signs
 * over the callback URL, so a WEBHOOK_CALLBACK_URL differing from the
 * registered value by so much as a trailing slash rejects EVERY delivery, and a
 * rejected webhook is unrecoverable (Trello will not re-send on demand). Set
 * TRELLO_API_SECRET and WEBHOOK_CALLBACK_URL together, then confirm real
 * deliveries still land.
 *
 * @param {{get: function(string): (string|undefined), rawBody: (Buffer|undefined)}} req
 * @return {{ok: boolean, reason: (string|undefined), enforced: boolean}}
 */
function verifyTrelloSignature(req) {
  const config = require('../config');
  const secret = config.get('TRELLO_API_SECRET');
  if (!secret) return {ok: true, enforced: false};

  const callbackUrl = config.get('WEBHOOK_CALLBACK_URL');
  if (!callbackUrl) {
    logger.error('TRELLO_API_SECRET is set but WEBHOOK_CALLBACK_URL is not -- signature ' +
      'verification cannot run and is being SKIPPED rather than rejecting every webhook. ' +
      'Set WEBHOOK_CALLBACK_URL to the exact URL registered with Trello.');
    return {ok: true, enforced: false};
  }

  const provided = (req.get && req.get('x-trello-webhook')) || '';
  if (!provided) return {ok: false, reason: 'no x-trello-webhook header', enforced: true};

  // rawBody, not the parsed body: re-serialising JSON does not reproduce the
  // exact bytes Trello signed (key order, whitespace, unicode escaping).
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  const expected = crypto.createHmac('sha1', secret)
      .update(raw + callbackUrl)
      .digest('base64');

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length is compared first; timingSafeEqual throws on a length mismatch. That
  // leak is unavoidable without padding and is not useful to an attacker who
  // cannot yet guess a byte of the secret -- the same trade-off SRC's own
  // timingSafeEqual_ documents.
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? {ok: true, enforced: true}
            : {ok: false, reason: 'signature mismatch', enforced: true};
}

/** SHIPMENTS columns A-J. Mirrors Service_Dates.SHIPMENTS_COL (SCHEMA §3). */
const COL = {
  CARD_ID: 0, DIRECTION: 1, BOARD_SOURCE: 2, ENTITY: 3, TRANSIT_MODE: 4,
  SCHEDULED_DATE: 5, LIST_STATUS: 6, LINE_ITEMS: 7, MASTER_TRACKING: 8,
  ROLLUP_STATUS: 9
};

/**
 * Reproduces Apps Script's `getValues()` row shape on top of the Sheets API.
 * See porting note 4.
 *
 * @param {Array<Array<*>>} rows
 * @param {number} width
 * @return {Array<Array<*>>}
 */
function padRows_(rows, width) {
  return (rows || []).map((row) => {
    const out = (row || []).slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
}

/**
 * Formats a Trello ISO date the way SRC's
 * `Utilities.formatDate(d, ss.getSpreadsheetTimeZone(), "MM/dd/yyyy")` does.
 *
 * The timezone is pinned to America/New_York rather than read from the
 * spreadsheet: Apps Script asks the bound spreadsheet, Cloud Functions has no
 * bound spreadsheet, and the workbook's zone is America/New_York
 * (appsscript.json). Formatting in the container's zone instead -- UTC -- would
 * put every evening due date on the wrong calendar day, which is the same class
 * of bug SRC's own parseTrelloDate() comment documents.
 *
 * @param {string} iso
 * @return {string} "MM/dd/yyyy", or "" when unparseable.
 */
function formatTrelloDate_(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('month')}/${get('day')}/${get('year')}`;
}

/**
 * Durable failure log.
 *
 * SRC's rationale was that Apps Script cannot return a non-200, so Trello never
 * retries and a failed webhook is gone forever -- this tab, holding the raw
 * body, was the only way to replay it. Cloud Functions COULD return 500 and get
 * a retry, but that is deliberately not done (see index.js), so this tab
 * remains the recovery path and is ported as-is.
 *
 * Deliberately defensive: this runs inside a catch block, and a throw here
 * would mask the original error.
 *
 * @param {string} errorText
 * @param {string} rawBody
 * @param {string} cardId
 * @return {Promise<void>}
 */
async function logWebhookError_(errorText, rawBody, cardId) {
  try {
    // Cells cap at 50,000 characters; a Trello payload can exceed that.
    const body = String(rawBody || '').slice(0, 45000);
    await SS_API.batchAppendRows('Webhook_Errors', [[
      new Date().toISOString(),
      String(cardId || ''),
      String(errorText).slice(0, 4000),
      body
    ]]);
  } catch (loggingFailure) {
    // SRC creates the tab on demand via insertSheet(); the Sheets API append
    // cannot, so a missing Webhook_Errors tab lands here. Log the payload
    // inline instead -- losing it entirely is the one outcome this function
    // exists to prevent.
    logger.error('logWebhookError_ could not write to Webhook_Errors -- the ' +
        'original failure and its raw payload are inlined here instead. ' +
        'Create a "Webhook_Errors" tab (Timestamp | Card ID | Error | Raw Payload) ' +
        'to make these replayable.', {
      writeError: loggingFailure.message,
      originalError: String(errorText).slice(0, 4000),
      cardId: String(cardId || ''),
      rawBody: String(rawBody || '').slice(0, 8000)
    });
  }
}

/**
 * Archives one SHIPMENTS row to Shipment_History the instant its Trello card
 * closes.
 *
 * Per the user's confirmed workflow -- mark complete, move to the Delivered
 * list, close the card -- a close IS the normal completion signal, not data
 * loss. Handling it here in real time is what stops the scheduled sync having
 * to discover it the slow way (notice the card missing, then pay for an extra
 * Trello GET just to ask why).
 *
 * Terminal-status logic mirrors resolveVanishedCardStatusesBatch_()'s "closed"
 * branch exactly -- same non-local/drop-ship carve-out, same DELIVERED-vs-
 * RECEIVED split by direction -- minus the lookup, since this payload already
 * IS that lookup.
 *
 * A no-op if the card is not a live SHIPMENTS row (already archived, or never
 * synced) -- not an error, just nothing to do.
 *
 * @param {string} cardId
 * @param {string} direction
 * @param {string} entityNameFromCard
 * @param {string} summaryFromCard
 * @param {Array<Object>} registry
 * @return {Promise<void>}
 */
async function archiveClosedCardNow_(cardId, direction, entityNameFromCard, summaryFromCard, registry) {
  const raw = await SS_API.getSheetValues('SHIPMENTS!A:J');
  if (!raw || raw.length < 2) return;
  const shipData = padRows_(raw.slice(1), 10);

  const rowIdx = shipData.findIndex((row) => String(row[0] || '').trim() === String(cardId).trim());
  if (rowIdx === -1) return;

  const row = shipData[rowIdx];
  // Prefer the SHIPMENTS row's own stored entityName/summary -- what the rest
  // of the pipeline already uses for this exact classification -- over the raw
  // webhook fields, which may be thinner depending on what triggered the event.
  const entityName = String(row[COL.ENTITY] || entityNameFromCard || '').trim();
  const summary = String(row[COL.LINE_ITEMS] || summaryFromCard || '').trim();

  let terminalStatus;
  if (direction !== 'Inbound') {
    terminalStatus = 'DELIVERED';
  } else {
    const isNonLocal = !classifyInboundOrderOriginServer_(entityName, summary, registry).isLocal;
    terminalStatus = isNonLocal ? 'DELIVERED' : 'RECEIVED';
  }

  const histRaw = await SS_API.getSheetValues('Shipment_History!A:K');
  const alreadyArchived = !!histRaw && histRaw.slice(1).some(
      (r) => String((r || [])[1] || '').trim() === String(cardId).trim());

  if (!alreadyArchived) {
    await SS_API.batchAppendRows('Shipment_History', [[
      new Date().toISOString(), row[0], row[1], row[2], row[3], row[4],
      row[5], row[6], row[7], row[8], terminalStatus
    ]]);
  }

  // SS_API.batchDeleteRows takes 1-BASED SHEET ROW NUMBERS (it computes
  // startIndex = rowNum - 1), matching every other caller -- see
  // Service_Write.js:716, which pushes `i + 1` off a header-inclusive index.
  // `rowIdx` here indexes the BODY (raw.slice(1)), so the sheet row is
  // rowIdx + 2: body[0] is sheet row 2. Getting this off by one deletes the
  // row ABOVE the one being archived -- a live shipment silently lost, while
  // the closed card stays put.
  const gid = await SS_API.getSheetId('SHIPMENTS');
  await SS_API.batchDeleteRows(gid, [rowIdx + 2]);

  logger.info('Card ' + cardId + ' closed on Trello -- archived to Shipment_History as ' +
      terminalStatus + ' in real time.');
}

/**
 * Fetches a card's checklists. Inbound cards need them for their line items;
 * any "Check*" action type needs them regardless of direction, because that
 * event IS a checklist change.
 *
 * @param {string} cardId
 * @return {Promise<Array<Object>>} empty on any failure -- a checklist fetch
 *     that fails must not cost the rest of the row update.
 */
async function fetchChecklists_(cardId) {
  const creds = trelloCreds_();
  if (!creds.key || !creds.token) return [];
  try {
    const url = `https://api.trello.com/1/cards/${cardId}/checklists?key=${creds.key}&token=${creds.token}`;
    const res = await trelloFetch_(url, null, {label: 'webhook checklist fetch'});
    if (res.getResponseCode() === 200) return JSON.parse(res.getContentText());
  } catch (e) {
    logger.warn('Webhook Checklist Fetch Error: ' + e.toString());
  }
  return [];
}

/**
 * Runs the readiness/ETA side-effects a comment or due-date event triggers.
 *
 * Split out of processWebhookPayload only so the main flow stays readable; the
 * ordering constraint is unchanged and still critical -- see the class comment
 * and SCHEMA §4F. Inbound only, matching the Readiness & ETA feature's scope
 * everywhere else.
 *
 * Wrapped in its own try/catch so a failure here can never break the row write.
 *
 * @param {Object} action
 * @param {string} cardId
 * @return {Promise<void>}
 */
async function applyReadinessSideEffects_(action, cardId) {
  const Dates = require('./Service_Dates');
  try {
    if (action.type === 'commentCard') {
      const commentText = (action.data && action.data.text) || '';
      // Sailing-schedule comments (the user's real, pre-existing convention:
      // ETD / ETA port (X) / shipping reference numbers) take priority over the
      // portal's own READY/PORT format when a comment matches both -- a real
      // sailing schedule is more authoritative than an estimate.
      // BOTH parsers are async in the port (classifyPortGroup_ reads a sheet),
      // so both MUST be awaited. An un-awaited call returns a Promise, which is
      // always truthy: every comment would look like a sailing schedule, fire
      // applySailingScheduleDeclaration_ with undefined dates, and the
      // READY/PORT branch below -- sitting in the `else` -- would never run at
      // all. SRC's are synchronous, so this hazard exists only in the port.
      const sailing = await Dates.parseSailingScheduleComment_(commentText);
      if (sailing) {
        logger.info('Sailing schedule comment detected on ' + cardId + ': ETD ' +
            sailing.etdDate + ' / ETA port (' + sailing.portRaw + ') ' + sailing.portArrivalDate);
        await Dates.applySailingScheduleDeclaration_(
            cardId, sailing.etdDate, sailing.portArrivalDate, sailing.portRaw, sailing.portGroup);
      } else {
        const parsed = await Dates.parseReadyPortComment_(commentText);
        if (parsed) {
          logger.info('READY/PORT comment detected on ' + cardId + ': ' +
              parsed.readyDate + ' / ' + parsed.portRaw);
          await Dates.applyReadyPortDeclaration_(cardId, parsed.readyDate, parsed.portRaw);
        }
      }
      return;
    }

    if (action.type === 'updateCard' && action.data && action.data.old &&
        Object.prototype.hasOwnProperty.call(action.data.old, 'due')) {
      const config = require('../config');
      const botMemberId = config.get('TRELLO_BOT_MEMBER_ID');
      const actingMemberId = action.idMemberCreator || '';
      let isOwnWrite;
      if (botMemberId) {
        // Identity check available (a dedicated automation account, resolved by
        // identifyTrelloBotAccount) -- authoritative regardless of the value.
        isOwnWrite = actingMemberId === botMemberId;
      } else {
        // No dedicated account yet: TRELLO_KEY/TOKEN are a personal login, so
        // Trello cannot distinguish "the automation" from "you, in Trello".
        // Fall back to comparing the new due date against what this system
        // itself last wrote -- a match is the echo of our own write.
        const newDue = action.data.card && action.data.card.due
          ? formatTrelloDate_(action.data.card.due) : '';
        const lastAutoDue = await Dates.getLastAutoDueForCard_(cardId);
        isOwnWrite = !!newDue && newDue === lastAutoDue;
      }
      if (!isOwnWrite) {
        await Dates.markEtaOverridden_(cardId);
        logger.info('Due date on ' + cardId + ' changed by ' +
            (actingMemberId || 'unknown member') +
            (botMemberId ? ' (bot is ' + botMemberId + ')'
              : ' (no TRELLO_BOT_MEMBER_ID set -- used value comparison)') +
            ' -- marking ETA_OVERRIDDEN, automation will stop pushing estimates ' +
            'until a new READY/PORT declaration arrives.');
      }
    }
  } catch (readinessWebhookError) {
    logger.warn('Readiness/override webhook handling failed for ' + cardId + ': ' +
        readinessWebhookError.message);
  }
}

/**
 * Turns one Trello webhook payload into one SHIPMENTS row.
 *
 * @param {Object} payload the parsed Trello webhook body.
 * @param {Array<Object>} [registry] pre-fetched CUSTOMER_REGISTRY.
 * @return {Promise<{handled: string, cardId?: string}>} what was done, for the
 *     HTTP layer's response text and for the parity harness.
 */
async function processWebhookPayload(payload, registry) {
  const action = payload.action;
  const card = action.data.card;
  const cardId = card.id;

  const cardName = String(card.name || '').trim();
  const listName = action.data.list ? action.data.list.name : 'Unknown List';
  const cardDesc = card.desc || '';

  // Mirror the scheduled sync's list-skip (SCHEMA "Lists That Are SKIPPED") --
  // NEEDED AS OF TODAY / GENERAL LEDGER are staging/reference lists, not real
  // shipments, on every board. Only skip when the webhook actually carries list
  // data: a checklist-only event has no action.data.list and must not be
  // dropped just because we cannot tell what list the card is in.
  if (action.data.list) {
    const listUpperForSkip = String(listName).toUpperCase().trim();
    if (listUpperForSkip.includes('NEEDED AS OF TODAY') ||
        listUpperForSkip.includes('GENERAL LEDGER')) {
      return {handled: 'skipped-list', cardId: cardId};
    }
  }

  // Resolve board identity by ID against the shared matrix, never by the live
  // Trello display name. Two bugs were fixed together here in SRC (2026-08-13):
  // direction used to be inferred by testing whether the board NAME contained
  // "inbound"/"receiving" -- none of the four real board names contain either
  // word, so every webhook-driven update was processed as Outbound, running the
  // wrong line-item parser and the wrong status lifecycle on every inbound card.
  // Writing the canonical name (not the live one) also means a future board
  // rename cannot split one board's rows into two incompatible groups depending
  // on which writer last touched them.
  const boardIdFromPayload = action.data.board ? action.data.board.id : '';
  const resolvedBoard = resolveBoardById_(boardIdFromPayload);
  const liveBoardName = action.data.board ? action.data.board.name : 'Shipping Schedule';
  const boardName = resolvedBoard ? resolvedBoard.name : liveBoardName;
  const direction = resolvedBoard
    ? resolvedBoard.direction
    // Fallback ONLY for a board outside the known matrix. Best-effort guess
    // rather than a hard failure, consistent with this app's fail-open pattern.
    : ((liveBoardName.toLowerCase().includes('inbound') ||
        liveBoardName.toLowerCase().includes('receiving')) ? 'Inbound' : 'Outbound');

  if (registry === undefined) {
    registry = await require('./Service_Read').getCustomerRegistry();
  }
  registry = registry || [];

  // --- Card closed/archived on Trello -------------------------------------
  // Trello sends `closed` in action.data.old the moment a card flips from open
  // to closed. Per the user's workflow that is the normal completion signal, so
  // handle it in real time rather than waiting for the sync to notice.
  if (action.type === 'updateCard' && action.data && action.data.old &&
      Object.prototype.hasOwnProperty.call(action.data.old, 'closed') && card.closed === true) {
    try {
      await archiveClosedCardNow_(cardId, direction, card.name, cardDesc, registry);
    } catch (closeWebhookError) {
      logger.warn('Close-detection webhook handling failed for ' + cardId + ': ' +
          closeWebhookError.message);
    }
    return {handled: 'archived-closed', cardId: cardId};
  }

  // --- ".ignore" / ".unignore" comment trigger -----------------------------
  // Unlike READY/PORT below, this runs for BOTH directions -- hiding a card
  // from the dashboard is a general utility, not part of the inbound-only
  // readiness feature. The comment is only ever a trigger; the durable state is
  // still the "PORTAL: IGNORE" label.
  if (action.type === 'commentCard') {
    try {
      const ignoreAction = parseIgnoreComment_((action.data && action.data.text) || '');
      if (ignoreAction) {
        logger.info(ignoreAction + ' comment detected on ' + cardId);
        const updatedLabels = await applyIgnoreDeclaration_(cardId, ignoreAction);
        // Reflect it in this same pass -- resolveTransitMode and the line-item
        // formatters below both read card.labels -- instead of making the user
        // wait for another webhook/sync round trip to see it take.
        if (updatedLabels) card.labels = updatedLabels;
      }
    } catch (ignoreWebhookError) {
      logger.warn('Ignore-comment webhook handling failed for ' + cardId + ': ' +
          ignoreWebhookError.message);
    }
  }

  // --- READY/PORT declarations + due-date override detection ---------------
  // MUST run before the A-J idempotency check further down: a comment-only or
  // due-date-only webhook produces byte-identical A-J data, so anything placed
  // after that early return would silently never fire for either event type.
  if (direction === 'Inbound') {
    await applyReadinessSideEffects_(action, cardId);
  }

  const storeInfo = extractStoreInfo(cardName);
  // extractStoreInfo's "LETTERS + number" regex is built for outbound retail
  // store cards ("MAR 1670" -> "MAR #1670"). Applied to an inbound PO card name
  // like "CIS PO 3584 - TJXC Sloth Lock Roll Out" it greedily matches "CIS PO"
  // + "3584" and drops everything after the first digit run -- including
  // exactly the non-local destination signal (TJXC, AUS, RTF) the origin
  // classifier scans entityName for. The scheduled sync never had this bug; it
  // writes the raw card name. Match that for Inbound; Outbound keeps the
  // extraction it was written for.
  const entityNameForRow = direction === 'Inbound'
    ? cardName
    : storeInfo.storeName + (storeInfo.storeNum !== 'N/A' ? ' #' + storeInfo.storeNum : '');
  const transitMode = resolveTransitMode(listName, card.labels || []);

  const scheduledDate = card.due ? formatTrelloDate_(card.due) : '';
  const masterTracking = harvestFedExTrackingNumber(cardDesc, '');

  let checklists = [];
  if (direction === 'Inbound' || action.type.includes('Check')) {
    checklists = await fetchChecklists_(cardId);
  }

  const lineItemsStr = direction === 'Inbound'
    ? formatInboundLineItems(checklists, card.labels || []).substring(0, 2000)
    : formatOutboundLineItems(boardName, card.labels || [], cardDesc, registry).substring(0, 2000);

  let isFullyPacked = false;
  let isPartiallyPacked = false;
  if (checklists.length > 0) {
    let totalCheckItems = 0;
    let completeCheckItems = 0;
    checklists.forEach((cl) => {
      if (cl.checkItems && cl.checkItems.length > 0) {
        totalCheckItems += cl.checkItems.length;
        cl.checkItems.forEach((item) => {
          if (item.state === 'complete') completeCheckItems++;
        });
      }
    });
    if (totalCheckItems > 0) {
      if (completeCheckItems === totalCheckItems) isFullyPacked = true;
      else if (completeCheckItems > 0) isPartiallyPacked = true;
    }
  }

  const listUpper = String(listName).toUpperCase();
  const listCls = classifyListStatus(listUpper);
  let initialRollup = direction === 'Inbound' ? 'PENDING' : 'PENDING PACK';
  const isToBeShipped = listCls.isToBeShipped;
  const isCompletedList = listCls.isReceived || listCls.isDone || listCls.isCompleted || listCls.isDelivered;
  const isInTransitList = listCls.isShipped || listCls.isInTransit || listCls.isFreightModeList;

  if (isCompletedList) {
    // A list named "Delivered" is not receiving verification, so inbound only
    // gets RECEIVED when the list itself says Received/Done/Completed, OR when
    // isFullyPacked confirms a fully-received local PO that landed there anyway
    // (this app's inbound boards have no separate "Received" list). Must match
    // the sync path's fallback exactly -- otherwise the same card flips between
    // RECEIVED and DELIVERED depending on which writer last touched it.
    const isReceivedDoneList = listCls.isReceived || listCls.isDone || listCls.isCompleted;
    initialRollup = direction === 'Inbound'
      ? ((isReceivedDoneList || isFullyPacked) ? 'RECEIVED' : 'DELIVERED')
      : 'DELIVERED';
  } else if (isFullyPacked) {
    initialRollup = direction === 'Inbound' ? 'RECEIVED' : 'PACKED';
  } else if (isPartiallyPacked) {
    initialRollup = direction === 'Inbound' ? 'Partially Received' : 'PARTIAL PACK';
  } else if (!isToBeShipped && isInTransitList) {
    initialRollup = direction === 'Inbound' ? 'ON THE WAY' : 'SHIPPED';
  } else if (masterTracking) {
    initialRollup = direction === 'Inbound' ? 'ON THE WAY' : 'IN TRANSIT';
  }

  const rowData = [
    cardId, direction, boardName, entityNameForRow, transitMode,
    scheduledDate, listUpper, lineItemsStr, masterTracking, initialRollup
  ];

  const raw = await SS_API.getSheetValues('SHIPMENTS!A:J');
  const data = padRows_(raw || [], 10);
  let foundIdx = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === cardId) {
      foundIdx = i;
      break;
    }
  }

  if (foundIdx > -1) {
    const currentRollup = String(data[foundIdx][COL.ROLLUP_STATUS] || '').toUpperCase();
    const isPendingLike = currentRollup === 'PENDING' || currentRollup === 'STAGED / PACKING';
    if (currentRollup && !isPendingLike) {
      // Rank-based, not list-based. A checkItem-state webhook carries no `list`
      // data, so gating on this event's list classification (the old check)
      // meant a checklist reaching 100% -- which already sets RECEIVED/PACKED
      // above via isFullyPacked, independent of list -- got reverted to the
      // stale status just because this event did not also prove the list moved.
      // Only revert when the fresh computation is an actual regression.
      if (getRollupRank_(direction, rowData[COL.ROLLUP_STATUS]) <
          getRollupRank_(direction, currentRollup)) {
        rowData[COL.ROLLUP_STATUS] = currentRollup;
      }
    }

    // Idempotency check -- skip the write entirely when nothing changed. This
    // is what stops every duplicate delivery costing a write and a cache warm.
    const oldRow = data[foundIdx];
    let isDifferent = false;
    for (let j = 0; j < 10; j++) {
      const oldVal = oldRow[j] != null ? String(oldRow[j]).trim() : '';
      const newVal = rowData[j] != null ? String(rowData[j]).trim() : '';
      if (oldVal !== newVal) {
        isDifferent = true;
        break;
      }
    }

    if (!isDifferent) return {handled: 'unchanged', cardId: cardId};

    await SS_API.batchUpdateValues([{
      range: `SHIPMENTS!A${foundIdx + 1}:J${foundIdx + 1}`,
      values: [rowData]
    }]);
  } else {
    // Only append if it is not a completed card (avoids zombie rows).
    // Deliberately excludes DELIVERED, unlike isCompletedList above -- a
    // newly-DELIVERED inbound card still needs appending so it can go through
    // receiving verification. SCHEMA invariant #10.
    const isCompletedListForAppendSkip = listCls.isReceived || listCls.isDone || listCls.isCompleted;
    if (isCompletedListForAppendSkip) return {handled: 'skipped-completed', cardId: cardId};
    await SS_API.batchAppendRows('SHIPMENTS', [rowData]);
  }

  // Warm the cache so the dashboard reflects this update immediately.
  try {
    await require('./Service_Read').warmLogisticsDashboardCache();
  } catch (warmErr) {
    logger.warn('processWebhookPayload: cache warm failed -- ' + warmErr.message);
  }

  return {handled: foundIdx > -1 ? 'updated' : 'appended', cardId: cardId};
}

module.exports = {
  verifyTrelloSignature,
  processWebhookPayload,
  archiveClosedCardNow_,
  logWebhookError_,
  formatTrelloDate_,
  padRows_,
  COL
};
