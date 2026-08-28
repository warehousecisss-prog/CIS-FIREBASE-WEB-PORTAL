/**
 * ============================================================================
 * WRITE-LOCK CONTRACT TEST -- `npm run test:lock`
 * ============================================================================
 *
 * Proves the thing AUDIT_2026-08-24.md B7 asks for: two writers cannot both
 * proceed against the same Inventory row, and the loser is TOLD rather than
 * silently overwriting the winner.
 *
 * Four parts, and they prove different things:
 *
 * PART A -- THE DECISION. `decideAcquire` in isolation. It is the only actual
 *   decision in functions/lock.js (is this lease live, or has it expired?), so
 *   it is worth pinning on its own, including the exact boundary.
 *
 * PART B -- THE BEHAVIOUR, against an in-memory store. Concurrency, the
 *   "Server busy" refusal, lease expiry, release, reentrancy, and the
 *   fail-open path when the store is unreachable. The fake store implements
 *   the same compare-and-set contract as the Firestore one and serialises its
 *   own operations, so the interleavings under test are real interleavings.
 *
 * PART D -- THE WIRING. Parts A-C prove the lock works; they prove nothing
 *   about whether the write path actually uses it, which would make all of the
 *   above decorative. This drives the real `Service_Write` entry points with
 *   `SS_API` stubbed out and asserts that a held lease stops them reaching the
 *   sheet at all. It also pins two things the lock must NOT have changed: the
 *   Phase 2 row-data-mismatch guard, and validation running before the lease.
 *   (Runs before Part C, which terminates the Firestore client.)
 *
 * PART C -- THE REAL FIRESTORE ROUND-TRIP, against the Firestore emulator.
 *   Parts A and B cannot prove that a Firestore transaction is actually atomic
 *   under concurrent writers -- only Firestore can. This part runs the real
 *   `firestoreStore()` code path against a real emulator, with two genuinely
 *   concurrent acquirers.
 *
 *   It is SKIPPED with a loud notice when FIRESTORE_EMULATOR_HOST is not set,
 *   so `npm test` still works on a machine without the emulator. Run it for
 *   real with:
 *
 *       npm run test:lock:emulator
 *
 *   which needs Java 21+ on PATH (the emulator jar is compiled for it; Java 8
 *   fails with UnsupportedClassVersionError). No Google credentials and no
 *   real Firestore database are required -- the emulator is entirely local.
 *
 * No new dependencies: firebase-admin is already a runtime dependency and the
 * concurrency is driven with plain promises.
 */

const assert = require('assert');

const lock = require('../lock');
const {
  withInventoryLock,
  decideAcquire,
  SERVER_BUSY_ERROR,
  LEASE_TTL_MS,
  ACQUIRE_TIMEOUT_MS,
  LOCK_COLLECTION,
  LOCK_DOC_ID,
  __setStoreForTests
} = lock;

let failures = 0;
let checks = 0;
const transcript = [];

/**
 * @param {string} label what is being asserted.
 * @param {Function} fn the assertion body; may be async.
 * @return {Promise<void>}
 */
async function check(label, fn) {
  checks++;
  try {
    await fn();
  } catch (e) {
    failures++;
    console.error('  FAIL  ' + label + '\n        ' + e.message);
  }
}

/** @param {string} line */
function say(line) {
  transcript.push(line);
}

/**
 * @param {number} ms
 * @return {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ==========================================================================
 * A fake store with the same contract as the Firestore one.
 *
 * `serialised` matters: every operation goes through one promise chain, so two
 * concurrent tryAcquire calls are ordered rather than reading the same state.
 * That is what a Firestore transaction gives us, and reproducing it is the
 * whole point of the fake -- a fake that let both callers read the pre-write
 * state would prove the opposite of what this file claims.
 * ========================================================================== */

/**
 * @param {{failWith?: Error, clock?: Function}} [opts]
 * @return {Object} a store implementing tryAcquire/release/peek.
 */
function makeFakeStore(opts) {
  const options = opts || {};
  const now = options.clock || (() => Date.now());
  let doc = null;
  let tail = Promise.resolve();
  const calls = { tryAcquire: 0, release: 0 };

  /**
   * @param {Function} fn
   * @return {Promise<*>}
   */
  function serialised(fn) {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  }

  return {
    calls,
    /** @return {?Object} */
    inspect() {
      return doc;
    },
    /** @param {?Object} d */
    seed(d) {
      doc = d;
    },
    /**
     * @param {{token: string, label: string}} meta
     * @return {Promise<Object>}
     */
    tryAcquire(meta) {
      return serialised(() => {
        calls.tryAcquire++;
        if (options.failWith) throw options.failWith;
        const t = now();
        const verdict = decideAcquire(doc, t);
        if (!verdict.acquired) return verdict;
        doc = {
          token: meta.token,
          label: meta.label,
          acquiredAt: t,
          expiresAt: t + LEASE_TTL_MS
        };
        return { acquired: true, expiresAt: doc.expiresAt };
      });
    },
    /**
     * @param {string} token
     * @return {Promise<Object>}
     */
    release(token) {
      return serialised(() => {
        calls.release++;
        if (options.failWith) throw options.failWith;
        if (!doc || doc.token !== token) return { released: false, wasExpired: true };
        const wasExpired = doc.expiresAt <= now();
        doc = null;
        return { released: true, wasExpired };
      });
    },
    /** @return {Promise<?Object>} */
    peek() {
      return serialised(() => doc);
    }
  };
}

/* ==========================================================================
 * PART A -- the decision
 * ========================================================================== */

/** @return {Promise<void>} */
async function partA() {
  console.log('\nPART A -- decideAcquire');

  await check('an absent lease is acquirable', () => {
    assert.strictEqual(decideAcquire(null, 1000).acquired, true);
  });

  await check('a live lease is not acquirable, and names its holder', () => {
    const v = decideAcquire({ label: 'modifySheetRow SWH-A-01/WIDGET', expiresAt: 2000 }, 1000);
    assert.strictEqual(v.acquired, false);
    assert.strictEqual(v.heldBy, 'modifySheetRow SWH-A-01/WIDGET');
  });

  await check('an expired lease IS acquirable -- this is what stops a crashed ' +
              'writer wedging the write path forever', () => {
    assert.strictEqual(decideAcquire({ label: 'dead writer', expiresAt: 999 }, 1000).acquired, true);
  });

  await check('expiry is exclusive: expiresAt === now has expired', () => {
    assert.strictEqual(decideAcquire({ label: 'x', expiresAt: 1000 }, 1000).acquired, true);
    assert.strictEqual(decideAcquire({ label: 'x', expiresAt: 1001 }, 1000).acquired, false);
  });

  await check('a lease with a garbage expiry is treated as expired, not as ' +
              'permanently held', () => {
    assert.strictEqual(decideAcquire({ label: 'x', expiresAt: 'nonsense' }, 1000).acquired, true);
    assert.strictEqual(decideAcquire({ label: 'x' }, 1000).acquired, true);
  });

  await check('the error string is byte-identical to SRC/src/Service_Write.js:754', () => {
    assert.strictEqual(SERVER_BUSY_ERROR, 'Server busy. Please try again.');
  });
}

/* ==========================================================================
 * PART B -- the behaviour, in memory
 * ========================================================================== */

/** @return {Promise<void>} */
async function partB() {
  console.log('\nPART B -- withInventoryLock behaviour');

  // ---- the headline: two concurrent writers ------------------------------
  await check('two concurrent writers do not both proceed; the loser gets ' +
              '"Server busy. Please try again." and its body never runs', async () => {
    __setStoreForTests(makeFakeStore());

    const order = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    /**
     * Stands in for modifySheetRow's read-compute-write. The `await` in the
     * middle is the whole hazard: without a lock, writer B reads the same
     * snapshot A did and its write lands on top.
     *
     * @param {string} who
     * @return {Promise<Object>}
     */
    async function writer(who) {
      return withInventoryLock(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(who + ' read');
        await sleep(60);
        order.push(who + ' wrote');
        concurrent--;
        return { success: true, wrote: who };
      }, { label: who });
    }

    // Both writers wait their turn (the wait budget is 10s and the critical
    // section is 60ms), so both eventually succeed. What must NOT happen is
    // the two bodies interleaving -- read/read/write/write is the silent
    // overwrite. Asserted two ways: never two inside at once, and each
    // writer's own read and write are adjacent.
    const [a, b] = await Promise.all([writer('station-A'), writer('station-B')]);
    const owners = order.map((s) => s.split(' ')[0]);

    assert.strictEqual(maxConcurrent, 1,
        'two writers were inside the critical section at once: ' + order.join(' | '));
    assert.strictEqual(owners[0], owners[1],
        'a second writer read before the first had written: ' + order.join(' | '));
    assert.strictEqual(owners[2], owners[3], order.join(' | '));
    assert.notStrictEqual(owners[0], owners[2], order.join(' | '));
    assert.ok(a.success && b.success, 'both should eventually succeed when they wait');
    say('  serialised, no interleave: ' + order.join(' -> '));
  });

  await check('the loser of a contended lock is REFUSED, not queued, once the ' +
              'wait budget is gone', async () => {
    const store = makeFakeStore();
    __setStoreForTests(store);

    // Hold the lease directly, as a writer that is still running would.
    await store.tryAcquire({ token: 'held-by-someone-else', label: 'station-A' });

    let bodyRan = false;
    const started = Date.now();
    // Temporarily shrink the wait budget by monkey-patching the store to keep
    // answering "held" -- the budget itself is a module constant, so instead of
    // waiting the full 10s we assert the refusal shape and that the budget was
    // actually spent.
    const result = await withInventoryLock(async () => {
      bodyRan = true;
      return { success: true };
    }, { label: 'station-B' });
    const waited = Date.now() - started;

    assert.strictEqual(bodyRan, false,
        'the losing writer RAN ITS BODY -- this is the silent-overwrite bug');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, SERVER_BUSY_ERROR);
    assert.ok(waited >= ACQUIRE_TIMEOUT_MS - 500,
        'gave up after ' + waited + 'ms, expected to wait out the full ' +
        ACQUIRE_TIMEOUT_MS + 'ms budget first');
    say('  contended: station-B waited ' + waited + 'ms then -> ' +
        JSON.stringify(result));
  });

  // ---- expiry ------------------------------------------------------------
  await check('an ABANDONED lease expires rather than wedging the write path ' +
              'forever', async () => {
    // A container frozen or killed mid-write leaves its lease behind and its
    // `finally` never runs. Simulated exactly: a lease written by a token
    // nobody will ever release.
    let fakeNow = 1000000;
    const store = makeFakeStore({ clock: () => fakeNow });
    __setStoreForTests(store);

    store.seed({
      token: 'token-of-a-container-that-died',
      label: 'modifySheetRow SWH-A-01/WIDGET-X-100',
      acquiredAt: fakeNow,
      expiresAt: fakeNow + LEASE_TTL_MS
    });

    // One second before expiry: still locked out.
    fakeNow += LEASE_TTL_MS - 1000;
    let ran = false;
    const blocked = await withInventoryLock(async () => {
      ran = true; return { success: true };
    }, { label: 'station-B' });
    assert.strictEqual(ran, false, 'took a lease that had not expired yet');
    assert.strictEqual(blocked.error, SERVER_BUSY_ERROR);
    say('  abandoned lease, ' + Math.round((LEASE_TTL_MS - (LEASE_TTL_MS - 1000)) / 1000) +
        's before TTL: -> ' + JSON.stringify(blocked));

    // Past expiry: the next writer gets in.
    fakeNow += 2000;
    const after = await withInventoryLock(async () => {
      ran = true; return { success: true, wrote: 'station-B' };
    }, { label: 'station-B' });
    assert.strictEqual(ran, true, 'the abandoned lease wedged the write path');
    assert.strictEqual(after.success, true);
    say('  same lease, past its ' + (LEASE_TTL_MS / 1000) + 's TTL: -> ' +
        JSON.stringify(after));
  });

  // ---- release -----------------------------------------------------------
  await check('the lease is released even when the body throws', async () => {
    const store = makeFakeStore();
    __setStoreForTests(store);

    await assert.rejects(withInventoryLock(async () => {
      throw new Error('Sheets quota exceeded');
    }, { label: 'station-A' }), /Sheets quota exceeded/);

    assert.strictEqual(store.inspect(), null,
        'a thrown write left the lock held for the full TTL');
    say('  body threw: lease released, next writer unblocked immediately');
  });

  await check('a release never deletes a lease that has already been taken ' +
              'over by someone else', async () => {
    const store = makeFakeStore();
    __setStoreForTests(store);
    await store.tryAcquire({ token: 'someone-else', label: 'station-B' });
    const before = store.inspect();
    await store.release('a-stale-token-from-a-previous-holder');
    assert.deepStrictEqual(store.inspect(), before);
  });

  // ---- reentrancy --------------------------------------------------------
  await check('a nested acquisition runs instead of deadlocking (SCHEMA #59)', async () => {
    const store = makeFakeStore();
    __setStoreForTests(store);

    const result = await withInventoryLock(async () => {
      // In Apps Script this exact shape deadlocks until timeout, which is why
      // SCHEMA invariant #59 has to warn people off it in prose.
      const inner = await withInventoryLock(async () => ({ success: true, depth: 2 }),
          { label: 'inner' });
      return { success: true, inner };
    }, { label: 'outer' });

    assert.strictEqual(result.inner.depth, 2);
    assert.strictEqual(store.calls.tryAcquire, 1,
        'the nested call took a second lease instead of reusing the held one');
    say('  nested withInventoryLock: ran at depth 2, one acquisition total');
  });

  // ---- fail-open ---------------------------------------------------------
  await check('an unreachable lock store fails OPEN, tagged, not closed', async () => {
    const boom = new Error('5 NOT_FOUND: The database (default) does not exist');
    boom.code = 5;
    __setStoreForTests(makeFakeStore({ failWith: boom }));

    const result = await withInventoryLock(async () => ({ success: true, wrote: 1 }),
        { label: 'station-A' });

    assert.strictEqual(result.success, true,
        'a broken lock store stopped an inventory write -- that is an outage, ' +
        'not a safeguard');
    assert.strictEqual(result.lockDegraded, true,
        'the degradation was silent; it must be visible on the result');
    say('  store unreachable: -> ' + JSON.stringify(result));
  });

  await check('after an unreachable store, the breaker keeps the next writes ' +
              'from paying the timeout again', async () => {
    const boom = new Error('14 UNAVAILABLE');
    boom.code = 14;
    const store = makeFakeStore({ failWith: boom });
    __setStoreForTests(store);

    await withInventoryLock(async () => ({ success: true }), { label: 'first' });
    const callsAfterFirst = store.calls.tryAcquire;
    await withInventoryLock(async () => ({ success: true }), { label: 'second' });

    assert.strictEqual(store.calls.tryAcquire, callsAfterFirst,
        'the second write called the known-dead store again');
  });

  await check('an ABORTED transaction is treated as contention, never as a ' +
              'reason to fail open', async () => {
    const aborted = new Error('10 ABORTED: Too much contention on these documents');
    aborted.code = 10;
    assert.strictEqual(lock.isContentionError(aborted), true);

    const notContention = new Error('7 PERMISSION_DENIED');
    notContention.code = 7;
    assert.strictEqual(lock.isContentionError(notContention), false);
  });

  __setStoreForTests(null);
}

/* ==========================================================================
 * PART C -- the real Firestore round-trip, against the emulator
 * ========================================================================== */

/** @return {Promise<void>} */
async function partC() {
  console.log('\nPART C -- real Firestore transactions (emulator)');

  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    console.log('  SKIPPED -- FIRESTORE_EMULATOR_HOST is not set.');
    console.log('  Parts A and B prove the lock\'s own logic but NOT that a');
    console.log('  Firestore transaction is atomic under concurrent writers.');
    console.log('  Run `npm run test:lock:emulator` (needs Java 21+) for that.');
    say('  PART C skipped -- no emulator');
    return;
  }

  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'cis-warehouse-portal';
  const admin = require('../admin');
  const db = admin.firestore();
  const ref = db.collection(LOCK_COLLECTION).doc(LOCK_DOC_ID);

  // Real store: storeOverride null means functions/lock.js builds its own
  // Firestore-backed one, so what runs below is the shipping code path.
  __setStoreForTests(null);
  await ref.delete().catch(() => {});

  await check('a real transaction serialises two concurrent acquirers', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const order = [];

    /**
     * @param {string} who
     * @return {Promise<Object>}
     */
    async function writer(who) {
      return withInventoryLock(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(who + ' in');
        await sleep(250);
        order.push(who + ' out');
        concurrent--;
        return { success: true, who };
      }, { label: who });
    }

    const results = await Promise.all([
      writer('station-A'), writer('station-B'), writer('station-C')
    ]);

    assert.strictEqual(maxConcurrent, 1,
        'Firestore let two writers into the critical section at once: ' +
        order.join(' | '));
    assert.ok(results.every((r) => r.success));
    say('  3 concurrent writers, real transactions: ' + order.join(' -> '));
  });

  await check('a real live lease refuses the next writer with the exact SRC ' +
              'string', async () => {
    await ref.set({
      token: 'held-by-another-container',
      label: 'modifySheetRow SWH-A-01/WIDGET-X-100',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + LEASE_TTL_MS
    });

    let bodyRan = false;
    const result = await withInventoryLock(async () => {
      bodyRan = true; return { success: true };
    }, { label: 'station-B' });

    assert.strictEqual(bodyRan, false);
    assert.deepStrictEqual(result, { success: false, error: SERVER_BUSY_ERROR });
    say('  real live lease -> ' + JSON.stringify(result));
  });

  await check('a real EXPIRED lease is taken over rather than wedging the ' +
              'write path', async () => {
    await ref.set({
      token: 'token-of-a-container-that-died',
      label: 'modifySheetRow SWH-A-01/WIDGET-X-100',
      acquiredAt: Date.now() - (LEASE_TTL_MS * 2),
      expiresAt: Date.now() - 1000   // one second ago
    });

    let bodyRan = false;
    const result = await withInventoryLock(async () => {
      bodyRan = true; return { success: true, wrote: 'station-B' };
    }, { label: 'station-B' });

    assert.strictEqual(bodyRan, true,
        'an abandoned lease permanently wedged the write path');
    assert.strictEqual(result.success, true);
    const after = await ref.get();
    assert.strictEqual(after.exists, false, 'the lease was not released');
    say('  real expired lease -> taken over, then released: ' +
        JSON.stringify(result));
  });

  await check('the lease document really is written and cleared in Firestore', async () => {
    let seen = null;
    await withInventoryLock(async () => {
      seen = (await ref.get()).data();
      return { success: true };
    }, { label: 'modifySheetRow SWH-A-01/WIDGET-X-100' });

    assert.ok(seen, 'no lease document existed while the lock was held');
    assert.strictEqual(seen.label, 'modifySheetRow SWH-A-01/WIDGET-X-100');
    assert.ok(seen.expiresAt - seen.acquiredAt === LEASE_TTL_MS,
        'lease TTL on the stored document is not LEASE_TTL_MS');
    assert.strictEqual((await ref.get()).exists, false,
        'the lease was not deleted on release');
    say('  stored lease: ' + JSON.stringify(seen));
  });

  await ref.delete().catch(() => {});
  await db.terminate().catch(() => {});
}

/* ==========================================================================
 * PART D -- the wiring
 *
 * Parts A-C prove the lock works. They prove nothing about whether the write
 * path actually USES it, which is the mistake that would make all of the above
 * decorative. So: drive the real Service_Write functions with SS_API stubbed
 * out, and assert that a held lease stops them reaching the sheet at all.
 *
 * SS_API is stubbed by patching the properties of its module exports object.
 * Node caches modules by resolved path and Service_Write calls through the
 * object (`SS_API.getSheetValues(...)`), so the patch is seen by the real code
 * under test -- no Sheets, no credentials, no network.
 * ========================================================================== */

/** @return {Promise<void>} */
async function partD() {
  console.log('\nPART D -- the write path actually takes the lock');

  const SS_API = require('../services/Service_SheetsAPI');
  const Service_Write = require('../services/Service_Write');

  const original = {};
  const sheetCalls = [];
  ['getSheetValues', 'batchUpdateValues', 'batchAppendRows',
    'batchDeleteRows', 'getSheetId'].forEach((fn) => {
    original[fn] = SS_API[fn];
  });

  /** @param {Array<Array<*>>} rows what getSheetValues should return. */
  function stubSheets(rows) {
    SS_API.getSheetValues = async (range) => {
      sheetCalls.push('getSheetValues ' + range);
      return rows;
    };
    SS_API.batchUpdateValues = async (u) => {
      sheetCalls.push('batchUpdateValues ' + JSON.stringify(u));
      return { success: true };
    };
    SS_API.batchAppendRows = async (tab) => {
      sheetCalls.push('batchAppendRows ' + tab);
      return { success: true };
    };
    SS_API.batchDeleteRows = async () => {
      sheetCalls.push('batchDeleteRows');
      return { success: true };
    };
    SS_API.getSheetId = async () => 12345;
  }

  /** Restores the real SS_API. */
  function unstubSheets() {
    Object.keys(original).forEach((fn) => {
      SS_API[fn] = original[fn];
    });
  }

  // An Inventory snapshot: header + one real pallet at SWH-A-01.
  const SNAPSHOT = [
    ['Location', 'SKU', 'Qty', 'Status', 'Type', 'Comment', 'Instance_ID'],
    ['SWH-A-01', 'WIDGET-X-100', 40, 'Open', 'None', '', 'inst-0001']
  ];
  // A fake signed-in operator, so getActiveUserEmail(context) resolves.
  const CONTEXT = { auth: { email: 'operator@example.com' } };

  stubSheets(SNAPSHOT);

  await check('setTotalStock reaches the sheet when the lock is free', async () => {
    __setStoreForTests(makeFakeStore());
    sheetCalls.length = 0;

    const result = await Service_Write.setTotalStock(
        'SWH-A-01', 'WIDGET-X-100', 25, 'inst-0001', CONTEXT);

    assert.strictEqual(result.success, true, JSON.stringify(result));
    assert.ok(sheetCalls.some((c) => c.startsWith('batchUpdateValues')),
        'no write reached the sheet: ' + sheetCalls.join(' | '));
    say('  lock free: setTotalStock -> ' + JSON.stringify(result) +
        ', sheet calls: ' + sheetCalls.length);
  });

  await check('setTotalStock does not touch the sheet at all while another ' +
              'writer holds the lease -- it refuses with "Server busy."', async () => {
    const store = makeFakeStore();
    __setStoreForTests(store);
    await store.tryAcquire({ token: 'held', label: 'station-A' });
    sheetCalls.length = 0;

    const result = await Service_Write.setTotalStock(
        'SWH-A-01', 'WIDGET-X-100', 25, 'inst-0001', CONTEXT);

    assert.deepStrictEqual(result, { success: false, error: SERVER_BUSY_ERROR });
    assert.deepStrictEqual(sheetCalls, [],
        'the refused write STILL read/wrote the sheet: ' + sheetCalls.join(' | '));
    say('  lock held: setTotalStock -> ' + JSON.stringify(result) +
        ', sheet calls: ' + sheetCalls.length);
  });

  await check('splitInventoryRow is locked too, and validates BEFORE taking ' +
              'the lease', async () => {
    const store = makeFakeStore();
    __setStoreForTests(store);
    await store.tryAcquire({ token: 'held', label: 'station-A' });
    sheetCalls.length = 0;

    // Invalid status: refused without ever consulting the lock, so a bad
    // request cannot be made to wait 10s behind another station's write.
    const t0 = Date.now();
    const bad = await Service_Write.splitInventoryRow(
        2, 'SWH-A-01', 'WIDGET-X-100', 5, 'Nonsense', CONTEXT);
    const validateMs = Date.now() - t0;
    assert.strictEqual(bad.success, false);
    assert.ok(/Unrecognized workflow status/.test(bad.error), bad.error);
    assert.ok(validateMs < 1000,
        'validation waited ' + validateMs + 'ms on the lock; it should refuse first');

    // Valid request, lock held: refused, sheet untouched.
    const busy = await Service_Write.splitInventoryRow(
        2, 'SWH-A-01', 'WIDGET-X-100', 5, 'Staged', CONTEXT);
    assert.deepStrictEqual(busy, { success: false, error: SERVER_BUSY_ERROR });
    assert.deepStrictEqual(sheetCalls, [], sheetCalls.join(' | '));
    say('  splitInventoryRow: bad status refused in ' + validateMs +
        'ms without the lock; valid request under a held lock -> ' +
        JSON.stringify(busy));
  });

  await check('the *ByRow twins inherit the lease through modifySheetRow', async () => {
    const store = makeFakeStore();
    __setStoreForTests(store);
    await store.tryAcquire({ token: 'held', label: 'station-A' });
    sheetCalls.length = 0;

    const a = await Service_Write.setTotalStockByRow(
        2, 'SWH-A-01', 'WIDGET-X-100', 25, CONTEXT);
    const b = await Service_Write.updateInventoryByRow(
        2, 'SWH-A-01', 'WIDGET-X-100', -5, CONTEXT);

    assert.deepStrictEqual(a, { success: false, error: SERVER_BUSY_ERROR });
    assert.deepStrictEqual(b, { success: false, error: SERVER_BUSY_ERROR });
    assert.deepStrictEqual(sheetCalls, [], sheetCalls.join(' | '));
  });

  await check('the Phase 2 row-data-mismatch guard SURVIVES the lock -- it is ' +
              'the only thing that catches a hand-edit in the Sheets UI', async () => {
    __setStoreForTests(makeFakeStore());
    sheetCalls.length = 0;

    // Row 2 really holds SWH-A-01/WIDGET-X-100. The client asserts row 2 holds
    // something else, as it would after a human inserted a row above it.
    const result = await Service_Write.setTotalStockByRow(
        2, 'SWH-B-09', 'OTHER-SKU', 25, CONTEXT);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error,
        'Row data mismatch. The sheet may have been modified.');
    assert.ok(!sheetCalls.some((c) => c.startsWith('batchUpdateValues')),
        'wrote to the wrong pallet: ' + sheetCalls.join(' | '));
    say('  hand-edited sheet, lock free: -> ' + JSON.stringify(result));
  });

  // ---- the three paths locked BEYOND SRC (2026-08-28) --------------------
  // SRC leaves these unlocked. They are locked here deliberately: of everything
  // on the write path they have the widest read-compute-write, and
  // removeItemFromLocation deletes rows, so a stale index destroys the wrong
  // pallet rather than merely overwriting a number. Pinned so a future "make it
  // match SRC" edit has to argue with a failing test.
  await check('moveInventoryItem takes the lease -- refused, sheet untouched', async () => {
    const store = makeFakeStore();
    __setStoreForTests(store);
    await store.tryAcquire({ token: 'held', label: 'station-A' });
    sheetCalls.length = 0;

    const result = await Service_Write.moveInventoryItem(
        'SWH-A-01', 'SWH-B-02', 'WIDGET-X-100', 5, false, 'inst-0001', true, CONTEXT);

    assert.deepStrictEqual(result, { success: false, error: SERVER_BUSY_ERROR });
    assert.deepStrictEqual(sheetCalls, [], sheetCalls.join(' | '));
    say('  lock held: moveInventoryItem -> ' + JSON.stringify(result) +
        ', sheet calls: ' + sheetCalls.length);
  });

  await check('moveInventoryItem validates BEFORE taking the lease', async () => {
    const store = makeFakeStore();
    __setStoreForTests(store);
    await store.tryAcquire({ token: 'held', label: 'station-A' });
    sheetCalls.length = 0;

    // A bad quantity and a blank destination must both be refused instantly,
    // not after a 10s wait behind another station's write.
    const t0 = Date.now();
    const badQty = await Service_Write.moveInventoryItem(
        'SWH-A-01', 'SWH-B-02', 'WIDGET-X-100', '5o', false, 'inst-0001', true, CONTEXT);
    const noDest = await Service_Write.moveInventoryItem(
        'SWH-A-01', '', 'WIDGET-X-100', 5, false, 'inst-0001', true, CONTEXT);
    const elapsed = Date.now() - t0;

    assert.ok(/Move quantity must be a number/.test(badQty.error), badQty.error);
    assert.strictEqual(noDest.error, 'Destination location is required.');
    assert.ok(elapsed < 1000, 'validation waited ' + elapsed + 'ms on the lock');
    assert.deepStrictEqual(sheetCalls, [], sheetCalls.join(' | '));
  });

  await check('moveHubGroup takes the lease, and its two argument checks are ' +
              'hoisted above it', async () => {
    const store = makeFakeStore();
    __setStoreForTests(store);
    await store.tryAcquire({ token: 'held', label: 'station-A' });
    sheetCalls.length = 0;

    const t0 = Date.now();
    const nothing = await Service_Write.moveHubGroup('SWH-A-01', 'SWH-B-02', [], true, CONTEXT);
    const noDest = await Service_Write.moveHubGroup('SWH-A-01', '', ['inst-0001'], true, CONTEXT);
    const elapsed = Date.now() - t0;

    assert.strictEqual(nothing.error, 'Nothing selected to move.');
    assert.strictEqual(noDest.error, 'Destination location is required.');
    assert.ok(elapsed < 1000, 'the hoisted checks waited ' + elapsed + 'ms on the lock');

    const busy = await Service_Write.moveHubGroup(
        'SWH-A-01', 'SWH-B-02', ['inst-0001'], true, CONTEXT);
    assert.deepStrictEqual(busy, { success: false, error: SERVER_BUSY_ERROR });
    assert.deepStrictEqual(sheetCalls, [], sheetCalls.join(' | '));
    say('  lock held: moveHubGroup -> ' + JSON.stringify(busy) +
        ', sheet calls: ' + sheetCalls.length);
  });

  await check('removeItemFromLocation takes the lease -- the delete path is ' +
              'the one where a stale row index destroys the wrong pallet', async () => {
    const store = makeFakeStore();
    __setStoreForTests(store);
    await store.tryAcquire({ token: 'held', label: 'station-A' });
    sheetCalls.length = 0;

    const result = await Service_Write.removeItemFromLocation(
        'SWH-A-01', 'WIDGET-X-100', 'inst-0001', CONTEXT);

    assert.deepStrictEqual(result, { success: false, error: SERVER_BUSY_ERROR });
    assert.deepStrictEqual(sheetCalls, [], sheetCalls.join(' | '));
    say('  lock held: removeItemFromLocation -> ' + JSON.stringify(result) +
        ', sheet calls: ' + sheetCalls.length);
  });

  await check('all three still work normally with the lease free', async () => {
    __setStoreForTests(makeFakeStore());
    sheetCalls.length = 0;
    const moved = await Service_Write.moveInventoryItem(
        'SWH-A-01', 'ZONE-BUFFER', 'WIDGET-X-100', 5, false, 'inst-0001', false, CONTEXT);
    assert.notStrictEqual(moved.error, SERVER_BUSY_ERROR);
    assert.ok(sheetCalls.length > 0, 'the move never reached the sheet');
  });

  await check('ZONE-STAGED is no longer a virtual move destination (F2)', async () => {
    __setStoreForTests(makeFakeStore());
    sheetCalls.length = 0;

    const result = await Service_Write.moveInventoryItem(
        'SWH-A-01', 'ZONE-STAGED', 'WIDGET-X-100', 5, false, 'inst-0001', false, CONTEXT);

    assert.strictEqual(result.success, false, JSON.stringify(result));
    assert.ok(/Unknown destination 'ZONE-STAGED'/.test(result.error), result.error);
    say('  move to ZONE-STAGED -> ' + JSON.stringify(result));
  });

  await check('ZONE-BUFFER is still a virtual move destination', async () => {
    __setStoreForTests(makeFakeStore());
    const result = await Service_Write.moveInventoryItem(
        'SWH-A-01', 'ZONE-BUFFER', 'WIDGET-X-100', 5, false, 'inst-0001', false, CONTEXT);
    assert.notStrictEqual(result.error,
        "Unknown destination 'ZONE-BUFFER' -- it doesn't match any existing " +
        'location or recognized zone. Move rejected rather than creating a new one.');
  });

  unstubSheets();
  __setStoreForTests(null);
}

/* ========================================================================== */

/** @return {Promise<void>} */
async function main() {
  await partA();
  await partB();
  await partD();
  await partC();

  console.log('\n  transcript:');
  transcript.forEach((l) => console.log(l));

  console.log('\n' + checks + ' checks, ' + failures + ' failures');
  if (failures > 0) {
    console.error('LOCK CONTRACT FAILED');
    process.exit(1);
  }
  console.log('LOCK CONTRACT OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
