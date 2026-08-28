const logger = require('firebase-functions/logger');
const config = require('../config');

/**
 * ============================================================================
 * SHARED TRELLO LIST / LABEL CLASSIFIERS
 * ============================================================================
 * Ported from SRC/src/Shared_Classifiers.js.
 *
 * Centralizes the substring-matching keyword logic that was previously
 * duplicated independently across resolveTransitMode(), the main loop in
 * syncAllBoardsToShipmentsTab(), archiveCompletedShipments(),
 * evaluateRollupStatuses(), receivePOCardItems(), and processWebhookPayload()
 * (in Webhook_Receiver.js -- the live doPost target).
 *
 * A future Trello list rename (e.g. "DELIVERED" -> "Delivered") now only needs
 * a fix here instead of a multi-file hunt with no shared error surface.
 *
 * IMPORTANT: classifyListStatus() intentionally returns only atomic flags
 * (isReceived, isDelivered, isDone, isCompleted, ...) rather than a single
 * bundled "isCompletedList" boolean. Different call sites compose these flags
 * differently on purpose -- e.g. Webhook_Receiver.js's initial-rollup check
 * includes DELIVERED, but its append-skip check for existing completed cards
 * deliberately does NOT (a newly-DELIVERED inbound card still needs to be
 * appended so it can go through receiving verification -- see SCHEMA.md
 * invariant #10, "DELIVERED != RECEIVED for local warehouse inbound").
 * Bundling those into one flag would have silently changed that behavior.
 *
 * ----------------------------------------------------------------------------
 * PORTING NOTES -- what necessarily changed, and what deliberately did not
 * ----------------------------------------------------------------------------
 *
 * 1. `trelloFetch_` is ASYNC here. Node's fetch is promise-based; Apps Script's
 *    UrlFetchApp is blocking. The returned object keeps the getResponseCode() /
 *    getContentText() shims from the original for exactly the reason the
 *    original grew them -- so a call site is a mechanical rename and cannot
 *    silently change what its branches decide. Callers must `await`.
 *
 * 2. `Utilities.sleep` -> an awaited timer. Same backoff arithmetic.
 *
 * 3. The name-matching helpers (canonicalNameKey_, productIdentityKey_,
 *    namesMatch_) are still SYNCHRONOUS, which matters: they run in tight
 *    per-row loops and making them async would turn every caller into a
 *    serialised await chain. The one thing they need that is now async -- the
 *    PRODUCT sheet index behind productIdentityKey_ -- is loaded separately by
 *    `primeQbNameIndex()` and read from cache. See getQbNameIndex_ below.
 *
 * 4. `getBoardMatrix_` reads board IDs through functions/config.js rather than
 *    PropertiesService, with the same defaults.
 * ============================================================================
 */

/**
 * The single source of truth for which 4 Trello boards this app reads, their
 * canonical (not necessarily current-Trello-display) name, and their
 * direction.
 *
 * Previously this array was defined inline inside syncAllBoardsToShipmentsTab(),
 * and Webhook_Receiver.js independently read the LIVE board name straight off
 * the incoming webhook payload (`action.data.board.name`) instead of resolving
 * it against this matrix.
 *
 * That meant the two writers could disagree about which name to write into
 * SHIPMENTS column C for the exact same board -- the sync always wrote the name
 * below, the webhook wrote whatever the board happened to be named in Trello at
 * that moment. Everything downstream keys off that string exactly (chain
 * classification, formatOutboundLineItems()'s per-board parsing rules,
 * getChainFromRecord()'s Burlington fallback) -- an unsynchronized rename would
 * split one board's rows into two incompatible groups depending on which writer
 * last touched each row.
 *
 * Resolve board identity by ID (stable) via resolveBoardById_() below, not by
 * matching Trello's live display name, and the display name becomes free to
 * change without touching any of this.
 *
 * @return {Array<{name: string, id: string, direction: string}>}
 */
function getBoardMatrix_() {
  return [
    {name: 'Purchase Orders', id: config.get('INBOUND_PO_BOARD_ID'), direction: 'Inbound'},
    {name: 'Nicole POs', id: config.get('INBOUND_NICOLE_BOARD_ID'), direction: 'Inbound'},
    {name: 'Burlington Shipping Schedule', id: config.get('BURLINGTON_OUTBOUND_BOARD_ID'), direction: 'Outbound'},
    {name: 'Shipping Schedule', id: config.get('OUTBOUND_BOARD_ID'), direction: 'Outbound'}
  ];
}

/**
 * Resolves a Trello board ID (stable across renames) to its canonical entry in
 * getBoardMatrix_(), or null if the ID isn't one of the 4 known boards (e.g. a
 * new board that has a webhook registered via setupWebhooksForAllBoards() --
 * which registers ALL org boards, not just these 4 -- but isn't part of the
 * sync/parsing pipeline yet).
 *
 * @param {string} boardId
 * @return {{name: string, id: string, direction: string}|null}
 */
function resolveBoardById_(boardId) {
  const id = String(boardId || '').trim();
  if (!id) return null;
  const matrix = getBoardMatrix_();
  for (let i = 0; i < matrix.length; i++) {
    if (matrix[i].id === id) return matrix[i];
  }
  return null;
}

/**
 * Classifies a Trello list name into the individual status keywords used across
 * the sync/webhook/archival/receiving pipeline. Each caller composes the exact
 * combination of flags it needs -- this function does not decide business logic
 * on its own, it only centralizes the keyword matching.
 *
 * @param {string} listName
 * @return {Object} atomic status flags plus the uppercased source text.
 */
function classifyListStatus(listName) {
  const upper = String(listName || '').toUpperCase();
  return {
    upper: upper,
    isToBeShipped: upper.includes('TO BE SHIPPED') || upper.includes('TO BE'),
    isReceived: upper.includes('RECEIVED'),
    isDelivered: upper.includes('DELIVERED'),
    isShipped: upper.includes('SHIPPED'),
    isDone: upper.includes('DONE'),
    isCompleted: upper.includes('COMPLETED') || upper.includes('COMPLETE'),
    isInTransit: upper.includes('IN TRANSIT'),
    isArchivedDeleted: upper === 'ARCHIVED/DELETED',
    // Matches the exact keyword set previously duplicated identically in both
    // syncAllBoardsToShipmentsTab.js's main loop and Webhook_Receiver.js's
    // processWebhookPayload() for their isInTransitList checks. Deliberately
    // NOT the same as resolveTransitModeFromText_ below -- that one also
    // matches bare "OCEAN"/"AIR"/"SEA" and "GROUND", which neither of the
    // original isInTransitList checks did. Keeping this separate preserves
    // exact existing behavior instead of silently broadening it.
    isFreightModeList: upper.includes('OCEAN FREIGHT') || upper.includes('AIR FREIGHT') ||
                       upper.includes('FEDEX') || upper.includes('UPS') || upper.includes('TRUCK')
  };
}

/**
 * Server-side mirror of isFullyReceivedFromLineItems_() (JS_Handlers.html).
 * This app's Trello boards have no "Received"/"Complete" list -- the terminal
 * list is named "Delivered" -- so a fully-received local warehouse PO's
 * rollupStatus/listStatus text can get stuck on "DELIVERED" forever (see
 * SCHEMA.md's "DELIVERED != RECEIVED for local warehouse inbound" invariant).
 * Parses the same "Desc | QTY: X | RCVD: Y" checklist text
 * archiveCompletedShipments() already has in `summary` (SHIPMENTS column H) to
 * recognize that case as terminal, independent of whatever status text is on
 * the row.
 *
 * @param {string} summary SHIPMENTS column H text.
 * @return {boolean}
 */
function isFullyReceivedFromSummaryServer_(summary) {
  const text = String(summary || '').trim();
  if (!text) return false;
  const lineItemRegex = /([^\n|]+?)\s*\|\s*QTY:\s*(\d+)(?:\s*\|\s*RCVD:\s*(\d+))?/gi;
  let match;
  let hasItems = false;
  while ((match = lineItemRegex.exec(text)) !== null) {
    hasItems = true;
    if (parseInt(match[2], 10) !== 0) return false;
  }
  return hasItems;
}

/**
 * Ranks a rollup status by how far along the inbound/outbound lifecycle it
 * represents, so callers can tell an advance from a regression instead of just
 * "different from before". Used by processWebhookPayload() (Webhook_Receiver.js)
 * to decide whether a freshly-computed status is trustworthy enough to overwrite
 * what's already in SHIPMENTS.
 *
 * Necessary because a single Trello event doesn't always carry full context --
 * e.g. a checkItem-state webhook has no `list` data, so a naive "does this
 * event's list look shipped/delivered?" gate can't tell a real regression (stale
 * checklist reread after the row was already advanced) apart from a legitimate
 * advance whose triggering event just didn't happen to include list info
 * (checklist reaching 100% complete IS itself full information -- it doesn't
 * need the list to confirm it).
 *
 * @param {string} direction "Inbound" or "Outbound".
 * @param {string} status rollup status text.
 * @return {number} lifecycle rank; higher is further along.
 */
function getRollupRank_(direction, status) {
  const s = String(status || '').toUpperCase();
  if (direction === 'Inbound') {
    // PARTIAL must be checked before RECEIVED/DELIVERED -- "PARTIALLY RECEIVED"
    // and "PARTIALLY DELIVERED" (evaluateRollupStatuses.js) both contain one of
    // those words as a substring, so checking them first would misrank an
    // in-progress partial shipment as fully terminal.
    if (s.includes('PARTIAL')) return 2;
    if (s.includes('RECEIVED') || s.includes('DONE') || s.includes('COMPLETE') ||
        s.includes('CLOSED') || s.includes('DELIVERED')) return 3;
    if (s.includes('ON THE WAY') || s.includes('TRANSIT')) return 1;
    return 0; // PENDING or unrecognized
  }
  // "RECEIVED" must be here too, not just Inbound's tier check above -- the
  // Rollup Engine's own "Delivered in Full" (evaluateRollupStatuses.js) is an
  // Outbound-eligible value and was previously falling through to the default
  // rank 0, making it rank BELOW "SHIPPED"/"IN TRANSIT". That let
  // syncAllBoardsToShipmentsTab.js's Trello-list-derived recompute silently
  // stomp a FedEx-confirmed "Delivered in Full" back down to "SHIPPED" on the
  // very next sync cycle -- see the guard in that file's updateShipmentRows
  // loop, which depends on this rank being correct to do anything at all.
  // Same PARTIAL-first ordering as the Inbound branch, same reason.
  if (s.includes('PARTIAL')) return 1;
  if (s.includes('DELIVERED') || s.includes('RECEIVED') || s.includes('DONE') ||
      s.includes('COMPLETE') || s.includes('CLOSED')) return 4;
  if (s.includes('SHIPPED') || s.includes('TRANSIT')) return 3;
  if (s === 'PACKED') return 2;
  return 0; // PENDING PACK, STAGED / PACKING, or unrecognized
}

/**
 * Resolves a freight/transit mode hint from a piece of text (a list name, or
 * card labels joined into one string). Returns null if nothing matches, so
 * callers can fall through to their own default (e.g. "Standard / Ground") or
 * try a second piece of text (e.g. list name first, then labels).
 *
 * @param {string} text
 * @return {string|null}
 */
function resolveTransitModeFromText_(text) {
  const upper = String(text || '').toUpperCase();
  if (upper.includes('OCEAN') || upper.includes('SEA')) return 'Ocean Freight';
  if (upper.includes('AIR')) return 'Air Freight';
  if (upper.includes('FEDEX') || upper.includes('UPS') || upper.includes('TRUCK')) {
    return 'FedEx, UPS, & Truck Lines';
  }
  if (upper.includes('GROUND')) return 'Ground Freight';
  return null;
}

/**
 * Returns true if the given label/text matches any brand's Regex_Aliases in a
 * CUSTOMER_REGISTRY export (see getCustomerRegistry() in Service_Read.js).
 *
 * Fails safe by design: a missing/empty registry returns false for everything
 * (caller's existing logic is unaffected). A malformed regex in any single
 * registry row is caught and skipped -- it never throws, and never prevents
 * other rows from being checked. This mirrors the exact pattern already used
 * client-side in JS_Handlers.html's getChainFromRecord().
 *
 * @param {string} text
 * @param {Array<Object>} registry
 * @return {boolean}
 */
function isKnownBrandLabel_(text, registry) {
  if (!text || !registry || registry.length === 0) return false;
  const upperText = String(text).toUpperCase();
  for (let i = 0; i < registry.length; i++) {
    const aliasPattern = registry[i] ? registry[i].Regex_Aliases : '';
    if (!aliasPattern) continue;
    try {
      const rgx = new RegExp(aliasPattern, 'i');
      if (rgx.test(upperText)) return true;
    } catch (e) {
      // Malformed regex in this one row -- skip it, don't let it block checking
      // the rest of the registry.
      continue;
    }
  }
  return false;
}

/**
 * Server-side mirror of classifyInboundOrderOrigin_() (JS_Render_UI.html) --
 * same two-layer local/non-local decision (CUSTOMER_REGISTRY Warehouse_Type
 * first, then the AUS/TJX-CANADA/RTF/TJXC keyword fallback) -- used by
 * archiveCompletedShipments() and resolveVanishedCardStatus_()
 * (syncAllBoardsToShipmentsTab.js) so a non-local inbound order's terminal
 * status is treated as DELIVERED the same way the dashboard already does
 * (isItemCompleted(), JS_Handlers.html), instead of every inbound order being
 * archived/closed out as RECEIVED regardless of whether it ever physically
 * touches the warehouse floor.
 *
 * Kept in lockstep with classifyInboundOrderOrigin_()'s rules by design -- if
 * one changes, the other should too.
 *
 * @param {string} entityName
 * @param {string} summary
 * @param {Array<Object>} registry
 * @return {{isLocal: boolean, reason: string|null}}
 */
function classifyInboundOrderOriginServer_(entityName, summary, registry) {
  const combined = (String(entityName || '') + ' ' + String(summary || '')).toUpperCase();

  // SRC also tracks a `registryLocalMatch` flag here. It is assigned and never
  // read -- dead in the original -- so it is omitted rather than carried across
  // as cargo. Behaviour is identical; noted so a future diff against SRC does
  // not read the absence as a porting slip.
  if (registry && registry.length > 0) {
    for (let i = 0; i < registry.length; i++) {
      const brand = registry[i];
      if (!brand || !brand.Regex_Aliases) continue;
      const boardIds = String(brand.Target_Board_ID || '').toUpperCase();
      if (!boardIds.includes('INBOUND_PO_BOARD_ID')) continue;
      try {
        const rgx = new RegExp(brand.Regex_Aliases, 'i');
        if (rgx.test(combined)) {
          const wt = String(brand.Warehouse_Type || '').trim();
          if (wt && wt !== 'Local Warehouse') return {isLocal: false, reason: wt};
        }
      } catch (e) { /* malformed alias -- skip, same as getChainFromRecord() */ }
    }
  }

  const keywordMatch = combined.match(/\b(AUSTRALIA|AUS|TJX CANADA|TJXC|RTF GLOBAL|RTF|TJX AU|TJX TK|TJX UK)\b/i);
  if (keywordMatch) return {isLocal: false, reason: keywordMatch[1].toUpperCase()};

  return {isLocal: true, reason: null};
}

/**
 * Per-card ".ignore" feature. A card carrying a Trello label named
 * "PORTAL: IGNORE" (case-insensitive, space around the colon optional) should
 * disappear from the dashboard entirely without being archived, deleted, or
 * otherwise touched in Trello or SHIPMENTS -- un-ignore is just removing the
 * label.
 *
 * The label is the only thing anything actually checks (isCardIgnored_ below)
 * -- cheap, no extra API calls on a normal sync/webhook pass. Attaching it by
 * hand in Trello's UI turned out to be too heavyweight for what's meant to be a
 * quick toggle, so a plain ".ignore" / ".unignore" Trello comment (see
 * parseIgnoreComment_() / applyIgnoreDeclaration_() below) drives the same
 * label on/off in real time -- the comment is a trigger, not a second storage
 * mechanism, same pattern as the READY/PORT comment feature in SCHEMA 4F.
 *
 * Deliberately NOT implemented as a sync-time skip (never writing/deleting the
 * SHIPMENTS row): pruneDeletedShipmentCards_()'s existing row-delete path only
 * rewrites columns A-J, which would desync every row below it from its own K-R
 * readiness/ETA data if reused here. Instead, formatInboundLineItems() /
 * formatOutboundLineItems() stamp PORTAL_IGNORED_MARKER into the summary column
 * and buildLogisticsDashboardPayload_() (Service_Read.js) filters any row
 * carrying it out of the payload before it ever reaches the client -- same
 * shape as that function's existing "Archived/Deleted" filter. The SHIPMENTS
 * row itself, and everything on it, is untouched either way.
 */
const PORTAL_IGNORED_MARKER = '[PORTAL_IGNORED]';

/**
 * @param {Array<{name: string}>} labels
 * @return {boolean}
 */
function isCardIgnored_(labels) {
  if (!labels || labels.length === 0) return false;
  return labels.some(function(l) {
    const name = String((l && l.name) || '').trim().toUpperCase().replace(/\s*:\s*/, ': ');
    return name === 'PORTAL: IGNORE';
  });
}

/**
 * Builds the SHIPMENTS summary column for an inbound card.
 *
 * Lives here rather than in a caller because both of its callers need it:
 * Webhook_Receiver.js (real-time card touch) and syncAllBoardsToShipmentsTab.js
 * (scheduled full pull). Until 2026-08-24 it was defined *twice*, byte-for-byte
 * identically, once in each of those files -- and since Apps Script has a single
 * server global namespace, whichever loaded last silently won for both callers,
 * so an edit to the other copy did nothing at all. See AUDIT_2026-08-24.md C1.
 *
 * @param {Array<Object>} checklists
 * @param {Array<{name: string}>} labels
 * @return {string}
 */
function formatInboundLineItems(checklists, labels) {
  const lines = [];
  (checklists || []).forEach((cl) => {
    if (cl.checkItems && cl.checkItems.length > 0) {
      cl.checkItems.forEach((item) => {
        lines.push(` • ${item.name}`);
      });
    }
  });
  const body = lines.length > 0 ? lines.join('\n') : 'No specific shipping line items listed.';

  // Origin-signal labels (TJX CANADA, RTF GLOBAL, AUS/CREDO, Timing lot, ...)
  // never come through checklists -- append them so classifyInboundOrderOrigin_
  // (JS_Render_UI.html) can see the vocabulary its keyword list was written for,
  // even when a card ships with an empty checklist. The ignore label itself is
  // excluded -- it's a portal-only signal, not shipment content.
  const labelNames = (labels || [])
      .map((l) => String(l.name || '').trim())
      .filter((name) => name && name.toUpperCase() !== 'PORTAL: IGNORE');
  let result = labelNames.length > 0 ? body + '\n[LABELS] ' + labelNames.join(', ') : body;

  // See isCardIgnored_() above for why this is a summary marker rather than a
  // sync-time skip or a new column.
  if (isCardIgnored_(labels)) result = PORTAL_IGNORED_MARKER + '\n' + result;
  return result;
}

/**
 * Comment-driven trigger for the ".ignore" feature above. This does NOT replace
 * the label as the storage mechanism -- isCardIgnored_() and everything
 * downstream of it still only ever looks at the label, so every sync/webhook
 * check stays a cheap in-memory check with no extra API calls. A recognized
 * comment just becomes a trigger that adds/removes the label on the user's
 * behalf, the same way postReadyPortComment_()'s READY/PORT format is a
 * comment-driven trigger for columns K/L/P.
 *
 * Recognizes a comment consisting of (optionally surrounded by whitespace)
 * ".ignore" or ".unignore" case-insensitively, on its own line -- deliberately
 * strict (not "contains the word ignore anywhere") so an unrelated comment
 * mentioning "ignore" in passing can't misfire.
 *
 * @param {string} commentText
 * @return {string|null} "IGNORE", "UNIGNORE", or null.
 */
function parseIgnoreComment_(commentText) {
  const text = String(commentText || '').trim();
  if (/^\.unignore$/i.test(text)) return 'UNIGNORE';
  if (/^\.ignore$/i.test(text)) return 'IGNORE';
  return null;
}

/**
 * Catch-up pass for the `.ignore` / `.unignore` comment trigger.
 *
 * WHY THIS EXISTS (SCHEMA §12, confirmed live 2026-08-17): a card had a clean
 * `.ignore` comment posted the same day the feature shipped, which never took
 * effect -- the card kept showing on the dashboard indefinitely with no error
 * anywhere. Unlike the READY/PORT feature, which has
 * `backfillReadyPortFromComments_()` wired into every sync specifically to
 * catch whatever its real-time webhook missed, the `.ignore` trigger shipped
 * with NO catch-up path: if the commentCard webhook ever missed a declaration
 * (posted before that day's deploy landed, a dropped delivery, the 3-second
 * debounce lock in doPost colliding on the same card, a mid-request error), it
 * was lost permanently with no recovery except noticing and re-posting the
 * comment by hand. This closes that gap the same way READY/PORT closes it.
 *
 * MANUALLY RUN, not wired into the periodic sync -- checking comments costs one
 * extra Trello API call per card, and `.ignore` is a rare deliberate action, not
 * worth paying that on every cycle for every row. Safe to re-run: a card already
 * in the correct state is a cheap no-op.
 *
 * This was blocked through Phase 2 and Phase 3 waiting on `fetchCardComments_`
 * and `SHIPMENTS_COL` from Service_Dates, both of which landed in Phase 4
 * Unit B. The require is INSIDE the function, not at the top of the file: this
 * module sits at the bottom of the dependency graph and Service_Dates requires
 * it, so a top-level import would be a cycle. Same idiom as Service_Write's
 * readLiveChecklistState_.
 *
 * Parity with SRC/src/Shared_Classifiers.js:466-517.
 *
 * @return {Promise<{success: boolean, checked?: number, fixed?: number, error?: string}>}
 */
async function backfillIgnoreCommentsFromComments_() {
  const SS_API = require('./Service_SheetsAPI');
  const {fetchCardComments_, SHIPMENTS_COL} = require('./Service_Dates');

  try {
    const data = await SS_API.getSheetValues('SHIPMENTS!A:J');
    if (!data) return {success: false, error: 'SHIPMENTS sheet not found.'};
    if (data.length < 2) return {success: true, checked: 0, fixed: 0};

    let checked = 0;
    let fixed = 0;
    const updates = [];

    for (let i = 1; i < data.length; i++) {
      const cardId = String(data[i][SHIPMENTS_COL.CARD_ID] || '').trim();
      if (!cardId) continue;
      checked++;

      const comments = await fetchCardComments_(cardId);
      let latestAction = null;
      for (let j = 0; j < comments.length; j++) { // newest first -- first match wins
        const parsed = parseIgnoreComment_(comments[j].text);
        if (parsed) { latestAction = parsed; break; }
      }
      if (!latestAction) continue;

      const currentSummary = String(data[i][SHIPMENTS_COL.LINE_ITEMS] || '');
      const currentlyMarkedIgnored = currentSummary.indexOf(PORTAL_IGNORED_MARKER) === 0;
      const shouldBeIgnored = (latestAction === 'IGNORE');
      if (currentlyMarkedIgnored === shouldBeIgnored) continue; // already consistent

      const updatedLabels = await applyIgnoreDeclaration_(cardId, latestAction);
      if (!updatedLabels) continue; // Trello write failed -- logged inside applyIgnoreDeclaration_

      // Rewrites the summary's marker prefix directly rather than re-deriving
      // the whole summary via formatInboundLineItems(): a full re-derivation
      // isn't needed just to toggle one marker, and doing it here means the fix
      // is visible on the very next dashboard poll rather than waiting for
      // another full sync.
      const strippedSummary = currentlyMarkedIgnored ?
        currentSummary.slice(PORTAL_IGNORED_MARKER.length).replace(/^\n/, '') :
        currentSummary;
      const newSummary = shouldBeIgnored ?
        (PORTAL_IGNORED_MARKER + '\n' + strippedSummary) :
        strippedSummary;

      updates.push({range: 'SHIPMENTS!H' + (i + 1), values: [[newSummary]]});
      data[i][SHIPMENTS_COL.LINE_ITEMS] = newSummary;

      fixed++;
      logger.info('backfillIgnoreCommentsFromComments_: ' + latestAction + ' applied for ' +
          cardId + ' (comment predates or was missed by the real-time webhook).');
    }

    if (updates.length > 0) await SS_API.batchUpdateValues(updates);
    logger.info('backfillIgnoreCommentsFromComments_: checked ' + checked +
        ' card(s), fixed ' + fixed + '.');
    return {success: true, checked: checked, fixed: fixed};
  } catch (e) {
    logger.error('backfillIgnoreCommentsFromComments_ failed', {error: e.message});
    return {success: false, error: e.toString()};
  }
}

/**
 * Trello API key/token.
 *
 * SRC keeps this in Service_Dates.js:1259 and reaches it through Apps Script's
 * single global namespace. In Node that would make Shared_Classifiers depend on
 * Service_Dates, which depends back on this file -- so the accessor lives here,
 * at the bottom of the dependency graph, and Service_Dates/Service_Read/
 * Service_Write import it from here instead of each reading config directly.
 *
 * @return {{key: string|undefined, token: string|undefined}}
 */
function trelloCreds_() {
  return {key: config.get('TRELLO_KEY'), token: config.get('TRELLO_TOKEN')};
}

/**
 * Applies a parseIgnoreComment_() result by adding/removing the actual
 * "PORTAL: IGNORE" label on the card -- the comment is only ever a trigger,
 * this is what actually changes the durable state isCardIgnored_() checks.
 *
 * Fetches the card's current labels live (GET) rather than trusting whatever
 * the triggering webhook payload happened to include, for two reasons: (1) a
 * commentCard action isn't guaranteed to carry a populated card.labels array
 * the way an updateCard-on-labels action would, and (2) it's what lets IGNORE
 * be idempotent (skip creating a second "PORTAL: IGNORE" label on the board if
 * one's already attached) and lets UNIGNORE find the exact label id to remove
 * without guessing. This is one extra API call, but only on a comment that
 * actually matched the trigger pattern -- not on every webhook.
 *
 * @param {string} cardId
 * @param {string} action "IGNORE" or "UNIGNORE".
 * @return {Promise<Array<Object>|null>} resulting labels, or null on failure.
 */
async function applyIgnoreDeclaration_(cardId, action) {
  const creds = trelloCreds_();
  if (!creds || !creds.key || !creds.token || !cardId) return null;

  try {
    const auth = 'key=' + creds.key + '&token=' + creds.token;
    const getRes = await trelloFetch_(
        'https://api.trello.com/1/cards/' + cardId + '/labels?' + auth,
        null, {label: 'read labels'});
    if (!getRes.ok) {
      logger.warn('applyIgnoreDeclaration_: failed to read current labels for ' + cardId +
                  ' -- ' + getRes.getContentText());
      return null;
    }
    const currentLabels = JSON.parse(getRes.text);
    const existing = currentLabels.find(function(l) {
      return String(l.name || '').trim().toUpperCase().replace(/\s*:\s*/, ': ') === 'PORTAL: IGNORE';
    });

    if (action === 'IGNORE') {
      if (existing) return currentLabels; // already ignored, nothing to do
      const addRes = await trelloFetch_(
          'https://api.trello.com/1/cards/' + cardId + '/labels?name=' +
          encodeURIComponent('PORTAL: IGNORE') + '&color=black&' + auth,
          {method: 'post'}, {label: 'add ignore label'});
      if (!addRes.ok) {
        logger.warn('applyIgnoreDeclaration_: failed to add ignore label to ' + cardId +
                    ' -- ' + addRes.getContentText());
        return null;
      }
      currentLabels.push(JSON.parse(addRes.text));
      return currentLabels;
    }

    if (action === 'UNIGNORE') {
      if (!existing) return currentLabels; // already not ignored
      const delRes = await trelloFetch_(
          'https://api.trello.com/1/cards/' + cardId + '/idLabels/' + existing.id + '?' + auth,
          {method: 'delete'}, {label: 'remove ignore label'});
      if (!delRes.ok) {
        logger.warn('applyIgnoreDeclaration_: failed to remove ignore label from ' + cardId +
                    ' -- ' + delRes.getContentText());
        return null;
      }
      return currentLabels.filter(function(l) {
        return l.id !== existing.id;
      });
    }

    return currentLabels;
  } catch (e) {
    logger.error('applyIgnoreDeclaration_ error for ' + cardId, {error: e.message});
    return null;
  }
}

/**
 * ============================================================================
 * PRODUCT ID / DESCRIPTION SPLITTING
 * ============================================================================
 * injectPOChecklist() (Service_Read.js) writes checklist items as
 * "[ProductID] Description | QTY: X | RCVD: Y" when a real Product ID was
 * selected from the PRODUCT sheet's autocomplete (getSkuCatalog()). Items typed
 * manually (not via the injector) may have no bracket at all, or a generic
 * "[ITEM]" placeholder -- both mean "no real productId".
 *
 * Before 2026-08-11 this bracketed text was written verbatim into Inventory's
 * product-name column, producing entries like
 * "[CIS 019 (SS Ink Pin 19mm)] INK PIN" on every inventory/Limbo view. These
 * helpers split the identifier (for canonical PRODUCT-sheet matching) from the
 * display text (for what staff actually see).
 * ============================================================================
 */

/**
 * PRODUCT sheet index: canonical name key -> the sheet's own column-A Product
 * ID text. Both the Product ID and the nickname are indexed, so any of a
 * product's names collapses to one identity.
 *
 * SRC keeps this in Service_Conversions.js (getQbNameIndex_) and reads the sheet
 * synchronously. Node cannot: the Sheets read is async, while namesMatch_ and
 * productIdentityKey_ run in tight per-row loops and must stay synchronous or
 * every caller becomes a serialised await chain.
 *
 * So the load is split. `primeQbNameIndex()` is async and fills this cache;
 * `getQbNameIndex_()` is synchronous and reads it. An unprimed cache degrades
 * exactly the way SRC's own try/catch does -- productIdentityKey_ falls back to
 * the plain canonical key -- rather than throwing, but it warns once so the
 * missing prime is findable instead of silently weakening every comparison.
 * @type {Object<string, string>|null}
 */
let PRODUCT_QB_NAME_CACHE_ = null;
let qbIndexWarned_ = false;

/**
 * Loads the PRODUCT sheet into the identity index. Call once per request,
 * before any namesMatch_ / productIdentityKey_ work.
 *
 * @param {boolean} [force] reload even when the cache is warm.
 * @return {Promise<Object<string, string>>}
 */
async function primeQbNameIndex(force) {
  if (PRODUCT_QB_NAME_CACHE_ && !force) return PRODUCT_QB_NAME_CACHE_;
  const SS_API = require('./Service_SheetsAPI');
  const index = {};
  try {
    const data = await SS_API.getSheetValues('PRODUCT!A:B');
    for (let i = 1; i < (data || []).length; i++) {
      const pid = String(data[i][0] || '').trim();
      if (!pid) continue;
      const nick = String(data[i][1] || '').trim();
      index[canonicalNameKey_(pid)] = pid;
      if (nick) index[canonicalNameKey_(nick)] = pid;
    }
  } catch (e) {
    logger.warn('primeQbNameIndex failed', {error: e.message});
  }
  PRODUCT_QB_NAME_CACHE_ = index;
  qbIndexWarned_ = false;
  return PRODUCT_QB_NAME_CACHE_;
}

/**
 * @return {Object<string, string>|null} the primed index, or null.
 */
function getQbNameIndex_() {
  if (!PRODUCT_QB_NAME_CACHE_ && !qbIndexWarned_) {
    qbIndexWarned_ = true;
    logger.warn('getQbNameIndex_: PRODUCT index not primed -- product identity matching is ' +
                'degraded to plain name comparison. Call primeQbNameIndex() first.');
  }
  return PRODUCT_QB_NAME_CACHE_;
}

/** Drops the PRODUCT index cache. For tests and post-write refreshes. */
function clearQbNameIndex() {
  PRODUCT_QB_NAME_CACHE_ = null;
  qbIndexWarned_ = false;
}

/**
 * Canonical comparison key for a product name, and an exact-with-truncation
 * matcher built on it. Server-side twin of canonicalNameKey/namesMatch in
 * JS_State.html -- duplicated rather than shared because the browser and the
 * backend are separate JS namespaces. KEEP THE TWO IN SYNC.
 *
 * Product names reach this app in three shapes: the PRODUCT sheet's full QB
 * name, its short nickname, and the injector's bracketed
 * "[CIS 019 (SS Ink Pin 19mm)] INK PIN" form. canonicalNameKey_ folds the third
 * down to its Product ID and normalises case and whitespace.
 *
 * @param {*} s
 * @return {string}
 */
function canonicalNameKey_(s) {
  const text = String(s === null || s === undefined ? '' : s).trim();
  const m = text.match(/^\[(.*?)\]\s*(.*)$/);
  if (m) {
    const bracket = m[1].trim();
    const picked = (!bracket || bracket.toUpperCase() === 'ITEM') ? (m[2].trim() || text) : bracket;
    return picked.replace(/\s+/g, ' ').trim().toUpperCase();
  }
  return text.replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Collapses any of a product's names -- Product ID, nickname, bracketed
 * injector form -- to ONE key: its Product ID. Falls through to the plain
 * canonical key for text that isn't a product at all (assembly parents like
 * "100 Sleeve Kit", one-off rows like "H Rack").
 *
 * This is what makes the identity change survivable. Inventory now stores the
 * Product ID, but Audit_Log still holds years of arrival events written under
 * whatever name was current at the time -- "v32", "GEN6 ALM",
 * "Burlington Scorpion Tag Case". Comparing those as raw text fails, and
 * measured against the live log, migrating Inventory without this would have
 * orphaned 20 aging anchors: those locations would read "unknown age" on the
 * heatmap for no reason a user could see.
 *
 * Resolving instead of rewriting is deliberate. Audit_Log is an append-only
 * historical record and a rename is not a correction to it; and any FUTURE
 * nickname change would re-create the same break, so a one-off rewrite only
 * moves the problem. Resolving at read time is permanent.
 *
 * @param {string} name
 * @return {string}
 */
function productIdentityKey_(name) {
  const key = canonicalNameKey_(name);
  if (!key) return '';
  const idx = getQbNameIndex_();
  if (idx && idx[key]) return canonicalNameKey_(idx[key]);
  return key;
}

/**
 * EXACT name match, with one narrow concession for the two ways the live
 * workbook holds genuinely truncated cells -- both mechanical, both leaving a
 * recognisable marker:
 *
 *   1. QuickBooks caps its exported name at 84 characters and appends "..." --
 *      74 of 184 PRODUCT rows and 80 Inventory cells are cut this way.
 *   2. An older export mangled the inch mark, cutting the string dead at a
 *      double-quote: `CIS NT510/2AF (2-alarm RF padlock tag, 3.5"` is the live
 *      remains of '...3.5"cable (normal lock))'. Four Inventory cells are in
 *      this state.
 *
 * So a prefix only counts when the longer side resumes with a double-quote at
 * the cut point, or the shorter side ends in "...".
 *
 * The old test was two-way substring containment, which cannot tell a
 * truncation from a sibling in a product family -- and this taxonomy is full of
 * families that share prefixes BY DESIGN (T25-SCREW / T25-SCREWDRIVER, V32 /
 * V32-BATTERY, a tag and that tag's CASE). A simple length floor is not
 * sufficient either: "SMART PL 48 AM" is 14 characters and still a legitimate
 * sibling of "SMART PL 48 AM SLIDE". Measured 2026-08-26 across the live
 * workbook: 27 such prefix pairs, zero duplicate names -- so an exact key is
 * unambiguous for every product while a substring test never can be. The marker
 * rule was verified across all 367 distinct names with zero false matches.
 *
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
function namesMatch_(a, b) {
  // Product identity first: two different names for the SAME product match
  // regardless of which vocabulary each side happens to be written in.
  const ia = productIdentityKey_(a);
  const ib = productIdentityKey_(b);
  if (ia && ib && ia === ib) return true;

  const ka = canonicalNameKey_(a);
  const kb = canonicalNameKey_(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  let shorter = ka.length < kb.length ? ka : kb;
  const longer = ka.length < kb.length ? kb : ka;
  // A QB-capped name carries a literal "..." that is NOT part of the real text,
  // so it has to come off before the prefix test or the comparison fails on the
  // ellipsis itself. Only trusted near the 84-character cap -- a short name that
  // merely happens to end in dots is not a truncation.
  const qbCapped = shorter.length >= 40 && shorter.slice(-3) === '...';
  if (qbCapped) shorter = shorter.slice(0, -3);
  if (!shorter || longer.indexOf(shorter) !== 0) return false;
  // Only a mechanical truncation marker lets a prefix through -- see above.
  return qbCapped || longer.charAt(shorter.length) === '"';
}

/**
 * @param {string} rawDesc
 * @return {{productId: string, cleanDescription: string}}
 */
function splitProductIdFromDesc_(rawDesc) {
  const text = String(rawDesc || '').trim();
  const match = text.match(/^\[(.*?)\]\s*(.*)$/);
  if (!match) return {productId: '', cleanDescription: text};

  const bracketContent = match[1].trim();
  const remainder = match[2].trim();

  if (!bracketContent || bracketContent.toUpperCase() === 'ITEM') {
    return {productId: '', cleanDescription: remainder || text};
  }

  return {productId: bracketContent, cleanDescription: remainder || bracketContent};
}

/**
 * Resolves the best display/inventory name for a checklist item description:
 * PRODUCT sheet canonical nickname (exact Product ID match, case-insensitive)
 * takes priority over the item's own typed description -- so the same product is
 * named identically in Inventory no matter which PO/staff member typed it --
 * falling back to the bracket-stripped description, then the raw text.
 *
 * @param {string} rawDesc the raw checklist item description.
 * @param {Object} productMapUpper getProductMap() results, re-keyed UPPERCASE
 *     (build once per request, not per item -- see receivePOCardItems).
 * @return {string}
 */
function resolveCanonicalItemName_(rawDesc, productMapUpper) {
  const parsed = splitProductIdFromDesc_(rawDesc);
  if (parsed.productId && productMapUpper) {
    const hit = productMapUpper[parsed.productId.toUpperCase()];
    if (hit && hit.nickname) return hit.nickname;
  }
  return parsed.cleanDescription || String(rawDesc || '').trim();
}

/**
 * The stable IDENTITY to write into Inventory's SKU column: the PRODUCT sheet's
 * own column-A text (the full QuickBooks name).
 *
 * Why this exists, and why it is not resolveCanonicalItemName_ above.
 *
 * The nickname is a DISPLAY convenience -- it is short enough to read in a
 * selector, where the 84-character QB name is not. It was never meant to be an
 * identity. But from 2026-08-11 receivePOCardItems() began writing it into
 * Inventory's SKU column, which quietly made a mutable label the primary key for
 * a warehouse row. Everything downstream then had to guess: name matching went
 * fuzzy, findCaseConversion_ stopped firing because a nickname does not start
 * with a supplier code, and renaming a product silently orphaned its stock.
 * Measured 2026-08-26: 81% of live rows still held the Product ID and only 8%
 * the nickname, so the drift was young and mostly reversible.
 *
 * The Product ID is the right key: it is what QuickBooks issues, what the
 * Assemblies sheet already references for real components (50 of 77), and it
 * does not change when someone improves a nickname. Display is unaffected --
 * getNickname() (JS_Handlers.html) resolves ID -> nickname at render time.
 *
 * Falls back to resolveCanonicalItemName_'s answer when the description carries
 * no resolvable Product ID, so a hand-typed checklist line still lands under a
 * sensible name rather than being dropped.
 *
 * @param {string} rawDesc
 * @param {Object} productMapUpper
 * @return {string}
 */
function resolveCanonicalProductId_(rawDesc, productMapUpper) {
  const parsed = splitProductIdFromDesc_(rawDesc);
  if (parsed.productId && productMapUpper) {
    const hit = productMapUpper[parsed.productId.toUpperCase()];
    // .productId is the sheet's own column-A text (getProductMap,
    // Service_Read.js); the uppercased index key is not usable as a value.
    if (hit && hit.productId) return hit.productId;
  }
  return resolveCanonicalItemName_(rawDesc, productMapUpper);
}

/**
 * ============================================================================
 * SHARED TRELLO FETCH -- RATE LIMIT / TRANSIENT ERROR HANDLING
 * ============================================================================
 * Trello's limit is 100 requests per 10 seconds per token (and 300/10s per key).
 * receivePOCardItems() issues two requests per checklist item in a tight loop
 * with no pacing at all, so a 40-line PO receipt is 80 requests back to back --
 * comfortably inside the window where Trello starts answering 429. Before this
 * helper there was not one occurrence of 429, retry or backoff anywhere in the
 * codebase: every call site used muteHttpExceptions with the response code
 * either unchecked or checked only for 200, so a throttled request looked
 * exactly like a successful one. See AUDIT_2026-08-24.md A8.
 *
 * Retries 429 and 5xx with exponential backoff (honouring Retry-After when
 * Trello sends it). NEVER retries 4xx other than 429 -- a 401 (dead token) or
 * 404 (deleted card) will not fix itself, and retrying a POST that already
 * succeeded would double-post a comment.
 *
 * Returns a plain object rather than the Response so callers can't go back to
 * ignoring the status: { ok, code, text, error, attempts }. `ok` is true only
 * for 2xx. `error` is set on a non-2xx or a thrown fetch. This never throws.
 *
 * It ALSO carries getResponseCode() / getContentText() shims with the same
 * signatures Apps Script's HTTPResponse has, so ported call sites that already
 * test `res.getResponseCode() === 200` stay a drop-in rename with no other edit
 * -- which is the point: a mechanical swap can't silently change what those
 * branches decide. New code should prefer `.ok` / `.text`.
 *
 * `opts` accepts Apps Script's UrlFetchApp shape (`payload`, `contentType`) as
 * well as fetch's own (`body`, `headers`), so a ported call site does not have
 * to be rewritten to move across. muteHttpExceptions is accepted and ignored --
 * this helper never throws on an HTTP status regardless.
 *
 * @param {string} url full Trello API URL (key/token already on it).
 * @param {Object} [opts] request options, either shape.
 * @param {{maxAttempts?: number, baseDelayMs?: number, label?: string}} [retryOpts]
 * @return {Promise<Object>} result envelope; never throws.
 */
async function trelloFetch_(url, opts, retryOpts) {
  const result = function(ok, code, text, error, attempts) {
    return {
      ok: ok, code: code, text: text, error: error, attempts: attempts,
      getResponseCode: function() {
        return code;
      },
      getContentText: function() {
        return text || error || '';
      }
    };
  };
  const cfg = retryOpts || {};
  const maxAttempts = cfg.maxAttempts || 4;
  const baseDelayMs = cfg.baseDelayMs || 500;
  const label = cfg.label || '';

  // Translate the Apps Script option shape into fetch's.
  const source = opts || {};
  const params = {method: String(source.method || 'get').toUpperCase()};
  if (source.payload !== undefined) params.body = source.payload;
  if (source.body !== undefined) params.body = source.body;
  const headers = Object.assign({}, source.headers || {});
  if (source.contentType) headers['Content-Type'] = source.contentType;
  if (Object.keys(headers).length > 0) params.headers = headers;

  let lastError = '';
  let lastCode = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response = null;
    let text = '';
    try {
      response = await fetch(url, params);
      text = await response.text();
    } catch (e) {
      // DNS/socket/timeout -- transient, worth retrying.
      lastError = String(e);
      lastCode = 0;
      if (attempt < maxAttempts) {
        await sleep_(trelloBackoffMs_(attempt, baseDelayMs));
        continue;
      }
      break;
    }

    const code = response.status;
    lastCode = code;

    if (code >= 200 && code < 300) {
      return result(true, code, text, '', attempt);
    }

    const retryable = (code === 429 || code >= 500);
    lastError = 'Trello ' + (label ? label + ' ' : '') + 'returned HTTP ' + code +
                (text ? ': ' + String(text).slice(0, 300) : '');

    if (!retryable || attempt === maxAttempts) {
      return result(false, code, text, lastError, attempt);
    }

    // Trello sends Retry-After (seconds) on 429; prefer it over our guess.
    let waitMs = trelloBackoffMs_(attempt, baseDelayMs);
    try {
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (isFinite(seconds) && seconds > 0) waitMs = Math.min(seconds * 1000, 30000);
      }
    } catch (e) { /* header read is best-effort; the computed backoff stands */ }

    logger.warn('trelloFetch_: HTTP ' + code + ' on attempt ' + attempt + '/' + maxAttempts +
                ' for ' + trelloRedactUrl_(url) + ' -- retrying in ' + waitMs + 'ms');
    await sleep_(waitMs);
  }

  return result(false, lastCode, '', lastError || 'Trello request failed', maxAttempts);
}

/**
 * Utilities.sleep equivalent.
 * @param {number} ms
 * @return {Promise<void>}
 */
function sleep_(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter, capped so no single call eats the request
 * budget.
 * @param {number} attempt 1-based.
 * @param {number} baseDelayMs
 * @return {number}
 */
function trelloBackoffMs_(attempt, baseDelayMs) {
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  return Math.min(exponential, 8000) + Math.floor(Math.random() * 250);
}

/**
 * Strips key/token before a URL goes anywhere near a log or a sheet.
 * @param {string} url
 * @return {string}
 */
function trelloRedactUrl_(url) {
  return String(url || '')
      .replace(/([?&]key=)[^&]*/gi, '$1***')
      .replace(/([?&]token=)[^&]*/gi, '$1***');
}

/**
 * ============================================================================
 * SHARED _SYS_ BLOB PARSER
 * ============================================================================
 * Every Master Hub / assembly row carries its structure as a JSON blob after a
 * "_SYS_" marker in the Inventory comment column (column F). That blob was
 * parsed at ~15 separate sites, each with its own
 * `try { JSON.parse(...) } catch(e){}` -- an empty catch, every time. A single
 * malformed blob therefore made a Master Hub row silently INVISIBLE to the
 * explode/move/delete logic: not an error, just a pallet that quietly stopped
 * being part of its build, with nothing written anywhere to say so.
 * See AUDIT_2026-08-24.md A5.
 *
 * This is the one auditable path. It still returns null on bad input -- the
 * callers genuinely do need to skip such a row rather than abort a whole batch
 * -- but it LOGS which row and what text failed, so a corrupt blob is findable
 * instead of invisible.
 *
 * @param {*} comment raw cell value from Inventory column F.
 * @param {string} context caller-supplied identifier for the log line, e.g.
 *     'Inventory row 412' -- worth passing.
 * @return {Object|null} the parsed blob, or null if absent/malformed.
 */
function parseSysBlob_(comment, context) {
  const text = (comment === null || comment === undefined) ? '' : String(comment);
  const marker = text.indexOf('_SYS_');
  if (marker === -1) return null;

  const raw = text.slice(marker + 5).trim();
  if (!raw) {
    logger.warn('parseSysBlob_: empty _SYS_ payload at ' + (context || 'unknown row'));
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      logger.warn('parseSysBlob_: non-object _SYS_ payload at ' + (context || 'unknown row') +
                  ' -- raw: ' + raw.slice(0, 200));
      return null;
    }
    return parsed;
  } catch (e) {
    // The row is skipped either way; the point is that it is no longer skipped
    // SILENTLY.
    logger.warn('parseSysBlob_: malformed _SYS_ payload at ' + (context || 'unknown row') +
                ' -- ' + e.message + ' -- raw: ' + raw.slice(0, 200));
    return null;
  }
}

module.exports = {
  // Board matrix
  getBoardMatrix_,
  resolveBoardById_,
  // List / status classification
  classifyListStatus,
  isFullyReceivedFromSummaryServer_,
  getRollupRank_,
  resolveTransitModeFromText_,
  // Brand / origin classification
  isKnownBrandLabel_,
  classifyInboundOrderOriginServer_,
  // .ignore feature
  PORTAL_IGNORED_MARKER,
  isCardIgnored_,
  formatInboundLineItems,
  parseIgnoreComment_,
  applyIgnoreDeclaration_,
  backfillIgnoreCommentsFromComments_,
  // Product identity
  primeQbNameIndex,
  getQbNameIndex_,
  clearQbNameIndex,
  canonicalNameKey_,
  productIdentityKey_,
  namesMatch_,
  splitProductIdFromDesc_,
  resolveCanonicalItemName_,
  resolveCanonicalProductId_,
  // Trello transport
  trelloCreds_,
  trelloFetch_,
  trelloBackoffMs_,
  trelloRedactUrl_,
  // _SYS_ blob
  parseSysBlob_
};
