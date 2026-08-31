const logger = require('firebase-functions/logger');
const SS_API = require('./Service_SheetsAPI');
const Email = require('./Service_Email');
const {
  classifyListStatus,
  cleanTrackingNumber,
  getBoardMatrix_,
  trelloCreds_,
  trelloFetch_
} = require('./Shared_Classifiers');

/**
 * ============================================================================
 * ROLLUP STATUS EVALUATION ENGINE  (SCHEMA.md Section 7 -- "Writer 3")
 * ============================================================================
 * Ported from SRC/src/evaluateRollupStatuses.js.
 *
 * One job: decide the single status string in SHIPMENTS column J for every
 * shipment, by rolling up the per-box FedEx statuses on the "MPS Backend" tab.
 * It runs LAST in the scheduled sync, after the Trello-derived writers, and its
 * governing rule (SCHEMA's "Golden Rule of Status Hierarchy") is that it may
 * UPGRADE a status but must NEVER downgrade one a human already set:
 *
 *   Trello says RECEIVED, FedEx says on the way  -> stays RECEIVED
 *   Trello says PENDING,  FedEx says all boxes delivered -> Delivered in Full
 *
 * Two automations hang off it, and both are why "never downgrade" matters so
 * much in practice rather than just in principle:
 *
 *  - **Delivered-in-full**: an email to the stakeholder list plus setting the
 *    Trello card's `dueComplete`. It fires only on a NEW transition into that
 *    status. The 2026-08-26 incident recorded in SCHEMA §7 is what happens
 *    when something upstream resets column J every cycle: one AEO card
 *    generated *hundreds* of duplicate "PO Delivered in Full" emails, because
 *    each cycle looked like a brand-new delivery.
 *  - **Board freshness**: an Outbound card still sitting in a "TO BE SHIPPED"
 *    list is moved to that board's "Shipped" list once FedEx reports a real
 *    carrier scan -- deliberately not merely a harvested tracking number, since
 *    a label is often printed days before the package moves.
 *
 * ----------------------------------------------------------------------------
 * PORTING NOTES -- what necessarily changed, and what deliberately did not
 * ----------------------------------------------------------------------------
 *
 * 1. **The decision tree is extracted into `evaluateRollupRow_`, a pure
 *    function.** SRC has it inline in one 230-line loop mixed with sheet and
 *    network I/O. The logic is byte-faithful -- same branch order, same
 *    string comparisons, same tally buckets -- it is only *reachable* now.
 *    That is what lets `test/parity_Rollup.js` drive every branch.
 *
 * 2. **`String(row[n]).trim()` is preserved verbatim, `|| ""` and all.** SRC
 *    guards row[1] with `|| ""` but NOT row[3], row[6] or row[9]. On a short
 *    row those become the literal string `"undefined"`, which then flows into
 *    the drop-ship regex test and the status comparisons. That is observable
 *    behaviour, not a typo to tidy up: "tidying" it would change what a
 *    malformed row rolls up to. Same reasoning for `String(brand.Parent_Account)`
 *    in the drop-ship loop.
 *
 * 3. **Column J is rewritten in ONE full-column write**, exactly as SRC's
 *    single `getRange(2, 10, n, 1).setValues(...)` does -- every row gets
 *    exactly one entry pushed on every branch, so the array length always
 *    matches the row count. Not split into per-row updates: a partial write
 *    here would leave the status column half-evaluated.
 *
 * 4. **Email fallback differs, and has to.** SRC falls back to
 *    `Session.getActiveUser().getEmail()` when the Config tab has no
 *    FEDEX_STAKEHOLDER row. A scheduled Cloud Function has no session user,
 *    and `getActiveUserEmail()` throws by design rather than inventing one
 *    (the Phase 1 auth decision, AUDIT C5). The chain here is FEDEX_STAKEHOLDER
 *    -> STAKEHOLDER_EMAILS (same Config tab, already used by the receiving
 *    path in Service_Write) -> log an error and skip the email. Skipping is
 *    deliberate: the alternative is silently mailing a placeholder address,
 *    which reads as "delivered" to nobody. The status write and the Trello
 *    `dueComplete` still happen either way -- only the notification is lost.
 *
 * 5. **No lock.** SRC takes none, and this writes SHIPMENTS, not Inventory --
 *    `functions/lock.js`'s lease is the Inventory lease and would be the wrong
 *    lock. The pre-existing read-compute-write race against the webhook path
 *    is unchanged from SRC, neither widened nor narrowed. Flagged in
 *    PHASE_5_NOTES.md as an open item rather than decided here.
 *
 * 6. **Rows are padded to full width on read -- see `padRows_`.** This is NOT
 *    cosmetic and it is the one place where porting SRC verbatim would have
 *    introduced a real bug. Apps Script's `getRange(2, 1, n, 10).getValues()`
 *    always returns exactly 10 cells per row, padding blanks with `""`. The
 *    Google Sheets API's `values.get` does the opposite: it OMITS trailing
 *    empty cells, so a row blank from column G onward comes back with 6
 *    entries and `row[9]` is `undefined`. SRC's unguarded `String(row[9])`
 *    then yields the literal string `"undefined"` instead of `""` -- and in
 *    Case A, `currentStatus || "PENDING"` would write the text **"undefined"**
 *    into the status column of every shipment that has no status yet. Padding
 *    reproduces the Apps Script guarantee exactly; adding `|| ""` guards
 *    instead would NOT, because `String(0)` and `String(0 || "")` differ for a
 *    cell holding a literal 0.
 * ============================================================================
 */

/** SHIPMENTS column indices. Mirrors Service_Dates.SHIPMENTS_COL (SCHEMA §3). */
const COL = {
  CARD_ID: 0, DIRECTION: 1, BOARD_SOURCE: 2, ENTITY: 3, TRANSIT_MODE: 4,
  SCHEDULED_DATE: 5, LIST_STATUS: 6, LINE_ITEMS: 7, MASTER_TRACKING: 8,
  ROLLUP_STATUS: 9
};

/**
 * Reproduces Apps Script's `getRange(row, col, numRows, numCols).getValues()`
 * row shape on top of the Sheets API's `values.get`, which omits trailing empty
 * cells. See porting note 6 -- without this, a shipment with no status yet gets
 * the literal text "undefined" written into its status column.
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
 * True when a FedEx status string represents "label exists, not yet physically
 * scanned by the carrier" -- i.e. still pre-transit. Gates the "TO BE SHIPPED"
 * -> "Shipped" list-move automation: a bare tracking number isn't enough on its
 * own, since a label can be printed/harvested well before the package leaves
 * the building. Values are already uppercased by the MPS Backend reader before
 * reaching here.
 *
 * @param {string} status
 * @return {boolean}
 */
function isPreTransitFedExStatus_(status) {
  const s = String(status || '').trim();
  if (!s || s === 'PENDING UPDATE' || s === 'UNKNOWN') return true;
  return s.indexOf('SHIPMENT INFORMATION SENT') !== -1 || s.indexOf('LABEL CREATED') !== -1;
}

/**
 * Does this row's entity name resolve to a CUSTOMER_REGISTRY brand handled as
 * "Direct Drop Ship"? Drop-ship shipments bypass local warehouse receiving, so
 * a full FedEx delivery is terminal for them (COMPLETE) rather than merely
 * "Delivered in Full".
 *
 * Ported verbatim, including two quirks worth not fixing here: the loop
 * `break`s on the first identity match regardless of whether that brand is
 * actually drop-ship (so a later matching row cannot rescue it), and an
 * unparseable Regex_Aliases is logged and skipped rather than aborting the scan
 * -- before that catch existed, one bad pattern silently disabled drop-ship
 * detection for the whole registry.
 *
 * @param {string} entityName
 * @param {Array<Object>} registry
 * @return {boolean}
 */
function resolveIsDropShip_(entityName, registry) {
  let isDropShip = false;
  if (registry && registry.length > 0) {
    for (const brand of registry) {
      if (entityName.toUpperCase() === String(brand.Parent_Account).toUpperCase() ||
          entityName.toUpperCase() === String(brand.Brand_ID).toUpperCase()) {
        if (brand.Handling_Type === 'Direct Drop Ship') isDropShip = true;
        break;
      }
      if (brand.Regex_Aliases) {
        try {
          const rgx = new RegExp(brand.Regex_Aliases, 'i');
          if (rgx.test(entityName)) {
            if (brand.Handling_Type === 'Direct Drop Ship') isDropShip = true;
            break;
          }
        } catch (e) {
          logger.warn('evaluateRollupStatuses: bad Regex_Aliases for brand "' +
                      (brand.Brand || brand.Name || '?') + '" -- ' + e.message);
        }
      }
    }
  }
  return isDropShip;
}

/**
 * THE STATE MACHINE. Decides one SHIPMENTS row's column J value.
 *
 * This is SCHEMA.md §7's "evaluateRollupStatuses() Decision Tree" in full, and
 * the reason it is a standalone pure function in the port is that it is the
 * single highest-consequence piece of logic in the sync pipeline: it decides
 * whether an operator's confirmed RECEIVED survives contact with stale carrier
 * data, and whether the delivered-in-full automation fires.
 *
 * @param {Array<*>} row a SHIPMENTS row, columns A-J.
 * @param {Array<string>} boxStatuses uppercased child-box statuses for this
 *     row's master tracking number; empty when discovery has not run.
 * @param {Array<Object>} registry CUSTOMER_REGISTRY export.
 * @return {{status: string, bucket: string, newlyReceived: boolean,
 *           moveToShipped: boolean, masterTrk: string}}
 */
function evaluateRollupRow_(row, boxStatuses, registry) {
  // `|| ""` on DIRECTION only -- see porting note 2.
  const direction = String(row[COL.DIRECTION] || '').trim();
  const entityName = String(row[COL.ENTITY]).trim();
  const listStatus = String(row[COL.LIST_STATUS]).trim();
  const masterTrk = cleanTrackingNumber(row[COL.MASTER_TRACKING]);
  const currentStatus = String(row[COL.ROLLUP_STATUS]).trim();

  const isDropShip = resolveIsDropShip_(entityName, registry);

  // --- Case A: no master tracking number ----------------------------------
  // Nothing for FedEx to say. Preserve whatever the Trello-derived writers put
  // there; this engine has no opinion on a shipment it cannot track.
  if (!masterTrk) {
    const preservedStatus = currentStatus || 'PENDING';
    const statusUpper = preservedStatus.toUpperCase();
    let bucket;
    if (statusUpper === 'RECEIVED' || statusUpper === 'PACKED' ||
        statusUpper === 'DELIVERED IN FULL' || statusUpper === 'RECEIVED AND DROPS OFF' ||
        statusUpper === 'DELIVERED') {
      bucket = 'RECEIVED';
    } else if (statusUpper === 'PARTIAL PACK' || statusUpper === 'PARTIALLY RECEIVED' ||
               statusUpper === 'PARTIALLY DELIVERED' || statusUpper === 'PARTIAL RECEIPT') {
      // Old labels kept alongside the current ones so rows not yet touched by
      // migrateRollupStatusLabels() still tally correctly.
      bucket = 'PARTIAL';
    } else if (statusUpper === 'ON THE WAY' || statusUpper === 'SHIPPED' ||
               statusUpper === 'IN TRANSIT') {
      bucket = 'ON_THE_WAY';
    } else if (statusUpper === 'EXCEPTION') {
      bucket = 'EXCEPTION';
    } else {
      bucket = 'PENDING';
    }
    return {
      status: preservedStatus, bucket: bucket,
      newlyReceived: false, moveToShipped: false, masterTrk: masterTrk
    };
  }

  const currentUpper = currentStatus.toUpperCase();
  const listUpper = listStatus.toUpperCase();
  const listCls = classifyListStatus(listUpper);

  const isManualReceived =
      currentUpper === 'RECEIVED' || currentUpper === 'PACKED' ||
      currentUpper === 'DELIVERED IN FULL' || currentUpper === 'RECEIVED AND DROPS OFF' ||
      currentUpper === 'DELIVERED' || currentUpper === 'DONE' || currentUpper === 'COMPLETE' ||
      listCls.isReceived || listCls.isDelivered || listCls.isDone || listCls.isCompleted;

  const isManualPartial = currentUpper.includes('PARTIAL') || listUpper.includes('PARTIAL');

  // --- Case B: tracking exists, but no child boxes discovered yet ----------
  // Same preserve-before-defaulting rule as Case C. A row already confirmed
  // RECEIVED/DELIVERED/COMPLETE must not be silently downgraded to "On the Way"
  // just because the box list is momentarily empty (fixed 2026-08-21; this
  // branch used to set "On the Way" unconditionally).
  if (boxStatuses.length === 0) {
    if (isManualReceived) {
      return {status: currentStatus, bucket: 'RECEIVED', newlyReceived: false, moveToShipped: false, masterTrk: masterTrk};
    }
    if (isManualPartial) {
      return {status: currentStatus, bucket: 'PARTIAL', newlyReceived: false, moveToShipped: false, masterTrk: masterTrk};
    }
    return {status: 'On the Way', bucket: 'ON_THE_WAY', newlyReceived: false, moveToShipped: false, masterTrk: masterTrk};
  }

  // --- Case C: evaluate the hierarchy across discovered child boxes --------
  const totalBoxes = boxStatuses.length;
  let deliveredCount = 0;
  let hasException = false;

  for (let b = 0; b < totalBoxes; b++) {
    const st = boxStatuses[b];
    if (st.includes('DELIVERED')) {
      deliveredCount++;
    } else if (st.includes('EXCEPTION') || st.includes('ERROR') ||
               st.includes('DELAY') || st.includes('ADDRESS')) {
      hasException = true;
    }
  }

  // Board-freshness automation -- independent of the badge tree below.
  // See SCHEMA §7's note: staff don't reliably keep the packing checklist
  // current, so a card can sit in "TO BE SHIPPED" long after it physically
  // shipped. Requires a real carrier scan, not just a tracking number.
  let moveToShipped = false;
  if (direction === 'Outbound' && listCls.isToBeShipped && !hasException) {
    const hasPhysicalScan = boxStatuses.some(function(st) {
      return !isPreTransitFedExStatus_(st);
    });
    if (hasPhysicalScan) moveToShipped = true;
  }

  let finalBadge = currentStatus || 'On the Way';
  let bucket;
  let newlyReceived = false;

  if (hasException) {
    finalBadge = 'EXCEPTION';
    bucket = 'EXCEPTION';
  } else if (deliveredCount === totalBoxes && totalBoxes > 0) {
    if (isManualReceived) {
      finalBadge = currentStatus; // preserve manual completion
      bucket = 'RECEIVED';
    } else {
      finalBadge = isDropShip ? 'COMPLETE' : 'Delivered in Full';
      bucket = 'RECEIVED';
      // Only a NEW transition into fully-delivered arms the automation.
      newlyReceived = true;
    }
  } else if (deliveredCount > 0 && deliveredCount < totalBoxes) {
    if (isManualReceived) {
      finalBadge = currentStatus;
      bucket = 'RECEIVED';
    } else {
      finalBadge = 'Partially Delivered';
      bucket = 'PARTIAL';
    }
  } else {
    if (isManualReceived) {
      finalBadge = currentStatus;
      bucket = 'RECEIVED';
    } else if (isManualPartial) {
      finalBadge = currentStatus;
      bucket = 'PARTIAL';
    } else {
      finalBadge = 'On the Way';
      bucket = 'ON_THE_WAY';
    }
  }

  return {
    status: finalBadge, bucket: bucket,
    newlyReceived: newlyReceived, moveToShipped: moveToShipped, masterTrk: masterTrk
  };
}

/**
 * Finds the id of the list on a board that represents "Shipped" -- a list whose
 * name contains "SHIPPED" but ISN'T "TO BE SHIPPED". The exclusion is not
 * cosmetic: classifyListStatus's isShipped matches both, since "TO BE SHIPPED"
 * contains "SHIPPED" as a substring, so without it this would find the card's
 * own current list and move it nowhere.
 *
 * Cached per boardId in the caller-supplied Map, so a run moving many cards on
 * one board fetches that board's lists once.
 *
 * @param {string} boardId
 * @param {string} trelloKey
 * @param {string} trelloToken
 * @param {Map<string, string|null>} cache
 * @return {Promise<string|null>}
 */
async function findShippedListId_(boardId, trelloKey, trelloToken, cache) {
  if (cache.has(boardId)) return cache.get(boardId);

  let shippedListId = null;
  const listsRes = await trelloFetch_(
      `https://api.trello.com/1/boards/${boardId}/lists?key=${trelloKey}&token=${trelloToken}`,
      {}, {label: 'board lists (Shipped-list lookup)'});
  if (listsRes.ok) {
    const lists = JSON.parse(listsRes.text);
    const found = lists.find((l) => {
      const cls = classifyListStatus(l.name);
      return cls.isShipped && !cls.isToBeShipped;
    });
    shippedListId = found ? found.id : null;
  } else {
    logger.warn(`findShippedListId_: could not fetch lists for board ${boardId} -- ${listsRes.error}`);
  }

  cache.set(boardId, shippedListId);
  return shippedListId;
}

/**
 * Resolves the notification recipient list. See porting note 4 for why this
 * chain exists and why it ends in "skip" rather than a placeholder address.
 *
 * @return {Promise<Array<string>>} possibly empty.
 */
async function resolveStakeholderEmails_() {
  const readKey = (rows, key) => {
    if (!rows) return [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] && String(rows[i][0]).toUpperCase() === key) {
        return String(rows[i][1]).split(',').map((x) => x.trim()).filter((x) => x);
      }
    }
    return [];
  };

  let rows = null;
  try {
    rows = await SS_API.getSheetValues('Config!A:B');
  } catch (e) {
    logger.warn('resolveStakeholderEmails_: could not read the Config tab -- ' + e.message);
    return [];
  }

  const fedex = readKey(rows, 'FEDEX_STAKEHOLDER');
  if (fedex.length > 0) return fedex;
  return readKey(rows, 'STAKEHOLDER_EMAILS');
}

/**
 * Reads the "MPS Backend" tab into a master-tracking -> [child box statuses]
 * map. Column A is the master tracking number, column C the box status.
 *
 * @return {Promise<Map<string, Array<string>>>}
 */
async function buildMasterStatusMap_() {
  const masterStatusMap = new Map();
  let backendData = null;
  try {
    backendData = await SS_API.getSheetValues('MPS Backend!A:C');
  } catch (e) {
    // A missing MPS Backend tab is not an error -- it means discovery has never
    // run. Every row then takes Case B, which preserves rather than downgrades.
    logger.info('evaluateRollupStatuses: no MPS Backend tab readable -- ' + e.message);
    return masterStatusMap;
  }
  if (!backendData || backendData.length < 2) return masterStatusMap;

  for (let i = 1; i < backendData.length; i++) {
    const row = backendData[i];
    const masterTrk = cleanTrackingNumber(row[0]);
    const boxStatus = String(row[2] || '').trim().toUpperCase();
    if (!masterTrk) continue;
    if (!masterStatusMap.has(masterTrk)) masterStatusMap.set(masterTrk, []);
    masterStatusMap.get(masterTrk).push(boxStatus);
  }
  return masterStatusMap;
}

/**
 * Writer 3. Rolls every SHIPMENTS row's child-box statuses up into column J,
 * writes the column in one call, then runs the two automations.
 *
 * @param {Array<Object>} [registry] pre-fetched CUSTOMER_REGISTRY, so a caller
 *     already holding one (the scheduled sync) doesn't re-read the tab.
 * @return {Promise<Object>}
 */
async function evaluateRollupStatuses(registry) {
  const startTime = Date.now();
  try {
    const shipmentsData = await SS_API.getSheetValues('SHIPMENTS!A:J');
    if (!shipmentsData || shipmentsData.length < 2) {
      logger.info("No shipment records found in 'SHIPMENTS'.");
      return {success: true, evaluated: 0};
    }

    if (registry === undefined) {
      // Required lazily: Service_Read pulls in the dashboard payload builder,
      // and a top-level require here would make that a load-time dependency of
      // the scheduled sync for what is a single optional tab read.
      registry = await require('./Service_Read').getCustomerRegistry();
    }
    registry = registry || [];

    const masterStatusMap = await buildMasterStatusMap_();

    // Padded to A-J -- see porting note 6.
    const rows = padRows_(shipmentsData.slice(1), 10);
    const updatedStatuses = [];
    const counts = {RECEIVED: 0, PARTIAL: 0, ON_THE_WAY: 0, EXCEPTION: 0, PENDING: 0};
    const newlyReceivedRows = [];
    const cardsToMoveToShipped = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const boxStatuses = masterStatusMap.get(cleanTrackingNumber(row[COL.MASTER_TRACKING])) || [];

      const verdict = evaluateRollupRow_(row, boxStatuses, registry);

      updatedStatuses.push([verdict.status]);
      counts[verdict.bucket]++;

      if (verdict.newlyReceived) {
        newlyReceivedRows.push({
          rowIdx: i + 2, masterTrk: verdict.masterTrk, cardId: row[COL.CARD_ID]
        });
      }
      if (verdict.moveToShipped) {
        cardsToMoveToShipped.push({cardId: row[COL.CARD_ID], boardName: row[COL.BOARD_SOURCE]});
      }
    }

    // One write for the whole column -- see porting note 3.
    await SS_API.batchUpdateValues([{
      range: `SHIPMENTS!J2:J${updatedStatuses.length + 1}`,
      values: updatedStatuses
    }]);

    const creds = trelloCreds_();
    const trelloKey = creds.key;
    const trelloToken = creds.token;

    await runDeliveredInFullAutomation_(newlyReceivedRows, trelloKey, trelloToken);
    await runShippedListAutomation_(cardsToMoveToShipped, trelloKey, trelloToken);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(`Rollup evaluation complete in ${duration}s.`);
    logger.info(`Summary -> RECEIVED: ${counts.RECEIVED} | PARTIAL: ${counts.PARTIAL} | ` +
                `ON THE WAY: ${counts.ON_THE_WAY} | EXCEPTION: ${counts.EXCEPTION} | ` +
                `PENDING: ${counts.PENDING}`);

    return {
      success: true, evaluated: updatedStatuses.length, counts: counts,
      newlyReceived: newlyReceivedRows.length, movedToShipped: cardsToMoveToShipped.length
    };
  } catch (e) {
    logger.error('evaluateRollupStatuses failed', {error: e.toString(), stack: e.stack});
    return {success: false, error: e.toString()};
  }
}

/**
 * Marks each newly-fully-delivered card `dueComplete` on Trello and sends ONE
 * batched email covering every tracking number that flipped this run -- not one
 * email per tracking.
 *
 * @param {Array<Object>} newlyReceivedRows
 * @param {string} trelloKey
 * @param {string} trelloToken
 * @return {Promise<void>}
 */
async function runDeliveredInFullAutomation_(newlyReceivedRows, trelloKey, trelloToken) {
  if (newlyReceivedRows.length === 0) return;

  const emails = await resolveStakeholderEmails_();
  const deliveredTrackings = [];

  for (const item of newlyReceivedRows) {
    const cardId = item.cardId;
    const trk = item.masterTrk;
    logger.info(`Automation Triggered for row ${item.rowIdx} (Tracking: ${trk}, Card: ${cardId})`);

    if (cardId && trelloKey && trelloToken) {
      try {
        const res = await trelloFetch_(
            `https://api.trello.com/1/cards/${cardId}?key=${trelloKey}&token=${trelloToken}`,
            {method: 'put', payload: {dueComplete: true}},
            {label: 'mark dueComplete'});
        if (!res.ok) logger.warn('Trello update failed: ' + res.error);
      } catch (e) {
        logger.warn('Trello update failed: ' + e.message);
      }
    }

    deliveredTrackings.push(trk);
  }

  if (emails.length === 0) {
    // See porting note 4. Loud, and specific about what was NOT sent -- a
    // silent skip here is indistinguishable from "nothing was delivered".
    logger.error('evaluateRollupStatuses: ' + deliveredTrackings.length +
        ' shipment(s) reached Delivered in Full but NO notification was sent -- ' +
        'neither FEDEX_STAKEHOLDER nor STAKEHOLDER_EMAILS is set on the Config tab. ' +
        'Trackings: ' + deliveredTrackings.join(', '));
    return;
  }

  try {
    const listItems = deliveredTrackings.map((trk) => `<li>${trk}</li>`).join('');
    const subject = deliveredTrackings.length === 1
      ? `PO Delivered in Full: Tracking ${deliveredTrackings[0]}`
      : `PO Delivered in Full: ${deliveredTrackings.length} Trackings`;
    const plural = deliveredTrackings.length === 1 ? '' : 's';

    await Email.sendMail({
      to: emails.join(','),
      subject: subject,
      html: `<h3>Shipment${plural} Fully Received</h3><p>The following tracking number${plural} ` +
            `${plural ? 'have' : 'has'} been marked as fully delivered by carrier:</p><ul>${listItems}</ul>`
    }, 'delivered-in-full notification');
  } catch (e) {
    logger.warn(`Email failed: ${e.message}`);
  }
}

/**
 * Moves Outbound cards out of "TO BE SHIPPED" once FedEx shows a real carrier
 * scan. One list lookup per board, cached, rather than per card -- almost every
 * card here shares one of the same two Outbound boards.
 *
 * @param {Array<{cardId: string, boardName: string}>} cardsToMoveToShipped
 * @param {string} trelloKey
 * @param {string} trelloToken
 * @return {Promise<void>}
 */
async function runShippedListAutomation_(cardsToMoveToShipped, trelloKey, trelloToken) {
  if (cardsToMoveToShipped.length === 0 || !trelloKey || !trelloToken) return;

  const boardMatrix = getBoardMatrix_();
  const shippedListCache = new Map();
  let moved = 0;
  let moveFailed = 0;
  let moveSkipped = 0;

  for (const item of cardsToMoveToShipped) {
    const boardEntry = boardMatrix.find((b) => b.name === String(item.boardName || '').trim());
    if (!boardEntry) { moveSkipped++; continue; }

    const shippedListId = await findShippedListId_(boardEntry.id, trelloKey, trelloToken, shippedListCache);
    if (!shippedListId) {
      moveSkipped++;
      logger.warn(`evaluateRollupStatuses: no "Shipped"-classified list found on board ` +
                  `"${boardEntry.name}" -- cannot move card ${item.cardId}.`);
      continue;
    }

    const moveRes = await trelloFetch_(
        `https://api.trello.com/1/cards/${item.cardId}?idList=${shippedListId}&key=${trelloKey}&token=${trelloToken}`,
        {method: 'put'},
        {label: 'move to Shipped (physical scan detected)'});
    if (moveRes.ok) {
      moved++;
    } else {
      moveFailed++;
      logger.warn(`evaluateRollupStatuses: failed to move card ${item.cardId} to Shipped -- ${moveRes.error}`);
    }
  }

  if (moved > 0 || moveFailed > 0) {
    logger.info(`Shipped-list automation: moved ${moved} | failed ${moveFailed} | ` +
                `skipped (unresolvable board/list) ${moveSkipped}.`);
  }
}

/**
 * ONE-OFF: rewrites the three rollup-status labels renamed 2026-08-26 --
 *   "Received and Drops Off" -> "Delivered in Full"
 *   "Partially Received" (FedEx meaning)  -> "Partially Delivered"
 *   "PARTIAL RECEIPT" (receiving meaning) -> "Partially Received"
 *
 * Necessary because the preservation logic above echoes back whatever is
 * already in column J verbatim once a row reaches a manual-received/partial
 * state (`finalBadge = currentStatus`) -- a row already sitting on an old label
 * would never self-correct, no matter how many cycles run.
 *
 * Exact-match only, so it cannot cross-contaminate the two "Partial..."
 * renames with each other. Defaults to a dry run (reports every cell it would
 * change, writes nothing). Safe to re-run either way -- a second pass finds
 * nothing left to change.
 *
 * @param {boolean} [dryRun=true]
 * @return {Promise<Object>}
 */
async function migrateRollupStatusLabels(dryRun) {
  if (dryRun === undefined) dryRun = true;
  logger.info(`=== ROLLUP STATUS LABEL MIGRATION (dryRun=${dryRun}) ===`);

  const RENAME_MAP = {
    'RECEIVED AND DROPS OFF': 'Delivered in Full',
    'PARTIALLY RECEIVED': 'Partially Delivered',
    'PARTIAL RECEIPT': 'Partially Received'
  };

  const targets = [
    {sheetName: 'SHIPMENTS', col: 'J'},
    {sheetName: 'Shipment_History', col: 'K'}
  ];

  const report = {};
  for (const target of targets) {
    let values = null;
    try {
      values = await SS_API.getSheetValues(`${target.sheetName}!${target.col}:${target.col}`);
    } catch (e) {
      logger.warn(`[${target.sheetName}] not readable -- ${e.message}`);
      report[target.sheetName] = {changed: 0, skipped: true};
      continue;
    }
    if (!values || values.length < 2) {
      report[target.sheetName] = {changed: 0, skipped: true};
      continue;
    }

    const body = values.slice(1);
    let changed = 0;
    const next = body.map((row) => {
      const current = String((row && row[0]) || '').trim();
      const replacement = RENAME_MAP[current.toUpperCase()];
      if (replacement && current !== replacement) {
        changed++;
        logger.info(`[${target.sheetName}] "${current}" -> "${replacement}"`);
        return [replacement];
      }
      return [current];
    });

    if (changed > 0 && !dryRun) {
      await SS_API.batchUpdateValues([{
        range: `${target.sheetName}!${target.col}2:${target.col}${body.length + 1}`,
        values: next
      }]);
    }
    logger.info(`[${target.sheetName}] ${dryRun ? 'Would change' : 'Changed'}: ${changed}`);
    report[target.sheetName] = {changed: changed, skipped: false};
  }

  logger.info('=== MIGRATION COMPLETE ===');
  return {success: true, dryRun: dryRun, report: report};
}

module.exports = {
  evaluateRollupStatuses,
  migrateRollupStatusLabels,
  // Exported for test/parity_Rollup.js -- the decision tree is the thing worth
  // pinning against SRC, and the two helpers gate the board-freshness automation.
  evaluateRollupRow_,
  resolveIsDropShip_,
  isPreTransitFedExStatus_,
  findShippedListId_,
  COL
};
