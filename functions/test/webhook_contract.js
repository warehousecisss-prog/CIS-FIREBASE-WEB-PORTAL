/**
 * ============================================================================
 * WEBHOOK CONTRACT TEST -- de-bounce + signature verification
 * ============================================================================
 * The two pieces of the webhook that parity cannot cover, for opposite reasons:
 *
 *  - **The event de-bounce key** CAN be compared to SRC, and is: the port must
 *    produce byte-identical keys to `webhookEventKey_` in Webhook_Receiver.js,
 *    because that is what defines "the same event". That check runs here rather
 *    than in parity_Webhook.js because it is a property of the key function,
 *    not of a webhook scenario.
 *
 *  - **The de-bounce STORE and the signature check have no SRC counterpart at
 *    all.** SRC used CacheService (no Node equivalent) and could not verify a
 *    signature in the first place (Apps Script cannot read request headers --
 *    the whole reason the Render proxy existed). So these are tested against
 *    their specification instead, the same way lock.js is.
 *
 * The behaviours asserted below are the ones that would cause real damage if
 * they regressed:
 *   - distinct events on ONE card must EACH be processed (SCHEMA invariant #43
 *     -- the card-scoped key caused a real incident; see webhook_dedupe.js)
 *   - a byte-identical re-delivery must be dropped
 *   - an unreachable store must FAIL OPEN (a dropped webhook is unrecoverable;
 *     a duplicate one is merely wasteful)
 *   - signature verification must be inert until configured, and must actually
 *     reject a bad signature once it is
 *
 *   npm run test:webhook
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = process.argv[2] || path.join(__dirname, '..', '..');

let checks = 0;
const failures = [];

/**
 * @param {string} label
 * @param {boolean} cond
 * @param {string} [detail]
 */
function ok(label, cond, detail) {
  checks++;
  if (!cond) failures.push(label + (detail ? '\n    ' + detail : ''));
}

/**
 * @param {string} label
 * @param {*} actual
 * @param {*} expected
 */
function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected),
      'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

/* ==========================================================================
 * 1. Event key -- compared against SRC
 * ========================================================================== */

const dedupe = require(path.join(ROOT, 'functions/webhook_dedupe.js'));

const srcWebhookPath = path.join(ROOT, 'SRC/src/Webhook_Receiver.js');
if (fs.existsSync(srcWebhookPath)) {
  // SRC's webhookEventKey_ uses Utilities.computeDigest(MD5, ...) and hand-rolls
  // the hex conversion. Give it a real MD5 so the two can be compared for real.
  const sandbox = {
    Logger: {log: () => {}},
    PropertiesService: {getScriptProperties: () => ({getProperty: () => null})},
    Utilities: {
      DigestAlgorithm: {MD5: 'MD5'},
      computeDigest: (alg, text) => {
        const buf = crypto.createHash('md5').update(text).digest();
        // Apps Script returns SIGNED bytes; SRC's hex conversion compensates
        // with `(b < 0 ? b + 256 : b)`. Reproduce the signedness so that
        // compensation is actually exercised rather than bypassed.
        return Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
      }
    },
    SpreadsheetApp: {getActiveSpreadsheet: () => null},
    CacheService: {getScriptCache: () => ({get: () => null, put: () => {}})},
    ContentService: {createTextOutput: (t) => ({text: t})},
    UrlFetchApp: {fetch: () => { throw new Error('no network'); }},
    Session: {getEffectiveUser: () => ({getEmail: () => 'x@y.z'})},
    MailApp: {sendEmail: () => {}},
    console, JSON, Math, String, Number, Object, Array, RegExp, Date, parseInt, isNaN
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(srcWebhookPath, 'utf8'), sandbox, {filename: srcWebhookPath});

  const ACTIONS = [
    {id: 'a1', type: 'updateCard', date: '2026-08-30T12:00:00.000Z',
      data: {card: {id: 'c1', name: 'X'}, list: {id: 'l1', name: 'IN TRANSIT'}}},
    // Same card, DIFFERENT event -- must produce a DIFFERENT key. This is the
    // invariant the card-scoped key violated.
    {id: 'a2', type: 'updateCard', date: '2026-08-30T12:00:01.000Z',
      data: {card: {id: 'c1', name: 'X'}, list: {id: 'l2', name: 'DELIVERED'}}},
    {id: 'a3', type: 'commentCard', date: '2026-08-30T12:00:02.000Z',
      data: {card: {id: 'c1'}, text: '.ignore'}},
    {id: '', type: '', date: '', data: {}},
    {type: 'updateCard', data: {card: {id: 'c2'}}},
    {id: 'unicode', type: 'commentCard', date: '2026-08-30T12:00:03.000Z',
      data: {card: {id: 'c3'}, text: 'ETA port (Ontario — GTA) 09/02/2026'}}
  ];

  ACTIONS.forEach((action, i) => {
    const cardId = (action.data && action.data.card && action.data.card.id) || 'c?';
    const srcKey = sandbox.webhookEventKey_(cardId, action);
    const portKey = dedupe.webhookEventKey_(cardId, action);
    eq('webhookEventKey_ matches SRC [action ' + i + ']', portKey, srcKey);
  });

  // The invariant itself, stated directly.
  const k1 = dedupe.webhookEventKey_('c1', ACTIONS[0]);
  const k2 = dedupe.webhookEventKey_('c1', ACTIONS[1]);
  ok('two DISTINCT events on the same card get DIFFERENT keys (SCHEMA #43)', k1 !== k2,
      'both hashed to ' + k1 + ' -- this is the card-scoped-key bug returning');
  eq('a byte-identical re-delivery gets the SAME key',
      dedupe.webhookEventKey_('c1', ACTIONS[0]), k1);
} else {
  console.log('note: SRC/src/Webhook_Receiver.js absent -- skipping the event-key ' +
              'comparison against SRC (the store and signature checks below still run).');
}

/* ==========================================================================
 * 2. The de-bounce store
 * ========================================================================== */

/**
 * @return {Promise<void>}
 */
async function testStore() {
  // --- a working store ----------------------------------------------------
  const seen = new Map();
  dedupe.__setStoreForTests({
    async claim(key) {
      const now = Date.now();
      const rec = seen.get(key);
      if (rec && rec.expiresAt > now) return {claimed: false};
      seen.set(key, {expiresAt: now + dedupe.CLAIM_TTL_MS});
      return {claimed: true};
    }
  });

  const first = await dedupe.claimWebhookEvent('webhook_evt_aaa');
  eq('first sighting is new', first, {isNew: true, degraded: false});

  const second = await dedupe.claimWebhookEvent('webhook_evt_aaa');
  eq('immediate re-delivery is a duplicate', second, {isNew: false, degraded: false});

  const other = await dedupe.claimWebhookEvent('webhook_evt_bbb');
  eq('a different event key is unaffected', other, {isNew: true, degraded: false});

  // --- expiry -------------------------------------------------------------
  seen.set('webhook_evt_aaa', {expiresAt: Date.now() - 1});
  const afterTtl = await dedupe.claimWebhookEvent('webhook_evt_aaa');
  eq('the same key after the TTL lapses is new again', afterTtl, {isNew: true, degraded: false});

  // --- fail open ----------------------------------------------------------
  dedupe.__setStoreForTests({
    async claim() { throw new Error('Firestore unreachable'); }
  });
  const degraded = await dedupe.claimWebhookEvent('webhook_evt_ccc');
  eq('an unreachable store FAILS OPEN (processes the event)', degraded,
      {isNew: true, degraded: true});

  // --- a hanging store must not hold the webhook open ---------------------
  dedupe.__setStoreForTests({
    claim: () => new Promise(() => {}) // never settles
  });
  const started = Date.now();
  const hung = await dedupe.claimWebhookEvent('webhook_evt_ddd');
  const elapsed = Date.now() - started;
  eq('a hanging store fails open', hung, {isNew: true, degraded: true});
  ok('a hanging store is abandoned in under 5s (deadline is 3s), took ' + elapsed + 'ms',
      elapsed < 5000);

  // --- a missing key ------------------------------------------------------
  const noKey = await dedupe.claimWebhookEvent('');
  eq('an empty key fails open rather than dropping the event', noKey,
      {isNew: true, degraded: true});
}

/* ==========================================================================
 * 3. Signature verification
 * ========================================================================== */

/**
 * @param {string} sig
 * @param {string} body
 * @return {Object} a minimal Express-like request.
 */
function fakeReq(sig, body) {
  return {
    get: (h) => (h.toLowerCase() === 'x-trello-webhook' ? sig : undefined),
    rawBody: Buffer.from(body || '', 'utf8')
  };
}

/**
 * @return {void}
 */
function testSignature() {
  const SECRET = 'trello-oauth-secret';
  const URL = 'https://us-central1-proj.cloudfunctions.net/trelloWebhook';
  const BODY = '{"action":{"id":"a1","type":"updateCard"}}';
  const goodSig = crypto.createHmac('sha1', SECRET).update(BODY + URL).digest('base64');

  const load = () => {
    // config caches nothing across requires here, but Service_Webhook reads
    // config lazily inside the function, so a plain re-read is enough.
    delete require.cache[require.resolve(path.join(ROOT, 'functions/services/Service_Webhook.js'))];
    return require(path.join(ROOT, 'functions/services/Service_Webhook.js'));
  };

  // --- unconfigured: inert, accepts everything ----------------------------
  delete process.env.TRELLO_API_SECRET;
  delete process.env.WEBHOOK_CALLBACK_URL;
  let W = load();
  let v = W.verifyTrelloSignature(fakeReq('', BODY));
  eq('unset TRELLO_API_SECRET -> accepted, not enforced', v, {ok: true, enforced: false});

  // --- secret set but no callback URL: still inert, but loudly -------------
  process.env.TRELLO_API_SECRET = SECRET;
  delete process.env.WEBHOOK_CALLBACK_URL;
  W = load();
  v = W.verifyTrelloSignature(fakeReq(goodSig, BODY));
  eq('secret without callback URL -> accepted, not enforced', v, {ok: true, enforced: false});

  // --- fully configured ---------------------------------------------------
  process.env.WEBHOOK_CALLBACK_URL = URL;
  W = load();

  v = W.verifyTrelloSignature(fakeReq(goodSig, BODY));
  eq('a correct signature is accepted and enforced', v, {ok: true, enforced: true});

  v = W.verifyTrelloSignature(fakeReq('bm90LXRoZS1yaWdodC1zaWc=', BODY));
  ok('a wrong signature is rejected', v.ok === false && v.enforced === true,
      JSON.stringify(v));

  v = W.verifyTrelloSignature(fakeReq('', BODY));
  ok('a missing header is rejected', v.ok === false && v.reason === 'no x-trello-webhook header',
      JSON.stringify(v));

  // A tampered body must fail even with a signature that was valid for the
  // original body -- this is the property the whole check exists for.
  v = W.verifyTrelloSignature(fakeReq(goodSig, BODY.replace('updateCard', 'deleteCard')));
  ok('a tampered body is rejected', v.ok === false, JSON.stringify(v));

  // A signature of the right length but wrong content must not slip through a
  // length-only comparison.
  const wrongSameLen = Buffer.from(goodSig).toString('utf8')
      .replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
  v = W.verifyTrelloSignature(fakeReq(wrongSameLen, BODY));
  ok('a same-length wrong signature is rejected', v.ok === false, JSON.stringify(v));

  // The callback URL is part of the signed material.
  process.env.WEBHOOK_CALLBACK_URL = URL + '/';
  W = load();
  v = W.verifyTrelloSignature(fakeReq(goodSig, BODY));
  ok('a callback URL differing by a trailing slash is rejected (why it must match exactly)',
      v.ok === false, JSON.stringify(v));

  delete process.env.TRELLO_API_SECRET;
  delete process.env.WEBHOOK_CALLBACK_URL;
}

/**
 * @return {Promise<void>}
 */
async function main() {
  await testStore();
  testSignature();

  console.log('\n' + checks + ' checks, ' + failures.length + ' failures');
  if (failures.length === 0) {
    console.log('WEBHOOK CONTRACT OK\n');
  } else {
    failures.forEach((f) => console.log('  FAIL: ' + f));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
