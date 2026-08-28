# Firebase Port — Service Audit

**Date:** 2026-08-28
**Baseline commit:** `dd07a8f` (Antigravity's in-progress port, imported as-is)
**Audited against:** original Apps Script repo at `SRC/src/` + `reference/SCHEMA.md` (v17)

> Purpose: an honest map of what is actually ported, what is stubbed, and what
> hasn't been started — so the remaining work can be sequenced. The existing
> `MIGRATION_CHANGELOG.md` marks every backend service `[DONE]`; that is
> optimistic. Several "done" services are 40–70% smaller than their originals
> with core functions missing.

---

## TL;DR

| Layer | State | Notes |
|---|---|---|
| Firebase scaffold | **Usable** | `firebase.json` hosting+functions OK. Missing `.firebaserc`, `firebase-admin` init, auth. Node engine pinned to EOL `18`. |
| `Service_SheetsAPI` (SS_API) | **Blocking bug** | `USER_ENTERED` instead of `RAW` (re-introduces AUDIT B1). Hardcoded `sheetId: 0` for deletes. `getSpreadsheetId()` returns `"PLACEHOLDER_SHEET_ID"`. |
| `Service_Read` | **~65%** | Dashboard + inventory reads ported. Trello label mgmt, shipping-reference r/w, SKU-last-updated map, board matrix all missing. |
| `Service_Write` | **~45%** | Core move/set/receive ported but with the AUDIT A1 silent-failure regression. 10 functions missing incl. `validateQty_`, `splitInventoryRow`, `moveHubGroup`, audit actions. |
| `Service_Dates` | **~55%** | Forward ETA estimate ported. Reverse `estimateShipByDateV2` (SCHEMA §8 Engine 4), override detection, comment backfill, bot-account logic all missing. |
| `Service_Conversions` | **~30%** | `planCaseConversion` shell ported; the case-breakdown / units-per-case engine (recent CHANGELOG work) is gone. |
| `Service_Assembly` | **~60%** | build + explode ported; `explodePartialHub`, `commitInventoryMutation_`, `findEffectiveQtyPer_` missing. |
| `Service_PO_Ingest` | **~60%** | Parser ported; **`extractTextFromPdfBlob` (the actual pdf-parse call) missing**, supplier email missing. |
| `Service_RXO` | **~80%** | Cleanest port. Missing config-status + diagnostics harness helpers. |
| `Service_Validate` | **~85%** | Ported; board-id check against env still a comment. |
| `Service_Diagnostics` / `Service_Email` | Ported / new | Email is a fresh nodemailer wrapper (no original). |
| HTTP routes (`index.js`) | **~5%** | 2 GET routes + email trigger. Every mutation, Trello, FedEx, and dates call the SPA makes has no endpoint. |
| Not ported at all | — | `Shared_Classifiers`, `Webhook_Receiver`, `syncAllBoardsToShipmentsTab`, `evaluateRollupStatuses`, `pushOutboundToShippingSchedule`, `Service_Router`, `Fedex_Master_Script`, HTS tools. |
| Frontend views | **~10%** | Shell + 14 map SVGs converted. All views are placeholder/dummy-data. Client engine (`JS_Handlers` 337KB, `JS_Render_UI` 145KB) not ported. |

---

## Critical regressions (fix before building on the port)

### C1 — `SS_API` writes with `USER_ENTERED`, not `RAW`
`functions/services/Service_SheetsAPI.js:50,84`. The original's `batchUpdateValues`
carries a long comment (still visible at `SRC/src/Service_SheetsAPI.js:20-35`)
explaining why this **must** be `RAW`: every value written is free text from Trello
(pallet comments, checklist descriptions). `USER_ENTERED` turns a checklist item
named `-3M SLIDE` or a comment `=2 pallets short` into a formula that renders
`#NAME?` forever, and strips leading apostrophes. This is AUDIT finding B1, already
fixed once upstream. Fix: `valueInputOption: "RAW"` in both `batchUpdateValues`
and `batchAppendRows`.

### C2 — Silent write-failure path re-introduced (AUDIT A1)
`Service_Write.js:29` `modifySheetRow()` still does `if (targetRowIdx > -1) {...}`
with no `else`, returning `undefined` when the row isn't found. Callers
(`setTotalStock:132`, `updateStock:158`, …) still `return { success: true }`
unconditionally. This is the exact bug the upstream AUDIT Phase 1 fixed: operator
taps SET, row was shifted by a concurrent sync, nothing writes, server says OK, UI
repaints the old number. Fix: `modifySheetRow` returns
`{success:false, error:'Row not found for <loc>/<sku>'}` on `-1`; callers return it
verbatim. (Upstream `Service_Write.js` already has this — diff against it.)

### C3 — `getSpreadsheetId()` returns a placeholder
`Service_SheetsAPI.js:31`. Nothing reads/writes until `BATCH_SHEET_ID` is wired
(env var / Firebase params). Same for every Trello/RXO/FedEx credential — the
original pulls them from Script Properties; there is no equivalent config layer
in the port yet.

### C4 — `batchDeleteRows` uses hardcoded `sheetId: 0`
`Service_Write.js:101` passes `inventorySheetId = 0` with a comment admitting it's
a guess. Sheet gid 0 is the *first* tab, not necessarily `Inventory`. A wrong gid
deletes rows from the wrong tab. Fix: resolve the real gid once via
`spreadsheets.get` and cache it.

### C5 — Operator identity lost
`getActiveUserEmail()` (duplicated in Write/Assembly/Diagnostics) returns the
constant `"system@cis-portal.app"`. Every `Audit_Log` row and receiving payload
loses who did it. Needs the real auth decision (below) before it means anything.

---

## Missing functions by service

### `Service_Write.js` (10 missing)
`validateQty_` · `processAuditAction` · `bulkVerifyAuditLocations` ·
`markAuditComplete` · `removeItemFromLocation` · `moveHubGroup` ·
`splitInventoryRow` · `readLiveChecklistState_` · `logDisplayDiagnostic` ·
`testReceivingDataFlow`
→ `validateQty_` and `splitInventoryRow` are load-bearing (Adjust popup
auto-split, SCHEMA v17 item 2). `moveHubGroup` is hub-group moves. Audit actions
power the Wall-to-Wall Audit view.

### `Service_Read.js` (~13 missing)
`getSkuLastUpdatedMap` / `buildSkuLastUpdatedMap_` · `getInboundPoBoardId_` ·
`getTrelloBoardLabels` · `getInboundPoBoardLabels` · `getCardLabels` ·
`updateCardLabels` · `getInjectorUrl` · `getCardShippingReference` ·
`setCardShippingReference` · `getBoardMatrix_` (referenced at `:555` as a TODO,
never defined) · `testReadMPS`
→ Label management + shipping-reference r/w are the TrelloInjector's backbone.

### `Service_Dates.js` (~16 missing)
`estimateShipByDateV2` (reverse calc — SCHEMA §8 Engine 4, the batch ship-by
estimator) · `getDeliveryDestinationCatalog_` · `resolveTransitDestinationCluster_` ·
`computeShipmentDates_` present but check body · `detectMissedDueDateOverrides_` ·
`backfillReadyPortFromComments_` · `getLastAutoDueForCard_` · `markEtaOverridden_` ·
`getTrelloMemberInfo_` · `identifyTrelloBotAccount` · `fetchCardComments_` ·
`findLatestReadyPortInfo_` · `getPeakSeasonWindow_` present · `setupShipmentDateColumns`
→ `estimateShippingWindowV2` also lost its `port` parameter in the port.

### `Service_Conversions.js` (~6 missing)
`getQbNameIndex_` · `resolveUnitsPerCase_` · `caseBreakdown_` ·
`formatQtyWithCases_` · `setupCaseConversions` · `reportConversionGap`
→ These are the "show case counts alongside unit counts" feature (multiple
recent CHANGELOG entries). Without them `planCaseConversion` can't actually
break a quantity into cases.

### `Service_Assembly.js` (3 missing)
`commitInventoryMutation_` (the shared atomic write helper) · `findEffectiveQtyPer_`
(recursive BOM qty resolution) · `explodePartialHub`

### `Service_PO_Ingest.js` (3 missing)
`extractTextFromPdfBlob` (**the pdf-parse invocation itself**) · `emailPOPdfToSupplier` ·
`resolveBrandFromPOText` is present

### `Service_RXO.js` (3 missing)
`getRxoConfigStatus` · `rxoRunDiagnostics` · `rxoTestShipmentLookup` · `rxoAuthProbe_`

---

## Not ported at all (whole files)

| File | Size | Role | Port target |
|---|---|---|---|
| `Shared_Classifiers.js` | 44KB | Canonical name resolution, transit-mode & brand classification — shared client+server. Write/Read reference it in comments as "assume available". | `functions/services/` + duplicate needed client-side |
| `Webhook_Receiver.js` | 33KB | Real-time Trello card-update webhook | `onRequest` function |
| `syncAllBoardsToShipmentsTab.js` | 35KB | Scheduled full board→SHIPMENTS pull | `onSchedule` (currently a no-op `scheduledSync`) |
| `evaluateRollupStatuses.js` | 20KB | Rollup status state machine | service module, called by sync |
| `pushOutboundToShippingSchedule.js` | 35KB | AEO/Burlington external-sheet → Trello push | `onSchedule` |
| `Service_Router.js` | 12KB | Webhook routing | folds into `Webhook_Receiver` |
| `Fedex_Master_Script.js` | 31KB | FedEx MPS discovery/tracking | service module |
| `Setup_Registry.js` | 68KB | One-off manual repair scripts | low priority — port on demand |
| `updateHtsDataSheet.js`, `checkFederalRegisterForTariffChanges.js`, `OneDrive_Graph_Sync.gs.js` | — | HTS/tariff + OneDrive sync | low priority |

---

## Infra gaps

- **No `.firebaserc`** — no project alias. `frontend/src/api.js:2` hardcodes
  `cis-warehouse-portal` in the emulator URL.
- **No `firebase-admin` init** anywhere; no `functions.config()` / params usage.
- **No auth**. Original deploys `ANYONE_ANONYMOUS` but runs inside a Google login
  (`Session.getActiveUser()` works). The port needs an explicit decision:
  Firebase Auth (Google provider) + token verify middleware, or IAP, or accept
  anonymous and drop operator attribution. This blocks C5.
- **CORS** is `origin: true` (reflect any origin) — fine for dev, tighten for prod.
- **Node `18`** in `functions/package.json` — EOL, Cloud Functions is pushing 20/22.
- **`scheduledSync`** is `logger.info("Scheduled sync running!")` and nothing else.
- **`index.js` routes**: `/inventory`, `/logistics-dashboard` only. `api.js`
  already calls `/shipment`, `/po-ingest`, `/diagnostics` → 404.

---

## Suggested sequencing

1. **Config + infra spine** — `.firebaserc`, `firebase-admin` init, a
   `config.js` that reads `BATCH_SHEET_ID` + all Trello/RXO/FedEx secrets from
   env/params, fix `getSpreadsheetId`, resolve the real `Inventory` gid. Decide
   auth. (Unblocks everything.)
2. **Fix C1–C4 in `SS_API` + `Service_Write`** by diffing against upstream —
   these are known-good fixes already written once.
3. **Port `Shared_Classifiers`** — Read/Write/Assembly all depend on it.
4. **Finish `Service_Write` + `Service_Read`** to function parity, checked
   against SCHEMA §3/§15 column maps.
5. **Build the HTTP route layer** in `index.js` — one route per server call the
   SPA makes; route mutations through a common `runMutation` wrapper that
   surfaces `{success:false}`.
6. **`Service_Dates` parity** incl. `estimateShipByDateV2`.
7. **Sync + webhook functions** (`syncAllBoardsToShipmentsTab`,
   `evaluateRollupStatuses`, `Webhook_Receiver`).
8. **Frontend**: real data wiring, then views one at a time
   (Dashboard → FedEx → Maps → Injector → Limbo/Staged).

Steps 1–3 are the unblock; do them before trusting any "done" marker.
