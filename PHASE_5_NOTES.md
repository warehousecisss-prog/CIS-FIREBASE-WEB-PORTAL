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
