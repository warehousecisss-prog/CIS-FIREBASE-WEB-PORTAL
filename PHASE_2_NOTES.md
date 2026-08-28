# Phase 2 — Shared_Classifiers + Write/Read parity

**Date:** 2026-08-28
**Baseline:** `1160f1f` (end of Phase 1)
**Scope:** port `Shared_Classifiers`, wire it into the services, bring
`Service_Write` and `Service_Read` to function parity with `SRC/src`.

Phases 5–8 (HTTP route layer, `Service_Dates` parity, sync/webhook functions,
frontend) not started.

---

## 1. `Shared_Classifiers` ported

`functions/services/Shared_Classifiers.js`. Read/Write/Assembly all referenced
it in comments as "assume available"; nothing was available.

Ported: the board matrix, list/status classification, brand and inbound-origin
classification, the `.ignore` feature, product identity resolution, the
rate-limited Trello transport, and `parseSysBlob_`.

### What necessarily changed in the move to Node

| | |
|---|---|
| `trelloFetch_` is **async** | Node's fetch is promise-based; `UrlFetchApp` blocks. It keeps the `getResponseCode()` / `getContentText()` shims for the reason the original grew them — a ported call site stays a mechanical rename and cannot silently change what its branches decide. It also accepts either the `UrlFetchApp` option shape (`payload`, `contentType`) or fetch's own. |
| `Utilities.sleep` → awaited timer | Same backoff arithmetic. |
| Name matching stays **synchronous** | `canonicalNameKey_` / `productIdentityKey_` / `namesMatch_` run in tight per-row loops; making them async would turn every caller into a serialised await chain. The one thing they need that is now async — the PRODUCT index behind `productIdentityKey_` — is split into an async `primeQbNameIndex()` plus a sync cache read. An unprimed cache degrades exactly the way SRC's own try/catch does (falls back to the plain canonical key) but warns once, so a missing prime is findable rather than silently weakening every comparison. |
| `trelloCreds_` lives here | SRC keeps it in `Service_Dates` and reaches it through Apps Script's single global namespace. In Node that would make `Shared_Classifiers` depend on `Service_Dates`, which depends back on this file. This module sits at the bottom of the dependency graph. |

### Deliberate omissions

- `classifyInboundOrderOriginServer_`'s `registryLocalMatch` local is assigned
  and never read in SRC. Dead, so not carried across as cargo. Noted in source.
- `backfillIgnoreCommentsFromComments_` needs `fetchCardComments_` and
  `SHIPMENTS_COL` from `Service_Dates`, neither ported yet. It lands with
  `Service_Dates` parity. `SHIPMENTS_COL` and `DATE_STATES` are now exported
  ready for it.

### Parity is tested, not asserted

`functions/test/parity_Shared_Classifiers.js` — `npm run test:parity`.

It executes SRC's original inside a sandboxed VM (stubbing `PropertiesService`,
`Logger`, `UrlFetchApp`) alongside the port and diffs every output. These
functions are pure, so the original can simply be run beside the port; "I
ported it carefully" is not evidence. It catches the class of mistake that
reads correctly and behaves differently — a dropped negation, a regex flag, an
ordering dependency like `getRollupRank_`'s PARTIAL-before-DELIVERED check.

**1492 comparisons across 19 functions, all identical.** That includes 702
`namesMatch_` / `productIdentityKey_` pairs run twice: once with the PRODUCT
index empty and once populated. The second round is the one that matters — it
proves the sync/async split changed no answer.

Skips cleanly when `SRC/` is absent (it is gitignored and lives on the porting
machine only).

---

## 2. Services wired into it

- **Trello transport (AUDIT A8).** 27 raw `fetch()` calls — `Service_Read` 13,
  `Service_Write` 12, `Service_Dates` 2 — now go through `trelloFetch_`, which
  retries 429 and 5xx with exponential backoff and honours `Retry-After`.
  Before this there was not one occurrence of `429`, `retry` or `backoff`
  anywhere: every call site checked only `res.ok`, so a throttled request looked
  exactly like a successful one. `receivePOCardItems` issues two requests per
  checklist item in a tight loop, so a 40-line PO receipt is 80 requests back to
  back. `Service_RXO`'s fetches are a different API and were left alone.
- **`_SYS_` parsing (AUDIT A5).** Nine inline `JSON.parse(...split('_SYS_')...)`
  sites with empty catches now call `parseSysBlob_`. A malformed blob still
  skips the row — callers need that rather than aborting a batch — but it is
  logged with the row number instead of making a Master Hub row silently
  invisible to the explode/move/delete logic.
- **Credentials.** Three services read `process.env.TRELLO_*` directly; all now
  use `trelloCreds_()`. `Service_Dates` carried its own duplicate, now deleted.

---

## 3. `Service_Write` parity

Ported: `validateQty_`, `processAuditAction`, `bulkVerifyAuditLocations`,
`markAuditComplete`, `removeItemFromLocation`, `moveHubGroup`,
`splitInventoryRow`, `logDisplayDiagnostic`, `readLiveChecklistState_`.

**`validateQty_` (AUDIT B5)** is wired into `setTotalStock`, `updateStock`,
`addNewItemToLocation`, `moveInventoryItem` and `splitInventoryRow`. NaN was the
hazard: every qty write branches on `newQty <= 0`, and `NaN <= 0` is **false**,
so `"12o"` from the drawer fell through to the else and wrote a literal `NaN`
into column C. Parity-checked against SRC across 22 inputs.

**Row-data-mismatch guard restored.** SRC's `updateInventoryByRow` /
`setTotalStockByRow` re-read the row and refuse with *"Row data mismatch. The
sheet may have been modified."* In this port those twins delegate to
`modifySheetRow`, so the guard was simply gone — a raw client row index was
trusted blind, and a row shifted by the concurrent sync meant the write landed
on a **different pallet**, silently, reported as success. The check now lives in
`modifySheetRow`'s numeric branch, covering both twins and every other numeric
caller.

### `receivePOCardItems` had five separate problems

1. **AUDIT B6 — trust boundary.** `oldQty`/`oldRcvd` arrived from the browser
   and fed the over-receipt guard directly, so two stations with the same PO
   open both held the same stale `oldRcvd`, both passed, and both appended. Now
   re-read from the live card via `readLiveChecklistState_` before the guard
   runs, with everything downstream using the corrected values.
2. **AUDIT A3 — false success.** The checklist PUTs and comment POSTs ran with
   the response code never inspected inside empty catches, then the function
   returned `{success:true}` regardless. A token expiry or a 429 mid-batch meant
   inventory gained the units, Trello still showed the full remaining QTY, the
   operator saw a success toast, and the next shift received the same PO again.
   Now returns `trelloSynced:false` plus `failedItems[]`. Deliberately **not** a
   hard failure: the stock is physically on the floor and the Inventory write
   succeeded, so refusing outright would be a lie in the other direction.
3. **Column D was written as `'PO_RECEIVED'`.** It is the workflow status
   column, so anything checking `status !== "Open"` (`generateLocalTotals`) read
   every freshly-received Limbo pallet as staged.
4. **Column E was written as a timestamp.** It is the soft-kit / bulk-hub type
   flag the assembly logic reads, not a date field.
5. **The inventory name came from two inline stubs** that just pulled the
   bracket contents out of the checklist text. Now `resolveCanonicalProductId_`
   against the PRODUCT map, so Inventory holds the stable Product ID — the
   identity fix from SRC 2026-08-26.

---

## 4. `Service_Read` parity

Ported: `getSkuLastUpdatedMap` / `buildSkuLastUpdatedMap_`,
`getInboundPoBoardId_`, `getTrelloBoardLabels`, `getInboundPoBoardLabels`,
`getCardLabels`, `updateCardLabels`, `getInjectorUrl`,
`getCardShippingReference`, `setCardShippingReference`. `getBoardMatrix_` — a
TODO in the port that was never defined — now comes from `Shared_Classifiers`.

### Three real bugs found while porting

- **`PORTAL_IGNORED_MARKER` was the wrong string.** Declared locally as
  `"PORTAL_IGNORED_MARKER"` under a comment reading *"Ensure this matches what
  Shared_Classifiers uses"*. It does not — the real marker is
  `"[PORTAL_IGNORED]"`. `buildLogisticsDashboardPayload_` filters on
  `summary.indexOf(PORTAL_IGNORED_MARKER) === 0`, so the filter matched nothing
  and every `.ignore`'d card kept showing on the dashboard. Now imported rather
  than re-declared, so it cannot drift again.
- **`getProductMap` did not carry `productId`.** That field is the whole point
  of `resolveCanonicalProductId_`, which reads it to decide what goes in
  Inventory's SKU column; without it that function falls through to the
  nickname, silently reintroducing the identity drift item 5 above fixes.
- **`getTrelloBoards` returned every board the token can see**, with a TODO
  admitting it was a placeholder for the board matrix. SRC filters to the 4
  boards in `getBoardMatrix_` (SCHEMA §2). Returning all of them puts boards the
  sync pipeline knows nothing about into the injector's picker, and a card
  created on one of those is invisible to everything downstream.

### Two necessary deviations

- **`getInjectorUrl`.** SRC returns `ScriptApp.getService().getUrl() +
  '?page=injector'`; Cloud Functions has no equivalent, since the backend does
  not know the Hosting domain it sits behind. It derives the origin from the
  incoming request when one is passed, falls back to a new optional
  `PORTAL_BASE_URL` config key, and returns `{success:false}` with an actionable
  message when neither is available.
- **`setCardShippingReference`.** SRC passes `payload: {desc}`, which
  `UrlFetchApp` form-encodes; Node's fetch does not, so the body goes as JSON
  with an explicit Content-Type, which Trello accepts for `PUT /1/cards/{id}`.
  Putting the description in the query string instead was rejected deliberately:
  a long description would blow the URL length limit and would put free card
  text into a URL that ends up in logs.

---

## 5. New config key

`PORTAL_BASE_URL` (port-only, optional) — public origin the SPA is served from,
for `getInjectorUrl()`. Documented in `config.js` and `.env.example`.

---

## Verification

| Check | Result |
|---|---|
| `npm run test:parity` | ✅ 1492 comparisons, 0 differences |
| `validateQty_` vs SRC, 22 inputs | ✅ identical |
| Product identity chain end-to-end | ✅ `resolveCanonicalProductId_` → Product ID, `resolveCanonicalItemName_` → nickname |
| `npm run lint` | ✅ exit 0 (6 pre-existing warnings) |
| All 12 service modules + `index.js` load | ✅ |
| `firebase emulators:start --only functions` | ✅ clean boot, `GET /me` 200 |
| No raw Trello `fetch` left in services | ✅ only RXO (different API) and the transport itself |
| No inline `_SYS_` parses left | ✅ |

---

## Still open

**Not started (Phases 5–8 of `PORT_AUDIT.md`'s sequencing):**

- The HTTP route layer. `index.js` still exposes only `/me`, `/inventory` and
  `/logistics-dashboard`; every mutation ported in this phase has no endpoint,
  and `frontend/src/api.js` already calls `/shipment`, `/po-ingest` and
  `/diagnostics`, which 404. **This is the natural next step** — the service
  layer is now largely there, and nothing the SPA does can reach it.
- `Service_Dates` parity (~16 functions, incl. `estimateShipByDateV2`), which
  also unblocks `backfillIgnoreCommentsFromComments_`.
- `Service_Conversions` parity — `getQbNameIndex_` was ported into
  `Shared_Classifiers` as `primeQbNameIndex`, but `caseBreakdown_`,
  `resolveUnitsPerCase_` and `formatQtyWithCases_` are still missing, and
  `findCaseConversion` still prefix-matches the raw SKU rather than resolving it
  to the QB name first (the SRC 2026-08-26 fix).
- `Service_Assembly`'s `commitInventoryMutation_`, `findEffectiveQtyPer_`,
  `explodePartialHub`.
- Sync + webhook functions, `Fedex_Master_Script`, frontend.

**Known gaps carried forward from Phase 1:**

- **No lock anywhere on the write path (AUDIT B7).** SRC wraps `modifySheetRow`,
  the `*ByRow` twins and `splitInventoryRow` in `LockService.tryLock(10000)`.
  Apps Script's `LockService` has no Node counterpart; this needs a Firestore
  transaction or a distributed lock and is its own design decision. The
  row-mismatch guard above narrows the window but does not close it.
- **`SS_API.commitAtomic` not ported (AUDIT B3).** Present in
  `SRC/src/Service_SheetsAPI.js`. Its only callers are the assembly write paths,
  which are still Phase 2+ work.
- Frontend sign-in (needs the `firebase` JS SDK — a new dependency).
- Secret Manager for the `secret: true` config keys (deploy-topology change).
