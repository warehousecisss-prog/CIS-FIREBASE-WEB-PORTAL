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
