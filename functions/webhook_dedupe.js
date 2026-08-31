const crypto = require('crypto');
const logger = require('firebase-functions/logger');

/**
 * ============================================================================
 * WEBHOOK EVENT DE-BOUNCE -- a Firestore first-claim record
 * ============================================================================
 *
 * LIKE lock.js, THIS IS DELIBERATELY DISPOSABLE SCAFFOLDING, and for the same
 * reason: it replaces one Apps Script primitive Node does not have --
 * `CacheService.getScriptCache()`. One entry point, one argument shape, so it
 * can be deleted in one go if the storage ever moves.
 *
 *
 * WHAT IT IS PROTECTING
 * ---------------------
 * Trello re-delivers the same webhook action more than once. Without a
 * de-bounce, one card move gets processed two or three times -- each one a
 * full SHIPMENTS read, a Trello checklist fetch, and a row write.
 *
 *
 * THE KEY IS THE EVENT, NOT THE CARD -- DO NOT NARROW THIS
 * -------------------------------------------------------
 * SCHEMA.md invariant #43 is explicit, and it is written that way because the
 * card-scoped version caused a real, reproducible bug (SCHEMA §7, the
 * 2026-08-12 PO 3571 incident):
 *
 *   The original keyed on `webhook_lock_<cardId>` with a 3-second window, so
 *   ANY second event for a card inside 3 seconds was dropped. Moving a card
 *   and labelling it in quick succession lost the second change entirely. In
 *   the recorded incident, a checkItem event and the follow-up card-move event
 *   collided, the move was discarded, and the shipment showed a stale
 *   PARTIAL RECEIPT for hours.
 *
 * `webhookEventKey_()` (Service_Webhook.js) therefore hashes the action's
 * id/type/date/data, so only a byte-identical re-delivery is dropped and
 * genuinely distinct events are each processed. This module only stores that
 * key. **Do not re-key it on the card.**
 *
 *
 * WHY IT FAILS OPEN, WHICH IS THE OPPOSITE OF lock.js
 * --------------------------------------------------
 * `lock.js` fails open too, but grudgingly. Here it is the clearly correct
 * behaviour, because the two failure modes are wildly asymmetric:
 *
 *   - de-bounce wrongly says "new"       -> the event is processed twice. The
 *                                           handler is idempotent (it ends in
 *                                           a row upsert with its own
 *                                           no-change early return), so the
 *                                           cost is a little wasted work.
 *   - de-bounce wrongly says "duplicate" -> the event is dropped, and Trello
 *                                           will not send it again. The change
 *                                           is invisible until the next
 *                                           scheduled sync.
 *
 * So when Firestore is unreachable, every event is treated as new.
 *
 *
 * TTL = 20 seconds, matching the original's `cache.put(eventKey, 'true', 20)`.
 * Long enough to cover Trello's re-delivery window, short enough that a
 * genuinely repeated user action minutes later is not mistaken for a duplicate.
 *
 * CLEANUP: claim records are ~120 bytes and expire logically, not physically.
 * Set a Firestore TTL policy on this collection's `expiresAt` field at deploy
 * time (one console setting, same list as "enable Firestore"), or the
 * collection grows by one tiny document per distinct Trello event forever.
 * Nothing breaks without it -- reads are by document id, so query cost does not
 * grow -- it is a storage-tidiness step, not a correctness one.
 * ============================================================================
 */

const DEDUPE_COLLECTION = 'webhook_dedupe';
const CLAIM_TTL_MS = 20 * 1000;

/** Firestore must answer fast; a webhook cannot wait on it. */
const STORE_DEADLINE_MS = 3000;

let cachedStore = null;
let storeOverride = null;

/**
 * @param {number} ms
 * @param {string} what
 * @param {Promise<*>} promise
 * @return {Promise<*>}
 */
function withDeadline(promise, ms, what) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(what + ' did not answer within ' + ms + 'ms.');
      e.dedupeStoreTimeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The Firestore-backed store. A transaction, not a get-then-set: two copies of
 * the same re-delivered event can land on two container instances at the same
 * moment, and a non-atomic check would let both through -- which is the exact
 * duplicate this module exists to stop.
 *
 * `require('./admin')` is deferred to first use so that merely loading this
 * module never touches Firestore (the deploy-time analysis pass loads every
 * function file).
 *
 * @return {{claim: Function}}
 */
function firestoreStore() {
  const admin = require('./admin');
  const db = admin.firestore();

  return {
    /**
     * @param {string} eventKey
     * @return {Promise<{claimed: boolean}>} claimed:true means "first sighting,
     *     process it"; claimed:false means "already seen, drop it".
     */
    async claim(eventKey) {
      const ref = db.collection(DEDUPE_COLLECTION).doc(eventKey);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        // Read the clock inside the transaction -- the SDK re-runs the body on
        // abort, and a timestamp captured outside would age across retries.
        const now = Date.now();
        if (snap.exists && Number(snap.data().expiresAt) > now) {
          return {claimed: false};
        }
        tx.set(ref, {claimedAt: now, expiresAt: now + CLAIM_TTL_MS});
        return {claimed: true};
      });
    }
  };
}

/** @return {Object} the active store. */
function getStore() {
  if (storeOverride) return storeOverride;
  if (!cachedStore) cachedStore = firestoreStore();
  return cachedStore;
}

/**
 * Claims one webhook event. THE ONLY ENTRY POINT.
 *
 * @param {string} eventKey from webhookEventKey_() -- an event hash, never a
 *     bare card id. See the header.
 * @return {Promise<{isNew: boolean, degraded: boolean}>} `isNew:false` means
 *     drop this delivery. `degraded:true` means the store could not be reached
 *     and the event was let through unchecked.
 */
async function claimWebhookEvent(eventKey) {
  if (!eventKey) {
    // No key means the fingerprint could not be built. Process it -- see the
    // asymmetry argument in the header.
    return {isNew: true, degraded: true};
  }
  try {
    const result = await withDeadline(
        getStore().claim(eventKey), STORE_DEADLINE_MS, 'webhook de-dupe store');
    return {isNew: !!result.claimed, degraded: false};
  } catch (e) {
    logger.error('Webhook de-dupe store unreachable -- processing this event ' +
        'UNCHECKED, so a Trello re-delivery may be handled twice. This is the ' +
        'deliberate fail-open direction (a dropped webhook is unrecoverable, a ' +
        'duplicate one is merely wasteful).', {error: e.message, eventKey: eventKey});
    return {isNew: true, degraded: true};
  }
}

/**
 * Deterministic key for one specific Trello action.
 *
 * Byte-compatible with SRC's `webhookEventKey_` (Webhook_Receiver.js): the same
 * `{id, type, date, data}` field order, the same JSON serialisation, the same
 * MD5, the same lowercase hex, the same `webhook_evt_` prefix. MD5 is not doing
 * security work here -- it is a fingerprint -- and keeping it identical means
 * the port and the original agree on what "the same event" is, which the parity
 * harness checks directly.
 *
 * Falls back to the pre-fix card-scoped key if the action cannot be serialised,
 * exactly as SRC does. That is a strictly worse key (see the header) but it is
 * only reachable when the payload is already malformed.
 *
 * @param {string} cardId
 * @param {Object} action
 * @return {string}
 */
function webhookEventKey_(cardId, action) {
  try {
    const fingerprint = JSON.stringify({
      id: action.id || '',
      type: action.type || '',
      date: action.date || '',
      data: action.data || {}
    });
    const digest = crypto.createHash('md5').update(fingerprint).digest('hex');
    return 'webhook_evt_' + digest;
  } catch (e) {
    return 'webhook_lock_' + cardId;
  }
}

/** Test seam. Mirrors lock.js's. */
function __setStoreForTests(store) {
  storeOverride = store;
  cachedStore = null;
}

module.exports = {
  claimWebhookEvent,
  webhookEventKey_,
  DEDUPE_COLLECTION,
  CLAIM_TTL_MS,
  __setStoreForTests
};
