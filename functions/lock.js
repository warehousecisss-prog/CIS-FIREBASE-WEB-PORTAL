/**
 * ============================================================================
 * INVENTORY WRITE LOCK -- a Firestore lease lock
 * ============================================================================
 *
 * THIS FILE IS DELIBERATELY DISPOSABLE SCAFFOLDING.
 *
 * It exists to replace one Apps Script primitive that Node does not have:
 * `LockService.getScriptLock()`. The intended end state for this project is a
 * Postgres database, which does per-row locking properly and automatically as
 * part of every transaction. When that migration happens, this file should be
 * deletable in ONE go -- delete `lock.js`, delete the `withInventoryLock(...)`
 * wrapper at each of its call sites, done. That is why the entire mechanism
 * lives behind a single function with a single argument shape, instead of
 * being spread across the write path as acquire/release pairs. Do not grow a
 * second entry point, and do not let lock state leak into the services.
 *
 *
 * WHAT IT IS PROTECTING
 * ---------------------
 * The write path is a read-compute-write against a Google Sheet:
 *
 *     read the whole Inventory tab  ->  work out which row  ->  write that row
 *
 * Nothing in Sheets makes those three steps one operation. Two writers that
 * interleave -- two floor stations, or a station and the background sync --
 * both read the same snapshot, both compute a row index from it, and the
 * second write silently lands on top of the first, or on a DIFFERENT pallet if
 * a row was inserted or deleted in between. Nobody is told. See
 * AUDIT_2026-08-24.md B7 and SCHEMA.md invariant #59.
 *
 * The original serialised this with `LockService.getScriptLock()` --
 * PROJECT-WIDE (one writer at a time across the whole spreadsheet), not
 * per-row -- at five places in `SRC/src/Service_Write.js` and two more in
 * `SRC/src/Fedex_Master_Script.js`. This is the Node equivalent, and it keeps
 * the original's project-wide scope deliberately: the write path resolves rows
 * by scanning a full-sheet snapshot, so a per-row lock would not protect the
 * scan that decides WHICH row to take.
 *
 *
 * WHY A LEASE, AND WHY THE TTL IS NOT OPTIONAL
 * -------------------------------------------
 * Apps Script releases a script lock when the script ends, whatever happens to
 * it. Cloud Functions has no such guarantee: a container can be frozen the
 * instant it responds, or killed outright, and a `finally` block does not run
 * in either case. A lock with no expiry would therefore wedge the entire write
 * path permanently the first time a writer died mid-critical-section -- every
 * operator on the floor stuck on "Server busy" forever, fixable only by hand.
 *
 * So every acquisition is a LEASE that expires on its own.
 *
 * TTL = 60 seconds, chosen against the platform limit rather than guessed:
 *
 *   - Cloud Functions' default request timeout is 60s. A request cannot
 *     outlive it, so a lease older than 60s is held by something that is
 *     definitionally no longer running. That makes 60s the SHORTEST TTL that
 *     can never expire underneath a writer that is still working -- and a TTL
 *     that expires early is worse than no lock at all, because it hands the
 *     lock to a second writer while the first is still mid-write, which is
 *     precisely the collision this file exists to prevent.
 *   - It is also the LONGEST an abandoned lease can block the floor. 60s of
 *     "Server busy" after a crashed write is unpleasant; a permanently wedged
 *     write path is an outage.
 *
 * IF THE FUNCTION TIMEOUT IS EVER RAISED ABOVE 60s, RAISE `LEASE_TTL_MS` TO
 * MATCH, or a long request will lose its lease while still writing. `release()`
 * logs an error if it finds its own lease already expired, so that mistake is
 * visible rather than silent.
 *
 *
 * WHAT HAPPENS WHEN FIRESTORE ITSELF IS UNREACHABLE -- fail OPEN, loudly
 * ---------------------------------------------------------------------
 * Deliberate, and the most consequential decision in this file.
 *
 * If the lock store cannot be reached at all (Firestore not enabled on the
 * project, IAM missing, network fault), this module logs an error, records
 * `lockDegraded: true` on the result, and RUNS THE WRITE ANYWAY, unlocked.
 *
 * The alternative -- refusing every write when the lock store is unreachable --
 * turns Firestore into a hard dependency of every inventory adjustment in the
 * building. A misconfiguration would take the whole warehouse down, and it
 * would announce itself as "Server busy. Please try again.", which points the
 * operator at the wrong problem entirely. Failing open is never worse than the
 * status quo (the write path was completely unlocked before this file existed)
 * and the failure is loud in two places, so it cannot rot unnoticed.
 *
 * CONTENTION IS DIFFERENT, AND NEVER FAILS OPEN. If the store answers, and the
 * answer is "someone else holds it", the write is refused with SRC's exact
 * string. That is the whole point.
 *
 *
 * ERROR TEXT IS LOAD-BEARING
 * --------------------------
 * `SERVER_BUSY_ERROR` must stay byte-identical to SRC's
 * "Server busy. Please try again." -- `runMutation()` in `JS_State.html`
 * surfaces it verbatim and SCHEMA.md invariant #37 names it as one of the two
 * strings the client is required not to swallow. Do not reword it.
 */

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const logger = require('firebase-functions/logger');

/** SRC/src/Service_Write.js:754 — byte-identical. See the header. */
const SERVER_BUSY_ERROR = 'Server busy. Please try again.';

/** Firestore collection/doc holding the single project-wide lease. */
const LOCK_COLLECTION = '_portal_locks';
const LOCK_DOC_ID = 'inventory';

/** See "WHY A LEASE" above. Raise in lockstep with the function timeout. */
const LEASE_TTL_MS = 60 * 1000;

/**
 * How long to keep trying before answering "Server busy".
 * Matches SRC's `tryLock(10000)` exactly: brief contention resolves invisibly,
 * sustained contention tells the operator rather than queueing indefinitely.
 */
const ACQUIRE_TIMEOUT_MS = 10 * 1000;

/**
 * Per-round-trip deadline on the lock store. A store that has not answered in
 * this long is unreachable, not contended -- the two are handled completely
 * differently (see the header), so they have to be distinguishable.
 */
const STORE_TIMEOUT_MS = 4 * 1000;

/**
 * After an unreachable-store failure, stop calling the store for this long.
 * Without it, every write on a project where Firestore is not enabled pays the
 * full STORE_TIMEOUT_MS before proceeding -- which is how a degraded lock turns
 * into an apparent app-wide slowdown.
 */
const BREAKER_COOLDOWN_MS = 60 * 1000;

/** Retry spacing while waiting out contention, jittered to avoid lock-step. */
const RETRY_MIN_MS = 40;
const RETRY_MAX_MS = 160;

/**
 * Tracks lock ownership across `await` boundaries within one request.
 *
 * SCHEMA.md invariant #59: "Nothing that already holds the script lock may call
 * modifySheetRow -- Apps Script locks are not reentrant, so a nested
 * acquisition deadlocks until timeout." That is a live footgun in the original,
 * defused here rather than reproduced: a nested `withInventoryLock` inside a
 * call that already holds the lease simply runs its body. Node's
 * AsyncLocalStorage is a core module, so this costs no dependency.
 */
const heldLock = new AsyncLocalStorage();

/** Injectable for tests; `null` means "build the Firestore-backed store". */
let storeOverride = null;
let cachedStore = null;

/** Epoch ms until which the store is presumed unreachable. 0 = closed. */
let breakerOpenUntil = 0;

/**
 * Decides whether a lease may be taken, given whatever the store currently
 * holds. Split out as a pure function on purpose: it is the only actual
 * *decision* in this file, so it is testable without a Firestore anywhere.
 *
 * @param {?Object} existing the stored lease, or null when the doc is absent.
 * @param {number} now epoch ms.
 * @return {{acquired: boolean, heldBy?: string, expiresAt?: number}}
 */
function decideAcquire(existing, now) {
  const expiresAt = existing ? Number(existing.expiresAt) : 0;
  // `>` not `>=`: a lease whose expiry is exactly now has expired.
  if (existing && isFinite(expiresAt) && expiresAt > now) {
    return { acquired: false, heldBy: existing.label || 'another writer', expiresAt };
  }
  return { acquired: true };
}

/**
 * True when a store error means "someone else is writing" rather than "the
 * store is broken". Firestore aborts a transaction (gRPC code 10) when another
 * transaction touched the same document first; the admin SDK retries a few
 * times and then throws. That is contention, and answering it by failing OPEN
 * would drop the lock exactly when it is most needed.
 *
 * @param {Error} e
 * @return {boolean}
 */
function isContentionError(e) {
  if (!e) return false;
  if (e.code === 10) return true; // gRPC ABORTED
  return /\bABORTED\b/i.test(String(e.message || ''));
}

/** @return {string} a token unique to one acquisition. */
function mintToken() {
  return crypto.randomUUID();
}

/**
 * @param {number} ms
 * @return {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rejects if `promise` has not settled within `ms`.
 *
 * @param {Promise<*>} promise
 * @param {number} ms
 * @param {string} what named in the timeout error.
 * @return {Promise<*>}
 */
function withDeadline(promise, ms, what) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(what + ' did not answer within ' + ms + 'ms.');
      e.lockStoreTimeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The Firestore-backed store. This is the ONLY Firestore-specific code in the
 * file; everything else is plain logic. Both operations are transactions, which
 * is what makes "check then take" a single atomic step -- a plain get-then-set
 * would have exactly the race this module exists to close, one layer down.
 *
 * `require('./admin')` is deferred to first use so that merely loading this
 * module (which `Service_Write` does at require time, which the deploy-time
 * analysis pass does for every function) never touches Firestore.
 *
 * @return {{tryAcquire: Function, release: Function, peek: Function}}
 */
function firestoreStore() {
  const admin = require('./admin');
  const db = admin.firestore();
  const ref = db.collection(LOCK_COLLECTION).doc(LOCK_DOC_ID);

  return {
    /**
     * @param {{token: string, label: string}} meta
     * @return {Promise<{acquired: boolean, heldBy?: string, expiresAt?: number}>}
     */
    async tryAcquire(meta) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        // Read the clock INSIDE the transaction: the SDK re-runs the body on
        // abort, and a timestamp captured outside would age across retries.
        const now = Date.now();
        const verdict = decideAcquire(snap.exists ? snap.data() : null, now);
        if (!verdict.acquired) return verdict;
        tx.set(ref, {
          token: meta.token,
          label: meta.label,
          acquiredAt: now,
          expiresAt: now + LEASE_TTL_MS
        });
        return { acquired: true, expiresAt: now + LEASE_TTL_MS };
      });
    },

    /**
     * Releases only if we are still the holder. A lease that expired and was
     * taken by someone else must not be deleted out from under them.
     *
     * @param {string} token
     * @return {Promise<{released: boolean, wasExpired: boolean}>}
     */
    async release(token) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { released: false, wasExpired: true };
        const data = snap.data();
        if (data.token !== token) return { released: false, wasExpired: true };
        const wasExpired = Number(data.expiresAt) <= Date.now();
        tx.delete(ref);
        return { released: true, wasExpired };
      });
    },

    /**
     * Diagnostics only -- never used to decide anything.
     *
     * @return {Promise<?Object>}
     */
    async peek() {
      const snap = await ref.get();
      return snap.exists ? snap.data() : null;
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
 * Runs `fn` with the project-wide inventory write lease held.
 *
 * The ONLY entry point. See the header for why that is deliberate.
 *
 * Three outcomes:
 *
 *   - lease acquired      -> `fn()` runs, its result is returned unchanged,
 *                            the lease is released in a `finally`.
 *   - someone else holds  -> `fn()` NEVER RUNS. Returns
 *                            `{success:false, error:"Server busy. Please try
 *                            again."}` -- SRC's exact refusal.
 *   - store unreachable   -> `fn()` runs UNLOCKED (see the header), its result
 *                            is tagged `lockDegraded:true`, and an error is
 *                            logged.
 *
 * Reentrant: calling this from inside a call that already holds the lease runs
 * `fn` directly instead of deadlocking (SCHEMA invariant #59).
 *
 * @param {Function} fn async () => result. Must be idempotent-safe to skip:
 *     on contention it is not called at all.
 * @param {{label?: string}} [opts] label appears in logs and in the stored
 *     lease, so a wedged lock names what was holding it.
 * @return {Promise<*>} `fn`'s result, or the Server-busy refusal.
 */
async function withInventoryLock(fn, opts) {
  const label = (opts && opts.label) || 'inventory write';

  // --- reentrancy ---------------------------------------------------------
  const outer = heldLock.getStore();
  if (outer) {
    logger.debug('withInventoryLock: already held by ' + outer.label +
                 ', running ' + label + ' inside it');
    return fn();
  }

  // --- breaker open: the store was unreachable recently -------------------
  if (Date.now() < breakerOpenUntil) {
    return runDegraded(fn, label, 'lock store is in cooldown after an earlier failure');
  }

  const token = mintToken();
  const store = getStore();
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  let lastHeldBy = null;

  for (;;) {
    let verdict;
    try {
      verdict = await withDeadline(
        store.tryAcquire({ token, label }), STORE_TIMEOUT_MS, 'lock store');
    } catch (e) {
      if (isContentionError(e)) {
        // Contention dressed as an error. Keep waiting it out; do NOT fail open.
        if (Date.now() >= deadline) {
          logger.warn('withInventoryLock: giving up after ' + ACQUIRE_TIMEOUT_MS +
                      'ms of contention', { label });
          return { success: false, error: SERVER_BUSY_ERROR };
        }
        await sleep(RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS)));
        continue;
      }
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      logger.error('withInventoryLock: lock store unreachable -- PROCEEDING ' +
                   'WITHOUT A LOCK. Concurrent writes to the same Inventory row ' +
                   'can overwrite each other until this is fixed.', {
        label,
        error: e.message,
        hint: 'Is Firestore enabled on this project, and does the function ' +
              'service account have Cloud Datastore User?'
      });
      return runDegraded(fn, label, e.message);
    }

    if (verdict && verdict.acquired) break;

    lastHeldBy = (verdict && verdict.heldBy) || lastHeldBy;
    if (Date.now() >= deadline) {
      logger.warn('withInventoryLock: ' + label + ' refused -- lock held by ' +
                  (lastHeldBy || 'another writer') + ' for the full ' +
                  ACQUIRE_TIMEOUT_MS + 'ms wait', { label, heldBy: lastHeldBy });
      return { success: false, error: SERVER_BUSY_ERROR };
    }
    await sleep(RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS)));
  }

  // --- held ---------------------------------------------------------------
  try {
    return await heldLock.run({ token, label }, fn);
  } finally {
    // Released in a finally so a throw inside `fn` still frees the lock for the
    // next operator instead of parking it for the full TTL. A release that
    // fails is not worth failing the write over -- the lease expires anyway --
    // but it is worth a log line.
    try {
      const out = await withDeadline(store.release(token), STORE_TIMEOUT_MS, 'lock release');
      if (out && out.wasExpired) {
        logger.error('withInventoryLock: ' + label + ' held its lease past the ' +
                     LEASE_TTL_MS + 'ms TTL. Another writer may have run ' +
                     'concurrently. Raise LEASE_TTL_MS or shorten the critical ' +
                     'section.', { label });
      }
    } catch (e) {
      logger.warn('withInventoryLock: could not release the lease for ' + label +
                  '; it will expire on its own within ' + LEASE_TTL_MS + 'ms',
      { label, error: e.message });
    }
  }
}

/**
 * Runs `fn` with no lock held and marks the result so the degradation is
 * visible to the caller and, via the route wrappers' rule 5, to the client.
 *
 * @param {Function} fn
 * @param {string} label
 * @param {string} reason
 * @return {Promise<*>}
 */
async function runDegraded(fn, label, reason) {
  const result = await fn();
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    // Non-destructive: never overwrites a key the service set itself.
    if (result.lockDegraded === undefined) result.lockDegraded = true;
    if (result.lockDegradedReason === undefined) result.lockDegradedReason = reason;
  }
  return result;
}

/**
 * Test seam. Swaps the Firestore store for a fake implementing the same three
 * methods. Pass `null` to restore. Also clears the breaker, so one test's
 * simulated outage cannot leak into the next.
 *
 * @param {?Object} store
 */
function __setStoreForTests(store) {
  storeOverride = store;
  cachedStore = null;
  breakerOpenUntil = 0;
}

/** Test seam: forget any open breaker. */
function __resetBreakerForTests() {
  breakerOpenUntil = 0;
}

module.exports = {
  withInventoryLock,
  SERVER_BUSY_ERROR,
  LEASE_TTL_MS,
  ACQUIRE_TIMEOUT_MS,
  STORE_TIMEOUT_MS,
  BREAKER_COOLDOWN_MS,
  LOCK_COLLECTION,
  LOCK_DOC_ID,
  // exported for the parity/unit tests only
  decideAcquire,
  isContentionError,
  __setStoreForTests,
  __resetBreakerForTests
};
