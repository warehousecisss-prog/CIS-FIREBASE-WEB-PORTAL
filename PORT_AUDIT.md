# Firebase Port — Service Audit

**Date:** 2026-08-28
**Baseline commit:** `dd07a8f` (Antigravity's in-progress port, imported as-is)
**Audited against:** original Apps Script repo at `SRC/src/` + `reference/SCHEMA.md` (v17)

> **Status update 2026-08-28 — Phases 1, 2 and 3 complete; Phase 4 in progress.**
> - **Phase 1** (`PHASE_1_NOTES.md`): infra spine, C1–C5, auth decision.
> - **Phase 2** (`PHASE_2_NOTES.md`): `Shared_Classifiers` ported and wired in,
>   `Service_Write` and `Service_Read` brought to parity.
> - **Phase 3** (`PHASE_3_NOTES.md`): the HTTP route layer — 71 routes covering
>   all 64 server calls the original's client makes, behind one `runMutation`
>   wrapper. 10 of those routes answer 501 because the service behind them is
>   unported.
> - **Phase 4, Unit A** (`PHASE_4_NOTES.md`): the write-path lock (AUDIT B7) —
>   `functions/lock.js`, a Firestore lease behind one `withInventoryLock(fn)`.
>   Also fixed F2 and restored the re-check-under-lock missing from
>   `receivePOCardItems`.
> - **Phase 4, Unit B** (`PHASE_4_NOTES.md`): `Service_Dates` parity — 14
>   functions including `estimateShipByDateV2`, and F4, which turned out to be
>   THREE missing pieces rather than two. 45,850-comparison parity harness.
>   `backfillIgnoreCommentsFromComments_` unblocked.
> - **Phase 4, Unit C** (`PHASE_4_NOTES.md`): the three move paths locked —
>   deliberately further than SRC goes.
> - **Phase 4, Unit D** (`PHASE_4_NOTES.md`): `Service_Conversions` parity,
>   including the 2026-08-26 QB-name fix. Tracing it uncovered **four
>   aging-anchor bugs** in `Service_Read`/`Service_Write` and the fact that
>   nothing was priming the product-identity index at all. Two more parity
>   harnesses.
> - **Phase 4, Unit E** (`PHASE_4_NOTES.md`): `Service_Assembly` parity and
>   `SS_API.commitAtomic` (AUDIT B3) — the assembly write paths were committing
>   through 3-4 separate API calls, so a failure mid-way doubled or destroyed
>   stock. `explodePartialHub` is live. Two more parity harnesses.
> - **Phase 4, Unit F** (`PHASE_4_NOTES.md`): outbound email — `Service_Email`
>   was ignoring all five SMTP_* config keys and hardcoding placeholder
>   credentials; `emailPOPdfToSupplier` ported. Also a **correction to this
>   document**, see `Service_PO_Ingest` below.
>
> Sections below are annotated where they are now out of date. **Every backend
> service is now at or near parity.** The next bottleneck is the
> **sync/webhook functions** (`syncAllBoardsToShipmentsTab`,
> `evaluateRollupStatuses`, `Webhook_Receiver`, `pushOutboundToShippingSchedule`,
> `Service_Router` — 135KB between them), then `Fedex_Master_Script` and the
> frontend. Seven routes still answer 501 — three FedEx, three RXO, one HTS —
> and every one waits on a whole unported file rather than a missing function.

> **Status update 2026-08-31 — Phase 5 started (`PHASE_5_NOTES.md`).** The
> sync/webhook body of work. Deploy-topology decisions taken up front (drop the
> Render proxy, widen the sync self-timeout, Firestore-backed webhook
> de-bounce, external AEO/Burlington sheets shared with the service account).
> **Step 1 done:** four pure SHIPMENTS-row helpers (`formatOutboundLineItems`,
> `harvestFedExTrackingNumber`, `extractStoreInfo`, `cleanTrackingNumber`)
> ported verbatim into `Shared_Classifiers.js`; `parity_Shared_Classifiers.js`
> extended to 3052 comparisons across 23 functions, mutation-tested. Nothing
> wired to a caller yet — these land ahead of the engines (steps 2–5).
> **Step 2 done:** `evaluateRollupStatuses` → `functions/services/Service_Rollup.js`
> (SCHEMA §7, the rollup state machine). Decision tree extracted as a pure
> `evaluateRollupRow_`; 455-comparison harness that diffs the emitted status
> writes / Trello calls / emails, mutation-tested against **ten** properties.
> Found and fixed **a real bug the verbatim port would have shipped** — the
> Sheets API omits trailing empty cells where Apps Script pads them, so every
> statusless shipment would have had the literal text `undefined` written into
> column J (see `padRows_`). Also closed a previously-unrecorded gap in
> `markFedExChildDeliveredInSheet`, which was missing SRC's post-write rollup
> refresh + cache warm. Not client-callable, so no route.

> Purpose: an honest map of what is actually ported, what is stubbed, and what
> hasn't been started — so the remaining work can be sequenced. The existing
> `MIGRATION_CHANGELOG.md` marks every backend service `[DONE]`; that is
> optimistic. Several "done" services are 40–70% smaller than their originals
> with core functions missing.

---

## TL;DR

| Layer | State | Notes |
|---|---|---|
| Firebase scaffold | ~~**Usable**~~ **Fixed (Phase 1)** | `.firebaserc`, shared `firebase-admin` init, `config.js`, auth middleware, ESLint config all added. Node engine now `22`. |
| `Service_SheetsAPI` (SS_API) | ~~**Blocking bug**~~ **Fixed (Phase 1)**, **`commitAtomic` added (Phase 4E)** | Writes use `RAW` + `INSERT_ROWS`. Real gid resolution via `getSheetId()`. `getSpreadsheetId()` reads `BATCH_SHEET_ID`. `batchUpdateSheet()` (4B) and `commitAtomic()` (4E, AUDIT B3) complete the write surface. |
| `Service_Read` | ~~**~65%**~~ **~95% (Phase 2)** | Label management, shipping-reference r/w, SKU-last-updated map and the board matrix all ported. Only `testReadMPS` (a manual Logger harness) is absent. **Phase 3 found three more gaps:** `findOrCreatePOCardAndInject` was creating Trello labels and had lost `idLabel` (fixed, F3); `getAllInventory` drops the Instance_ID column (F5) and returns `null` where SRC rethrows (F6, AUDIT A4). |
| `Service_Write` | ~~**~45%**~~ **~95% (Phase 2)** | A1 silent-failure fixed; 9 of 10 missing functions ported (`validateQty_`, `splitInventoryRow`, `moveHubGroup`, audit actions, …). B5/B6/A3 fixed. Only `testReceivingDataFlow` (a manual Logger harness) is absent. **Phase 3 found two more gaps:** `moveInventoryItem` had lost `clientAssertsKnownCoordinate` (fixed, F1) and still listed `ZONE-STAGED` as a virtual zone (fixed, F2 — Phase 4). **Phase 4 also added the write lease and restored `receivePOCardItems`' missing re-check-under-lock.** |
| `Service_Dates` | ~~**~55%**~~ **~98% (Phase 4B)** | `estimateShipByDateV2` (SCHEMA **§4G** — *not* §8 Engine 4, which is the FedEx CSV batch tool), override detection, comment backfill and bot-account logic all ported. F4 was three missing pieces, not two — the third, a lost exact-`Port`-first match in `findTransitLane_`, had reintroduced the 2026-08-21 port-collision bug on **every** ETA recompute. 45,850-comparison parity harness. |
| `Service_Conversions` | ~~**~30%**~~ **~100% (Phase 4D)** | Case-breakdown / units-per-case engine ported, and `findCaseConversion` restored to resolving the SKU to its QB name first — without that, the put-away conversion had stopped firing for everything received since 2026-08-11, silently. 7,401-comparison parity harness. Note the `CASE_CONVERSIONS` tab does not exist in the live workbook on either side. |
| `Service_Assembly` | ~~**~60%**~~ **~100% (Phase 4E)** | `explodePartialHub`, `commitInventoryMutation_` and `findEffectiveQtyPer_` ported, and all three write paths rewired through one atomic commit (AUDIT B3). Before this, `buildHardAssembly` deleted the consumed components in one call and minted the assembly in a later one — a failure in between **destroyed stock**; `explodeAssembly` was the mirror image and **doubled** it. Parity harness compares the emitted Sheets operations, not the return value. |
| `Service_PO_Ingest` | ~~**~60%**~~ **~95% (Phase 4F)** | ~~`extractTextFromPdfBlob` missing~~ — **that claim was wrong**: the capability is inlined into `processUploadedPOFile`, which calls `pdfParse(buffer)`. There IS a real gap underneath it, and a more interesting one: SRC does not read the PDF's text layer at all, it round-trips the file through Google Drive with `{ocr:true}`. That reads a **scanned** PO; `pdf-parse` only extracts an existing text layer. A QuickBooks-generated PO parses identically; a scanned one the original could read, this cannot — it refuses honestly rather than parsing to nothing. Closing it needs a new dependency or Google service, so it **needs a decision**. `emailPOPdfToSupplier` ported (4F). |
| `Service_RXO` | **~80%** | Cleanest port. Missing config-status + diagnostics harness helpers. |
| `Service_Validate` | **~85%** | Ported; board-id check against env still a comment. |
| `Service_Diagnostics` / `Service_Email` | Ported / new, **`Service_Email` fixed (4F)** | Email is a fresh nodemailer wrapper (no original). It hardcoded `smtp.ethereal.email` with a literal placeholder password and read **none** of the five SMTP_* keys Phase 1 declared, so every outbound message failed. Now built from config, lazily, failing soft when unconfigured. |
| HTTP routes | ~~**~5%**~~ **Done (Phase 3)** | `functions/http/` — 71 routes, all 64 SRC client calls covered, common `runMutation` wrapper, 82-check contract test (`npm run test:routes`). ~~10~~ **7** routes answer **501** naming the unported service behind them — `estimateShipByDateV2` went live in 4B, `explodePartialHub` in 4E and `emailPOPdfToSupplier` in 4F. All seven remaining wait on a whole unported FILE, not a missing function. |
| Not ported at all | — | ~~`Shared_Classifiers`~~ **(ported, Phase 2)**, `Webhook_Receiver`, `syncAllBoardsToShipmentsTab`, `evaluateRollupStatuses`, `pushOutboundToShippingSchedule`, `Service_Router`, `Fedex_Master_Script`, HTS tools. |
| Frontend views | **~10%** | Shell + 14 map SVGs converted. All views are placeholder/dummy-data. Client engine (`JS_Handlers` 337KB, `JS_Render_UI` 145KB) not ported. |

---

## Critical regressions — ALL FIXED IN PHASE 1 (2026-08-28)

> Kept below as the record of what was wrong and why it mattered. Each entry now
> carries a **FIXED** line. Details in `PHASE_1_NOTES.md`.

### C1 — `SS_API` writes with `USER_ENTERED`, not `RAW`
`functions/services/Service_SheetsAPI.js:50,84`. The original's `batchUpdateValues`
carries a long comment (still visible at `SRC/src/Service_SheetsAPI.js:20-35`)
explaining why this **must** be `RAW`: every value written is free text from Trello
(pallet comments, checklist descriptions). `USER_ENTERED` turns a checklist item
named `-3M SLIDE` or a comment `=2 pallets short` into a formula that renders
`#NAME?` forever, and strips leading apostrophes. This is AUDIT finding B1, already
fixed once upstream. Fix: `valueInputOption: "RAW"` in both `batchUpdateValues`
and `batchAppendRows`.

**FIXED 2026-08-28** — both use `RAW`; `batchAppendRows` also gained
`insertDataOption: "INSERT_ROWS"` (AUDIT B2, same request object).

### C2 — Silent write-failure path re-introduced (AUDIT A1)
`Service_Write.js:29` `modifySheetRow()` still does `if (targetRowIdx > -1) {...}`
with no `else`, returning `undefined` when the row isn't found. Callers
(`setTotalStock:132`, `updateStock:158`, …) still `return { success: true }`
unconditionally. This is the exact bug the upstream AUDIT Phase 1 fixed: operator
taps SET, row was shifted by a concurrent sync, nothing writes, server says OK, UI
repaints the old number. Fix: `modifySheetRow` returns
`{success:false, error:'Row not found for <loc>/<sku>'}` on `-1`; callers return it
verbatim. (Upstream `Service_Write.js` already has this — diff against it.)

**FIXED 2026-08-28** — `modifySheetRow` returns a real result object on every
path; all five callers return it verbatim. Callback is now awaited too. Still
missing vs SRC: the `LockService` guard (B7) and `validateQty_` (B5) — Phase 2.

### C3 — `getSpreadsheetId()` returns a placeholder
`Service_SheetsAPI.js:31`. Nothing reads/writes until `BATCH_SHEET_ID` is wired
(env var / Firebase params). Same for every Trello/RXO/FedEx credential — the
original pulls them from Script Properties; there is no equivalent config layer
in the port yet.

**FIXED 2026-08-28** — `functions/config.js` declares every key found by
grepping SRC for `getProperty`, with defaults, aliases and source lines;
`getSpreadsheetId()` is `config.require('BATCH_SHEET_ID')`.

### C4 — `batchDeleteRows` uses hardcoded `sheetId: 0`
`Service_Write.js:101` passes `inventorySheetId = 0` with a comment admitting it's
a guess. Sheet gid 0 is the *first* tab, not necessarily `Inventory`. A wrong gid
deletes rows from the wrong tab. Fix: resolve the real gid once via
`spreadsheets.get` and cache it.

**FIXED 2026-08-28** — `SS_API.getSheetId()` / `getSheetMetadata()` resolve and
cache the real gid; all three hardcoded `0` call sites replaced;
`batchDeleteRows` rejects a non-integer gid. Also supplies the
`getSheetMetadata` that `Service_Assembly` already called but which never existed.

### C5 — Operator identity lost
`getActiveUserEmail()` (duplicated in Write/Assembly/Diagnostics) returns the
constant `"system@cis-portal.app"`. Every `Audit_Log` row and receiving payload
loses who did it. Needs the real auth decision (below) before it means anything.

**FIXED 2026-08-28** — Firebase Auth (Google provider), domain-locked, 401 on
failure. One shared `getActiveUserEmail()` in `functions/auth.js` that throws
rather than substituting a placeholder. Frontend sign-in still outstanding (needs
the `firebase` JS SDK).

---

## Missing functions by service

### `Service_Write.js` — **RESOLVED in Phase 2** (1 of 10 still missing)
~~`validateQty_`~~ · ~~`processAuditAction`~~ · ~~`bulkVerifyAuditLocations`~~ ·
~~`markAuditComplete`~~ · ~~`removeItemFromLocation`~~ · ~~`moveHubGroup`~~ ·
~~`splitInventoryRow`~~ · ~~`readLiveChecklistState_`~~ ·
~~`logDisplayDiagnostic`~~ · **`testReceivingDataFlow`** (still missing)
→ `testReceivingDataFlow` is a manual `Logger.log` harness with no caller; a
Node equivalent wants a different shape (returning data, not streaming to a
log). Everything else is ported. See `PHASE_2_NOTES.md` §3.

### `Service_Read.js` — **RESOLVED in Phase 2** (1 still missing)
~~`getSkuLastUpdatedMap` / `buildSkuLastUpdatedMap_`~~ · ~~`getInboundPoBoardId_`~~ ·
~~`getTrelloBoardLabels`~~ · ~~`getInboundPoBoardLabels`~~ · ~~`getCardLabels`~~ ·
~~`updateCardLabels`~~ · ~~`getInjectorUrl`~~ · ~~`getCardShippingReference`~~ ·
~~`setCardShippingReference`~~ · ~~`getBoardMatrix_`~~ (now imported from
`Shared_Classifiers`) · **`testReadMPS`** (still missing, same reason as
`testReceivingDataFlow`)
→ Three real bugs were found and fixed while porting these: a wrong
`PORTAL_IGNORED_MARKER` literal that made the dashboard's ignore filter match
nothing, a missing `productId` field on `getProductMap` entries that silently
defeated the Inventory identity fix, and `getTrelloBoards` returning every board
the token can see instead of the 4-board matrix. See `PHASE_2_NOTES.md` §4.

### `Service_Dates.js` — **RESOLVED in Phase 4, Unit B**
~~`estimateShipByDateV2`~~ · ~~`getDeliveryDestinationCatalog_`~~ ·
~~`resolveTransitDestinationCluster_`~~ · ~~`detectMissedDueDateOverrides_`~~ ·
~~`backfillReadyPortFromComments_`~~ · ~~`getLastAutoDueForCard_`~~ ·
~~`markEtaOverridden_`~~ · ~~`getTrelloMemberInfo_`~~ · ~~`identifyTrelloBotAccount`~~ ·
~~`fetchCardComments_`~~ · ~~`findLatestReadyPortInfo_`~~ · ~~`setupShipmentDateColumns`~~
→ `computeShipmentDates_` and `getPeakSeasonWindow_` were checked against SRC and
are at parity — the latter had lost its diagnostic logging, now restored.
→ `estimateShippingWindowV2`'s `port` parameter is restored and
`findTransitLane_` honours it. See `PHASE_4_NOTES.md` §Unit B/2 for the third,
previously unrecorded, piece of F4 — the one that mattered most, because it sat
on the path every ETA recompute takes.
→ Also fixed while in there: `TRAVEL_TYPE_LABELS` was missing `TRUCKING`;
`getTransitLaneCatalog` was missing `deliveryDestinations`, which *is* the
Destination dropdown; two Trello error strings rendered `undefined`; and
`formatDateCell_` could write the literal `"NaN/NaN/NaN"` into a sheet cell.
→ **Note:** `estimateShipByDateV2` is SCHEMA **§4G**. §8's Engine 4 is
`batchCalculateTransitTimes()`, the FedEx CSV batch estimator, still a 501.

### `Service_Conversions.js` — **RESOLVED in Phase 4, Unit D**
~~`getQbNameIndex_`~~ (in `Shared_Classifiers` as `primeQbNameIndex` /
`getQbNameIndex_`, split async/sync — `PHASE_2_NOTES.md` §1) ·
~~`resolveUnitsPerCase_`~~ · ~~`caseBreakdown_`~~ · ~~`formatQtyWithCases_`~~ ·
~~`setupCaseConversions`~~ · ~~`reportConversionGap`~~ · ~~`FLOOR_CASE_SKUS_`~~
→ `findCaseConversion` now resolves the SKU to its QB name before
prefix-matching — the 2026-08-26 fix. This was **not** a cosmetic gap: since
2026-08-11 receiving writes the *nickname* into Inventory, and a nickname shares
no prefix with the supplier-code rule (both `NT525S/2AMF` products are nicknamed
"2 Alarm SMALL Scorpion Tag"), so the put-away conversion had silently stopped
firing for everything received after that date.
→ The `CASE_CONVERSIONS` tab **does not exist in the live workbook** —
`setupCaseConversions()` was written in the original but never run. The
sheet-driven half is dormant on both sides; `resolveUnitsPerCase_`'s second
source (`FLOOR_CASE_SKUS_`) is what keeps the display helpers working.

### Aging anchors — **four bugs found and fixed in Phase 4, Unit D**

Not previously listed here, because both functions were marked done.
`buildAgingData_` (`Service_Read`) and `resolveOriginalArrivalDate`
(`Service_Write`) are the only two places the portal decides how old the stock
in a location is. Both listed **`EXPLODE_ASSEMBLY`**, a string nothing ever
writes (every explode logs `EXPLODE_RESTORE`), both were missing **`SPLIT_IN`**,
`resolveOriginalArrivalDate` used a two-way substring test where SRC uses
`namesMatch_`, and both carried-date branches checked `MOVE_IN` only. Net effect:
explode-restored and split-off rows had **no age anchor at all** and their
locations read as unknown age on the heatmap forever. See `PHASE_4_NOTES.md`
§Unit D/2 and the new `npm run test:parity:aging`.

Separately: **nothing in the codebase was calling `primeQbNameIndex()`**, so the
product-identity index was empty in every request and every name comparison had
silently degraded to plain-key matching — the exact weakening SCHEMA invariant
#69 exists to prevent. Now awaited at the sites that need it.

### `Service_Assembly.js` — **RESOLVED in Phase 4, Unit E**
~~`commitInventoryMutation_`~~ · ~~`findEffectiveQtyPer_`~~ · ~~`explodePartialHub`~~
→ Landed together with `SS_API.commitAtomic`, as they had to: the whole point of
`commitInventoryMutation_` is that it routes through an atomic commit.
→ All three assembly write paths also take the write lease now — a step beyond
SRC, on the same reasoning as the move paths in Unit C.

### `Service_PO_Ingest.js` (3 missing)
`extractTextFromPdfBlob` (**the pdf-parse invocation itself**) · `emailPOPdfToSupplier` ·
`resolveBrandFromPOText` is present

### `Service_RXO.js` (3 missing)
`getRxoConfigStatus` · `rxoRunDiagnostics` · `rxoTestShipmentLookup` · `rxoAuthProbe_`

---

## Not ported at all (whole files)

| File | Size | Role | Port target |
|---|---|---|---|
| ~~`Shared_Classifiers.js`~~ | 44KB | **PORTED (Phase 2)** to `functions/services/Shared_Classifiers.js`, with a parity harness (`npm run test:parity`, 1492 comparisons). `backfillIgnoreCommentsFromComments_` landed in Phase 4B, once `fetchCardComments_` existed to unblock it. A client-side duplicate is still needed. |
| `Webhook_Receiver.js` | 33KB | Real-time Trello card-update webhook | `onRequest` function |
| `syncAllBoardsToShipmentsTab.js` | 35KB | Scheduled full board→SHIPMENTS pull | `onSchedule` (currently a no-op `scheduledSync`) |
| ~~`evaluateRollupStatuses.js`~~ | 20KB | **PORTED (Phase 5, step 2)** to `functions/services/Service_Rollup.js`, with a 455-comparison harness (`npm run test:parity:rollup`) that diffs emitted status writes, Trello calls and emails, mutation-tested against 10 properties. Two deliberate divergences (stakeholder-email fallback, no lock) both documented and asserted. `migrateRollupStatusLabels` ported but untested (manual one-off). |
| `pushOutboundToShippingSchedule.js` | 35KB | AEO/Burlington external-sheet → Trello push | `onSchedule` |
| `Service_Router.js` | 12KB | Webhook routing | folds into `Webhook_Receiver` |
| `Fedex_Master_Script.js` | 31KB | FedEx MPS discovery/tracking | service module |
| `Setup_Registry.js` | 68KB | One-off manual repair scripts | low priority — port on demand |
| `updateHtsDataSheet.js`, `checkFederalRegisterForTariffChanges.js`, `OneDrive_Graph_Sync.gs.js` | — | HTS/tariff + OneDrive sync | low priority |

---

## Infra gaps

Resolved in Phase 1:

- ~~**No `.firebaserc`**~~ — added, alias `default` → `cis-warehouse-portal`.
- ~~**No `firebase-admin` init**~~ — `functions/admin.js`, required once.
- ~~**No auth**~~ — Firebase Auth (Google provider), domain-locked, 401.
  See `PHASE_1_NOTES.md`.
- ~~**Node `18`**~~ — now `22`.
- **`npm run lint` was broken** (no ESLint config existed, yet `firebase.json`
  runs it as a `predeploy` hook, so every deploy would have aborted) — fixed.

Still open:

- **CORS** is `origin: true` (reflect any origin). Acceptable now that every
  route is bearer-token gated, but narrow it to the Hosting domain for prod.
- **No frontend sign-in.** `frontend/src/api.js` sends no `Authorization`
  header, so it 401s against a deployed backend. Needs the `firebase` JS SDK.
- **Secrets are plain env vars**, not Secret Manager. Moving them is a
  deploy-topology change — needs a decision.
- **`scheduledSync`** is `logger.info("Scheduled sync running!")` and nothing else.
- ~~**`index.js` routes**~~ — **DONE (Phase 3)**. `/shipment`, `/po-ingest` and
  `/diagnostics` exist; see `PHASE_3_NOTES.md` §3 for the full inventory.
- **No `/api` rewrite in `firebase.json`** (Phase 3, F9). `frontend/src/api.js`
  uses `/api` as its production base URL, but `hosting.rewrites` is only the SPA
  catch-all, so in production every call would be answered with `index.html`.
  Adding `{"source": "/api/**", "function": "api"}` is a deploy-topology change
  — **needs a decision**.
- **No Application Default Credentials locally.** Any Sheets-backed route hangs
  for 60s against the emulator (googleapis falls back to the GCE metadata
  server) until `gcloud auth application-default login` is run and a real
  `BATCH_SHEET_ID` is set. Pre-existing; surfaced by Phase 3's route testing.

---

## Suggested sequencing

1. ~~**Config + infra spine**~~ — **DONE 2026-08-28** (`PHASE_1_NOTES.md`).
2. ~~**Fix C1–C4 in `SS_API` + `Service_Write`**~~ — **DONE 2026-08-28**.
3. ~~**Port `Shared_Classifiers`**~~ — **DONE 2026-08-28** (`PHASE_2_NOTES.md`).
4. ~~**Finish `Service_Write` + `Service_Read`**~~ — **DONE 2026-08-28**.
5. ~~**Build the HTTP route layer**~~ — **DONE 2026-08-28** (`PHASE_3_NOTES.md`).
   `functions/http/`, 71 routes, one `runMutation` wrapper, machine-checked
   against the 64 SRC client calls.
6. ~~**`Service_Dates` parity** incl. `estimateShipByDateV2`~~ — **DONE
   2026-08-28** (`PHASE_4_NOTES.md`, Unit B). Also picked up
   `estimateShippingWindowV2`'s lost `port` parameter and `findTransitLane_`'s
   missing port-narrowing (Phase 3, F4) — plus a third piece of F4 that Phase 3
   had not spotted.
7. **Sync + webhook functions** (`syncAllBoardsToShipmentsTab`,
   `evaluateRollupStatuses`, `Webhook_Receiver`).
8. **Frontend**: real data wiring, then views one at a time
   (Dashboard → FedEx → Maps → Injector → Limbo/Staged).

Steps 1–6 are done, and `Service_Conversions` parity landed with them
(Phase 4, Unit D). **Step 7 (sync + webhook functions) is the next
bottleneck**, and `Service_Assembly` parity — which must land together with
`SS_API.commitAtomic` — is the largest remaining service-level gap. Phase 4 also delivered the write-path lock, which never
appeared in this list because it was blocking nothing — and blocking-adjacent to
everything.

Two gaps span everything above and are worth deciding on before much more is
built on the write path:

- ~~**No lock anywhere on the write path (AUDIT B7).**~~ **DONE (Phase 4,
  Unit A).** `functions/lock.js` — a Firestore lease lock behind one
  `withInventoryLock(fn)`, project-wide like SRC's, with a 60s TTL so a killed
  container cannot wedge the write path. All five `Service_Write` lock sites are
  covered; the two in `Fedex_Master_Script.js` and one in `Setup_Registry.js`
  belong to unported files. The Phase 2 row-mismatch guard is **kept** — the
  lease only serialises our own writers, not people hand-editing the sheet.
  `npm run test:lock` (26 checks incl. real Firestore transactions).
  **Firestore must be enabled on the project before deploy.**
- **`SS_API.commitAtomic` not ported (AUDIT B3).** Its only callers are the
  assembly write paths, which are still unported. Phase 4B added
  `SS_API.batchUpdateSheet()` — the atomic `spreadsheets.batchUpdate`
  passthrough this needs — so the primitive is now in place.
