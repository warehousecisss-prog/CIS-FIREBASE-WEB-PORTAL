const logger = require('firebase-functions/logger');
const SS_API = require('./Service_SheetsAPI');
const {
  getBoardMatrix_,
  classifyListStatus,
  getRollupRank_,
  resolveTransitMode,
  harvestFedExTrackingNumber,
  extractStoreInfo,
  formatInboundLineItems,
  formatOutboundLineItems,
  isKnownBrandLabel_,
  isFullyReceivedFromSummaryServer_,
  classifyInboundOrderOriginServer_,
  trelloCreds_
} = require('./Shared_Classifiers');

/**
 * ============================================================================
 * 4-BOARD MASTER SYNC (SCHEMA.md Section 7, "Writer 1")
 * ============================================================================
 * Ported from SRC/src/syncAllBoardsToShipmentsTab.js.
 *
 * The scheduled counterpart to the real-time webhook: every cycle it pulls all
 * four Trello boards and rewrites SHIPMENTS from what it finds, then hands off
 * to the rest of the pipeline in a specific order that is NOT arbitrary:
 *
 *   1. rewrite SHIPMENTS A-J from live Trello  (this file)
 *   2. evaluateRollupStatuses()                 -> Service_Rollup, "Writer 3"
 *   3. archiveCompletedShipments()              (this file)
 *   4. pruneDeletedShipmentCards_()             (this file)
 *   5. detectMissedDueDateOverrides_()          -> Service_Dates
 *   6. backfillReadyPortFromComments_()         -> Service_Dates
 *   7. refreshAllShipmentDateStates()           -> Service_Dates
 *   8. warmLogisticsDashboardCache()            -> Service_Read
 *
 * Step 5 must land AFTER this file rewrites column F and BEFORE step 7, so the
 * override is visible to THIS cycle's recompute rather than next cycle's --
 * see detectMissedDueDateOverrides_'s own doc comment. Step 2 must precede
 * step 7 because the IN_TRANSIT/ARRIVED date transitions key off the tracking
 * number and delivered status step 2 writes.
 *
 * ----------------------------------------------------------------------------
 * PORTING NOTES -- what necessarily changed, and what deliberately did not
 * ----------------------------------------------------------------------------
 *
 * 1. **A REAL BUG IN THE ORIGINAL IS FIXED HERE, NOT REPRODUCED.** See
 *    `deleteShipmentRows_` below. In short: SRC's archive and prune paths
 *    compact SHIPMENTS by rewriting columns A-J only, on an 18-column
 *    (A-R) sheet -- so every row below an archived one keeps ANOTHER
 *    shipment's readiness/ETA data. This port deletes whole rows instead,
 *    which moves all 18 columns together. This is a deliberate divergence and
 *    the parity harness asserts it rather than hiding it.
 *
 * 2. **The execution budget is widened, not removed** (user decision, Phase 5).
 *    SRC stops at 4.5 minutes because Apps Script kills a script at 6. Cloud
 *    Functions allows up to 60 minutes. The budget is raised to 8 minutes
 *    (against a 9-minute function timeout) but the MECHANISM is kept, because
 *    it is load-bearing: a board that did not finish its card list is excluded
 *    from `boardsFullyProcessed`, and pruning treats "not seen this run" as
 *    "deleted from Trello". Without the budget-and-exclusion pair, a slow run
 *    would archive live shipments.
 *
 * 3. **`UrlFetchApp.fetchAll` -> `Promise.all(fetch)`.** Same shape: all
 *    boards' list and card requests issued together, one round trip's latency
 *    rather than eight.
 *
 * 4. **Per-row `setValues` -> one batched update.** SRC writes each changed row
 *    with its own `getRange().setValues()` call inside a `forEach`. The port
 *    collects them and issues one `batchUpdateValues`. Same cells, same values;
 *    fewer API calls and no half-written cycle.
 *
 * 5. **Rows are padded to full width on read** (`padRows_`), for the reason in
 *    Service_Rollup.js's porting note 6.
 * ============================================================================
 */

/** SHIPMENTS columns A-J. */
const COL = {
  CARD_ID: 0, DIRECTION: 1, BOARD_SOURCE: 2, ENTITY: 3, TRANSIT_MODE: 4,
  SCHEDULED_DATE: 5, LIST_STATUS: 6, LINE_ITEMS: 7, MASTER_TRACKING: 8,
  ROLLUP_STATUS: 9
};

/** The full SHIPMENTS width (A-R), per SCHEMA section 3. */
const SHIPMENTS_WIDTH = 18;

/**
 * How long one sync run may spend fetching and processing cards. See porting
 * note 2 -- this is a real safety mechanism, not a leftover.
 */
const MAX_EXECUTION_MS = 8 * 60 * 1000;

/**
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
 * Formats a Trello ISO date as MM/dd/yyyy in the workbook's timezone. Same
 * function as Service_Webhook's, for the same reason -- Cloud Functions has no
 * bound spreadsheet to ask for a zone, and formatting in the container's UTC
 * would push evening dates onto the previous calendar day.
 *
 * @param {string} iso
 * @return {string}
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
 * ============================================================================
 * THE ONE PLACE SHIPMENTS ROWS ARE REMOVED -- and a fix to a real bug in the
 * original.
 * ============================================================================
 *
 * SRC removes rows by REWRITING the sheet: it reads columns A-J, filters out
 * the doomed rows, clears A-J, and writes the compacted list back into A-J
 * (`syncAllBoardsToShipmentsTab.js:538-544` and `:724-731`, identical code in
 * both `archiveCompletedShipments` and `pruneDeletedShipmentCards_`).
 *
 * SHIPMENTS is **eighteen** columns wide, A-R (SCHEMA section 3). Columns K-R
 * are the entire Readiness/ETA state machine written by `Service_Dates`:
 * ready-to-ship date and basis, ETA date and basis, date state, port of
 * arrival, last auto-pushed due date, and the ETA-overridden flag.
 *
 * Those eight columns are never moved. So the moment ONE shipment is archived,
 * every row beneath it has its A-J data shifted up by one row while its K-R
 * data stays where it was -- and every one of those shipments is now carrying
 * **a different shipment's ETA and readiness data**. It compounds with each
 * archived row in the same pass.
 *
 * SRC is aware of the hazard in the abstract: `isCardIgnored_`'s comment
 * (Shared_Classifiers.js) says this path "only rewrites columns A-J, which
 * would desync every row below it from its own K-R readiness/ETA data" -- and
 * declines to REUSE it for the ignore feature. It was left running on the
 * archive and prune paths.
 *
 * This port deletes whole rows via `deleteDimension` instead. Sheets moves all
 * eighteen columns together, so nothing can desync; it is also a single API
 * call rather than a clear plus a write. Deliberate divergence, asserted by
 * `test/parity_Sync.js` rather than hidden by it.
 *
 * @param {Array<number>} sheetRowNumbers 1-based, as SS_API.batchDeleteRows
 *     expects.
 * @return {Promise<void>}
 */
async function deleteShipmentRows_(sheetRowNumbers) {
  if (!sheetRowNumbers || sheetRowNumbers.length === 0) return;
  const gid = await SS_API.getSheetId('SHIPMENTS');
  await SS_API.batchDeleteRows(gid, sheetRowNumbers);
}

/**
 * Reads a Trello endpoint and returns parsed JSON, or null on any failure.
 * Used for the bulk board fetches, which are issued together via Promise.all.
 *
 * @param {string} url
 * @return {Promise<?Object>}
 */
async function fetchJson_(url) {
  try {
    const res = await fetch(url, {method: 'get'});
    if (res.status !== 200) {
      logger.warn('Trello fetch returned HTTP ' + res.status);
      return null;
    }
    return JSON.parse(await res.text());
  } catch (e) {
    logger.warn('Trello fetch failed: ' + e.message);
    return null;
  }
}

/**
 * Pulls all four boards into SHIPMENTS, then runs the rest of the pipeline.
 *
 * @param {{maxExecutionMs?: number}} [opts]
 * @return {Promise<Object>} a summary, for logs and for the scheduler.
 */
async function syncAllBoardsToShipmentsTab(opts) {
  const startTime = Date.now();
  const maxExecutionTime = (opts && opts.maxExecutionMs) || MAX_EXECUTION_MS;

  try {
    const creds = trelloCreds_();
    if (!creds.key || !creds.token) {
      logger.error('ERROR: Missing TRELLO_KEY or TRELLO_TOKEN.');
      return {success: false, error: 'Missing Trello credentials.'};
    }

    // Fetched once per run (not per card) so formatOutboundLineItems can
    // recognise brand labels without re-reading CUSTOMER_REGISTRY hundreds of
    // times across a full 4-board sync.
    const registry = await require('./Service_Read').getCustomerRegistry();
    const boardMatrix = getBoardMatrix_();

    // --- existing state -----------------------------------------------------
    const shipRaw = await SS_API.getSheetValues('SHIPMENTS!A:J');
    const shipBody = padRows_((shipRaw || []).slice(1), 10);

    const existingShipmentsMap = new Map();
    // Column J snapshot per card, read alongside existingShipmentsMap so the
    // update path can tell "the Rollup Engine already confirmed this" apart
    // from "Trello still says it's in transit". Without it, Writer 1 clobbers
    // Writer 3 every cycle -- the 2026-08-26 incident where one card generated
    // hundreds of duplicate "PO Delivered in Full" emails (SCHEMA section 7).
    const existingRollupMap = new Map();
    shipBody.forEach((row, idx) => {
      const cardId = String(row[COL.CARD_ID] || '').trim();
      if (cardId) {
        existingShipmentsMap.set(cardId, idx + 2);
        existingRollupMap.set(cardId, String(row[COL.ROLLUP_STATUS] || '').trim().toUpperCase());
      }
    });

    const histRaw = await SS_API.getSheetValues('Shipment_History!A:K');
    const existingHistoryCards = new Set();
    (histRaw || []).slice(1).forEach((row) => {
      const cardId = String((row || [])[1] || '').trim();
      if (cardId) existingHistoryCards.add(cardId);
    });

    const mpsRaw = await SS_API.getSheetValues('Multi Piece Tracking!A:D');
    const existingMpsTracking = new Set();
    (mpsRaw || []).slice(1).forEach((row) => {
      const trk = String((row || [])[3] || '').trim();
      if (trk) existingMpsTracking.add(trk);
    });

    let totalProcessed = 0;
    const newShipmentRows = [];
    const updateShipmentRows = [];
    const newMpsRows = [];
    let isTimedOut = false;

    // Card IDs still open on Trello per board, plus which boards made it all
    // the way through their card list. pruneDeletedShipmentCards_ only prunes
    // rows belonging to a board in the second set -- see its comment.
    const liveCardIdsByBoard = {};
    const boardsFullyProcessed = new Set();

    // --- Phase 1: fetch every board's lists and cards, in parallel ----------
    const auth = `key=${creds.key}&token=${creds.token}`;
    const responses = await Promise.all(boardMatrix.flatMap((board) => [
      fetchJson_(`https://api.trello.com/1/boards/${board.id}/lists?${auth}`),
      fetchJson_(`https://api.trello.com/1/boards/${board.id}/cards?filter=open&` +
        `fields=name,desc,due,idList,labels,idChecklists&checklists=all&` +
        `actions=commentCard&${auth}`)
    ]));

    for (let b = 0; b < boardMatrix.length; b++) {
      if (isTimedOut || Date.now() - startTime > maxExecutionTime) break;

      const board = boardMatrix[b];
      const lists = responses[b * 2];
      const cards = responses[b * 2 + 1];

      if (!lists || !cards) {
        logger.warn(`Skipping board ${board.name} due to fetch error.`);
        continue;
      }

      const listsMap = {};
      lists.forEach((l) => { listsMap[l.id] = l.name; });
      const liveCardIds = new Set();

      for (let c = 0; c < cards.length; c++) {
        if (Date.now() - startTime > maxExecutionTime) {
          isTimedOut = true;
          break;
        }

        const card = cards[c];
        const cardId = card.id;
        liveCardIds.add(cardId);
        const listName = listsMap[card.idList] || 'Unknown List';
        const listUpper = String(listName).toUpperCase().trim();

        // Staging/reference lists, not real shipments. The webhook mirrors this.
        if (listUpper.includes('NEEDED AS OF TODAY') || listUpper.includes('GENERAL LEDGER')) {
          continue;
        }

        let entityName = String(card.name || '').trim();
        const descText = String(card.desc || '').trim();

        if (board.name === 'Burlington Shipping Schedule') {
          // The legacy hardcoded keywords stay as a fail-safe, but the primary
          // check is CUSTOMER_REGISTRY via isKnownBrandLabel_ -- that is the
          // registry's whole purpose. Without it, cards for a brand not in the
          // 5-word legacy list, even ones explicitly marked "Store: Multi",
          // were silently renamed as if they were a single numbered Burlington
          // store.
          const legacyBrandRegex = /\b(BURLINGTON|AEO|AERIE|OFF|TS)\b/i;
          const isKnownBrand = legacyBrandRegex.test(entityName) || legacyBrandRegex.test(descText) ||
            isKnownBrandLabel_(entityName, registry) || isKnownBrandLabel_(descText, registry);
          if (!isKnownBrand) {
            entityName = /^STORE\b/i.test(entityName)
              ? 'Burlington ' + entityName
              : 'Burlington Store ' + entityName;
          }
        }

        const dueStr = card.due ? formatTrelloDate_(card.due) : '-';
        const cleanSummary = board.direction === 'Inbound'
          ? formatInboundLineItems(card.checklists || [], card.labels || [])
          : formatOutboundLineItems(board.name, card.labels || [], descText, registry);

        const transitMode = resolveTransitMode(listName, card.labels || []);
        const comments = (card.actions || []).map((a) => {
          if (a.data && a.data.text) return a.data.text;
          return '';
        }).join(' ');
        const trackingNumber = harvestFedExTrackingNumber(descText, comments);

        let initialRollup = board.direction === 'Inbound' ? 'PENDING' : 'PENDING PACK';
        const listCls = classifyListStatus(listUpper);
        const isToBeShipped = listCls.isToBeShipped;
        const isCompletedList = listCls.isReceived || listCls.isDone ||
                                listCls.isCompleted || listCls.isDelivered;
        const isInTransitList = listCls.isShipped || listCls.isInTransit || listCls.isFreightModeList;

        let isFullyPacked = false;
        let isPartiallyPacked = false;
        if (card.checklists && card.checklists.length > 0) {
          let totalCheckItems = 0;
          let completeCheckItems = 0;
          card.checklists.forEach((cl) => {
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

        if (isCompletedList) {
          // A list named "Delivered" is not receiving verification (SCHEMA
          // invariant #10) -- EXCEPT this app's inbound boards have no
          // "Received" list at all, so receivePOCardItems() moving a fully
          // received card there is the only way a local card reaches it.
          // isFullyPacked is this app's actual receiving-complete signal for
          // that case. Confirmed live with PO 3503/3562, which were stuck
          // showing PAST DUE with 100% received line items. The webhook must
          // match this exactly or the same card flips between RECEIVED and
          // DELIVERED depending on which writer touched it last.
          const isReceivedDoneList = listCls.isReceived || listCls.isDone || listCls.isCompleted;
          initialRollup = board.direction === 'Inbound'
            ? ((isReceivedDoneList || isFullyPacked) ? 'RECEIVED' : 'DELIVERED')
            : 'DELIVERED';
        } else if (isFullyPacked) {
          initialRollup = board.direction === 'Inbound' ? 'RECEIVED' : 'PACKED';
        } else if (isPartiallyPacked) {
          initialRollup = board.direction === 'Inbound' ? 'Partially Received' : 'PARTIAL PACK';
        } else if (!isToBeShipped && isInTransitList) {
          initialRollup = board.direction === 'Inbound' ? 'ON THE WAY' : 'SHIPPED';
        } else if (trackingNumber) {
          initialRollup = board.direction === 'Inbound' ? 'ON THE WAY' : 'IN TRANSIT';
        }

        const shipmentRecord = [
          cardId, board.direction, board.name, entityName, transitMode,
          dueStr, listName, cleanSummary.substring(0, 2000), trackingNumber, initialRollup
        ];

        if (existingShipmentsMap.has(cardId)) {
          // Don't let this Trello-list-derived recompute stomp a status the
          // Rollup Engine already advanced further on a prior cycle -- e.g.
          // FedEx confirming full delivery while the card still sits in a
          // non-terminal list. See SCHEMA section 7's 2026-08-26 warning.
          const currentRollup = existingRollupMap.get(cardId) || '';
          const isPendingLike = currentRollup === 'PENDING' ||
            currentRollup === 'PENDING PACK' || currentRollup === 'STAGED / PACKING';
          if (currentRollup && !isPendingLike &&
              getRollupRank_(board.direction, shipmentRecord[COL.ROLLUP_STATUS]) <
              getRollupRank_(board.direction, currentRollup)) {
            shipmentRecord[COL.ROLLUP_STATUS] = currentRollup;
          }
          updateShipmentRows.push({row: existingShipmentsMap.get(cardId), data: shipmentRecord});
        } else if (!existingHistoryCards.has(cardId)) {
          newShipmentRows.push(shipmentRecord);
          existingShipmentsMap.set(cardId, true);
        }

        if (trackingNumber && !existingMpsTracking.has(trackingNumber)) {
          const storeInfo = extractStoreInfo(entityName);
          newMpsRows.push([storeInfo.storeName, storeInfo.storeNum, board.direction, trackingNumber, '']);
          existingMpsTracking.add(trackingNumber);
        }

        totalProcessed++;
      }

      liveCardIdsByBoard[board.name] = liveCardIds;
      if (!isTimedOut) boardsFullyProcessed.add(board.name);
    }

    if (isTimedOut) {
      logger.warn('syncAllBoardsToShipmentsTab: execution budget (' +
        Math.round(maxExecutionTime / 1000) + 's) reached -- ' +
        (boardMatrix.length - boardsFullyProcessed.size) + ' board(s) incomplete. ' +
        'Pruning will skip them, so no live row is archived on a partial view.');
    }

    // --- Phase 2: batch sheet writes ---------------------------------------
    // Column D (Entity / Store) is forced to plain text. A store number like
    // "0012" must not become 12, and a name like "1-800-Flowers" must not
    // become a date. SRC does this with setNumberFormat('@') on the same range.
    try {
      const gid = await SS_API.getSheetId('SHIPMENTS');
      await SS_API.batchUpdateSheet([{
        repeatCell: {
          range: {sheetId: gid, startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4},
          cell: {userEnteredFormat: {numberFormat: {type: 'TEXT'}}},
          fields: 'userEnteredFormat.numberFormat'
        }
      }]);
    } catch (fmtErr) {
      logger.warn('Could not set the plain-text format on SHIPMENTS column D -- ' +
        fmtErr.message);
    }

    // One call rather than SRC's per-row loop. See porting note 4.
    if (updateShipmentRows.length > 0) {
      await SS_API.batchUpdateValues(updateShipmentRows.map((item) => ({
        range: `SHIPMENTS!A${item.row}:J${item.row}`,
        values: [item.data]
      })));
    }
    if (newShipmentRows.length > 0) {
      await SS_API.batchAppendRows('SHIPMENTS', newShipmentRows);
    }
    if (newMpsRows.length > 0) {
      await SS_API.batchAppendRows('Multi Piece Tracking', newMpsRows);
    }

    // --- Phase 4: rollup, archive, prune -----------------------------------
    const rollupResult = await require('./Service_Rollup').evaluateRollupStatuses(registry);
    const archiveResult = await archiveCompletedShipments(registry);
    const pruneResult = await pruneDeletedShipmentCards_(
        liveCardIdsByBoard, boardsFullyProcessed, registry);

    // --- Phase 4.5 / 4.6 / 5: the date pipeline -----------------------------
    // Order is fixed: detectMissedDueDateOverrides_ AFTER column F is rewritten
    // above and BEFORE refreshAllShipmentDateStates, so an override caught here
    // is visible to THIS cycle's recompute. See its doc comment.
    const Dates = require('./Service_Dates');
    await Dates.detectMissedDueDateOverrides_();
    await Dates.backfillReadyPortFromComments_();
    await Dates.refreshAllShipmentDateStates();

    await require('./Service_Read').warmLogisticsDashboardCache();

    const durationS = ((Date.now() - startTime) / 1000).toFixed(2);
    const summary = {
      success: true,
      durationSeconds: Number(durationS),
      timedOut: isTimedOut,
      cardsProcessed: totalProcessed,
      rowsUpdated: updateShipmentRows.length,
      rowsAppended: newShipmentRows.length,
      mpsRowsAppended: newMpsRows.length,
      boardsFullyProcessed: Array.from(boardsFullyProcessed),
      archived: archiveResult.archived,
      pruned: pruneResult.pruned,
      rollup: rollupResult.counts || null
    };
    logger.info('syncAllBoardsToShipmentsTab complete in ' + durationS + 's.', summary);
    return summary;
  } catch (e) {
    logger.error('syncAllBoardsToShipmentsTab failed', {error: e.toString(), stack: e.stack});
    return {success: false, error: e.toString()};
  }
}

/**
 * Moves finished shipments off the live SHIPMENTS tab into Shipment_History.
 *
 * Inbound and outbound have different definitions of "finished", and the
 * inbound side has three separate ways to be done -- see the branches below.
 *
 * @param {Array<Object>} [registry]
 * @return {Promise<{archived: number}>}
 */
async function archiveCompletedShipments(registry) {
  const raw = await SS_API.getSheetValues('SHIPMENTS!A:J');
  if (!raw || raw.length < 2) return {archived: 0};
  const shipData = padRows_(raw.slice(1), 10);

  if (registry === undefined) {
    registry = await require('./Service_Read').getCustomerRegistry();
  }
  registry = registry || [];

  const histRaw = await SS_API.getSheetValues('Shipment_History!A:K');
  const existingHistory = new Set();
  (histRaw || []).slice(1).forEach((r) => {
    const id = String((r || [])[1] || '').trim();
    if (id) existingHistory.add(id);
  });

  const newHistoryRows = [];
  const rowsToDelete = [];

  shipData.forEach((row, index) => {
    const cardId = String(row[COL.CARD_ID]).trim();
    const direction = String(row[COL.DIRECTION]).trim();
    const entityName = String(row[COL.ENTITY] || '').trim();
    const summary = String(row[COL.LINE_ITEMS] || '').trim();
    const rollupStatus = String(row[COL.ROLLUP_STATUS]).toUpperCase();
    const listStatus = String(row[COL.LIST_STATUS]).toUpperCase();
    const listCls = classifyListStatus(listStatus);
    const isToBeShipped = listCls.isToBeShipped;

    let shouldArchive = false;
    if (direction === 'Inbound') {
      if (rollupStatus === 'RECEIVED' || rollupStatus === 'DELIVERED IN FULL' ||
          rollupStatus === 'RECEIVED AND DROPS OFF' || listCls.isReceived ||
          listCls.isDone || listCls.isCompleted || listCls.isArchivedDeleted) {
        shouldArchive = true;
      } else if (rollupStatus === 'DELIVERED' &&
          !classifyInboundOrderOriginServer_(entityName, summary, registry).isLocal) {
        // Non-local/drop-ship inbound orders (Australia, TJX Canada RTF/TJXC)
        // never go through warehouse receiving -- DELIVERED IS their terminal
        // status. Local orders deliberately do NOT hit this branch; they must
        // reach a literal RECEIVED via the receiving feature (SCHEMA #10).
        shouldArchive = true;
      } else if (rollupStatus === 'DELIVERED' &&
          isFullyReceivedFromSummaryServer_(summary)) {
        // A local PO whose checklist shows every line fully received but whose
        // status text never advanced past DELIVERED -- this board has no
        // "Received" list, so moving the card to "Delivered" is as far as the
        // status text can go. Without this they sit in SHIPMENTS forever.
        shouldArchive = true;
      }
    } else {
      if (rollupStatus === 'DELIVERED' || rollupStatus === 'SHIPPED' ||
          listCls.isArchivedDeleted ||
          (!isToBeShipped && (listCls.isShipped || listCls.isDelivered))) {
        shouldArchive = true;
      }
    }

    if (shouldArchive && cardId) {
      rowsToDelete.push(index + 2);
      if (!existingHistory.has(cardId)) {
        newHistoryRows.push([
          new Date().toISOString(), cardId, row[1], row[2], row[3], row[4],
          row[5], row[6], row[7], row[8], rollupStatus
        ]);
        existingHistory.add(cardId);
      }
    }
  });

  if (newHistoryRows.length > 0) {
    await SS_API.batchAppendRows('Shipment_History', newHistoryRows);
  }
  // Whole-row deletes -- see deleteShipmentRows_ for why this is NOT SRC's
  // A-J compaction.
  await deleteShipmentRows_(rowsToDelete);

  if (rowsToDelete.length > 0) {
    logger.info('archiveCompletedShipments: archived ' + rowsToDelete.length + ' row(s).');
  }
  return {archived: rowsToDelete.length};
}

/**
 * A card missing from its board's live open-card fetch means one of three
 * things, and only one is "deleted":
 *   1. genuinely deleted/unreachable -- a GET for it fails outright
 *   2. archived/closed by a human -- still fetchable, `closed: true`. This is
 *      the user's normal completion workflow, a completion signal not data loss
 *   3. still open but moved to a board this app does not track
 *
 * Batched into one parallel fetch for every vanished card, rather than a serial
 * GET each: a burst of closures landing in one cycle used to turn a ~20s sync
 * into 60-68s. Since the webhook handles closures in real time
 * (Service_Webhook's archiveClosedCardNow_), this is now the fallback for
 * whatever it missed, not the primary path.
 *
 * @param {Array<Object>} vanishedRows
 * @param {{key: string, token: string}} creds
 * @param {Array<string>} knownBoardIds
 * @param {Array<Object>} registry
 * @return {Promise<Object>} cardId -> terminal status.
 */
async function resolveVanishedCardStatusesBatch_(vanishedRows, creds, knownBoardIds, registry) {
  const deletedFallback = 'CARD DELETED FROM TRELLO';
  const result = {};

  if (!creds || !creds.key || !creds.token || vanishedRows.length === 0) {
    vanishedRows.forEach((v) => { result[v.cardId] = deletedFallback; });
    return result;
  }

  let cardInfos;
  try {
    cardInfos = await Promise.all(vanishedRows.map((v) => fetchJson_(
        `https://api.trello.com/1/cards/${v.cardId}?fields=closed,idBoard&` +
        `key=${creds.key}&token=${creds.token}`)));
  } catch (e) {
    logger.warn('resolveVanishedCardStatusesBatch_: batch fetch failed -- ' + e.message);
    vanishedRows.forEach((v) => { result[v.cardId] = deletedFallback; });
    return result;
  }

  vanishedRows.forEach((v, i) => {
    const cardInfo = cardInfos[i];
    if (!cardInfo) { result[v.cardId] = deletedFallback; return; }
    if (cardInfo.closed) {
      if (v.direction !== 'Inbound') { result[v.cardId] = 'DELIVERED'; return; }
      // Same non-local carve-out as archiveCompletedShipments -- a closed
      // non-local inbound card never went through warehouse receiving.
      const isNonLocal = !classifyInboundOrderOriginServer_(
          v.entityName, v.summary, registry).isLocal;
      result[v.cardId] = isNonLocal ? 'DELIVERED' : 'RECEIVED';
      return;
    }
    if (knownBoardIds.indexOf(cardInfo.idBoard) === -1) {
      result[v.cardId] = 'MOVED OFF TRACKED BOARD';
      return;
    }
    result[v.cardId] = deletedFallback;
  });

  return result;
}

/**
 * Removes SHIPMENTS rows whose card no longer exists on its source board at
 * all -- deleted outright, not merely moved to another list.
 * archiveCompletedShipments only clears a row once its status says it is
 * finished; a card simply deleted from Trello never reaches such a state, so
 * nothing else would ever remove its row.
 *
 * Only prunes rows whose board finished its card fetch this run: a board cut
 * off by the execution budget or a fetch error has an incomplete liveCardIds
 * set, and treating "not seen yet" as "deleted" would archive live rows.
 *
 * @param {Object} liveCardIdsByBoard
 * @param {Set<string>} boardsFullyProcessed
 * @param {Array<Object>} [registry]
 * @return {Promise<{pruned: number}>}
 */
async function pruneDeletedShipmentCards_(liveCardIdsByBoard, boardsFullyProcessed, registry) {
  if (!boardsFullyProcessed || boardsFullyProcessed.size === 0) return {pruned: 0};

  const raw = await SS_API.getSheetValues('SHIPMENTS!A:J');
  if (!raw || raw.length < 2) return {pruned: 0};
  const shipData = padRows_(raw.slice(1), 10);

  if (registry === undefined) {
    registry = await require('./Service_Read').getCustomerRegistry();
  }
  registry = registry || [];

  const histRaw = await SS_API.getSheetValues('Shipment_History!A:K');
  const existingHistory = new Set();
  (histRaw || []).slice(1).forEach((r) => {
    const id = String((r || [])[1] || '').trim();
    if (id) existingHistory.add(id);
  });

  const vanished = [];
  shipData.forEach((row, index) => {
    const cardId = String(row[COL.CARD_ID] || '').trim();
    const direction = String(row[COL.DIRECTION] || '').trim();
    const boardSource = String(row[COL.BOARD_SOURCE] || '').trim();
    if (!cardId || !boardsFullyProcessed.has(boardSource)) return;

    const liveIds = liveCardIdsByBoard[boardSource];
    if (liveIds && !liveIds.has(cardId)) {
      vanished.push({
        index: index, row: row, cardId: cardId, direction: direction,
        entityName: row[COL.ENTITY], summary: row[COL.LINE_ITEMS]
      });
    }
  });

  const newHistoryRows = [];
  const rowsToDelete = [];

  if (vanished.length > 0) {
    const creds = trelloCreds_();
    const knownBoardIds = getBoardMatrix_().map((b) => b.id);
    const statusByCardId = await resolveVanishedCardStatusesBatch_(
        vanished, creds, knownBoardIds, registry);

    vanished.forEach((v) => {
      rowsToDelete.push(v.index + 2);
      if (!existingHistory.has(v.cardId)) {
        const terminalStatus = statusByCardId[v.cardId] || 'CARD DELETED FROM TRELLO';
        const row = v.row;
        newHistoryRows.push([
          new Date().toISOString(), v.cardId, row[1], row[2], row[3], row[4],
          row[5], row[6], row[7], row[8], terminalStatus
        ]);
        existingHistory.add(v.cardId);
      }
    });
  }

  if (newHistoryRows.length > 0) {
    await SS_API.batchAppendRows('Shipment_History', newHistoryRows);
  }
  // Whole-row deletes -- see deleteShipmentRows_.
  await deleteShipmentRows_(rowsToDelete);

  if (rowsToDelete.length > 0) {
    logger.info('Pruned ' + rowsToDelete.length +
      ' SHIPMENTS row(s) for cards deleted from Trello.');
  }
  return {pruned: rowsToDelete.length};
}

module.exports = {
  syncAllBoardsToShipmentsTab,
  archiveCompletedShipments,
  pruneDeletedShipmentCards_,
  resolveVanishedCardStatusesBatch_,
  deleteShipmentRows_,
  formatTrelloDate_,
  padRows_,
  MAX_EXECUTION_MS,
  SHIPMENTS_WIDTH,
  COL
};
