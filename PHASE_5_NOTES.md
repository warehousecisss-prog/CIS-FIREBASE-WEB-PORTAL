# Phase 5 — the sync / webhook functions

The biggest remaining body of unported code: the real-time Trello webhook, the
scheduled board→SHIPMENTS sync, the rollup-status state machine, and the
one-way AEO/Burlington→Trello push. Different in kind from Phase 4 — that was
"port pure-ish functions and prove parity in a VM sandbox"; this is real-time
infrastructure. Some of it genuinely cannot be verified without live Trello
credentials and a real webhook endpoint, and where that's true it's said
plainly rather than tested around.

Source files (ORIGINAL Apps Script sizes):

| File | Lines | Role |
|---|---|---|
| `Webhook_Receiver.js` | 691 | Real-time Trello card-update webhook. `doPost`. |
| `syncAllBoardsToShipmentsTab.js` | 731 | Scheduled full board→SHIPMENTS pull. The conductor. |
| `evaluateRollupStatuses.js` | 470 | Rollup-status state machine (FedEx override). Called by the sync. |
| `pushOutboundToShippingSchedule.js` | 760 | External AEO/Burlington sheet → Trello push. Independent hourly job. |
| `Service_Router.js` | 286 | Mostly dead. `doGet`/`doHEAD` superseded by SPA hosting + the Phase 3 routes. |

## Decisions taken at the start of Phase 5 (from the user)

1. **Drop the Render.com proxy.** The webhook Cloud Function verifies Trello's
   signature header itself — Cloud Functions have header access, which is the
   only reason SRC needed the proxy. No more Render server in the topology.
2. **Widen the sync's self-timeout, keep the mechanism.** SRC cuts its own run
   off at 4.5 min (Apps Script's 6-min ceiling). Keep a time budget — the
   partial-run behaviour gates card-pruning (`boardsFullyProcessed`) — but
   raise it (Cloud Functions v2 allows up to 60 min).
3. **Firestore-backed webhook de-bounce**, reusing the `functions/lock.js`
   Firestore plumbing. The *key* logic ports verbatim (hash the event, not the
   card — SCHEMA invariant #43); only the 20s-TTL store swaps from CacheService
   to a short-lived Firestore doc.
4. **`Service_Router.js` — take the live helpers, drop the dead bulk.** Not
   ported as a file. Fold the webhook-validation GET response into the webhook
   function; the retired `legacyDoPost_`/`legacyProcessWebhookPayload_` and the
   Apps-Script `doGet` template rendering are already dead here.
5. **AEO / Burlington external sheets fold in.** `pushOutboundToShippingSchedule`
   only ever opens a Google Sheet by ID and reads a named tab — it doesn't care
   how the data arrives. AEO is a Power Automate → Google Sheets update;
   Burlington is a local Python script that parses a CSV and uploads to Drive
   (as a Google Sheet). Both stay native Google Sheets. The port reads them
   through the same Sheets API the rest of the backend uses, pointed at a
   different spreadsheet ID; the two file IDs move from hardcoded literals into
   config keys. **One operational step at deploy time:** each of the two sheets
   must be shared (Viewer) with the Functions service account — it runs as a
   service account, not as the user, so it sees nothing in the user's Drive by
   default. User confirmed a service account is already set up (for the Python
   script) so this is not a blocker.

## Verifiability map (what an executed test can and can't cover)

Same rule as Phase 4: pure logic → parity harness against SRC-in-a-VM; anything
that reads/writes Trello or Sheets → reviewed line-by-line against SRC, **not**
executed (no Trello creds, no Google ADC on this machine, emulator times out
~60s on any real Sheets call).

- **Strongly verifiable (parity-harnessable):** the whole rollup state machine
  (SCHEMA §7), the webhook's status-computation + row-upsert decision, all the
  date math, `pushOutbound`'s row-grouping / description-building /
  create-vs-update-vs-skip decision, and the pure helpers.
- **Partially verifiable:** the webhook payload-branch dispatch; the
  archive/prune *decision* (pure) vs its batched Trello GET (I/O); the sync's
  call ordering (SCHEMA is emphatic about it — worth a light assertion).
- **Not verifiable here — review + emulator smoke-boot only:** every real
  Trello read/write, the external-sheet reads, all SHIPMENTS / MPS Backend
  reads and writes, the schedule actually firing.

Bottom line: the majority of the *consequential* logic is parity-testable. The
**sync orchestrator specifically** will land as "reviewed against SRC,
smoke-tested on the emulator, not proven by execution" — the same honest caveat
Phase 4 put on its Trello-write functions.

## Planned sequence

1. **Pure shared helpers + parity harness.** ← DONE (Step 1 below)
2. **`evaluateRollupStatuses`** — decision tree as a pure function behind a thin
   I/O shell; harness the tree hard. Highest consequence, highest testability.
3. **`Webhook_Receiver`** — status computation + upsert are the parity target;
   payload router + checklist fetch are the reviewed shell. Needs the
   signature-verification design (decision 1) settled first.
4. **`syncAllBoardsToShipmentsTab`** — the conductor, least provable. Port last,
   leaning on its now-verified sub-parts; light call-order check for the SCHEMA
   ordering rule.
5. **`pushOutboundToShippingSchedule`** — independent; any time after step 1.
   Card-shaping harnessed, Trello writes reviewed, needs the two config keys +
   `getUsFederalHolidayList_` / `computeShipByDateStr_` / `parseTrelloDate`.
6. **`Service_Router`** — cleanup pass, not a port.

---

## Step 1 — pure shared helpers (DONE)

Four pure functions the rollup engine, the webhook, and the scheduled sync all
need were moved into `functions/services/Shared_Classifiers.js`, beside the
already-ported `formatInboundLineItems` and the list/label classifiers:

| Function | From (SRC) | What it does |
|---|---|---|
| `formatOutboundLineItems` | `syncAllBoardsToShipmentsTab.js` | Builds the SHIPMENTS summary column for an outbound card — three board-specific label/description extraction rules. |
| `harvestFedExTrackingNumber` | `syncAllBoardsToShipmentsTab.js` | First 12- or 15-digit run in desc + comment text; `''` if none. |
| `extractStoreInfo` | `syncAllBoardsToShipmentsTab.js` | `"MAR 1670"` → `{storeName:"MAR", storeNum:"1670"}`; falls back to `{first 30 chars, "N/A"}`. |
| `cleanTrackingNumber` | `evaluateRollupStatuses.js` | Digits only, dropping a trailing `.0`/`.00` float artifact first. |

All four ported **verbatim** from SRC — same regexes, same branch order, same
double-quoted string literals — so a future `diff` against SRC still lines up.

### One deliberate divergence

`formatOutboundLineItems` — SRC fills an omitted `registry` argument from a
synchronous global `getCustomerRegistry()`. Only the retired
`legacyProcessWebhookPayload_()` ever omitted it. The port has no synchronous
registry source (`getCustomerRegistry()` is async and in `Service_Read`), so an
omitted `registry` here just means "no brand labels to recognise" — `registry`
defaults to `[]`. Every live caller (the scheduled sync, the webhook) passes a
pre-fetched registry, exactly like `classifyInboundOrderOriginServer_` /
`isKnownBrandLabel_` already require. The parity harness always supplies one, so
the divergence is confined to the omitted-argument case and is never on a real
path. Documented in the function's own doc comment.

### Lint

3 new `no-useless-escape` **warnings** (not errors) on `formatOutboundLineItems`
— the `\*` in SRC's `/^[•\-\*\s]+/` character classes is cosmetically
unnecessary but kept for byte-fidelity with SRC. Consistent with the ~2000
style complaints the repo's `.eslintrc.js` already tolerates in ported bodies
(`no-useless-escape` is downgraded to `warn` there for exactly this reason).
Total warnings: 6 → 9 in the Functions tree; still 0 errors, predeploy hook
still green.

### Test — `parity_Shared_Classifiers.js` extended

Rather than a new harness file, the existing `parity_Shared_Classifiers.js` was
extended: it now also loads `SRC/src/syncAllBoardsToShipmentsTab.js` and
`SRC/src/evaluateRollupStatuses.js` into the same VM sandbox (both are top-level
`function` declarations only — nothing executes at load) and compares the four
new functions against their SRC originals.

```
npm run test:parity        →  ran 3052 comparisons across 23 functions
                              PARITY OK — every output identical to SRC
```

(was 1492 / 19 functions before this step.)

Corpora: 6 board names × 14 label sets × 9 description strings × 2 registries
for `formatOutboundLineItems` (covering each board branch labels-only /
desc-only / both / neither / ignored-card, metadata-label filtering, known-brand
filtering, the smart-quote-inches marker); 11 texts × 2 comment strings for
`harvestFedExTrackingNumber`; 13 entity strings for `extractStoreInfo`; 13
values (incl. `null`/`undefined`/`0`/`false`/float) for `cleanTrackingNumber`.

**Mutation-tested — each function's fix reverted, harness confirmed it goes red,
then restored:**

| Mutation | Result |
|---|---|
| `formatOutboundLineItems`: `lines.length > 1` → `> 0` | 564 differences |
| `harvestFedExTrackingNumber`: `\d{15}` → `\d{14}` | 4 differences (the 15-digit and numeric-arg cases) |
| `extractStoreInfo`: `\d{2,6}` → `\d{1,6}` | 1 difference (`"A 1"`) |
| `cleanTrackingNumber`: `/\.0+$/` → `/\.0$/` | 1 difference (`"875021925761.00"`) |

### Full check run

| Check | Result |
|---|---|
| `npm run lint` | 0 errors, 9 warnings (6 pre-existing + 3 noted above) |
| `npm run test:parity` | ✅ 3052 + 45850 + 7401 + 198 + 34 + 17, 0 differences |
| `npm run test:routes` | ✅ 82 checks, 0 failures |
| `npm run test:lock` | ✅ 27 checks, 0 failures |

Nothing was wired to a caller yet — these are pure helpers landing ahead of the
engines that use them (steps 2–5). No route, no `module.exports` consumer
outside the harness, no behaviour change to any existing path.

---

## Step 2 — `evaluateRollupStatuses`, the rollup status engine (DONE)

`functions/services/Service_Rollup.js`, ported from
`SRC/src/evaluateRollupStatuses.js`. This is SCHEMA §7 — the section SCHEMA
itself calls "the most critical section" — and the reason it went first among
the three engines is that it is simultaneously the highest-consequence and the
most testable.

What it does: reads every SHIPMENTS row plus the per-box FedEx statuses on the
`MPS Backend` tab, rolls them up into one status per shipment in column J, and
fires two automations. Its governing rule is that it may **upgrade** a status
but must **never downgrade** one a human already set.

### Structure — the decision tree is now a pure function

SRC has the whole state machine inline in one 230-line loop mixed with sheet
reads, Trello calls and mail. The port keeps the logic byte-faithful — same
branch order, same string comparisons, same tally buckets — but extracts it
into `evaluateRollupRow_(row, boxStatuses, registry)`, a pure function, with a
thin I/O shell around it. That is what makes every branch reachable from a
test. `resolveIsDropShip_` and `isPreTransitFedExStatus_` came out alongside it.

### A real bug found while porting: the `"undefined"` status

**Failure scenario in one sentence:** every shipment that has no status yet
would have had the literal text **`undefined`** written into its status column,
where the original writes `PENDING`.

This is the difference between the two platforms' sheet-reading APIs, and it is
invisible until you look for it:

- Apps Script's `getRange(2, 1, n, 10).getValues()` **always** returns exactly
  10 cells per row, padding blanks with `""`.
- The Google Sheets API's `values.get` does the opposite — it **omits trailing
  empty cells**. A row blank from column G onward comes back with 6 entries, and
  `row[9]` is `undefined`.

SRC indexes those cells unguarded (`String(row[9]).trim()` — it guards `row[1]`
with `|| ""` but not `row[3]`, `row[6]` or `row[9]`, which on Apps Script is
perfectly safe). Ported verbatim onto the Sheets API, `String(undefined)` is the
string `"undefined"`, and then Case A's `currentStatus || "PENDING"` sees a
non-empty string and preserves it. Straight onto the dashboard, on every
untracked shipment.

Fixed with `padRows_`, which reproduces the Apps Script guarantee exactly.
Deliberately **not** fixed by sprinkling `|| ""` guards: `String(0)` is `"0"`
but `String(0 || "")` is `""`, so guards would themselves change behaviour for a
cell holding a literal `0`. Padding is the faithful fix; guards are a second
divergence wearing a fix's clothing.

Checked the rest of the port for the same hazard — the existing services guard
their SHIPMENTS reads, so this was specific to the code being ported here.

### A second gap, in a function `PORT_AUDIT` already marked ported

`markFedExChildDeliveredInSheet` (`Service_Write.js`) was missing SRC's two
follow-up calls (`SRC/src/Service_Write.js:1802-1803`):

```js
if (typeof evaluateRollupStatuses === 'function') evaluateRollupStatuses();
if (typeof warmLogisticsDashboardCache === 'function') warmLogisticsDashboardCache();
```

**Failure scenario:** an operator manually marks a FedEx child box delivered;
the box status is written, but the shipment's status badge and the dashboard do
not change until the next scheduled sync — up to an hour of "I pressed it and
nothing happened". Now wired (lazily, to avoid a require cycle; failures are
logged rather than propagated, since the box status IS written by that point).

It could not have been fixed before now — there was no ported rollup engine to
call. Recorded here because it is the fourth time a function marked ported has
turned out to be missing something.

### Deliberate divergences

1. **Stakeholder email fallback.** SRC falls back to
   `Session.getActiveUser().getEmail()` when the Config tab has no
   `FEDEX_STAKEHOLDER` row. A scheduled Cloud Function has no session user, and
   the Phase 1 auth decision (AUDIT C5) forbids inventing one. The port's chain
   is `FEDEX_STAKEHOLDER` → `STAKEHOLDER_EMAILS` (same tab, already used by the
   receiving path) → **log an error and skip the email**. Skipping beats
   silently mailing a placeholder that reaches nobody. The status write and the
   Trello `dueComplete` still happen either way — only the notification is lost.
   All three variants of this are asserted by the harness, not hidden.
2. **No lock.** SRC takes none, and this writes SHIPMENTS, not Inventory —
   `functions/lock.js`'s lease is the *Inventory* lease and would be the wrong
   lock. See the open item below.

### Test — `npm run test:parity:rollup`

```
ran 455 comparisons across 11 scenarios
  (3 of them the verified stakeholder-resolution divergence)
ROLLUP PARITY OK — identical status writes, Trello calls and notifications
```

SRC's `evaluateRollupStatuses` returns **nothing** — it is a void function that
logs — so a return-value comparison was never even available. Just as well: it
would have proved nothing. Following the `parity_Service_Assembly` precedent,
the harness compares **what each side does**:

- the single column-J write, cell for cell
- every Trello call, method and URL
- the notification email — recipients, subject, body

Both sides get recording fakes and the two op streams are diffed. The
normalisation is declared in the harness header and is mechanical (SRC's
`getRange().setValues()` and `MailApp.sendEmail` vs the port's
`SS_API.batchUpdateValues` and `Service_Email.sendMail` map to the same
intent); cell values, ordering and call counts are compared raw.

The synthetic workbook has 43 SHIPMENTS rows chosen to drive every branch: all
five Case-A tally buckets including both pre-rename labels, Case B's three-way
preserve, all-delivered / partial / none-delivered / exception, drop-ship
resolution by `Parent_Account`, `Brand_ID` and `Regex_Aliases`, a malformed
`Regex_Aliases` row followed by a matching one (proving the scan continues), the
board-freshness move and all five reasons it should *not* fire, a float tracking
number, and a short row.

**The harness deliberately reproduces the Sheets API's trailing-empty
omission** rather than handing the port a conveniently rectangular grid — that
omission is the whole hazard above, so a harness that padded it away would have
passed straight over the bug.

### Mutation-tested — ten properties, each broken in turn

Ten separate mutations were applied to the pristine file, the harness re-run,
and the file restored. **Every one went red:**

| Mutation | Result |
|---|---|
| M1 never-downgrade guard removed (all boxes delivered) | 8 differences |
| M2 Case B preserve removed (the pre-2026-08-21 downgrade bug) | 8 differences |
| M3 drop-ship carve-out removed (`COMPLETE` never produced) | 5 differences |
| M4 exception no longer outranks full delivery | 9 differences |
| M5 pre-transit gate defeated (a bare label counts as a scan) | 6 differences |
| M6 row padding removed (the real bug above) | 10 differences |
| M7 `findShippedListId_` no longer excludes "TO BE SHIPPED" | 7 differences |
| M8 `isManualPartial` ignores the list name | 8 differences |
| M9 drop-ship scan aborts on a malformed regex (pre-fix behaviour) | 5 differences |
| M10 partial delivery may downgrade a manual `RECEIVED` | 6 differences |

M6's first reported difference is the bug verbatim:

```
first differing row: sheet row 3 (card "c-a-blank")
  SRC wrote : "PENDING"
  PORT wrote: "undefined"
```

### What the harness does NOT cover

The real Trello transport and the real Sheets transport are stubbed, so this
proves *which* calls are made with *which* payloads, not that they succeed
against a live API. `migrateRollupStatusLabels` (the one-off 2026-08-26 label
rename, ported for completeness) has **no executed test** — it is a manual
repair script with a dry-run default; it was reviewed line-by-line against SRC
and is stated as untested rather than counted.

### No route

`evaluateRollupStatuses` is not client-callable in SRC — no HTML file calls it.
Its callers are the scheduled sync, `Fedex_Master_Script`, and
`markFedExChildDeliveredInSheet`. So no route was added and
`routes_contract.js` is unchanged.

### Everything else

| Check | Result |
|---|---|
| `npm run lint` | 0 errors, 10 warnings (unchanged — no new ones) |
| `npm run test:parity` | ✅ 57,007 comparisons total, 0 differences |
| `npm run test:routes` | ✅ 82 checks, 0 failures |
| `npm run test:lock` | ✅ 27 checks, 0 failures |
| module load / require-cycle check | ✅ no cycle |
| `firebase emulators:start --only functions` | ✅ clean boot, 3 functions |

### New open item

**Three writers, one column, no lock.** Writer 1 (scheduled sync), Writer 2
(webhook) and Writer 3 (this engine) all write SHIPMENTS column J. In SRC the
sync calls the rollup engine synchronously right after its own write so those
two cannot interleave, but the webhook can land between either one's read and
its write. SRC has no protection and the port neither widens nor narrows the
race. Worth a decision once the webhook lands in step 3 — the options are a
second (non-Inventory) lease, or making the sync the only caller. **Not decided
here.**

---

## Step 3 — `Webhook_Receiver`, the real-time webhook (DONE)

Three new files:

| File | Role |
|---|---|
| `functions/services/Service_Webhook.js` | `processWebhookPayload`, `archiveClosedCardNow_`, `logWebhookError_`, `verifyTrelloSignature` |
| `functions/webhook_dedupe.js` | The Firestore event de-bounce — `lock.js`'s sibling, same disposable-scaffolding discipline |
| `functions/index.js` → `exports.trelloWebhook` | The HTTP entry point, outside the Express app (Trello sends no Firebase token) |

### The Render proxy is gone

SRC bounced every Trello webhook through a free Render.com server and
authenticated only that hop with a shared `?k=` secret. That existed for exactly
one reason: Apps Script's `doPost(e)` **cannot read request headers**, so it
could never check Trello's real signature. Cloud Functions can, so
`verifyTrelloSignature()` does the real check — `base64(HMAC-SHA1(apiSecret,
rawBody + callbackURL))` against the `x-trello-webhook` header — and a sleeping
free-tier server, plus the 5-minute cron that existed only to keep it awake,
leave the topology entirely. `WEBHOOK_HOP_SECRET` is retired;
`TRELLO_API_SECRET` + `WEBHOOK_CALLBACK_URL` replace it.

It is **inert until both are configured**, on the same reasoning SRC applied to
its hop secret and for a sharper reason: Trello signs *over the callback URL*,
so a `WEBHOOK_CALLBACK_URL` differing by a trailing slash rejects every
delivery, and a rejected webhook is unrecoverable. Set both together, then
confirm real deliveries land.

### The de-bounce

Moved from `CacheService` to a small Firestore claim record, same 20s TTL, same
event-hash key. **The key hashes the action, not the card** — SCHEMA invariant
#43, which exists because the card-scoped version caused a real incident (PO
3571: a checklist event and the follow-up card-move collided inside the 3-second
window, the move was dropped, and the shipment showed a stale status for hours).
The port's key is byte-identical to SRC's, and that is asserted directly.

It **fails open** where `lock.js` fails open grudgingly, because the asymmetry
here is stark: a wrongly-dropped webhook is unrecoverable (Trello will not
re-send), while a wrongly-processed duplicate costs a little wasted work against
an idempotent handler.

**One deploy step to remember:** set a Firestore TTL policy on the
`webhook_dedupe` collection's `expiresAt` field, alongside "enable Firestore".
Without it the collection grows by one ~120-byte document per distinct Trello
event forever. Nothing breaks — reads are by document id — it is tidiness, not
correctness.

### Two real bugs found, both mine, both caught by the harness

**1. An off-by-one that would have deleted the wrong shipment.**
`SS_API.batchDeleteRows` takes **1-based sheet row numbers** (it computes
`startIndex = rowNum - 1`), which is what every existing caller passes
(`Service_Write.js:716`). `archiveClosedCardNow_`'s `rowIdx` indexes the *body*
of the sheet, so the sheet row is `rowIdx + 2`. I passed `rowIdx + 1`.

**Failure scenario:** close a Trello card, and the portal archives the right row
to history but deletes **the row above it** from SHIPMENTS — silently losing a
different, live shipment while the closed one stays put.

Worse, my first version of the harness *hid it*: the recording stub did
`i => i + 1`, which made the numbers line up. A recorder that massages values to
match is worse than no recorder — it converts a caught bug into a passing test.
The stub now records exactly what the caller passed, and that is noted in the
file so it does not get "helpfully" adjusted again.

**2. Two missing `await`s that would have killed the READY/PORT feature.**
`parseSailingScheduleComment_` and `parseReadyPortComment_` are `async` in the
port (they await `classifyPortGroup_`, which reads a sheet) but synchronous in
SRC. My call site forgot to await them. An un-awaited async call returns a
**Promise, which is always truthy**, so:

- every Trello comment — "hello" included — looked like a sailing-schedule
  declaration and fired `applySailingScheduleDeclaration_` with `undefined`
  dates, and
- the READY/PORT branch, sitting in the `else`, would **never have run at all**.

Both parsers turn out to be absent from `parity_Service_Dates.js` too, so they
have no direct SRC comparison anywhere — recorded below as a coverage gap.

### A harness flaw worth recording, because it made three scenarios vacuous

Patching `require.cache[...].exports.trelloFetch_` looks like a working stub and
is not: a CommonJS module's **internal** calls resolve against its own module
scope, never through its exports object. `applyIgnoreDeclaration_` therefore
kept calling the real `trelloFetch_`, reached for the network, failed, and
returned `null` — while SRC's equivalent (`UrlFetchApp.fetch`, which the sandbox
stubbed with a *thrower*) also failed and also returned `null`. Both sides broke
identically, the diff stayed empty, and the three `.ignore` scenarios were
proving nothing.

Fixed by stubbing the **transport** on both sides — `global.fetch` for the port,
a recording `UrlFetchApp.fetch` for SRC. Separately, SRC's `trelloCreds_` lives
in `Service_Dates.js`, which this sandbox does not load, so it had been throwing
a `ReferenceError` into its own catch; the sandbox now supplies it.

### Deliberate divergences

1. **`alertOnWebhookErrors` not ported.** A daily digest of the Webhook_Errors
   tab, which exists in SRC only because a failed webhook was otherwise
   invisible. Cloud Logging makes alerting a platform feature rather than a mail
   loop this code runs. The durable **Webhook_Errors tab is still written** —
   its real value is keeping the raw payload for replay.
2. **`setupWebhooksForAllBoards` / `keepRenderAwake` not ported.** Both are
   Render-proxy artefacts. Registration is now a one-off setup step against the
   new endpoint.
3. **Malformed JSON returns 400, not 200.** The Functions runtime's body parser
   rejects it before the handler is entered — verified against the emulator, not
   assumed. Arguably better (a truncated delivery is exactly the case a retry
   fixes) but it does mean the "always 2xx" contract has a hole and a malformed
   payload is not captured to Webhook_Errors.

### Tests

```
npm run test:parity:webhook  →  43 scenario comparisons, 0 differences
npm run test:webhook         →  24 checks, 0 failures
```

The parity harness compares **what each side does**: the row upsert (update
range or append, cell for cell), the idempotency skip (an unchanged row must
emit *no* write), the archive path (history append **and** the SHIPMENTS
delete), every Trello call, and the readiness side-effects. 43 scenarios cover
list-skips, board/direction resolution, all seven rollup-status branches, the
rank guard, both append-skip rules including SCHEMA invariant #10, five
card-closed variants, four `.ignore` variants, and four due-date override
variants.

Two scenarios exist specifically to pin **SCHEMA §4F's ordering constraint**: a
comment on a row whose A–J data is byte-identical, so the write is skipped and
the readiness side-effect must fire *anyway*. Move the readiness block below the
idempotency return and those go red.

**Mutation-tested — sixteen properties, in two passes.** The first pass caught
9 of 14 and **five survived**, which is the whole reason to run it: the survivors
were corpus blind spots (no outbound `Check*` event, no evening-UTC due date, no
short row, and the vacuous `.ignore` scenarios above). After closing those gaps
and adding the two `await` mutations, the second pass caught **all fifteen, none
survived**:

| Mutation | Result |
|---|---|
| archive delete off-by-one (the bug the harness once masked) | 4 differences |
| readiness moved below the idempotency return (SCHEMA §4F) | 2 differences |
| rank guard removed | 1 difference |
| idempotency check defeated | 3 differences |
| board resolved by live Trello name, not id (the 2026-08-13 bug) | 29 differences |
| inbound entity uses store extraction instead of the raw card name | 23 differences |
| append-skip also excludes DELIVERED (breaks SCHEMA #10) | 1 difference |
| `isFullyPacked` fallback removed for a Delivered inbound list | 1 difference |
| checklists never fetched for `Check*` on an outbound card | 1 difference |
| due date formatted in UTC instead of America/New_York | 1 difference |
| row padding removed | 1 difference |
| ignore result not reflected into `card.labels` this pass | 2 differences |
| archive non-local carve-out removed | 1 difference |
| sailing parser not awaited (bug 2 above) | 7 differences |
| READY/PORT parser not awaited | 7 differences |

One mutation (`if (action.data.list)` → `if (true)`) was dropped as an
**equivalent mutant**: the fallback list name is `"Unknown List"`, which matches
neither skip keyword, so the two forms are behaviourally identical. Recorded
rather than silently omitted.

The contract test covers what parity cannot: the de-bounce key **is** compared
to SRC byte-for-byte (including SRC's signed-byte hex conversion, reproduced so
it is actually exercised), and the store and signature checks are tested against
their specification — first-claim vs duplicate, TTL expiry, fail-open on an
unreachable *and* on a hanging store, and for signatures: inert-until-configured,
correct signature, wrong signature, missing header, tampered body, a same-length
wrong signature (so a length-only comparison cannot pass), and a callback URL
differing by a trailing slash.

### Emulator smoke test

Verifiable without credentials, because these paths fail before any Sheets call:

| Request | Response |
|---|---|
| `HEAD` (Trello's registration probe) | `200` |
| `GET` | `200 Trello Webhook Active` |
| `POST` empty body | `200 OK - No Data` |
| `POST` non-card event | `200 OK - Ignored` |
| `PUT` | `200 OK - Ignored` |
| `POST` malformed JSON | `400` (platform body parser — see divergence 3) |

### Everything else

| Check | Result |
|---|---|
| `npm run lint` | 0 errors, 10 warnings (unchanged) |
| `npm test` (full suite) | ✅ exit 0 |
| `npm run test:parity` | ✅ 57,248 comparisons, 0 differences |
| `npm run test:routes` | ✅ 82 checks (unchanged — the webhook is not an SPA route) |
| `firebase emulators:start` | ✅ clean boot, **4** functions |

### Coverage gap recorded, not closed

`parseSailingScheduleComment_` and `parseReadyPortComment_` are absent from
`parity_Service_Dates.js` and have **no direct SRC comparison anywhere**. The
webhook harness exercises which *branch* they drive, not whether they parse
correctly. Worth adding to the Service_Dates harness — they are pure and
trivially comparable — flagged rather than done here to keep this step's diff
about the webhook.

---

## Step 4 — `syncAllBoardsToShipmentsTab`, the scheduled sync (DONE)

`functions/services/Service_Sync.js`, plus `exports.scheduledSync` in
`index.js` — which until now was a one-line stub that logged and did nothing.

This is the conductor. Every cycle it pulls all four Trello boards, rewrites
SHIPMENTS from what it finds, and then runs the rest of the pipeline in a fixed
order: rollup engine → archive → prune → missed-override detection → READY/PORT
backfill → date-state refresh → cache warm. Steps 2 and 3 built the pieces;
this is what runs them.

### A REAL BUG IN THE ORIGINAL — found, fixed, and demonstrated

**Failure scenario in one sentence:** the moment one shipment is archived,
every shipment below it on the sheet inherits **a different shipment's ETA and
readiness data**, and it compounds with each archived row.

SHIPMENTS is **eighteen** columns wide (A–R). Columns K–R are the entire
Readiness/ETA state machine `Service_Dates` maintains: ready-to-ship date and
basis, ETA date and basis, date state, port of arrival, last auto-pushed due
date, ETA-overridden flag.

SRC removes finished rows by **rewriting columns A–J**: read A–J, filter out
the doomed rows, clear A–J, write the compacted list back into A–J. Identical
code in `archiveCompletedShipments` (`:538-544`) and
`pruneDeletedShipmentCards_` (`:724-731`). Columns K–R are never touched, so
the A–J data slides up a row and the K–R data does not.

The original is aware of the hazard in the abstract — `isCardIgnored_`'s
comment in `Shared_Classifiers.js` says this path "only rewrites columns A-J,
which would desync every row below it from its own K-R readiness/ETA data", and
declines to *reuse* it for the ignore feature. It was left running on the
archive and prune paths, which run every cycle.

**Fixed by deleting whole rows** (`deleteShipmentRows_` → `deleteDimension`).
Sheets moves all eighteen columns together, so nothing can desync; it is also
one API call instead of a clear plus a write.

The harness *demonstrates* it rather than asserting it — SRC failing this **is**
the bug, not a regression — by stamping a per-row tag into K/P/Q and printing
the alignment after archiving 4 of 10 shipments:

```
--- readiness/ETA alignment after archiving 4 of 10 shipments ---
  SRC  (A-J compaction) : 0 intact, 6 carrying ANOTHER shipment's ETA data
      s-keep-inb   (has K1-RTS, should have K4-RTS)
      s-keep-pend  (has K2-RTS, should have K5-RTS)
      s-out-tbs    (has K3-RTS, should have K7-RTS)
      s-out-keep   (has K4-RTS, should have K8-RTS)
      s-vanished   (has K5-RTS, should have K9-RTS)
      s-unfinished (has K6-RTS, should have K10-RTS)
  PORT (whole-row delete): 6 intact, 0 desynced
```

Every single surviving shipment had the wrong readiness block. **This one is
worth raising with whoever still runs the original**, not just the port.

### Other deliberate divergences

1. **The execution budget is widened, not removed** (user decision). SRC stops
   at 4.5 minutes because Apps Script kills a script at 6. The port uses 8
   minutes against a 9-minute function timeout — and `timeoutSeconds: 540` is
   set explicitly, because the **default for a scheduled function is 60
   seconds**, which this cannot finish in. The mechanism is kept because it is
   load-bearing: a board that did not finish its card list is excluded from
   `boardsFullyProcessed`, and pruning treats "not seen this run" as "deleted
   from Trello". Without the budget-and-exclusion pair, a slow run archives
   live shipments.
2. **`UrlFetchApp.fetchAll` → `Promise.all(fetch)`**; same batching shape.
3. **Per-row `setValues` → one batched update.** SRC writes each changed row in
   its own call inside a `forEach`. Same cells, fewer calls, no half-written
   cycle.
4. **Row padding** (`padRows_`), as in steps 2 and 3.

### Test — `npm run test:parity:sync`

```
ran 50 comparisons across 13 scenarios
SYNC PARITY OK — identical writes, identical surviving rows, and the
documented A-J-compaction divergence verified
```

The fixture builds SHIPMENTS at its **real 18-column width** — a 10-column
fixture could not show the desync at all — and the fakes on both sides
**apply** their writes rather than only recording them. That second point
matters: the sync runs archive and then prune against the same tab, and a
recorder that does not mutate makes the second pass see a stale sheet, which
produced a reported difference that had nothing to do with the port. Applying
also makes the final sheet, K–R included, directly inspectable.

Three assertions per scenario: the non-removal ops must match exactly; the
**set of surviving shipments** must match (the mechanisms differ, the outcome
must not); and the port must leave every surviving row owning its own K–R block.

**Mutation-tested — fifteen properties, two passes.** The first caught 12 and
**three survived** (no already-archived Trello card, no card in a Delivered list
with a complete checklist, no short row). After adding those fixtures, the
second pass caught **all fifteen, none survived**:

| Mutation | Result |
|---|---|
| the K–R fix reverted to SRC's A–J compaction | 39 differences |
| rank guard removed (Writer 1 clobbers Writer 3) | 4 differences |
| prune ignores `boardsFullyProcessed` (archives live rows) | 6 differences |
| archive: non-local carve-out removed | 5 differences |
| archive: fully-received-from-summary route removed | 5 differences |
| Burlington rename applied to known brands too | 3 differences |
| skipped lists no longer skipped | 6 differences |
| history gate removed (re-appends archived cards) | 6 differences |
| vanished card: closed branch removed | 3 differences |
| vanished card: untracked-board branch removed | 1 difference |
| tracking harvested from description only, not comments | 3 differences |
| `isFullyPacked` fallback removed for a Delivered inbound list | 3 differences |
| pipeline order: date refresh before override detection (SCHEMA §4F) | 4 differences |
| rollup engine no longer run before archive | 4 differences |
| row padding removed | 4 differences |

### What is NOT covered

The Trello transport and the Sheets transport are stubbed, so this proves which
calls are made with which payloads — not that they succeed against live APIs.
The schedule firing, real Trello pagination, and rate-limit behaviour are all
unverifiable here and are stated as such rather than tested around.

### Everything else

| Check | Result |
|---|---|
| `npm run lint` | 0 errors, 10 warnings (unchanged) |
| `npm test` | ✅ exit 0 |
| `npm run test:parity` | ✅ 57,298 comparisons, 0 differences |
| `firebase emulators:start` | ✅ clean boot, 4 functions |

---

## Step 5 — `pushOutboundToShippingSchedule` (DEFERRED, by decision)

Not started. The user is handling it at deployment time, since it is the one
unit that cannot be finished without live access: it reads two **external**
Google Sheets (the AEO sheet Power Automate updates, and the Burlington sheet a
local Python script uploads) and pushes cards to Trello.

It is genuinely independent — a one-way push from those sheets to Trello that
never touches SHIPMENTS — so nothing else waits on it. What it will need is in
`DEPLOYMENT.md` under "When you want the AEO / Burlington push".

## Step 6 — `Service_Router` retirement (DONE)

Not a port. `SRC/src/Service_Router.js` is 286 lines of which almost nothing is
live, and the risk in "mostly dead" is dropping the part that isn't. So rather
than deleting by eye, the mapping is now **machine-checked** — `PART C` of
`npm run test:routes`, which extracts the dataset list **from SRC** and compares
it against what the port actually serves.

### Where each piece went

| `Service_Router.js` | Disposition |
|---|---|
| `doHEAD` | `exports.trelloWebhook` answers HEAD with 200 (step 3) |
| `doGet` webhook fast-path | `exports.trelloWebhook` answers GET with 200 (step 3) |
| `doGet` precompiled datasets | `GET /boot` (Phase 3) — all nine, same fallbacks |
| `BOOT_ISSUES_` / `getBootIssues_` | `GET /boot` → `bootIssues` |
| `precompileDataset_` | `boot.js` → `precompile()` |
| `doGet` `?page=injector` | SPA route `/trello-injector` |
| `legacyDoPost_` | **Dead in the ORIGINAL** — explicitly retired there, with a comment warning against renaming it back |
| `legacyProcessWebhookPayload_` | **Dead in the ORIGINAL**, same note |
| `include()` | Apps Script `HtmlService` templating; Vite bundles the SPA |
| `safeJsonForScriptTag_` | **Structurally unnecessary** — see below |

### Why `safeJsonForScriptTag_` is not ported, checked rather than assumed

AUDIT D3 is a real finding: `JSON.stringify` does not escape `<`, U+2028 or
U+2029, so a cell containing `</script` inlined into an inline `<script>` block
ends the tag early and breaks the whole page load with no error anywhere.

That vulnerability needs an **inline-script injection point**, and the port has
none: boot data crosses as an `application/json` response body
(`frontend/src/api.js` → `getBootDataset: () => fetchFromFirebase('/boot')`),
parsed by the client. Verified there is no `innerHTML`,
`dangerouslySetInnerHTML`, or HTML-with-interpolated-data anywhere in
`functions/` or `frontend/src`. React escapes text nodes by default on top of
that. The escaping helper has nothing to protect, so porting it would be cargo.

**If that ever changes** — if anything starts inlining server data into markup —
this decision has to be revisited, which is why it is written down rather than
silently omitted.

### The check

`PART C` of `npm run test:routes` (95 checks total now, up from 82):

- the nine dataset names are read out of `SRC/src/Service_Router.js` and must
  match `boot.js` exactly — **add a tenth upstream or drop one here and it
  fails, naming it**
- `GET /boot` is registered and still returns `bootIssues`
- each re-homed function has a verified live counterpart
- the four dead functions are asserted **absent** from the port, so nobody
  "helpfully" ports them back later

Skips cleanly when `SRC/` is absent, like the parity harnesses.

**Mutation-tested — four mutations, all caught** (the first pass let one
through: the `bootIssues` check matched the word in a comment, so it survived
the field being deleted from the response. Tightened to match the actual
property):

| Mutation | Result |
|---|---|
| a precompiled dataset dropped from `/boot` | 1 failure |
| `bootIssues` removed from the response | 2 failures |
| a dataset renamed (drifts from SRC) | 1 failure |
| a dead `Service_Router` function ported back in | 1 failure |

### One frontend gap recorded

`doGet`'s `?page=rxo` served `RXO_Test.html`, a standalone RXO Connect API test
bench. There is **no SPA route for it** — `frontend/src/App.jsx` has no `/rxo`.
That is a frontend gap, not a `Service_Router` one (the backend `Service_RXO` is
~80% ported), and it belongs with the rest of the frontend work. Recorded here
because this is where it was noticed.
