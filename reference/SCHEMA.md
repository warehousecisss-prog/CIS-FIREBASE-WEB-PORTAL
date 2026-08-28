# CIS Warehouse Portal — Canonical Operations Schema
**Generated**: 2026-08-10  
**Last Updated**: 2026-08-27 (v17 — User-reported UI bugs (screenshots) plus a follow-up design question, bundled into one pass. (1) **Outbound Staging Aggregator / the `ZONE-STAGED` virtual location removed entirely.** Staging was always meant to be a status change — `renderLabels()` recoloring a slot and `generateLocalTotals()` deducting it from "available" both already worked off a row's Workflow Status alone — but the `ZONE-STAGED` zone worked against that: moving a pallet there emptied its rack slot instead of recoloring it in place. Both STAGED controls (`Index.html`'s move-carry-bar, `JS_Render_UI.html`'s accordion-card quick-action) now call `updateItemField(...,'status','Staged',...)` in place. `View_Staged.html`/`renderStagedView()` deleted; `ZONE-STAGED` removed from `VIRTUAL_ZONES` in both `moveInventoryItem()` and `moveHubGroup()` (`Service_Write.js`) — see the Move Destination Validation subsection in Section 15, now `ZONE-BUFFER` only. Confirmed via the `CIS INVENTORY.xlsx` snapshot before deleting: exactly one `ZONE-STAGED` row, at qty 0. New invariant #75. (2) **Adjust popup's Workflow Status dropdown now decides split-vs-whole-row for itself** (`applyRowStatus_`, `JS_Handlers.html`), replacing the v16 manual "SPLIT INTO NEW ROW" button and its red SET-overwrite warning: staging less than the row's full quantity auto-splits the typed amount into a new row at the same location (still via `splitInventoryRow()`, unchanged server-side, still refusing `_SYS_` rows); staging the whole amount changes the whole row's status the old way. The warning is gone because the destructive keystroke pattern it protected against (SET + a smaller number) can no longer occur through this popup at all. (3) **Fixed three stacked causes of the drawer's qty not visibly updating after a mutation** (`runMutation`/`refreshDataset`, `JS_State.html`/`JS_Store.html`): a post-write forced refresh arriving while a background poll was already mid-flight for that dataset used to be dropped outright (now queued, drained the moment the in-flight fetch finishes — `slot.forceQueued`); `window.isEditing` (which a `<select>`'s `onchange` can still be true under, since `onchange` fires before blur) used to block the repaint (`runMutation` now clears it up front, same precedent as `updateItemField`); and the Adjust popup's own "Current Volume" line never updated in place after `setTotal`/`adjustStock` succeeded (now does, via `syncAdjustPopupQty_`, or closes the popup if the row hit zero). Also added one floating busy pill (`#mutation-busy-pill`) covering every mutation, since they all already funnel through `runMutation`. (4) **Fixed the search bar rendering visibly detached over page content on iOS**: not a `#top-ui` bug — the keyboard-focus scroll helper (`JS_Store.html`) called `el.scrollIntoView({block:'center'})`, which scrolls every scrollable ancestor including `document.body` (still possible even though `body` is `overflow:hidden` by design — that only blocks the scrollbar, not a programmatic `scrollTop`), producing a visible split-render glitch with the sticky header on iOS WebKit. Rewritten to scroll only the field's one real scrolling ancestor. (5) **Replaced two independently hand-maintained, already-drifted view-layout lists** — `Styles_Base.html`'s `.map-view:not(#totals-view):not(#hts-view)...` CSS exclusion chain and `changeView()`'s own separate id list (`JS_Render_Core.html`) — with two shared classes, `.floor-plan-view` (real SWH/PWH/P&P maps — centers) and `.flex-doc-view` (Open Slots, Inventory Totals — need their own internal flex-column, not centering); every other document view now needs neither, with plain `display:block` as the default instead of something to opt into. The drifted lists had both omitted `open-slots-view` and `wall-audit-view`, which is why Open Slots read as half-centered on mobile with its P&P metric card clipped off the right edge (also fixed: `.metrics-row-wrapper`'s doubled padding/missing `flex-wrap`, `#open-slots-drilldown-panel`'s doubled width inset). New invariant #76. Also fixed: Rollup Status pills rendering at a different width per row and wrapping mid-word on mobile (`renderStatusPill_()`, `JS_Handlers.html` — `display:block; width:100%` so every pill in a column shares the column's width, `word-break`/`overflow-wrap` reset to `normal`). (6) **Reorganized the Warehouse Operations nav menu**: CIS Warehouses (now also holding Temp Storage, folded in — it's a real CIS location, not "elsewhere") → Timing Lot → RTF Lot → Inventory Audit (new group: QB Audit + "Warehouse Audit," renamed from "Wall-to-Wall Audit" as a display label only, `wall-audit-view`/`openWallAuditMode()` unchanged) → Open Slots. Standardized `.menu-item` styling (`Styles_Components.html`) — icon carries the color/weight now, label reads uniformly — and fixed `#view-menu`'s hardcoded `top:60px` overlapping the wrapped mobile search bar below 768px. (7) **Station ID (device/kiosk name) removed entirely, not fixed.** First pass replaced the v-era blocking `prompt()` on load with a lazy prompt + `localStorage → sessionStorage → memory` fallback chain. User then asked whether a durable version was possible; answer: no — this app is `ANYONE_ANONYMOUS` (no login to key an identity to) inside a cross-origin `googleusercontent.com` iframe where iOS WebKit can partition/block client storage outright, so no client-storage-based device identity can ever be durable here, only ever an unpredictable nag. User's decision on hearing that: drop it rather than ship something unreliable that deters people from using the tool. Removed the prompt, `getStationId_`/`setStationId_`/`ensureStationId_` (`JS_State.html`), and the `stationId` field from the receiving payload and the Audit_Log tag (`receivePOCardItems`, `Service_Write.js`). New invariant #77. See CHANGELOG.md for the same pass in narrative form.)  
**Last Updated**: 2026-08-26 (v16 — Removed the real source of a data-loss incident and, while fixing what it exposed, changed what Inventory's identity column actually holds. (1) **The Adjust popup had no way to move part of a row's quantity to a new status without destroying the difference.** SET (`setTotalStockByRow`) is an absolute overwrite, not "move this many" — an operator who typed a smaller number after picking a new status got that smaller number as the row's new total, with the removed units written nowhere. New `splitInventoryRow()` (`Service_Write.js`) decrements the source row in place and appends a new row (fresh instanceId) at the split-off quantity and target status, logging `SPLIT_OUT`/`SPLIT_IN`; refuses `_SYS_` rows (that's `explodePartialHub()`'s job) and any split `>=` the row's current total. The Adjust popup's SET button now turns red and warns the moment the typed number would be a partial. See Section 15's Audit_Log table and Section 17 invariant #66. (2) **Name matching was two-way substring containment everywhere in the app** (`a.includes(b) || b.includes(a)`) — harmless-looking until a product family shares a prefix by design (`T25-SCREW`/`T25-SCREWDRIVER`, `V32`/`V32-BATTERY`, a tag and that tag's CASE), at which point whichever row got scanned first silently won. Replaced with `canonicalNameKey`/`namesMatch` (`JS_State.html`, server twin `canonicalNameKey_`/`namesMatch_` in `Shared_Classifiers.js`) — exact match, with a prefix allowed only behind one of two confirmed mechanical truncation markers (QuickBooks' 84-char `...` cap, or an old export's inch-mark cutoff.) Applied to aging (`calculateInventoryAgeDays`), the Inbound Report's on-hand fallback (now refuses an ambiguous match rather than returning a confident wrong number), `resolveOriginalArrivalDate_`, and `findCaseConversion_`. (3) **`findCaseConversion_` had been silently dead for every receipt since 2026-08-11** — it prefix-matches a rule against the product's full QB name, but `receivePOCardItems()` had switched to writing the *nickname*, which doesn't start with the supplier code. Fixed by resolving the SKU back to its QB name first (`getQbNameIndex_`) before matching. (4) **The real fix, prompted by the user's own framing ("the nickname was only used in the selector because it's smaller and less cumbersome than the actual PRODUCT"): Inventory's SKU column now stores the Product ID, not the nickname.** `receivePOCardItems()` writes `resolveCanonicalProductId_` (`Shared_Classifiers.js`) instead of `resolveCanonicalItemName_`; `getNickname()` (`JS_Handlers.html`) is now the only place a nickname enters the UI, resolving ID→nickname at render time with a canonical fallback so a stored ID differing only by case/whitespace/truncation still displays short. Because Audit_Log holds years of arrivals logged under whatever name was current at the time, `namesMatch_`/`namesMatch` first try `productIdentityKey_`/`productIdentityKey` — collapsing any of a product's names to its Product ID — before falling back to the plain canonical key; without this, migrating Inventory would have orphaned 20 real aging anchors (verified by replay against the live `Audit_Log`, zero lost after). `migrateInventoryToProductIds(dryRun)` (`Setup_Registry.js`, dry-run by default) backfills rows written during the nickname window — **and unconditionally skips any row whose text also appears in the `Assemblies` sheet**, because assembly recipes match parent/component names by exact string equality with no canonical resolution (Section 18); rewriting such a row would silently detach its stock from its recipe. Run live 2026-08-26: 251 rows already correct, 17 rewritten (repairing assembly-matching gaps that already existed — those 17 rows were invisible to their own recipes before this), 31 held by the Assemblies guard, 11 still unmatched to any product. See Sections 4D, 15, 17 invariants #67–#69, and 18.)  
**Last Updated**: 2026-08-26 (v15 — Two additions closing the gap between an item's "age" and when it was last physically confirmed correct, per user request: a floor walk that finds a count still accurate writes nothing today, so the item looked stale even though it was just checked. (1) "Verify All" button added to the existing SKU-driven QB Audit page (`View_Audit.html`/`JS_Render_UI.html`'s `renderAuditList()`): one click stamps every remaining queued location `VERIFIED` in a single write via new `bulkVerifyAuditLocations()` (`Service_Write.js`) — a batched counterpart to `processAuditAction()`'s existing no-qty VERIFIED branch — then flags the affected `QB_Audits` rows DONE. Client-side `verifyAllAuditItems()` (`JS_Handlers.html`) skips any row with an unsaved typed qty (an in-progress correction) rather than silently discarding it. Safe by construction: `VERIFIED` was already excluded from `buildAgingData_()`'s `validActions` (v3, see below), so this bulk write can never reset an item's age/heatmap anchor — it only refreshes `getSkuLastUpdatedMap()`'s "last touched" signal, which counts every action type by design. (2) New page "Wall-to-Wall Audit" (`View_WallAudit.html`, menu entry next to QB Audit in Warehouse Operations) for a materially different workflow the user described as "we won't be hunting down items, instead we'll each be tackling a space/wall/P&P": location-first instead of SKU-first. Pick a warehouse (SWH/PWH/P&P) → pick a rack/section (grouped by the same `[-=_]L-\d+$` leaf-suffix-strip regex `renderOpenSlotsGrid_()` already uses for Open Slots, so the two tools agree on warehouse geography) → get every individual occupied leaf slot in that section as a blank checklist row. Nothing about a slot's contents renders until tapped (`revealWallSlot()`, JS_Handlers.html) — a deliberate blind-count-first design per user preference — at which point it reveals the system SKU(s)/qty and offers Verify / type-a-correction / Remove per item, reusing the same `processAuditAction()` backend as QB Audit and the existing `deleteItem()` client flow for Remove (extended with an optional `onDone` callback so the wall-audit page can mark a slot done only after a confirmed server-side delete, not on click). Needs no new server read: the zone picker and worklist are built entirely from already-hydrated `window.inventoryData` and the scraped real slot ids (`window.scrapedSwhSlots`/`scrapedPwhSlots`/`scrapedPpBins`, harvested from the Maps SVG at boot). Per-slot "done today" state is session-scoped (`sessionStorage`, mirrors the existing `AUDIT_DRAFT_KEY` pattern) so progress on a half-finished wall survives a view switch within the same session but isn't a durable second source of truth — `Audit_Log` remains that.)  
**Last Updated**: 2026-08-25 (v14 — Four changes. (1) Fixed the `receivePOCardItems()` column-E bug documented in v13-and-earlier copies of the Inventory table below (Section 15) — see that table's caution note for the fix; grepped every other Inventory-row append in `Service_Write.js`/`Service_Assembly.js`/`migration.js` and confirmed no other write site had the same bug. (2) Added a "Last Updated" column to the Totals view (`View_Totals.html`/`renderTotalsTable()` in `JS_Render_UI.html`), with the SKU nickname turning green (`#00e676`, matching the app's existing "today" token) when that SKU was touched today. Backed by a new `getSkuLastUpdatedMap()` (`Service_Read.js`, cached like `getAgingData()`) that does its own unfiltered pass over `Audit_Log` — deliberately NOT a reuse of `buildAgingData_()`'s `agingMap`, which anchors to arrival events only and excludes SET_TOTAL/REMOVE/MOVE_OUT/VERIFIED/CONVERT_OUT by design (see that function's comment) — "when was this last touched" needs every action type, "how old is this stock" doesn't. Wired through the precompiled-boot-payload pattern (`Service_Router.js`'s `precompileDataset_`, `Index.html`, `JS_State.html`) and the `STORE_FETCHERS`/`window.store` poller (`JS_Store.html`) as a new `skuLastUpdated` dataset, then merged into the client-side `generateLocalTotals()` (`JS_Handlers.html`) that actually feeds this view — note `getInventoryTotals()` (`Service_Read.js`) is a separate consumer (the Inbound Report's On Hand calc) and was NOT the totals-view's data source. (3) Revived "Open Slots": `calculateEmptyLayoutMetrics()`/`viewScraperTargetList()` (`JS_Handlers.html`) and `paintScraperTargetList()` (`JS_Render_UI.html`) already existed and were already being called at boot — they targeted DOM elements (`#count-empty-swh/pwh/pp`, `#home-drilldown-panel`) that no longer existed anywhere, a leftover from the old Dashboard Home landing page (confirmed via `clasp pull --versionNumber 170` into an isolated scratch dir, never pushed/deployed) before that page became the Logistics Control Tower. Rebuilt as its own view (`View_OpenSlots.html`, id `open-slots-view`), entry point at the top of the Warehouse Operations submenu (`Index.html`): a total-open-slots badge plus per-warehouse SWH/PWH/P&P breakdown (P&P explicitly labeled "Empty Shelf Spaces," not pallet positions, per user correction), each drilling into the actual empty location ids grouped by rack/section (`renderOpenSlotsGrid_()`) with a filter box — a deliberate redesign from the old flat single-column pill list, which the user described as unwieldy. `jumpTo()` (`JS_Handlers.html`) now also closes this drilldown, matching its existing `hideDrilldownPanel()` call. (4) Nav reorder + style cleanup (`Index.html`): "Inventory Totals" moved to the top of the root menu, "Warehouse Operations" second; removed the `chevron-right` icon that only Warehouse Operations had (the only root item that opens a submenu) so no root button looks visually different from the others — existing per-item accent colors (each matching its destination page's own header, per v13) were deliberately kept as-is.)  
**Last Updated**: 2026-08-21 (v13 — Hamburger-nav UI pass, purely cosmetic/navigational, no data contract or status-lifecycle changes. Two passes: (1) `ebcc862` consolidated the root hamburger menu — SWH/PWH warehouse nav, QB Audit, Limbo/Temp Storage, and Outbound Staging, previously five flat root-level entries, now live behind one "Warehouse Operations" submenu (`Index.html`'s `#warehouse-ops-submenu`) so the root menu stays short; SWH/PWH's own Back buttons now return to that submenu instead of menu-root. (2) Same-day follow-up per user feedback: root menu reordered (Warehouse Operations now first, FedEx Tracking and Inventory Totals moved up beneath it, Dashboard Home after); "Offsite (Virtual)" relocated from the root into the Warehouse Operations submenu (below SWH/PWH); Diagnostics moved out of the menu-item list entirely into a sticky `<footer>` pinned to the bottom of `#view-menu` — deliberately not a `div`, since `openSubMenu()`'s `#view-menu > div` selector (`JS_Render_Core.html`) hides every direct-child div when switching submenus, and a `footer` element is excluded from that selector so it stays visible regardless of which submenu is open. Several labels renamed for plain-language clarity, updated in the nav AND on the destination view's own header/breadcrumb/drawer title so neither ever goes stale against the other: "FedEx Tracking Engine" → "FedEx Tracking" (`Index.html`, `View_FedEx.html`); "Guided QB Audit" → "QB Audit" (`Index.html`, `View_Audit.html`); "Limbo Buffer Zone" → "Temp Storage" (`Index.html`, `JS_Render_UI.html`'s `renderLimboView()` header and drawer title, `JS_Render_Core.html`'s breadcrumb); "HTSUS Tariff Matrix" → "Tariffs" (`Index.html`, `View_HTS.html`, `JS_Render_UI.html`'s rendered HTS table header); and the FedEx bulk-tracking-entry modal's "Stage New Store Orders" / "Stage Store Orders" → "New Shipment Entry" / "Add Shipments" (`View_FedEx.html` — the old copy implied a staging/holding step that doesn't exist, and not every entry is a retail "store" order). Inventory Totals also restyled to the same bold treatment as Dashboard/FedEx/Warehouse Operations, in `#ec2127` — the same red as the "CIS Portal" wordmark and hamburger icon (`Styles_Base.html`'s `#menu-btn`).)  
**Last Updated**: 2026-08-17 (v12 — Redesigned the RTS (Readiness/ETA) input flow per user feedback that the old free-text "Port of arrival" field was "ugly, and beyond vague": both the inline Readiness & ETA panel and the standalone Shipping Estimate calculator now share a guided 4-step flow (Ship Date → Transit Type → Origin → Destination/Port), backed by a new detailed lane-lookup engine (`findTransitLane_()`/`estimateShippingWindowV2()`, `Service_Dates.js`) sourced from the user's new `Transit_Time` tab — season-aware (Peak vs. Standard, via new `Peak_Start_Date`/`Peak_End_Date` cells), defaults to the SLOWEST matching lane per the user's "don't be optimistic" instruction, and shows a FedEx-specific caveat. Wired into `resolveEtaAndBasis_()` as the first-try path ahead of the older Config-sheet port-group math, so every row benefits automatically. See the new Section 4G.)  
**Last Updated**: 2026-08-17 (v11 — Consolidated the user's separate `Assemblies.xlsx` workbook (19 per-assembly tabs) into the live `Assemblies` tab via a new `consolidateAssemblyRecipes()` one-off, 74 recipe rows resolved against the `PRODUCT` catalog — see the new "Recipe Consolidation" subsection under Section 18. Also fixed two real `CUSTOMER_REGISTRY` bugs found by cross-referencing the new `Delivery_Address`/`Transit_Time`/`Order Process` tabs: `getChainFromRecord()` (`JS_Handlers.html`) had no specific-beats-generic match precedence (unlike `classifyInboundOrderOrigin_`), so Canada-bound Homesense/Marshalls cards were grouped under the wrong parent in the "Select All Chains/Brands" dropdown; and TK Maxx was registered under a dead `"TJX UK"` bucket with a regex that could never match. Both fixed — new `fixTjxCanadaAndTkMaxxRegistry()` in `Setup_Registry.js`, precedence fix in `getChainFromRecord()`. See the new Section 9A and CHANGELOG.md.)
**Last Updated**: 2026-08-14 (v10 — Corrected the v10-in-progress edit to Section 4E: an earlier pass this same day claimed the non-local keyword fallback was removed entirely, but that overcorrected — confirmed with the user that `RTF`/`TJXC`/`TJX CANADA`/`TJX AU`/`TJX TK`/`TJX UK` are real destination signals (RTF is the physical Canadian warehouse), not vendor noise, and removing them would have reopened the `GEN6 SLIDE PB` blending bug the fallback exists to prevent. Only `TIMING` (a vendor name) and bare `CANADA` (too generic) actually stay dropped. Also this pass: fixed the free-text SKU/store filter persisting across the Outbound/Inbound tab switch (`switchLogisticsTab()`, `JS_Handlers.html`); fixed the RTS panel staying unreachable when a row was already open via a body click — a date-cell click now reveals it in place instead of collapsing the row (`toggleChildBoxRow()`); scoped the Trello Injector's board picker (`getTrelloBoards()`, `Service_Read.js`) to the known 4-board matrix instead of every open board on the account, fixing a duplicate-Burlington-board cache-bloat issue; added a "Clear RTS" button to the Readiness/ETA editor and a new standalone Shipping Estimate calculator (`estimateShippingWindow()`, `Service_Dates.js` — same port/transit-mode math, no card or sheet write) — see Section 4F and CHANGELOG.md for both.)
**Last Updated**: 2026-08-14 (v9 — This copy had only ever existed pasted into a chat session, never committed to the actual codebase — moved into `src/SCHEMA.md` this pass, and brought current against four commits made after v8 was written (all still 2026-08-13, but later in the day): (1) `pruneDeletedShipmentCards_()` added to `syncAllBoardsToShipmentsTab.js` — a card deleted outright from Trello (not just moved to a done list) now gets archived to `Shipment_History` instead of leaving a permanent dead-linked row in SHIPMENTS; documented as new Section 11A and folded into Section 17's invariants. (2) A follow-up same-day bug this fix exposed: `Shipment_History` rows re-surface into the live dashboard payload (for the "Show Completed" toggle) with no marker that they're done, so a pruned or received card kept rendering as an active row and kept inflating the Inbound Report's Expected/Received totals forever — fixed by stamping `historical: true` on every history-sourced record (`Service_Read.js`) and making `isItemCompleted()` (`JS_Handlers.html`) and `renderInboundReportModal()` (`JS_Render_UI.html`) both respect it; also folded into Section 11A, Section 14's payload contract, and Section 17. (3) Section 4E rewritten: the Inbound Report's Expected/Received totals now unconditionally exclude non-local/administrative POs regardless of the Local/All toggle (previously only excluded when scope was `'local'` — switching to `'all'` used to fold their checklist quantities straight into shared SKU buckets with no way to back them out again); "All" now instead reveals a separate reference-only list of those excluded orders. The Logistics Control Tower's own Inbound Origin filter (a separate, earlier control from the Inbound Report modal — see Section 2's board matrix and Section 4E) also now defaults to "Local Only" instead of "All Origins", for the same reason. (4) `fixMisdirectedInboundRows()` one-off repair added to `Setup_Registry.js` for SHIPMENTS rows written before the (already-shipped, undocumented-until-now) webhook direction-resolution fix — folded into Section 13 and newly documented alongside `Setup_Registry.js`'s other one-off repair functions in Section 19. Also noted: `BUILD_VERSION`'s client auto-reload-on-mismatch was removed the same day (every forced reload was re-triggering Google's own "not verified by Google" banner on the web app URL) — `BUILD_VERSION` is diagnostics-only now; see Section 19 and the new Section 17 invariant.)  
**Last Updated**: 2026-08-13 (v8 — Redesigned Section 4F's Readiness/ETA feature per a same-day user decision to cut portal data entry: the portal's Readiness editor now posts a canonical `"READY <date> PORT <port>"` Trello comment on Save instead of (only) writing the sheet directly, and the same comment can be typed straight into Trello by hand — `parseReadyPortComment_()`/`applyReadyPortDeclaration_()` in `Service_Dates.js` parse it from a `commentCard` webhook in real time or a sync-side backfill. ETA math now prefers user-supplied port-specific lead times (`PORT_GROUPS` — LA/Long Beach 39 days total, Miami 47 days total) over the older generic transit-mode table when the port classifies. The computed ETA is pushed into Trello's own Due Date field (`pushEtaToTrelloDue_()`) so the board shows it, not just the portal — new columns Q (`lastAutoDue`) and R (`etaOverridden`) track this system's own writes so a real sailing schedule, entered directly in Trello, is detected and respected rather than clobbered; detection uses Trello's `idMemberCreator` (delivered free in every webhook) when a dedicated `TRELLO_BOT_MEMBER_ID` automation account is configured, falling back to comparing values otherwise. Prior pass (v7) — Section 3's SHIPMENTS table previously stopped at column J; added K–P (readyToShipDate/Basis, etaDate/Basis, dateState, portOfArrival — `Service_Dates.js`, actually added 2026-08-13 but never documented here). New Section 4F documents the readiness/ETA state machine, the new `portOfArrival` field, and the 2026-08-13 decision to remove the Readiness & ETA panel from the outbound UI entirely (`renderReadinessPanel_()` now returns '' when `isOutbound`) while keeping it — plus the new port-of-arrival field — inbound-only; also documents, with file:line citations, why Trello syncs can never clobber columns K–P (both writers are hardcoded to a 10-wide A–J range). Found and fixed a real bug while verifying this pass: `Service_Conversions.js`'s `setupCaseConversions()` seed data had every one of its 5 `Case_SKU` strings corrupted (product name doubled with the units-per-case annotation folded back into itself, e.g. `Burlington 12" Siren Tag Case (Burlington 12" Siren Tag Case (25 units per 1 case))` instead of the plain name) — running it as-shipped would have written near-duplicate floor SKUs, exactly the failure mode `CIS_PORTAL_DEPLOY_PLAN.md`'s smoke test 3.6 warns about; fixed to the clean names, with the 3.5" row flagged as UNVERIFIED against the live floor string pending manual confirmation (deploy plan Part 6, decision #2). Prior pass (v6) — Fixed `getInventoryTotals()` to exclude `TIMING`/`RTF` virtual-lot locations from On Hand `total`/`available`/`staged`/`committed` — both are UI-labeled `(Virtual)` and RTF specifically holds TJX Canada's non-local stock; verified against the live workbook snapshot, 17 SKUs / 109,432 units were being wrongly counted before the fix — see the new subsection under Section 15's Inventory table. Added Section 4E: `classifyInboundOrderOrigin_()` separates local from non-local (Australia/CREDO, TJX Canada RTF, Timing lot) inbound POs so the Inbound Report's `Expected` figure defaults to local-only demand, with an "All" toggle; documents a real precedence bug found and fixed during development (a generic registry alias match was shadowing a more specific non-local signal). Prior pass (v5): Extracted `computeOutboundDemandMap_()`, a reusable outbound demand aggregator, out of `renderShippingReportModal()`'s local `matrixMap`; new Section 5A documents it, its caching on `window.outboundDemandData` at both `window.logisticsData` assignment sites in `JS_Handlers.html`, and its wiring into the Inbound Report's On Hand formula (now `total − staged − outbound demand`, best-effort matched via `findOutboundDemandForSku_`); flagged a dead duplicate `refreshData()` in `JS_Network.html` shadowed by `JS_Handlers.html`'s live copy — see Section 19. Prior pass (v4): Full source re-verification — confirmed P0-1 doPost collision is resolved in code (`Webhook_Receiver.js` live, `Service_Router.js`'s copy retired to `legacyDoPost_`) and documented exactly where; confirmed the instanceId/aging fix from v3 is not only intact but was extended with an undocumented `Audit_Log` column H that carries true arrival dates across moves — Section 15's Audit_Log table rewritten to match; confirmed `Shared_Classifiers.js` (P2-1) is fully wired into all documented call sites; corrected Section 4/4A/7 — the "Drop Ship" business rules were partially aspirational, not fully implemented, see the new `[!CAUTION]` in 4A; corrected Section 9 — `Handling_Type` IS now consumed (by `evaluateRollupStatuses()`), contrary to the prior "not yet consumed" note; corrected the Assemblies sheet column table; added Section 18 (Assembly/Kitting System) and Section 19 (Utility & One-Off Scripts), both previously undocumented; flagged a live-looking hardcoded Trello credential in dead code in `migration.js` — see Section 13)  
**Purpose**: Definitive reference for all business logic, data flows, status lifecycles, and integration contracts. This document serves as **guardrails** to prevent regressions during refactoring and feature enhancements.

> [!CAUTION]
> Any code change that contradicts this schema MUST be flagged and reviewed. Do NOT silently alter status values, column positions, Trello board mappings, or FedEx API contracts without updating this document first.

---

## Table of Contents
1. [System Architecture Overview](#1-system-architecture-overview)
2. [The 4-Board Trello Matrix](#2-the-4-board-trello-matrix)
3. [SHIPMENTS Tab Schema (The Central Nervous System)](#3-shipments-tab-schema)
4. [Inbound Pipeline](#4-inbound-pipeline)
    - 4A. [Destination-Aware Receiving & Drop Ship Rules](#4a-destination-aware-receiving--drop-ship-rules)
    - 4B. [Barcode Scanner Receiving & Optimistic UI Guardrails](#4b-barcode-scanner-receiving--optimistic-ui-guardrails)
    - 4C. [Checklist Parsing Resilience](#4c-checklist-parsing-resilience)
    - 4D. [Canonical Product-ID / Naming Pipeline](#4d-canonical-product-id--naming-pipeline-added-2026-08-11)
    - 4E. [Inbound Report Local/Non-Local Classification](#4e-inbound-report-localnon-local-classification)
    - 4F. [Readiness / ETA & Port of Arrival (Inbound-Only)](#4f-readiness--eta--port-of-arrival-inbound-only)
    - 4G. [Detailed Transit-Lane Engine & Guided RTS Flow](#4g-detailed-transit-lane-engine--guided-rts-flow-added-2026-08-17)
5. [Outbound Pipeline](#5-outbound-pipeline)
    - 5A. [Outbound Demand Aggregator](#5a-outbound-demand-aggregator)
6. [Transit Mode Resolution](#6-transit-mode-resolution)
7. [Rollup Status Lifecycle — COMPLETE State Machine](#7-rollup-status-lifecycle)
8. [FedEx Multi-Piece Shipping (MPS) System](#8-fedex-mps-system)
9. [Customer/Client Registry](#9-customer-client-registry)
10. [Tracking Number Harvesting](#10-tracking-number-harvesting)
11. [Archival System](#11-archival-system)
    - 11A. [Deleted-Card Pruning & Historical Tagging](#11a-deleted-card-pruning--historical-tagging-added-2026-08-13)
12. [Trigger & Timing Architecture](#12-trigger-timing-architecture)
13. [Webhook Real-Time Pipeline](#13-webhook-real-time-pipeline)
14. [Data Payload Contract (Client to Server)](#14-data-payload-contract)
15. [All Google Sheets Tabs and Column Maps](#15-all-google-sheets-tabs)
16. [Function Dependency Graph](#16-function-dependency-graph)
17. [Invariants — Things That Must NEVER Break](#17-invariants)
18. [Assembly and Kitting System](#18-assembly-and-kitting-system)
19. [Utility, Ingestion & One-Off Scripts](#19-utility-ingestion--one-off-scripts)

---

## 1. System Architecture Overview

```
+---------------------------------------------------------------------+
|                        TRELLO BOARDS (4)                            |
|  Purchase Orders | Nicole POs | Burlington Shipping | Shipping Sched|
+--------+--------------+--------------+---------------+--------------+
         |              |              |               |
         |   +----------v----------+   |    +----------v----------+
         |   |  Trello Webhooks    |   |    |  Scheduled Sync     |
         |   |  (Real-time POST)   |   |    |  (Time-driven)      |
         |   +----------+----------+   |    +----------+----------+
         |              |              |               |
         v              v              v               v
+---------------------------------------------------------------------+
|                    Google Apps Script Engine                         |
|                                                                     |
|  syncAllBoardsToShipmentsTab()  <-  STEP 1: Full 4-Board Pull      |
|  evaluateRollupStatuses()       <-  STEP 2: MPS Rollup Evaluation  |
|  archiveCompletedShipments()    <-  STEP 3: Move Done to History    |
|  pruneDeletedShipmentCards_()   <-  STEP 3.5: Prune deleted cards   |
|  warmLogisticsDashboardCache()  <-  STEP 4: Pre-warm API Cache     |
|                                                                     |
|  runMPSDiscovery()              <-  Every 10min: Discover child boxes|
|  runMPSBatchAndReassemble()     <-  Every 3hr: Update all box scans |
|                                                                     |
|  processWebhookPayload()        <-  Real-time: Single card updates  |
+------------------------+--------------------------------------------+
                         |
                         v
+---------------------------------------------------------------------+
|                    GOOGLE SHEETS (Database)                          |
|                                                                     |
|  SHIPMENTS ---------- Central ledger (18 columns, A-R)              |
|  Multi Piece Tracking  FedEx MPS front-end (25+ cols)               |
|  MPS Backend --------- Hidden child box statuses (4 cols)           |
|  Shipment_History ---- Archived completed records (11 cols)         |
|  Inventory ----------- Warehouse rack positions (7 cols)            |
|  TOTALS -------------- Aggregate counts (4 cols)                    |
|  PRODUCT ------------- Product catalog (6 cols)                     |
|  Assemblies ---------- Assembly definitions (4 cols)                |
|  HTS_Data ------------ Tariff codes (8 cols)                        |
|  QB_Audits ----------- QuickBooks audit trail (5 cols)              |
|  Audit_Log ----------- System audit log (8 cols)                    |
|  Naming Conv --------- Location naming conventions (5 cols)         |
|  CUSTOMER_REGISTRY --- Brand/chain identity + handling (7 cols)     |
|  BRAND_ITEM_CATALOG -- Brand SKU keyword catalog (5 cols)           |
+------------------------+--------------------------------------------+
                         |
                         v
+---------------------------------------------------------------------+
|                    WEB APP (Browser SPA)                             |
|                                                                     |
|  Dashboard --- Logistics Control Tower (Inbound/Outbound/Staged)    |
|  FedEx View -- Master Ledger + Child Box Drill-Down                 |
|  Maps -------- SVG Warehouse Floor Plans (PWH, PP, SWH)             |
|  Inventory --- Rack-level product placement                         |
|  Totals ------ Aggregate stock counts                               |
|  Audit ------- QuickBooks reconciliation                            |
|  HTS --------- Tariff classification                                |
+---------------------------------------------------------------------+
```

> [!NOTE]
> The `SHIPMENTS` and `Audit_Log` column counts above were corrected in v8/v9 to match Sections 3 and 15 exactly (18 and 8 columns respectively) — this diagram previously undercounted both (10 and 7). `CUSTOMER_REGISTRY`/`BRAND_ITEM_CATALOG` were also missing from this diagram entirely despite being documented in Section 9 since v3; added here in v9.

---

## 2. The 4-Board Trello Matrix

These are the ONLY boards that `syncAllBoardsToShipmentsTab()` reads. Adding or removing boards changes the entire data pipeline.

| Board Name | Board ID (Default) | Script Property Override | Direction | Purpose |
|---|---|---|---|---|
| **Purchase Orders** | `649c805bad63086ff6689611` | `INBOUND_PO_BOARD_ID` | **Inbound** | Primary inbound POs (international freight, domestic) |
| **Nicole POs** | `64c286cd0d581563f72d58c0` | `INBOUND_NICOLE_BOARD_ID` | **Inbound** | Secondary inbound POs (Nicole's purchasing) |
| **Burlington Shipping Schedule** | `649c7dd6690130fe8ef3689a` | `BURLINGTON_OUTBOUND_BOARD_ID` | **Outbound** | Burlington-specific outbound shipments |
| **Shipping Schedule** | `66bcf93dd63eecdb2d4e91e7` | `OUTBOUND_BOARD_ID` | **Outbound** | All other client outbound shipments |

### Lists That Are SKIPPED (Never Synced)
| List Name Pattern | Reason |
|---|---|
| `NEEDED AS OF TODAY` | Staging/planning list, not a real shipment |
| `GENERAL LEDGER` | Reference list, not a shipment |

> [!IMPORTANT]
> The board direction (`Inbound` vs `Outbound`) is hardcoded in the `boardMatrix` array. It is NOT derived from list names or labels. If a board is tagged `"Inbound"`, ALL cards on that board are treated as inbound shipments regardless of their list position.

---

## 3. SHIPMENTS Tab Schema

This is the **central nervous system** of the entire portal. Every pipeline reads from or writes to this tab.

| Column | Letter | Index | Field Name | Source | Description |
|--------|--------|-------|------------|--------|-------------|
| 1 | A | 0 | `cardId` | Trello API | Trello card ID (unique key for deduplication) |
| 2 | B | 1 | `direction` | Board Matrix | `"Inbound"` or `"Outbound"` |
| 3 | C | 2 | `boardSource` | Board Matrix | Board name (e.g., `"Shipping Schedule"`) |
| 4 | D | 3 | `entityName` | Card Name | Store/entity name (e.g., `"Burlington Store 1234"`) |
| 5 | E | 4 | `transitMode` | Resolved | `"Ocean Freight"`, `"Air Freight"`, `"FedEx, UPS, & Truck Lines"`, `"Ground Freight"`, `"Standard / Ground"` |
| 6 | F | 5 | `scheduledDate` | Card Due Date | `MM/dd/yyyy` format or `"-"` |
| 7 | G | 6 | `listStatus` | Trello List | Current Trello list name (e.g., `"TO BE SHIPPED"`, `"SHIPPED"`) |
| 8 | H | 7 | `summary` | Card Checklists/Labels/Desc | Line items summary (max 450 chars) |
| 9 | I | 8 | `masterTracking` | Harvested | 12 or 15-digit FedEx tracking number |
| 10 | J | 9 | `rollupStatus` | Computed | **THE STATUS BADGE** — see Section 7 |
| 11 | K | 10 | `readyToShipDate` | Manual | `MM/dd/yyyy` or blank — see Section 5B |
| 12 | L | 11 | `readyToShipBasis` | Manual | `ESTIMATE` \| `SUPPLIER_CONFIRMED` \| `ACTUAL` |
| 13 | M | 12 | `etaDate` | Derived, then carrier | `MM/dd/yyyy` or blank |
| 14 | N | 13 | `etaBasis` | Computed | `DERIVED` \| `SUPPLIER` \| `CARRIER` \| `ACTUAL` |
| 15 | O | 14 | `dateState` | Computed | `NO_DATES` \| `RTS_ESTIMATED` \| `RTS_CONFIRMED` \| `IN_TRANSIT` \| `ARRIVED` |
| 16 | P | 15 | `portOfArrival` | Manual or Trello comment | Freeform text, blank allowed — see Section 4F |
| 17 | Q | 16 | `lastAutoDue` | Computed | `MM/dd/yyyy` or blank — the due-date value this system itself last wrote to Trello. Internal bookkeeping, not exposed to the client — see Section 4F |
| 18 | R | 17 | `etaOverridden` | Computed | `""` or `"MANUAL"` — set once Trello's due date is taken over by a human (or the future RXO API) — see Section 4F |

> [!CAUTION]
> Column D (index 3) is formatted as TEXT (`@`) to prevent Google Sheets from converting tracking-number-like store names into scientific notation. This `setNumberFormat('@')` call in `syncAllBoardsToShipmentsTab()` MUST be preserved.

> [!IMPORTANT]
> Columns K–R (K–P added 2026-08-13, Q–R added 2026-08-13, all `Service_Dates.js`) are the two-date readiness/ETA state machine, a freeform port-of-arrival field, and the Trello due-date self-write tracking that makes the whole thing safe to write back to Trello automatically. Both `syncAllBoardsToShipmentsTab()` and `Webhook_Receiver.js`'s webhook writer touch **only columns A–J** (`getRange(row, 1, 1, 10)` / a 10-wide append) — K–R are structurally outside every Trello-sync write, so a Trello *sync* can never overwrite a manually-entered readiness date, basis, or port of arrival. As of 2026-08-13 this system also writes *to* Trello (comments and the Due Date field) through dedicated, narrowly-scoped functions — see Section 4F for the full read/write picture and the override-detection mechanism that keeps that from fighting a human who takes the due date over directly.

---

## 4. Inbound Pipeline

### What "Inbound" Means
Goods coming INTO the business from suppliers/manufacturers. **Critically, not all inbound shipments arrive at the warehouse.** There are two distinct inbound sub-types that must be handled differently:

| Inbound Type | Destination | Receiving Method | Statuses |
|---|---|---|---|
| **Local Warehouse** | PWH / SWH / PP | Barcode scanner (physical scan required) | Standard lifecycle → RECEIVED |
| **China Drop Ship** | Supplier → Customer (bypasses warehouse) | Carrier delivery / supplier check-off | DELIVERED / DROPSHIP COMPLETE |

### Data Sources
- **Purchase Orders** board (Trello)
- **Nicole POs** board (Trello)

### Line Items Extraction
Inbound line items come from **Trello Checklists** on each card:
```
formatInboundLineItems(card.checklists)
  -> Iterates all checklist items
  -> Produces: " * Item Name 1\n * Item Name 2\n..."
```

### Inbound Status Lifecycle — LOCAL WAREHOUSE (PWH / SWH / PP)

```
PENDING -----------------------------------> Card exists, no tracking, no checklist progress
  |
  +-- [Tracking # harvested] ----------------> ON THE WAY
  |
  +-- [Card moved to transit list] ---------> ON THE WAY
  |     (SHIPPED, IN TRANSIT, OCEAN FREIGHT,
  |      AIR FREIGHT, FEDEX, UPS, TRUCK)
  |
  +-- [FedEx: All boxes delivered] ---------> DELIVERED (carrier confirmed)
  |     NOTE: This is NOT the same as RECEIVED.
  |     Goods are at the dock but NOT yet verified/accepted.
  |     A FedEx box scan-to-deliver (Section 4B) may update individual box
  |     status here but cannot itself produce RECEIVED.
  |
  +-- [Receiving verification — partial] ----> Partially Received
  |     (Human verifies what actually came vs. what was expected.
  |      Some items confirmed, others still pending.)
  |
  +-- [Receiving verification — complete] ---> RECEIVED (all items verified)
  |     Items accepted into inventory, placed into ZONE-BUFFER (Limbo)
  |
  +-- [Checklist 100% checked (isFullyPacked), OR card in a list -->  RECEIVED
  |     literally named Received/Done/Completed]
                                                |
                                                v
                                           [Archived to Shipment_History]
```

> [!IMPORTANT]
> **DELIVERED ≠ RECEIVED for local warehouse inbound.** Carrier delivery confirmation (FedEx says "Delivered") means the goods are physically at the facility, but they are NOT received into inventory until the **receiving feature** verifies what actually arrived. The receiving feature (`submitBulkPOReceipt` in `JS_Handlers.html`) is the mechanism that transitions local warehouse inbound from DELIVERED → RECEIVED.
>
> **This app's inbound boards have no list literally named "Received."** A card landing in a `Delivered`-classified list only gets `RECEIVED` if its checklist is 100% checked (`isFullyPacked` — the same signal `receivePOCardItems()` flips on a full receipt), regardless of which specific list it's in. This isn't list-name-driven the way the diagram above implies at a glance — see `syncAllBoardsToShipmentsTab.js`'s and `Webhook_Receiver.js`'s `isCompletedList` branch, added after a real incident (PO 3503/3562 stuck showing PAST DUE despite 100% received line items — see Section 7's Writer 2 note for the webhook-side history of this same fallback).
>
> **Barcode scanning is a SEPARATE concern from Receiving Verification above.** See Section 4B for the FedEx box scan-to-deliver feature — it updates individual box status and triggers a rollup recompute, but per Section 4B's invariant it can never itself produce the `RECEIVED` string.

### Inbound Status Lifecycle — CHINA DROP SHIP (Supplier → Customer)

```
PENDING -----------------------------------> Card exists, order placed with supplier
  |
  +-- [Tracking # harvested] ---------------> ON THE WAY (carrier picked up)
  |
  +-- [FedEx/Carrier: Delivered] -----------> DELIVERED
  |     (Drop ship — no warehouse handling needed)
  |
  +-- [Supplier check-off / manual] --------> DROPSHIP COMPLETE
  |     (Order fulfilled, no physical receiving)
  |
  +-- [Card in RECEIVED/DONE/COMPLETED] ----> DROPSHIP COMPLETE
                                                |
                                                v
                                           [Archived to Shipment_History]
```

> [!WARNING]
> **Drop ships are EXEMPT from barcode scanning.** They never touch the warehouse floor, never enter ZONE-BUFFER, and never appear in the physical inventory maps. They must be identified by a `DROP SHIP` label/tag on the Trello card or transit mode classification, and the system must NOT expect or require physical warehouse handling for them.

### Transit Modes (Inbound)
| Mode | How Detected |
|------|-------------|
| **Ocean Freight / SEA** | List name contains `OCEAN` or `SEA`, or label contains same |
| **Air Freight** | List name contains `AIR`, or label contains same |
| **FedEx, UPS, & Truck Lines** | List name contains `FEDEX`, `UPS`, or `TRUCK`, or label contains same |
| **Ground Freight** | List name contains `GROUND`, or label contains same |
| **Standard / Ground** | Default fallback if nothing matches |

> [!CAUTION]
> **"Drop Ship" is NOT an actual `transitMode` value produced by any code as of 2026-08-12.** A previous version of this table listed a `Drop Ship` row (label contains `DROP SHIP`/`DROPSHIP`). Verified by direct source search: `resolveTransitModeFromText_()` (`Shared_Classifiers.js`) — the sole implementation behind `resolveTransitMode()` — only matches `OCEAN`/`SEA`/`AIR`/`FEDEX`/`UPS`/`TRUCK`/`GROUND`. The literal string `"Drop Ship"` does not appear anywhere as an assigned transit mode in any `.js` file. See the `[!CAUTION]` in Section 4A for what drop-ship handling actually exists in code today (much narrower than this table previously implied).

---

### 4A. Destination-Aware Receiving & Drop Ship Rules

> [!CAUTION]
> **Reality check (2026-08-12): most of this subsection describes design intent, not verified current behavior.** A direct source search for `DROP SHIP`/`DROPSHIP`/`isDropShip` across every `.js` and `.html` file found exactly ONE consumer: `evaluateRollupStatuses()` (`evaluateRollupStatuses.js:73-91, 163-164`). It checks whether a row's `entityName` matches a `CUSTOMER_REGISTRY` entry whose `Handling_Type` is the literal string `"Direct Drop Ship"` (registry match by `Parent_Account`/`Brand_ID` or `Regex_Aliases` — NOT by a Trello card label), and — **only when 100% of that shipment's FedEx child boxes are already confirmed Delivered** — substitutes the final rollup badge `"COMPLETE"` instead of `"Received and Drops Off"`. That is the entire implemented behavior.
>
> None of the following, despite being described below and in Section 4B/17 invariant #25, were found anywhere in the codebase as of 2026-08-12:
> - No code path exempts a card from `submitBulkPOReceipt`/`receivePOCardItems` (receiving verification) based on drop-ship status.
> - No code path exempts a card from barcode scanning based on drop-ship status.
> - No code path skips `ZONE-BUFFER`/Limbo stowing based on drop-ship status.
> - The status value `"DROPSHIP COMPLETE"` (as an exact string) is never written by any `.js` file — only the unrelated string `"COMPLETE"` is (see above). `DROPSHIP COMPLETE` appears to be a planned/aspirational status that was never implemented, or was implemented once and later removed without this doc being updated.
> - Detecting drop-ship via a `DROP SHIP`/`DROPSHIP` Trello **label** (as opposed to the `CUSTOMER_REGISTRY` `Handling_Type` field) is not implemented anywhere.
>
> Treat the diagram and rules immediately below as the **intended design**, not a guarantee of current behavior. If a card is genuinely a drop-ship order today, it will still flow through the exact same receiving/scanning/Limbo path as a local-warehouse card — the only difference is the final badge text once FedEx confirms full delivery. If this system is expected to actually exempt drop-ship cards from warehouse handling, that is unbuilt work, not a regression to fix.

The system must classify every inbound card into one of two receiving paths at sync time (**intended design — see caution above for what's actually implemented**):

```
Inbound Card Arrives in SHIPMENTS
  |
  +-- Has label/tag "DROP SHIP" or "DROPSHIP"?
  |     |
  |     YES --> Drop Ship Path
  |     |     - Exempt from receiving verification
  |     |     - Exempt from barcode scanning (no physical warehouse handling)
  |     |     - Exempt from ZONE-BUFFER / Limbo stowing
  |     |     - Carrier delivery OR supplier check-off = final status
  |     |     - Terminal statuses: DELIVERED, DROPSHIP COMPLETE
  |     |     - Does NOT appear in warehouse floor map inventory
  |     |
  |     NO --> Local Warehouse Path
  |           - MUST go through receiving verification (the receiving feature)
  |           - Carrier delivery alone does NOT auto-receive into inventory
  |           - Barcode scanning creates audit trail (but does NOT change status)
  |           - Items enter ZONE-BUFFER (Limbo) after receiving verification
  |           - Terminal status: RECEIVED
  |           - Appears in warehouse floor map inventory after stowing
```

> [!CAUTION]
> **Carrier delivery logs alone MUST NOT auto-receive local warehouse inventory.** If FedEx says "Delivered" for a local warehouse inbound, the rollup status should reflect the delivery (e.g., `DELIVERED` or `Delivered in Full`) but the inventory system should NOT create inventory entries until the **receiving verification** completes.

---

### 4B. Barcode Scanning vs. Receiving — Two Distinct Operations

These are frequently confused but serve completely different purposes:

| Operation | Purpose | Changes Status? | Where It Lives |
|---|---|---|---|
| **Barcode Scanning (FedEx box scan-to-deliver)** | Warehouse staff scan a FedEx child box's tracking barcode to mark that specific box "Delivered (Manually Received)" without waiting for the next FedEx API poll — a global `keydown` listener matches the scan against open boxes and calls `markFedExChildDeliveredInSheet()`. | **Box-level: YES (intended).** Writes `MPS Backend`/`Multi Piece Tracking`, then calls `evaluateRollupStatuses()` + `warmLogisticsDashboardCache()` so the SHIPMENTS rollup (Col J) recomputes immediately from the new box statuses — same recompute that already runs on every sync/webhook/FedEx-batch cycle. **It can never produce the literal `RECEIVED` status** (Tier 4, local-warehouse manual receiving) — `evaluateRollupStatuses()` only ever *preserves* `RECEIVED` if a row is already there; nothing in its decision tree (Section 7) assigns that string. A scan can legitimately advance a row to `Partially Delivered`, `Delivered in Full`, `COMPLETE`, or `EXCEPTION` (the same FedEx-rollup values a scheduled discovery cycle would eventually produce anyway) — just sooner. | `JS_Handlers.html` (barcode scanner feature, `markFedExChildDeliveredInSheet()` in `Service_Write.js`) |
| **Receiving Verification** | Human verification of what actually came vs. what was expected. Confirms items into inventory. | **YES** — transitions DELIVERED → Partially Received → RECEIVED | `JS_Handlers.html` (`submitBulkPOReceipt`) |

**The Receiving Flow (status-changing):**
```
Shipment arrives at warehouse (status = DELIVERED)
  |
  +-- [Optional] Barcode scanning for audit trail (NO status change)
  |
  +-- Warehouse staff uses Receiving Feature to verify contents
  |     +-- Compares what arrived vs. what was expected (PO checklist)
  |     +-- Checks off verified items
  |
  +-- submitBulkPOReceipt() called
  |     +-- Optimistic UI: Immediately update client-side display
  |     +-- google.script.run call to receivePOCardItems() (writes Sheets + Trello)
  |     +-- SERVER: re-reads the card's LIVE Trello checklist and uses its
  |     |          qty/rcvd as the expected/already-received figures — the
  |     |          browser-supplied oldQty/oldRcvd are overwritten, never
  |     |          trusted (see Section 17 invariant #53)
  |     +-- SERVER: rejects the WHOLE batch atomically, before any writes,
  |     |          if any item's total would exceed that server-read expected
  |     |          qty (mirrors the client-side "Cannot over-receive!" check —
  |     |          see Section 17 invariant #28), and re-verifies the checklist
  |     |          has not moved again once the write lock is held
  |     +-- ON SUCCESS ({success:true, confirmedItems:[...]}):
  |     |     +-- Reconcile UI from confirmedItems (computed server-side,
  |     |     |    directly from the write just performed) — NOT a second
  |     |     |    getLogisticsDashboardData() fetch, which would return
  |     |     |    stale cached data (see Section 17 invariant #29)
  |     |     +-- refreshData() also called to pick up new ZONE-BUFFER rows
  |     +-- ON FAILURE OR {success:false} (over-receipt rejection is a
  |           NORMAL return, not a thrown exception — google.script.run
  |           routes it to withSuccessHandler, so the client must check
  |           res.success explicitly, not just rely on withFailureHandler):
  |           +-- REVERT optimistic UI changes
  |           +-- Show error to user
  |
  +-- Partial verification --> Partially Received
  +-- Full verification -----> RECEIVED (items enter ZONE-BUFFER / Limbo,
                                          named via the canonical Product-ID
                                          pipeline — see Section 4D)
```

> [!NOTE]
> As of 2026-08-11, `submitBulkPOReceipt` DOES issue a post-roundtrip reconciliation, and `receivePOCardItems()` DOES reject over-receipts server-side atomically. Both were previously missing (see v2 of this doc) — this note replaces the old `[!CAUTION]` that flagged them as required fixes.

> [!WARNING]
> **Barcode scanning (the FedEx box scan-to-deliver feature above) must NEVER produce the literal `RECEIVED` status.** `RECEIVED` is reserved for the human-verified local-warehouse Receiving Verification flow (`submitBulkPOReceipt`) — a scan-triggered rollup recompute must never be able to write that exact string. As implemented, this already holds: `evaluateRollupStatuses()`'s decision tree (Section 7) only ever *preserves* an existing `RECEIVED`, never assigns it. It IS expected and intended for a scan to update the scanned box's own status and to call `evaluateRollupStatuses()`/`warmLogisticsDashboardCache()` afterward so the SHIPMENTS rollup reflects the new box state immediately — that is not a violation of this rule. If you ever add a status-writing path here, the thing to protect is specifically "never write `RECEIVED`," not "never write anything."

---

### 4C. Checklist Parsing Resilience

**Corrected 2026-08-21** — the previous version of this section described quantity/format parsing (`Qty:`, mixed delimiters, unicode bullets) that `formatInboundLineItems()` does not actually do, and named the wrong caller files. Written down accurately:

`formatInboundLineItems(checklists, labels)` is duplicated (not shared — see the README's warning about GAS global-namespace shadowing, which calls this exact function out by name) in `syncAllBoardsToShipmentsTab.js` and `Webhook_Receiver.js`. Its only callers are those same two files. It does **not** parse quantities or formats out of each line — it lists each `item.name` as-is with a leading bullet (`" * " + item.name`), falls back to a fixed placeholder string when the checklist is empty, and appends label text. It genuinely is resilient to messy input, just not by *parsing* it: an unparseable/unexpected item name is simply passed through verbatim as the bullet text, so there's no format to fail on and nothing to throw.

The real "Qty:"-style parsing in this codebase is a separate, stricter convention used elsewhere — a pipe-delimited `Desc | QTY: X | RCVD: Y` format, produced by the Trello Injector (Section 4D-adjacent) and consumed by regexes in `JS_Handlers.html` and `JS_Render_UI.html` (the Section 5A demand aggregator's line-item parser is one consumer). That parser is what actually needs to tolerate missing/partial quantities and stray whitespace — not `formatInboundLineItems()`.

> [!WARNING]
> **Silent errors are the worst kind.** Neither `formatInboundLineItems()` nor the `QTY:`/`RCVD:` line parsers should ever throw on a single malformed checklist item or line — always fall back to passing the raw text through / treating quantity as 0/unknown, and keep processing the rest. This principle still holds; just don't look for it inside a quantity-parsing code path in `formatInboundLineItems()` that doesn't exist.

---

### 4D. Canonical Product-ID / Naming Pipeline (Added 2026-08-11, superseded 2026-08-26 — see below)

**The problem this originally solved**: `TrelloInjector.html` writes checklist items as `"[ProductID] Description | QTY: X | RCVD: Y"` when a real Product ID was selected from its autocomplete. Before the 2026-08-11 fix, `receivePOCardItems()` wrote that raw bracketed string straight into `Inventory` column B, producing entries like `"[CIS 019 (SS Ink Pin 19mm)] INK PIN"` on every Limbo/Staged/Totals view.

> [!CAUTION]
> **Superseded 2026-08-26 — read this before touching anything in this section.** The pipeline below wrote `resolveCanonicalItemName_`'s answer (the **nickname**) into Inventory column B. That was itself the root cause of a real inventory-loss incident's investigation trail: a mutable *display* label had quietly become the *identity* of a warehouse row, which broke name matching everywhere (two-way substring containment was covering for it — see the v16 changelog entry above and Section 17 invariants #67–#69), broke `findCaseConversion_` for every receipt after 2026-08-11 (a nickname doesn't start with the supplier code a conversion rule matches on), and meant renaming a product in PRODUCT silently orphaned its Inventory rows. **`receivePOCardItems()` now writes `resolveCanonicalProductId_()` (`Shared_Classifiers.js`), not `resolveCanonicalItemName_`.** The pipeline diagram below is otherwise unchanged — same bracket-split, same fallback chain — only the final step differs.

**The pipeline (current)**:
```
Trello checklist item text: "[CIS 019 (SS Ink Pin 19mm)] INK PIN | QTY: 24 | RCVD: 0"
  |
  v
splitProductIdFromDesc_(rawDesc)          <- Shared_Classifiers.js
  -> { productId: "CIS 019 (SS Ink Pin 19mm)", cleanDescription: "INK PIN" }
  (a bracket of "" or "ITEM" is treated as "no productId" — manually-typed
   checklist items without a real Product ID selection fall back cleanly)
  |
  v
resolveCanonicalProductId_(rawDesc, productMapUpper)   <- Shared_Classifiers.js
  -> PRODUCT sheet's own column-A text (the Product ID) if productId matches
     getProductMap() (case-insensitive) — getProductMap() now carries this
     verbatim as .productId on each entry, since a caller reaching an entry
     through the uppercased lookup key can't recover the original casing
  -> else falls through to resolveCanonicalItemName_'s answer (nickname, then
     cleanDescription, then raw text) — only reached when the description
     carries no resolvable Product ID at all
  |
  v
Written to Inventory column B (receivePOCardItems) AND Audit_Log column C
(both MUST stay in sync — namesMatch_()'s product-identity resolution,
Section 17 #67, depends on Audit_Log's historical text still resolving to
the same product even though it predates this pipeline)
```

Display is unaffected by any of this: `getNickname()` (`JS_Handlers.html`) resolves ID → nickname at render time and always has — that's the whole reason the nickname column exists on PRODUCT. Nothing about what staff see in the drawer, Totals, or Temp Storage changed; only what gets written to the sheet.

> [!IMPORTANT]
> There are now TWO parallel implementations of this split/resolve logic — **server-side** (`splitProductIdFromDesc_` / `resolveCanonicalItemName_` / `resolveCanonicalProductId_` in `Shared_Classifiers.js`) and a **client-side mirror** (`splitProductIdFromDescClient_` / `resolveCanonicalItemNameClient_` in `JS_Render_UI.html`, used by the Inbound Report so it doesn't need a round-trip — `window.productMap` is already loaded client-side via `precompiledProductMap`). The client mirror was **not** given a `resolveCanonicalProductId_` counterpart — the Inbound Report only ever needs the nickname for display, never writes to Inventory. Keep both in sync if this parsing logic ever changes.

**What still writes the raw bracketed text and is NOT yet fixed**: `confirmedItems.desc` (returned by `receivePOCardItems()` to the client for UI reconciliation) and `trelloComments` (posted back to the Trello card) both intentionally stay as the raw `item.desc` — the client regex-matches `confirmedItems.desc` against `itemObj.summary`, which still has the raw checklist text (that's what Trello actually stores), so changing this would break the reconciliation match.

**Historical data**: `migrateInventoryToProductIds(dryRun)` (`Setup_Registry.js`, added 2026-08-26, dry-run by default) is exactly the "run once under supervision" migration this section used to say hadn't been written. It rewrites an Inventory row's SKU cell **only** when the text is an unambiguous nickname of exactly one product, is not already a Product ID, and — critically — does **not** appear anywhere in the `Assemblies` sheet (see Section 18: assembly recipes match by exact string equality, so rewriting text a recipe depends on would silently break the build). Run live 2026-08-26 against the real workbook: 251 rows already correct, 17 rewritten, 31 held by the Assemblies guard, 11 left unmatched to any product (genuine gaps — a name matching nothing, or an assembly-parent aggregate like a "New/Relo Kit" that is deliberately not a PRODUCT row). See Section 17 invariant #69.

---

### 4E. Inbound Report Local/Non-Local Classification

**Added 2026-08-12, tightened 2026-08-13, keyword list retuned 2026-08-14 (briefly removed entirely earlier the same day, then restored narrower — see note below).** The Inbound Report pools every open inbound PO's requested quantities into one `Expected` number per SKU (Section 4D resolves the SKU name; this section is about which POs get counted at all). Before the 2026-08-12 pass, that pool was unconditional — a PO destined for TJX Australia (fulfilled by a third party, CREDO) or TJX Canada (physically held in the `RTF` virtual lot, not the CIS floor — see Section 15's Inventory `locId` prefix table) counted identically to a genuinely local PO, even though its stock will never sit in local Inventory. Confirmed against a real support case this session: `GEN6 SLIDE PB` showed `Expected: 7,600` blending a real local Sierra Boots order (4,000) with two TJX-Canada-earmarked orders (3,000 + 600) — accurate arithmetic, misleading number, since 3,600 of that 7,600 could never be fulfilled from local stock regardless of what arrives.

`classifyInboundOrderOrigin_(order)` (`JS_Render_UI.html`, immediately above `renderInboundReportModal()`) determines whether a given inbound order is locally fulfillable. Two layers, because neither alone covers the real data:

1. **`CUSTOMER_REGISTRY` lookup** (`window._serverCustomerRegistry`, same regex-alias convention as `getChainFromRecord()` in `JS_Handlers.html`), scoped to rows whose `Target_Board_ID` includes `INBOUND_PO_BOARD_ID` — a brand can have a second, outbound-only registry row with a different `Warehouse_Type` (e.g. Burlington's `"Order Fullfilment"` row), which must never be used to classify an inbound PO. A `Warehouse_Type` other than `"Local Warehouse"` (e.g. `"Virtual_Warehouse"`, `"Customer Warehouse"`, `"Direct Drop Ship"`) marks the order non-local.
2. **Keyword fallback** — `\b(AUSTRALIA|AUS|TJX CANADA|TJXC|RTF GLOBAL|RTF|TJX AU|TJX TK|TJX UK)\b` against the order's `entityName`+`summary` (which includes appended Trello labels as of 2026-08-14). Necessary because the registry's brand-oriented aliases don't catch real card-naming patterns: the registry's TJX-AU alias is `TJX\s*(?:AUSTRALIA|AU)\b`, which does **not** match the literal live card name `"CIS PO 3581 - 2026 TJX AUS Bulk Order #3"` (`AU` has no word boundary before the trailing `S` in `AUS`), and `"CIS PO 3588 - Celine Australia"` isn't a registered brand alias at all — "Celine" isn't in `CUSTOMER_REGISTRY`.

> [!NOTE]
> **2026-08-14, same-day correction.** An earlier pass this day dropped this entire keyword fallback, reasoning that `TIMING`/`RTF`/`TJXC`/etc. are vendor or freight-mode labels rather than destinations. Confirmed with the user: that's true for `TIMING` (a supplier name — removed, stays removed) and for bare `CANADA` (too generic — matched local orders that merely mentioned Canada, also stays removed), but **not** for `RTF`/`TJXC`/`TJX CANADA` or `TJX AU`/`TJX TK`/`TJX UK` — these genuinely identify a non-local destination (RTF is literally the physical Canadian warehouse the stock sits in) and removing them reopens exactly the `GEN6 SLIDE PB` blending bug described above. The fallback is restored with the narrower list above.

> [!IMPORTANT]
> **Precedence order matters and was a live bug during development**: a card can match multiple registry rows at once — `"CIS PO 3581 - 2026 TJX AUS Bulk Order #3"` matches both the generic `\bTJX\b` alias (`Warehouse_Type: "Local Warehouse"`) and is exactly the case the keyword layer exists to catch. A naive first-match-wins scan returns "local" the moment it hits the generic `TJX` row and never reaches the more specific signal. The implementation scans every `INBOUND_PO_BOARD_ID` registry row for a given order: any non-`"Local Warehouse"` match wins immediately; a `"Local Warehouse"` match is held as a tentative verdict but the keyword layer still runs and can override it; only if nothing else matched does the tentative registry verdict (or the true default, local) win. Verified against all known live examples (7 non-local, 14 local) before shipping.

**UI, rewritten 2026-08-13 — two separate controls, both now default to hiding non-local:**

1. **Logistics Control Tower's own Inbound "Origin" filter** (`View_Dashboard.html`'s `log-filter-origin` dropdown, inbound-tab-only) briefly defaulted to `LOCAL` instead of `ALL` (`resetOutboundFilters()` in `JS_Handlers.html`) from 2026-08-13 through 2026-08-17, but **was reverted back to `ALL` on 2026-08-17** after a live bug: defaulting to LOCAL made real customer POs vanish from the default view whenever `classifyInboundOrderOrigin_()` misjudged them as non-local. `View_Dashboard.html`'s dropdown now reads `<option value="ALL" selected>` again. This is the main Control Tower table's row-level filter, separate from the Inbound Report modal below it — when a user manually switches it to Local Only, it hides internal/administrative Nicole POs cards (e.g. `SUPPLIES AT RTF`, `Timing - Boot & Sleeve Count`) from the queue view. Nothing about the underlying cards or sheet rows changes either way.
2. **The Inbound Report modal's own Local Only / All toggle** (`renderInboundReportModal()`, `window.inboundReportScope`) — **as of 2026-08-13, non-local/administrative orders are unconditionally excluded from the `Expected`/`Received`/On Hand `itemMap` regardless of this toggle's setting.** Before this date, switching scope to `'all'` folded a non-local order's raw checklist quantities straight into the same shared SKU buckets as real customer demand, with no way to back them back out again — confirmed live: `SUPPLIES AT RTF` and `Timing - Boot & Sleeve Count` (both Nicole POs board, internal warehouse administrative cards, not customer merchandise) were doing exactly this to shared buckets like `SLEEVE KIT` whenever scope was switched to `'all'`. Now, the toggle only controls whether excluded orders are **additionally listed**: `'local'` shows a collapsed "N non-local/administrative purchase orders excluded" notice (with a "view them separately" link); `'all'` instead renders a separate **reference-only** section below the totals ("Non-Local / Administrative Orders"), listing each excluded order's raw untouched summary, status, and a direct Trello link — informational only, never counted.

> [!CAUTION]
> Both layers only classify **inbound** orders — this is a `renderInboundReportModal()`-specific feature, not a change to `getInventoryTotals()` or the outbound demand aggregator (Section 5A). It does not affect what physically writes to the `Inventory` sheet. But its scope is **broader than just report display**: the same `classifyInboundOrderOriginServer_()` classifier is also consulted by `archiveCompletedShipments()` and `resolveVanishedCardStatus_()` (`syncAllBoardsToShipmentsTab.js`) to decide whether a DELIVERED, non-local inbound card should archive/resolve as terminal `DELIVERED` rather than waiting on `RECEIVED` — a real SHIPMENTS/`Shipment_History` lifecycle effect, not merely which rows a modal shows. Defaults to `isLocal: true` on no match (only excludes on positive evidence), so a PO with an unrecognized naming pattern stays counted/archived-as-local rather than silently vanishing from demand totals or getting mis-archived — a false negative here is investigated on discovery, not a silent stock-availability bug.

> [!IMPORTANT]
> **This section only governs currently-open orders.** A `Shipment_History`-sourced (archived/deleted) record is excluded from the Inbound Report entirely before origin classification is even reached — see the new `historical` check in Section 11A. Origin classification (local vs. non-local) and historical-state exclusion are two independent filters applied in sequence, not the same mechanism.

---

### 4F. Readiness / ETA & Port of Arrival (Inbound-Only)

**Added 2026-08-13, redesigned 2026-08-13, day-math corrected 2026-08-14** (`Service_Dates.js`, columns K–R — see Section 3). A two-date state machine that replaces the single Trello-derived `scheduledDate` (column F) with an explicit model of what's actually known: a **Ready-to-Ship** date the supplier commits to (basis `ESTIMATE` / `SUPPLIER_CONFIRMED` / `ACTUAL`), and an **ETA** the system derives from RTS + a lead time once a tracking number appears, the carrier's own timeline would take over (`etaBasis` `CARRIER` — reserved for the RXO API, see below; nothing sets it yet). `computeShipmentDates_()` itself is pure and side-effect-free — driven entirely by the row's transit mode, port, list/rollup status, and master tracking presence — but as of 2026-08-14 the port-day-math it calls into (`classifyPortGroup_()` / `addPortGroupLeadTime_()`) is backed by a memoized Config-sheet read (`getPortGroups_()`, one read per script execution, not per row). Five states: `NO_DATES → RTS_ESTIMATED → RTS_CONFIRMED → IN_TRANSIT → ARRIVED`.

**Inbound-only, both directions of the UI.** The panel (`renderReadinessPanel_()` in `JS_Handlers.html`) takes an `isOutbound` flag and renders nothing at all when true — outbound shipments have their own Trello board and `rollupStatus` (Section 7) to say whether an order is done, and don't leave FROM a port, so neither half of this feature applies there. The backend state machine itself is NOT direction-aware (`computeShipmentDates_()` runs against every row regardless of `direction`) — harmless inertness on outbound rows, since nothing in the UI can trigger a write from one.

**How the ETA is derived (redesigned 2026-08-14 — Config sheet is now the source of truth):** `classifyPortGroup_()` matches the freeform `portOfArrival` text against whatever port groups `getPortGroups_()` reads out of the **Config** sheet's hand-maintained port table (three rows per port — Estimated Departure / Port to Port / Clearance, Delivery — scanned by content, not fixed row position, so a newly added port row is picked up with no code change). `LONG BEACH` / `LAX` / `Los Angeles` roll up into one `LA` group (`PORT_LABEL_TO_GROUP_KEY` in `Service_Dates.js`); any other port label becomes its own group automatically — this is how `Canada[Toronto]`, added by hand 2026-08-13, started working without a code change. Current live values:

| Leg | Day type | LA / Long Beach / LAX | Miami | Canada [Toronto] |
|---|---|---:|---:|---:|
| Pickup → departure port (RXO) | Business days (Sat/Sun skipped) | 3 | 3 | 3 |
| Port-to-port transit | Calendar days (ship sails through weekends) | 18 | 35 (Panama Canal / all-water) | 28 |
| Port arrival → customs → delivery | Business days (Sat/Sun skipped) | 8 | 5 | 5 |

> [!IMPORTANT]
> **These three legs are NOT summed into one flat day count.** `addPortGroupLeadTime_()` walks them in order, each with its own calendar arithmetic (`addBusinessDays_()` vs. `addDays_()`) — confirmed with the user 2026-08-14: Estimated Departure and Clearance/Delivery are real business-day counts (a customs office and a trucking dispatch don't run on weekends), Port-to-Port is not (the ship doesn't stop). Because of that, the real elapsed calendar time from RTS to ETA is NOT a fixed number — it depends on which day of the week the RTS date falls on (how many weekends the two business-day legs land on top of). There is no holiday calendar involved, only Saturday/Sunday.

> [!NOTE]
> Before 2026-08-14, this used a separate hardcoded object (`PORT_GROUPS`) that silently disagreed with the Config sheet, and additionally summed all three legs as flat calendar days regardless of the sheet's own "business" vs. "weekdays" wording. `PORT_GROUPS_FALLBACK` in `Service_Dates.js` keeps the old hardcoded numbers (LA 39d, Miami 47d, flat) only as an emergency fallback if the Config sheet is ever unreadable; it is never used while Config is readable and complete, and even the fallback path now goes through the same business-day-aware `addPortGroupLeadTime_()`.

When `portOfArrival` doesn't classify into any known group (unrecognized port, or a non-ocean transit mode), `computeShipmentDates_()` falls back to the older generic `TRANSIT_LEAD_DAYS` table (ocean 38d, air 6d, fedex/ups 3d, ground/truck 4d, ltl 5d, default 14d) — flat calendar days, never a guess at which port math to apply, only a documented fallback.

> [!IMPORTANT]
> **Data entry moved from the portal into Trello itself, 2026-08-13 (user decision — "reduce data entry, not increase it").** The portal's Readiness editor is still the fast way to enter a ready date + port, but Saving now does three things instead of one local sheet write:
> 1. Writes K/L/P locally (unchanged, optimistic UI).
> 2. **Posts a canonical `"READY <date> PORT <port>"` comment on the Trello card** (`postReadyPortComment_()`, only when the port actually classifies — an unclassifiable port still gets the local write + generic-lead-time ETA, it just doesn't get echoed as a comment nobody could parse back out). This makes Trello — not the sheet — the durable, human-readable record, visible to anyone on the card.
> 3. **Pushes the computed ETA into Trello's own Due Date field** (`pushEtaToTrelloDue_()`, PUT `/1/cards/{id}` with `due`) — so the board itself shows the current best estimate, not just the portal. This also runs on every scheduled sync (`refreshAllShipmentDateStates()`) whenever the recomputed estimate changes, e.g. as a card moves into `IN_TRANSIT`.
>
> **The same comment can also be typed directly into Trello by hand**, bypassing the portal entirely — `parseReadyPortComment_()` parses it out of a `commentCard` webhook (real-time, comment text arrives free in the webhook payload, no extra API call) or the sync-side backfill (`backfillReadyPortFromComments_()`, scoped to inbound rows still in `NO_DATES` so it isn't fetching comments for every card every cycle). Both paths funnel through the same `applyReadyPortDeclaration_()` core the portal Save uses, so there's exactly one code path for "a fresh declaration arrived," not two that could drift apart.

> [!CAUTION]
> **The pushed ETA is explicitly a placeholder, and this system knows to back off.** A real sailing schedule (from RXO, today by phone/email; hopefully later via the RXO API already scaffolded in `Service_RXO.js`, blocked on credentials) should always win. This is the override-detection mechanism, columns Q (`lastAutoDue`) and R (`etaOverridden`):
> - Every time this system writes Trello's Due Date, it records that exact value in `lastAutoDue` (column Q).
> - **Identity check (precise, real-time):** on an incoming `updateCard` webhook where `due` changed, `Webhook_Receiver.js` compares `action.idMemberCreator` — Trello's own tag for who/what made the change, delivered free in every webhook — against the `TRELLO_BOT_MEMBER_ID` script property. A mismatch means someone other than this system's own Trello identity changed it, so `etaOverridden` is set to `MANUAL`.
> - **Value check (fallback, always available):** `TRELLO_BOT_MEMBER_ID` is only meaningful if `TRELLO_KEY`/`TRELLO_TOKEN` point at a **dedicated automation-only Trello account**, resolved once via `identifyTrelloBotAccount()` (calls `/1/members/me`, writes the property, logs the account name for visual confirmation). Until/unless that's set up, the credentials are a personal login, so Trello can't distinguish "the automation wrote this" from "you, in Trello" by identity — both show the same member. The fallback: does the new due date match `lastAutoDue`? A match is just the echo of this system's own write (harmless, ignored, and also what stops the write→webhook→re-write loop from spinning — no value change means nothing re-fires). A mismatch means something else changed it. `detectMissedDueDateOverrides_()` runs the same value comparison once per scheduled sync as a safety net for whatever the webhook path missed (dropped delivery, a 3-second debounce collision with the automation's own echo — see `doPost`'s `webhook_lock_` cache key).
> - Once `etaOverridden = MANUAL`, `resolveEtaAndBasis_()` reports the ETA as Trello's own due date with `etaBasis: "CONFIRMED"` instead of computing its own DERIVED estimate, and every Trello-push path (`writeReadinessAndSyncTrello_`, `refreshAllShipmentDateStates`) skips pushing anything further for that row. **Only a fresh READY/PORT declaration resets it** — `applyReadyPortDeclaration_()` always clears `etaOverridden` on a new declaration, since new information should supersede an old override.
> - The portal surfaces this: `Service_Read.js` exposes `etaOverridden` to the client, and the panel shows an explicit badge ("Confirmed directly in Trello — automation has stopped pushing its own estimate") rather than leaving the switch from DERIVED to CONFIRMED math silently unexplained.

> [!NOTE]
> **Real sailing-schedule comments (added 2026-08-14).** Independently of the portal-authored READY/PORT format above, the user's actual pre-existing comment convention (confirmed 2026-08-14) looks like:
> ```
> ETD: 08/20/2026
> ETA port (Long Beach): 09/07/2026
> Shipping reference numbers: (...)
> ```
> `ETD` is the literal port departure date off an official sailing schedule — the pickup-to-port leg is already done, nothing to add before it. The `ETA port (X)` date is arrival AT that port only, before customs/delivery. `parseSailingScheduleComment_()` recognizes this (multi-line tolerant, order-independent), and `applySailingScheduleDeclaration_()` applies it: `readyToShipDate` = ETD with basis `ACTUAL`, `etaDate` = the port-arrival date plus only the Clearance/Delivery business-day leg (pickup and port-to-port are skipped entirely — both endpoints of that leg are already known from the real schedule), landing as `etaBasis: "CARRIER"`. The reference-number line is intentionally not parsed yet — reserved for the planned RXO API tracing feature.
>
> **`CARRIER` is sticky**, the same way `etaOverridden = MANUAL` is: `resolveEtaAndBasis_()` checks for an existing `CARRIER` basis before doing any generic derivation and just returns the stored value unchanged, so the periodic recompute (`refreshAllShipmentDateStates()`) can never silently downgrade a real sailing-schedule date back to a generic estimate. Only a fresh sailing-schedule comment (via `applySailingScheduleDeclaration_()` again) overwrites it — same "new information supersedes" rule as the READY/PORT `etaOverridden` reset. A `CARRIER` ETA is pushed to Trello's Due Date exactly like a `DERIVED` one (`writeReadinessAndSyncTrello_`, `refreshAllShipmentDateStates` — both now check for either basis).
>
> Wired into the same two paths as READY/PORT: the `commentCard` webhook (sailing-schedule format tried first, since it's real data rather than an estimate — falls through to `parseReadyPortComment_()` if it doesn't match) and the sync-side backfill (`findLatestReadyPortInfo_()`, still scoped to `NO_DATES` rows only — unchanged scope, just recognizes one more format within it).

> [!CAUTION]
> **Trello sync writers never touch K–R — verified, not assumed** (see the `[!IMPORTANT]` under Section 3's column table). What changed 2026-08-13 is that *dedicated, narrow* functions now write to Trello outside that sync path — `postReadyPortComment_()`, `pushEtaToTrelloDue_()` — each doing exactly one thing, logged, best-effort (a Trello-side failure never blocks the local sheet write, which is the more important side effect and must succeed independently of Trello's mood).

**Clear RTS (added 2026-08-14).** The Readiness/ETA editor (`renderReadinessPanel_()`, `JS_Handlers.html`) shows a "Clear RTS" button next to Save whenever a ready-to-ship date is set, for when it was only ever an estimate that's since gone stale. It blanks the date/basis inputs client-side and calls the normal save path (`saveShipmentReadiness()` → `updateShipmentReadiness()`); the server already clears K (`readyToShipDate`)/L (`readyToShipBasis`) and recomputes M–O whenever it receives an empty date (see the empty-date branch above `updateShipmentReadiness()` in `Service_Dates.js`) — no server change was needed, this only exposed an existing capability in the UI. Port (column P) is left untouched by Clear — only the date/basis reset.

**Standalone Shipping Estimate calculator (added 2026-08-14, redesigned 2026-08-17 — see below).** A separate, inbound-only "Shipping Estimate" button/modal (`View_Dashboard.html`) returns a computed date without writing anything: no cardId, no sheet row, no Trello comment or due-date push. Purely a "what would the ETA be if..." calculator, with its own Clear button that blanks the inputs client-side.

### 4G. Detailed Transit-Lane Engine & Guided RTS Flow (Added 2026-08-17)

**Why:** the original free-text "Port of arrival" field (both here and in the standalone calculator) gave no guidance on what to type or why — confirmed with the user as "ugly, and beyond vague." Separately, the user built a much richer lead-time reference table directly into the workbook, the **`Transit_Time`** tab (48 rows, not yet documented elsewhere in Section 15): one row per real shipping lane, with columns `Origin` (`"China"` — Timing produces the goods — or `"CIS (Florida)"` — already-landed goods being re-shipped to a Canada/Australia hub), `Destination` (the receiving hub — **reconciled/renamed 2026-08-19**, see below), `Travel_Type` (`OCEAN`/`AIR`/`FEDEX`), `Load_Type` (FCL/LCL for ocean; a single combined label for air; several FedEx service levels — IP/IE/Ground), `Season` (`Standard`/`Peak Season`), `Port`/`Port_Keyword` (comma-separated aliases, same convention as `PORT_GROUPS`), a `Parent_Account` column (M, read by `Service_Dates.js` but not currently used for lane filtering), and five day-count legs (`Collection_Days`, `Port_to_Port_Days`, `Port_Dwell_Days`, `Customs_Days`, `Delivery_Days`) that `Total_Est_Days` is a straight sum of (verified against live data — unlike the older Config-sheet math below, these are NOT business-day-adjusted).

> [!NOTE]
> **Destination values reconciled 2026-08-19.** The original destination set (`CIS (Florida)`, `CIS (LA)`, `RTF (Ontario)`, `RTF (Edmonton)`, `CREDO (AU)`, `RTF (CA)`, `BUNZL`, `TDC`) was clustered/renamed to `"Ontario (GTA)"`, `"Alberta (Edmonton)"`, `"Florida (US East)"`, `"Victoria (AU)"` (plus `BUNZL`/`TDC` unchanged); `CIS (LA)` was retired as a destination entirely. Code referencing `Transit_Time` destinations should use the current names, not the original list.

**Peak season window:** the sheet has no explicit date range attached to `Season` — the user added `Peak_Start_Date`/`Peak_End_Date` header cells (2026-08-17), with the actual dates one row below (confirmed live window: **August 15 – November 15**). **Corrected 2026-08-19:** the cells actually live at `Transit_Time!O1:P1` (headers) / `O2:P2` (dates) — earlier documentation here claimed `Q1:R1`/`Q2:R2`, which were never the real location; that error meant `getPeakSeasonWindow_()` silently treated every date as `Standard` season from 2026-08-17 until the 2026-08-19 fix, since it found no headers at the column it was told to expect (it scans row 1 by header TEXT, not fixed column position, same philosophy as `getPortGroups_()`'s Config-sheet scan — the column letters above are informational, not load-bearing to the code itself, but this doc had the wrong ones). It reads only month+day from row 2 — the year is ignored, so this is a recurring annual window that doesn't need updating every year. If the headers aren't found, every date is treated as `Standard` season rather than guessing.

**The lookup — `findTransitLane_()`:** narrows the 48-row table by (in order) Origin → Travel_Type → Destination-or-portText → Season (from the ready date via `isPeakSeasonForDate_()`; if the season filter would eliminate every remaining row — e.g. FedEx lanes only ever have `Standard` rows — the filter is skipped rather than returning nothing) → Load_Type. Two calling conventions:
- **Explicit selection** (`destination` param) — used by the new guided UI below.
- **Free-text `portText`** — matched, in order, against (1) the lane's literal `Port` field (exact, case-insensitive), (2) an exact match within `Port_Keyword`'s comma-separated aliases, (3) a substring match within those aliases. This is what makes the engine backward-compatible with every `portOfArrival` value already saved before this feature existed, with no data migration.

> [!CAUTION]
> **Port-collision bug, fixed 2026-08-21.** `resolveEtaAndBasis_()` only ever calls `findTransitLane_()` with `portText` (never `destination` — see the `[!IMPORTANT]` below on why the picker's Destination isn't persisted), so on every recompute after the initial save, disambiguation depends entirely on `Port_Keyword` text. Two lanes can legitimately share an alias — e.g. Ontario (GTA)'s "LA to Toronto (IPI)" lane listed `Los Angeles`/`LA`/`LAX`/`Longbeach` alongside the actual Los Angeles port's own keywords, since both routes physically pass through LA. Before this fix, `portText` matching only checked `Port_Keyword`, so a Florida-bound "Los Angeles" declaration matched *both* lanes and the "pick the slowest" tiebreak (below) silently resolved it to the much slower Ontario/IPI lane (68 days vs. 39) — no error, no override, just a systematically wrong ETA that reproduced identically on every save. Fixed by trying an exact match against the lane's own `Port` field first, since that's a single unambiguous value and exactly what the UI's Port select writes into `portOfArrival`. `Port_Keyword` lists that double as another lane's alias (e.g. the IPI lane's "Los Angeles") should still be trimmed to route-specific terms where practical, since a legacy freeform `portOfArrival` or Trello comment that doesn't exactly match a `Port` label falls back to the same ambiguous alias search.

**Load_Type default — confirmed with the user 2026-08-17: auto-picks the SLOWEST matching lane** (max `Total_Est_Days`), not the fastest — "we don't want to be optimistic in planning for shipping times." An explicit `loadTypePreference` (the UI's collapsed "Advanced: Load Type" selector) overrides this when supplied.

**Wired into `resolveEtaAndBasis_()` as the FIRST thing tried**, ahead of the older `classifyPortGroup_()`/Config-sheet path — so every row, including ones already in flight before this pass, gets the richer season-aware math automatically on the next recompute (`refreshAllShipmentDateStates()`), using the SAME `portOfArrival` text already on the row. The older port-group math survives only as a fallback for a port string that doesn't match any `Transit_Time` alias yet. `etaBasis` stays `"DERIVED"` either way — no new enum value, so `BASIS_LABELS`, the sticky override checks, and `RTS_BASES` are all unchanged.

**The guided UI — both the inline Readiness & ETA panel (`renderReadinessPanel_()`) and the standalone Shipping Estimate calculator now share the same 5-step flow**, in the order requested: **Ship Date → Transit Type → Origin → Destination → Port** (Destination/Port split into separate steps 2026-08-20), plus a collapsed "Advanced: Load Type" selector. Shared cascading-dropdown helpers (`populateTransitTypeSelect_`/`populateOriginSelect_`/`populateDestinationSelect_`/`populatePortSelect_`/`populateLoadTypeSelect_`, `JS_Handlers.html`) read `window._serverTransitLaneCatalog` — precompiled server-side via `getTransitLaneCatalog()` and injected into `Index.html` on page load, the same pattern as `window._serverCustomerRegistry`. A caveat note ("FedEx/UPS/Truck lead times here are reference shipping-lane estimates, not a live rate quote...") appears whenever Transit Type = FedEx, confirmed with the user 2026-08-17. `estimateShippingWindowV2(readyDateStr, travelType, origin, destination, port, loadType)` (forward: ready date → ETA) and `estimateShipByDateV2(arriveByDateStr, …)` (reverse: hard arrive-by date → latest ship-by date) are the pure, no-write client RPCs both UIs call for their live preview / final calculation.

**Literal Destination picker (2026-08-27).** The Destination dropdown used to list the `Transit_Time` regional clusters directly (`"Ontario (GTA)"`, `"Alberta (Edmonton)"`, …) — the user found the abstraction confusing next to a real shipment. It now lists the **literal receiving docks** from the `Delivery_Address` tab (RTF — Orangeville, BUNZL Burlington, TJX DC (TDC), CAVALIER (RTF storage), BUNZL Edmonton, CREDO, CIS Security Solutions), each mapped to its cluster by the hand-maintained `DELIVERY_DESTINATION_CLUSTERS` table (`Service_Dates.js`) — an **explicit** map, keyed by the exact upper-cased `Delivery_Address.Destination` string, not fuzzy dock-name matching (see the Port-collision `[!CAUTION]` above for why). `getTransitLaneCatalog()` gained a `deliveryDestinations: [{destination, label, cluster}]` array (built by `getDeliveryDestinationCatalog_()`; a `Delivery_Address` row with no map entry is logged and omitted; any cluster with real lanes but no literal dock is appended as its own entry so it can't become unreachable). Several docks legitimately resolve to the same cluster and therefore the same numbers — confirmed with the user that's expected. The `<option>` value is the literal destination (`data-cluster` carries the cluster); `resolveDestinationCluster_()` (client) / `resolveTransitDestinationCluster_()` (server, called from `findTransitLane_()` when `opts.destination` isn't already a cluster) map it back before any lane lookup. Nothing new is persisted — see the `[!IMPORTANT]` below; the resolved **Port** is still the only thing written. The Port dropdown now lists that cluster's entry ports **ordered fastest → slowest**, each option labelled with its worst-case estimate (`"Prince Rupert · ~53 days"`) — the max `Total_Est_Days` across the port's load types and both seasons, i.e. the same figure `findTransitLane_()`'s slowest-wins default resolves to. The option **value** stays the bare port name (unchanged for `portOfArrival` / server matching); only the visible text carries the day count.

> [!IMPORTANT]
> **The picker's Transit Type/Origin/Load Type selections are NOT persisted as new SHIPMENTS columns** — only the resolved **Port name** is written into the existing `portOfArrival` column (P), exactly as before. This keeps `classifyPortGroup_()`, the Inbound Report, and every other existing consumer of that column working unchanged, but means the inline panel's picker always starts unselected on reopen (a hidden field carries the previously-saved port forward so leaving the picker untouched and saving just a Basis change doesn't blank it — see `rts-original-port-<cardId>` in `saveShipmentReadiness()`). Widening the SHIPMENTS schema to persist the full lane selection was considered and deliberately deferred — out of scope for a UX-clarity pass.

> [!NOTE]
> **`Delivery_Address` and `Order Process` (the other two tabs added alongside `Transit_Time`) were not read by any code as of this pass** — see Section 9A. Only `Transit_Time` gained a code consumer here; `Delivery_Address` gained one 2026-08-25 (`getEstimatorRtfOriginZip()`) and a second 2026-08-27 (`getDeliveryDestinationCatalog_()` — the literal Destination picker, see the note above) — `Order Process` remains unread.

---

## 5. Outbound Pipeline

### What "Outbound" Means
Goods leaving the warehouse going TO retail customers/stores.

### Data Sources
- **Burlington Shipping Schedule** board (Trello)
- **Shipping Schedule** board (Trello)
- **pushOutboundToShippingSchedule.js** — Pushes order data FROM external Google Sheets INTO Trello

### Line Items Extraction — Board-Specific Logic

#### Shipping Schedule Board
```
1. Uses Trello LABELS as line items (primary)
2. Filters out metadata labels: "BRAND:*", "CLIENT:*", "TIMING TECH", "SEA SHIP",
   "TJX INVENTORY", "PORTAL:*" (e.g. "PORTAL: IGNORE", added with the 2026-08-14
   .ignore feature), AND (as of 2026-08-11) any label matching a CUSTOMER_REGISTRY
   brand's Regex_Aliases — see Section 9. Verified against a live board export
   2026-08-11: no "BRAND:*"-prefixed labels currently exist on real cards —
   labels are plain product/qty text ("5000 INK PINS", "24 BOOTS"). This filter
   is defensive/future-proofing, not currently removing anything in practice.
3. Falls back to card DESCRIPTION bullets if no labels
4. Extracts lines matching: starts with bullet, or contains "qty" or "case"
5. Filters out: "total cases" only (unlike the Burlington board below, this
   branch does NOT also filter "scheduled date"/"store:")
```

#### Burlington Shipping Schedule Board
```
1. Uses card DESCRIPTION bullets as line items (primary)
2. Extracts lines matching: starts with bullet, or contains "qty:" or quotes
3. Filters out: "total cases", "scheduled date", "store:"
4. Falls back to Trello LABELS if description has no bullets (same
   CUSTOMER_REGISTRY-aware filter as Shipping Schedule above)
5. Card names get "Burlington" or "Burlington Store" prefix if not already branded
```

> [!NOTE]
> `formatOutboundLineItems()`'s signature is now `(boardName, labels, descText, registry)`. `registry` is optional — `syncAllBoardsToShipmentsTab()` and `Webhook_Receiver.js` fetch `getCustomerRegistry()` ONCE per sync run / webhook call and pass it in (never per-card, to avoid hundreds of redundant sheet reads during a full 4-board sync). If omitted, the function fetches its own copy — kept for the one remaining 3-arg caller, the retired `legacyProcessWebhookPayload_` in `Service_Router.js`.

### Outbound Status Lifecycle

```
PENDING PACK ---------------------------------> Card exists, nothing packed
  |
  +-- [Some checklist items checked] ---------> PARTIAL PACK
  |
  +-- [All checklist items checked] ----------> PACKED
  |
  +-- [Tracking # harvested] -----------------> IN TRANSIT
  |
  +-- [Card moved to transit list] -----------> SHIPPED
  |     (SHIPPED, IN TRANSIT)
  |
  +-- [FedEx API: All boxes delivered] -------> Delivered in Full
  |     (triggers email + Trello dueComplete)
  |
  +-- [FedEx API: Some boxes delivered] ------> Partially Delivered
  |
  +-- [Card in DELIVERED/DONE/COMPLETED] -----> DELIVERED
  |
  +-- [FedEx Exception detected] ------------> EXCEPTION
  |
  +-- [DELIVERED, SHIPPED, or shipped/delivered ------> [Archived to Shipment_History]
        list-classified & not still-to-ship]
```

> [!NOTE]
> `PACKED` is the only live "all checklist items checked" value (`syncAllBoardsToShipmentsTab.js`, `Webhook_Receiver.js`). `"STAGED / PACKING"` is a *separate* status string, not an alias — it was only ever written by the retired `legacyProcessWebhookPayload_()` (`Service_Router.js`) and no longer occurs on any live path; see the Status Value Table in Section 7.
>
> **Archival** (`syncAllBoardsToShipmentsTab.js`'s outbound archive condition) fires on `rollupStatus === 'DELIVERED' || rollupStatus === 'SHIPPED' || <list classified as archived/deleted> || (!isToBeShipped && <list classified as shipped or delivered>)`. **`EXCEPTION` is not checked and is never archived by this condition** — an exception-status outbound card stays live in SHIPMENTS indefinitely until its status changes. If that's not intentional, it's a gap worth revisiting; documenting it here so it isn't mistaken for the diagram's old (incorrect) claim that EXCEPTION itself leads to archival.

### Outbound Customers (Client Registry)

> [!CAUTION]
> The table below (client identification via `BRAND:AEO`-style label regexes) does NOT match how customer/chain identification actually works in the live app as of 2026-08-11. `getChainFromRecord()` (`JS_Handlers.html`) does the real work — it parses `entityName`/`summary`/`boardSource` text via `CUSTOMER_REGISTRY` (Section 9), falling back to a hardcoded regex set ONLY if the registry failed to load. Live card names use plain store-number naming ("AEO Store 893", "Burlington Store 1767"), not `BRAND:` label prefixes — verified against a live board export. Treat this table as historical/aspirational, not a current contract; see Section 9 for the real mechanism.

| Customer | How Identified | Board | Label Patterns |
|----------|---------------|-------|---------------|
| **Burlington** | Dedicated board + card name prefix | Burlington Shipping Schedule | -- |
| **AEO** (American Eagle Outfitters) | Card name/desc regex `BRAND:AEO` | Shipping Schedule | `v32`, purple label |
| **AERIE** | Card name/desc regex | Shipping Schedule | -- |
| **OFF** | Card name/desc regex | Shipping Schedule | -- |
| **TJX** | Card name/label | Shipping Schedule | -- |
| **MARSHALLS** | Card name/label | Shipping Schedule | -- |
| **HOMEGOODS** | Card name/label | Shipping Schedule | -- |
| **SIERRA** | Card name/label | Shipping Schedule | -- |
| **NORDSTROM** | Card name/label | Shipping Schedule | -- |
| **DICKS SPORTING GOODS** | Card name/label | Shipping Schedule | -- |
| **BASS PRO SHOPS** | Card name/label | Shipping Schedule | -- |
| **ROSS** | Card name/label | Shipping Schedule | -- |

### Store Info Extraction
```javascript
extractStoreInfo("Burlington Store 1234")
// -> { storeName: "Burlington Store", storeNum: "1234" }

extractStoreInfo("AEO Store 567")
// -> { storeName: "AEO Store", storeNum: "567" }

// Regex: /^([A-Za-z\s]+)\s*#?\s*(\d{2,6})/
```

---

### 5A. Outbound Demand Aggregator

**Added 2026-08-12.** `computeOutboundDemandMap_(outboundOrders, options)` (`JS_Render_UI.html`, immediately above `renderShippingReportModal()`) is the single source of truth for **"how many units of SKU X are still owed to open outbound orders."** It was extracted out of `renderShippingReportModal()`, which used to compute this same matrix as a throwaway local variable that only existed while that one modal was open.

**What it does** (unchanged from the pre-extraction logic — this was a reuse extraction, not a parsing redesign):
1. Walks a list of outbound order records (normally `window.logisticsData.outbound`).
2. Applies the **STRICT SHIPPED/COMPLETED EXCLUSION GUARDRAIL** — skips any order whose status is `PACKED`/`SHIPPED`/`ROLLED_UP`/`ARCHIVED`, or where `isItemCompleted(order, true)` is true, or `order.isRollup`/`order.rolledUp` is true. Only genuinely open orders count toward demand. **As of 2026-08-13, `isItemCompleted()` itself also short-circuits to `true` for any `historical:true` record before checking any status string — see Section 11A** — so a `Shipment_History`-sourced outbound record is excluded here too, not just on the inbound side.

> [!NOTE]
> **Fixed 2026-08-12**: `isItemCompleted` (defined once, in `JS_Handlers.html`) branches its completion rules on whether the order is inbound or outbound. It infers that direction from `window.activeLogisticsTab` by default — correct for callers inside `renderLogisticsControlTower()`, which scope their own data to the same tab, but wrong here: this aggregator and `renderShippingReportModal()`'s date-range filter both walk `window.logisticsData.outbound` unconditionally, regardless of which tab the user has open (including on the 2-minute background poll, where no tab is being actively viewed). Grading outbound orders with the inbound tab's rules meant a `DELIVERED` outbound order wasn't recognized as complete, so it stayed counted as outstanding demand — inflating this aggregator's totals and, via the netting in the `[!IMPORTANT]` block below, the Inbound Report's On Hand figure. `isItemCompleted` now takes an explicit second parameter (`isItemCompleted(item, isOutboundOverride)`) so callers with unconditional outbound data can pass `true` instead of relying on tab state. A second, dead copy of `isItemCompleted` previously also existed near the top of `JS_Render_UI.html` (shadowed by GAS's include-concatenation order, so it never ran) — it has been deleted.
3. Parses each surviving order's `summary` line items with the same quantity-extraction regexes as before (leading number, trailing number, the Trello Injector `"Desc | QTY: X | RCVD: Y"` checklist format, a `100 SLEEVE KIT` special case, and two hardcoded aliases — `V32` → `"V32 UNIT SHIPMENT"`, `INK PIN(S)` → `"INK PINS"`).
4. Returns `{ matrixMap, grandTotalUnits, matchingOrdersCount }`, where `matrixMap` is keyed by the normalized (uppercased) item name → `{ totalUnits, storeCount, qtyDistribution }`.

**Extensibility hooks** (added during the extraction, so `renderShippingReportModal()`'s chain/date-range filters and diagnostic logging didn't have to duplicate the guardrail or the parsing regexes): `options.orderFilter(order)` for additional per-order filtering layered on top of the guardrail, `options.onOrderSkipped(order, reason, orderStatus, isCompleted)` and `options.onLine({ order, itemKey, qty, cleanLine, orderStatus, isCompleted })` for observing skip/include/line events. `renderShippingReportModal()` uses these to keep its chain-classification (TJX/BURLINGTON/AEO), date-range filtering, and 7-field `window.shippingReportDebugLog` exactly as they were — same rendered output, just sourced from the shared function.

**Caching**: recomputed once per fresh `logisticsData` fetch, not per-caller. Both `window.logisticsData = data` assignment sites in `JS_Handlers.html` (`fetchLogisticsDashboard()`, and the 2-minute background cache-poll inside the `DOMContentLoaded` handler) immediately recompute `window.outboundDemandData = computeOutboundDemandMap_(window.logisticsData.outbound || [])` right after the assignment — mirroring how `window.inventoryTotalsData` caches the inbound on-hand totals. Unlike `inventoryTotalsData` (a server round-trip via `getInventoryTotals()`), this is a pure client-side recomputation over data already in memory, so it's cheap to run on every `logisticsData` refresh rather than only on-demand.

**Consumers**:
- `renderShippingReportModal()` — calls it with a chain/date `orderFilter` for the modal's own filtered view; identical rendered output to the pre-extraction inline version.
- `renderInboundReportModal()` / `findOutboundDemandForSku_()` (both `JS_Render_UI.html`) — the Inbound Report's On Hand figure now nets against `window.outboundDemandData` in addition to staged stock; see the `[!IMPORTANT]` below.

> [!IMPORTANT]
> **Inbound Report On Hand formula, as of 2026-08-12: `On Hand (truly available) = inventory total − staged − outbound demand`.** Previously it was just `total − staged`. `findOutboundDemandForSku_(skuName, outboundDemandData)` matches an Inventory `sku` against `outboundDemandData.matrixMap`'s keys using the **same exact-then-fuzzy-substring strategy** `findOnHandForItem_` already uses (just in the reverse direction — sku → outbound item key), so there is only one matching convention in this codebase, not two. This match is **best-effort by design**: inbound line items resolve through the PRODUCT sheet for a canonical SKU (Section 4D), but outbound line items are free text ("24 BOOTS", "5000 INK PINS") with only the two hardcoded aliases above and no Product-ID tagging at all. A `null` match means "no open outbound order matched this item name" and contributes 0 to the netting — the modal shows a "no outbound match" indicator (title tooltip + icon) rather than silently treating an unmatched item as fully netted. **Retrofitting Product-ID tagging onto outbound checklist items to improve this match rate is unbuilt work, not a regression** — see Section 4D for how the inbound side got its canonical matching and consider the same pipeline for outbound if this becomes a priority.

---

## 6. Transit Mode Resolution

Transit mode is resolved with a **priority cascade**: List Name -> Labels -> Default.

```javascript
function resolveTransitMode(listName, labels) {
  // PRIORITY 1: Check Trello list name via resolveTransitModeFromText_()
  //   if text includes "OCEAN" or "SEA"        -> "Ocean Freight"
  //   if text includes "AIR"                    -> "Air Freight"
  //   if text includes "FEDEX/UPS/TRUCK"        -> "FedEx, UPS, & Truck Lines"
  //   if text includes "GROUND"                 -> "Ground Freight"

  // PRIORITY 2: Check Trello card labels (same keywords, same helper)

  // PRIORITY 3: Default
  //   return "Standard / Ground"
}
```

> [!IMPORTANT]
> As of 2026-08-11, the actual keyword matching lives in `resolveTransitModeFromText_()` (`Shared_Classifiers.js`), and `resolveTransitMode()` just calls it twice (list name, then labels). This is a genuinely different (broader) keyword set than the similarly-named `isFreightModeList`/`isInTransitList` checks in `syncAllBoardsToShipmentsTab.js` and `Webhook_Receiver.js` — those intentionally do NOT match bare `SEA`/`AIR`/`GROUND` (only `OCEAN FREIGHT`/`AIR FREIGHT` as compound phrases, no `GROUND` at all), to preserve their pre-existing exact behavior. Do not casually consolidate these two — they were kept deliberately separate. See `classifyListStatus()`'s `isFreightModeList` comment in `Shared_Classifiers.js` for the full reasoning.

> [!WARNING]
> There are **four** resolvable transit modes, plus a default fallback. These map to:
> - AIR -> `"Air Freight"` (Trello list/label: `AIR`)
> - SEA/OCEAN -> `"Ocean Freight"` (Trello list/label: `OCEAN` or `SEA`)
> - FEDEX/UPS/TRUCK -> `"FedEx, UPS, & Truck Lines"` (Trello list/label: `FEDEX`, `UPS`, or `TRUCK`)
> - GROUND -> `"Ground Freight"` (Trello list/label: `GROUND`)
> - Default (nothing matches) -> `"Standard / Ground"`

---

## 7. Rollup Status Lifecycle — COMPLETE State Machine

This is the most critical section. The rollup status in Column J of SHIPMENTS is computed by **three different writers**, each with its own logic. Understanding their interaction is essential.

### Writer 1: `syncAllBoardsToShipmentsTab()` — Initial Assignment
Sets the status when a card is first written or updated from the scheduled Trello sync.

> [!WARNING]
> ### RESOLVED 2026-08-26: Writer 1 re-arming the "newly received" email every cycle
>
> **Real incident**: a single AEO outbound card whose Trello list was never moved to
> a terminal ("Delivered") list, but whose FedEx tracking was fully delivered,
> generated hundreds of "PO Delivered in Full" emails.
>
> **Root cause**: Writer 1 recomputes Column J purely from live Trello card/list
> state on every sync cycle and — unlike Writer 2, which already had a
> `getRollupRank_()` guard — wrote it unconditionally, clobbering whatever Writer 3
> had set on the previous cycle (e.g. `"Received and Drops Off"`). Because the card
> stayed in a non-terminal Trello list, Writer 1 reset Column J back to `"SHIPPED"`/
> `"IN TRANSIT"` every cycle; Writer 3 then saw `!isManualReceived`, treated it as a
> brand-new delivery, and re-fired the automation (email + Trello `dueComplete`) on
> every single sync.
>
> A compounding bug in `getRollupRank_()` (`Shared_Classifiers.js`) made this
> unfixable by rank comparison alone: the Outbound branch never recognized
> `"Received and Drops Off"` as tier 4 (it only matched `DELIVERED`/`DONE`/
> `COMPLETE`/`CLOSED`), so it silently ranked as tier 0 — lower than `SHIPPED`.
>
> **Fix**: (1) `getRollupRank_()` now also matches `"RECEIVED"` for Outbound. (2)
> Writer 1's `updateShipmentRows` loop now applies the same rank-based
> preserve-don't-downgrade guard Writer 2 already used, via `existingRollupMap`
> snapshotted alongside `existingShipmentsMap`.

### Writer 2: `processWebhookPayload()` — Real-Time Updates
Sets the status when a Trello webhook fires (card moved, checklist updated, etc.).

### Writer 3: `evaluateRollupStatuses()` — FedEx Override
Runs AFTER Writers 1/2 and can **upgrade** (but not downgrade) statuses based on FedEx API data.

### The Golden Rule of Status Hierarchy
```
evaluateRollupStatuses() will NEVER downgrade a manual/Trello status.

If Trello says "RECEIVED" but FedEx says "On the Way":
  -> Status stays "RECEIVED" (Trello wins, human override preserved)

If Trello says "PENDING" but FedEx says all boxes delivered:
  -> Status becomes "Received and Drops Off" (FedEx upgrades)
```

> [!NOTE]
> ### RESOLVED: "Delivered" → "Partially Received" Mismatch
> 
> Confirmed 2026-08-11: `evaluateRollupStatuses.js`'s `isManualReceived` check already includes `DELIVERED` (`currentUpper === "DELIVERED"` and `listCls.isDelivered`) — this was fixed before this document's current revision. Kept as a note (not deleted) because it's exactly the kind of regression worth actively guarding against: if `DELIVERED` is ever removed from that check set again, this exact anti-pattern (see the `[!WARNING]` below) comes back.

> [!NOTE]
> ### RESOLVED 2026-08-12: Writer 2 (`processWebhookPayload()`) reverting a fresh RECEIVED back to stale
> 
> **Real incident**: PO 3571 (SO56S) was fully received via the portal. Trello's checklist item correctly flipped to `state: complete`, and the card was correctly auto-moved to the Delivered list — but the SHIPMENTS row (and therefore the dashboard card) kept showing `PARTIAL RECEIPT` / the pre-receipt qty for hours.
>
> **Root cause**: the old "preserve non-pending rollup" guard (see item 20 below) gated purely on *this webhook event's* list classification (`!listCls.isShipped && !listCls.isDelivered`). A `checkItem`-state webhook carries no `list` data at all, so `listName` fell back to `"Unknown List"` — which always fails that check — so the guard reverted the freshly-computed `RECEIVED` (already correctly derived from `isFullyPacked`, independent of list) back to the stale `currentRollup`. The follow-up card-move webhook, which *did* carry list data and would have set it correctly, then landed inside the 3-second per-card debounce window and got dropped.
>
> **Fix**: replaced the list-based gate with a rank-based one — `getRollupRank_(direction, status)` in `Shared_Classifiers.js`. The guard now only reverts `rowData[9]` when the freshly-computed status ranks *lower* than `currentRollup` (an actual regression, e.g. a stale partial-checklist reread trying to undo a status a later event already advanced past). A newly-computed status that's equal or further along is always trusted, regardless of whether this particular event happened to carry list context. This still satisfies the original intent one section up ("don't overwrite `DELIVERED` with `PARTIAL RECEIPT` based on checklist state") since `DELIVERED`/`RECEIVED` outrank `PARTIAL RECEIPT` in the rank table — it just also fixes the reverse direction that was silently broken.

### Complete Status Value Table

| Status Value | Direction | Meaning | Set By | Badge Color |
|---|---|---|---|---|
| `PENDING` | Inbound | No tracking, no progress | Sync/Webhook | Grey `#888888` |
| `PENDING PACK` | Outbound | Card exists, not packed yet | Sync/Webhook | Grey `#888888` |
| `PARTIAL PACK` | Outbound | Some checklist items checked | Sync/Webhook | Orange `#ff9800` |
| `PACKED` | Outbound | All checklist items checked | Sync/Webhook | Green `#00e676` |
| ~~`STAGED / PACKING`~~ | *(historical — see note below)* | Only ever written by the retired `legacyProcessWebhookPayload_()` (`Service_Router.js`), superseded by `Webhook_Receiver.js`. No live path writes this string as of 2026-08-21; kept as a historical marker like `DROPSHIP COMPLETE` below. | N/A | N/A |
| `ON THE WAY` | Inbound | Tracking exists OR in transit list | Sync/Webhook/Rollup | Blue `#4dabff` |
| `IN TRANSIT` | Outbound | Tracking exists (pre-FedEx scan) | Sync/Webhook | Blue `#4dabff` |
| `SHIPPED` | Outbound | Card in shipped list | Sync/Webhook | Blue `#4dabff` |
| `Partially Received` | Inbound | Some checklist items received (human verification, in progress) | Sync/Webhook | Orange `#ff9800` |
| `Partially Delivered` | Either | FedEx: some boxes delivered, not all — carrier signal only, never a receiving claim | Rollup Engine | Orange `#ff9800` |
| `RECEIVED` | Inbound | All items physically scanned/received | Sync/Webhook/Barcode | Green `#00e676` |
| `DELIVERED` | Either | Carrier confirmed all boxes delivered (NOT = RECEIVED for local warehouse inbound) | Sync/Webhook/FedEx | Green `#00e676` |
| `Delivered in Full` | Either | FedEx: ALL boxes delivered — carrier signal only, never a receiving claim (renamed 2026-08-26 from "Received and Drops Off" specifically because FedEx is a delivery service and never verifies receipt) | Rollup Engine | Green `#00e676` |
| `COMPLETE` | Inbound (Registry Drop Ship) | FedEx: ALL boxes delivered AND `entityName` matches a `CUSTOMER_REGISTRY` row with `Handling_Type === "Direct Drop Ship"` | Rollup Engine (`evaluateRollupStatuses()` only) | Green `#00e676` (matches via generic `.includes("COMPLETE")` in the frontend badge colorer, no dedicated branch) |
| ~~`DROPSHIP COMPLETE`~~ | *(aspirational — see Section 4A caution)* | Never written by any code as of 2026-08-12. Kept here as a historical marker, not a real status value. | N/A | N/A |
| `EXCEPTION` | Either | FedEx: address/carrier error | Rollup Engine | Red `#ff1744` |
| `CARD DELETED FROM TRELLO` | Either | The card was deleted outright from its Trello board, never moved to a done list — see Section 11A | `pruneDeletedShipmentCards_()` (writes to `Shipment_History` only, never to a live SHIPMENTS row) | N/A — not a live rollup badge; see Section 11A on why `historical:true` suppresses this text from being graded as an active status at all |

### Status Hierarchy (Strict Ordering — Higher = Cannot Be Overwritten By Lower)

```
Tier 5 (Highest): EXCEPTION          -- FedEx error, overrides everything
Tier 4 (Terminal): RECEIVED, DELIVERED, DROPSHIP COMPLETE, Delivered in Full
Tier 3 (Partial):  Partially Received, Partially Delivered, PARTIAL PACK
Tier 2 (Moving):   ON THE WAY, IN TRANSIT, SHIPPED, PACKED
Tier 1 (Initial):  PENDING, PENDING PACK
```

> [!IMPORTANT]
> **Status transitions must ONLY move UP this hierarchy, never down.** The only exception is `EXCEPTION` (Tier 5), which can override any status because it represents a carrier-level problem requiring human intervention.

### evaluateRollupStatuses() Decision Tree (CORRECTED 2026-08-21)

`isManualReceived` = current status is `RECEIVED`/`PACKED`/`DELIVERED IN FULL`/`RECEIVED AND DROPS OFF`/`DELIVERED`/`DONE`/`COMPLETE` (exact string match — the old `RECEIVED AND DROPS OFF` value is kept in the set alongside `DELIVERED IN FULL` so rows not yet touched by `migrateRollupStatusLabels()` don't get downgraded), OR the row's Trello list itself classifies as received/delivered/done/completed (`classifyListStatus()`). `DROPSHIP COMPLETE` is never a real value (see the Status Value Table) so it is not actually part of this set despite older docs implying it. `isManualPartial` = current status or list name contains `"PARTIAL"`.

```
For each row in SHIPMENTS:

IF no Master Tracking Number (Col I is empty):
  -> PRESERVE current status (Trello-derived, not FedEx-dependent)

IF Master Tracking exists but NO child boxes in MPS Backend (discovery
hasn't run yet, or MPS Backend rows were cleared):
  +-- isManualReceived? -> PRESERVE current
  +-- isManualPartial?  -> PRESERVE current
  +-- Otherwise         -> "On the Way"
  (Fixed 2026-08-21 — this branch previously set "On the Way" unconditionally,
  which could silently downgrade an already-RECEIVED/DELIVERED/COMPLETE row.)

IF child boxes exist in MPS Backend:
  |
  +-- ANY box has EXCEPTION/ERROR/DELAY/ADDRESS status?
  |     -> "EXCEPTION" (highest priority, overrides everything)
  |
  +-- ALL boxes = DELIVERED?
  |     +-- isManualReceived?
  |     |     -> PRESERVE current (don't override manual confirmation)
  |     +-- Otherwise, entityName matches a CUSTOMER_REGISTRY row with
  |     |    Handling_Type === "Direct Drop Ship"?
  |     |     -> "COMPLETE" (bypasses local receiving for drop ships)
  |     +-- Otherwise?
  |           -> "Delivered in Full"
  |           -> TRIGGER: Email notification to stakeholders
  |           -> TRIGGER: Trello card marked dueComplete = true
  |
  +-- SOME boxes = DELIVERED (partial)?
  |     +-- isManualReceived?
  |     |     -> PRESERVE current (NEVER downgrade from Tier 4 to Tier 3)
  |     +-- Otherwise?
  |           -> "Partially Delivered"
  |
  +-- NO boxes delivered yet?
        +-- isManualReceived?  -> PRESERVE current
        +-- isManualPartial?   -> PRESERVE current
        +-- Otherwise?         -> "On the Way"
```

> [!NOTE]
> ### Board-freshness automation: auto-move to "Shipped" on first carrier scan (added 2026-08-26)
>
> Independent of the rollup-badge tree above, `evaluateRollupStatuses()` also checks
> — for every **Outbound** row still sitting in a **"TO BE SHIPPED"**-classified
> Trello list, with no exception — whether any MPS child box status shows a real
> carrier scan (`isPreTransitFedExStatus_()`, `evaluateRollupStatuses.js`: false for
> a bare "Shipment information sent to FedEx" / "Label Created" status, true once
> FedEx shows real movement). If so, the Trello card is PUT to whatever list on that
> board is classified `isShipped && !isToBeShipped` (`findShippedListId_()`) — i.e.
> moved out of "TO BE SHIPPED" into "Shipped".
>
> **Why this exists**: the packing checklist (which normally drives PACKED/the list
> move) isn't reliably kept up to date by warehouse staff, so a card can carry a
> real tracking number and real carrier movement while still visually sitting in "TO
> BE SHIPPED" indefinitely. A bare tracking number isn't a strong enough signal on
> its own — a label can be printed well before the package leaves the building —
> so this specifically requires FedEx to report an actual scan, not just a
> harvested tracking number.
>
> This is separate from, and does not replace, the "ALL boxes = DELIVERED" trigger
> above (email + `dueComplete`) — that one still only fires on full delivery, and
> still never moves the card's list itself.

> [!CAUTION]
> The "Delivered in Full" status (renamed 2026-08-26 from "Received and Drops Off" — FedEx is a delivery service and never verifies receipt, so the label shouldn't say "Received") triggers **automation**:
> 1. Email sent to stakeholder list (from Config sheet or session user)
> 2. Trello card `dueComplete` set to `true` via Trello API
> 
> This automation ONLY fires when a row **newly transitions** to this status. It does NOT re-fire on subsequent sync runs.

> [!WARNING]
> ### The DELIVERED → Partially Delivered Anti-Pattern
> (status renamed 2026-08-26; was "Partially Received" when this was fixed 2026-08-11 — the anti-pattern itself is unchanged)
> 
> **This must NEVER happen:**
> ```
> Cycle 1: syncAllBoardsToShipmentsTab() sets status to "DELIVERED" 
>          (all FedEx boxes confirmed delivered)
> Cycle 2: evaluateRollupStatuses() runs, sees only 3/5 MPS child boxes are 
>          "Delivered" (2 are still updating), overwrites to "Partially Delivered"
> ```
> 
> **Why it's wrong:** The MPS Backend may have stale data for some child boxes. A shipment that was previously confirmed `DELIVERED` must not be downgraded because the batch refresh hasn't updated all child boxes yet.
> 
> **Status:** Fixed — `DELIVERED` is in the `isManualReceived` check set in `evaluateRollupStatuses()` (via `classifyListStatus().isDelivered`, `Shared_Classifiers.js`). Confirmed 2026-08-11.

---

## 8. FedEx Multi-Piece Shipping (MPS) System

### The Four Engines

| Engine | Function | Trigger | Purpose |
|---|---|---|---|
| **Engine 1: Fast Batch** | `runLiveBatch()` / `runLiveSelection()` | Manual (FedEx Tools menu) | Updates `Live Tracking` tab with latest FedEx scan status |
| **Engine 2: Discovery** | `runMPSDiscovery()` | Time-driven (every 10 min) | Finds child box tracking numbers from master tracking |
| **Engine 3: Batch & Reassembly** | `runMPSBatchAndReassemble()` | Time-driven (every 3 hr) | Updates ALL child box statuses + reassembles MPS frontend |
| **Engine 4: Batch Shipping Schedule Estimator** | `batchCalculateTransitTimes()` | Manual (web app, FedEx view) | Given a CSV of store ZIPs + target arrival dates, computes a ship-by date per row via FedEx's Rates API — see its own subsection below |

### MPS Data Flow

```
Multi Piece Tracking (Frontend Tab)
+----------+----------+-----------+----------------+--------------+-----------------+----------+
| Col A    | Col B    | Col C     | Col D          | Col E        | Col F+          |          |
| Store    | Store #  | Direction | Master Trk #   | Discovery    | Box 1 Status,   | ...      |
| Name     |          |           | (12/15 digits) | Status       | Box 1 Trk#, ... |          |
+----------+----------+-----------+----------------+--------------+-----------------+----------+
                                        |
                                        | Discovery Engine
                                        v
MPS Backend (Hidden Tab)
+----------------+----------------+----------------------+-----------------+
| Col A          | Col B          | Col C                | Col D           |
| Master Trk #   | Child Trk #    | Status               | (FedEx API result)| Last Checked    |
|                |                |                      | MM/dd/yyyy HH:mm|
+----------------+----------------+----------------------+-----------------+
```

### Discovery Status Values (Col E of Multi Piece Tracking)
| Value | Meaning |
|---|---|
| *(empty)* | Not yet discovered — eligible for next discovery run |
| `Active - N Pieces` | Discovery found N child boxes |
| `No Pieces Found` | FedEx API returned no associated shipments |
| `Delivered` | All child boxes delivered |
| `Partial Delivery (X/Y Delivered)` | X of Y boxes delivered |
| `Active - In Transit` | Boxes discovered, none delivered yet |

### FedEx Status Parsing (`formatFedExStatus`)
| FedEx Code/Description | Parsed Output |
|---|---|
| `DL` or "delivered" | `"Delivered - MM/dd/yyyy [Est: date / Loc: city, state]"` (no weight field — `extra[]` only ever pushes `Est:`/`Loc:`) |
| `HL`, `SE`, `AR`, "ready for recipient pickup", "held at location", "at destination sort facility" | `"READY FOR PICKUP (original status) [details]"` |
| All other | Raw `statusDesc + [details]` |

### FedEx API Endpoints Used
| Endpoint | Purpose | Auth |
|---|---|---|
| `POST /oauth/token` | OAuth2 bearer token | `CLIENT_ID`/`CLIENT_SECRET` (Track) or `FEDEX_RATES_KEY`/`FEDEX_RATES_SECRET` (Rates) — **two separate FedEx API credentials**, cached under different `CacheService` keys (`FEDEX_TRACK_TOKEN` / `FEDEX_RATES_TOKEN`, 50 min each) since they authenticate against different FedEx products |
| `POST /track/v1/trackingnumbers` | Batch tracking (up to 30) | Bearer token (Track) |
| `POST /track/v1/associatedshipments` | MPS child box discovery | Bearer token (Track) |
| `POST /rate/v1/rates/quotes` | Transit-day lookup for Engine 4 (below) | Bearer token (Rates), `FEDEX_ACCOUNT` |

> [!IMPORTANT]
> **LockService Pattern**: The FedEx engines use a "Late-Stage Lock" pattern. API calls run UNLOCKED (so the web app stays responsive), and only the final sheet write acquires a `ScriptLock`. If the lock fails (web app is actively editing), the write is skipped and retried next cycle.

### Engine 4: Batch Shipping Schedule Estimator (added 2026-08-20)

**What it does:** a "Batch Shipping Schedule Estimator" panel in the web app's FedEx view (`View_FedEx.html`) lets an operator upload a CSV of store locations, map which column holds the ZIP code and which holds a target arrival date (auto-detected by header name via `/zip|postal/i` and `/arrive|date|target|fixture/i`, both overridable), and get back a per-row **ship-by date** — the target date minus FedEx Ground transit time, walked backward skipping weekends and a hardcoded holiday list. The tool auto-downloads an annotated copy of the same CSV with `Transit Days` and `Ship-By Date` columns appended once every row is processed.

**Client → server flow:** `processBatchShippingEstimator()` (`JS_Handlers.html`) parses the CSV client-side (`parseCSVRow()`, a small quoted-field-aware splitter — not a full RFC 4180 parser, but sufficient for simple store-list exports) into a `parsedLocations` array, then calls `batchCalculateTransitTimes(parsedLocations, 0)`. Each row resolves its transit time either from the `Shipping_Time` cache sheet (below) or a live Rates API call, capped at 100 live API calls per invocation (`MAX_API_CALLS`) to stay inside Apps Script's 6-minute execution ceiling. If the array has unprocessed rows left when the cap is hit, the server returns `{ nextIndex: <resume point> }` and `renderShippingEstimatorResults()` immediately re-invokes `batchCalculateTransitTimes()` starting there — the SAME recursive-continuation pattern used elsewhere for long-running Apps Script work, just client-driven instead of trigger-driven.

**ZIP extraction has two confidence tiers.** A ZIP taken from the mapped column is treated as confirmed. When that column is empty for a given row, the code falls back to scanning the row's raw text for any 5-digit number (`\b\d{5}(?:-\d{4})?\b`) — which can just as easily latch onto a store number, phone extension, or any other 5-digit field in an unmapped row. **Fixed 2026-08-20:** a guessed ZIP is now flagged (`zipGuessed: true`) rather than silently treated with the same confidence as a mapped one — the results table marks it `(guessed)` in orange and the downloaded CSV appends `(ZIP guessed, verify)` to its Transit Days cell. Before this fix, a false-positive regex match produced a confidently-wrong ship-by date with no indication it wasn't a real column value. A row with no extractable ZIP at all still sets `manualReviewNeeded: true` and skips the API call entirely.

**`subtractBusinessDays()`'s holiday list is hardcoded to 2026 and 2027 only.** Dates in 2028+ will silently stop skipping holidays (weekends are still skipped correctly, since that's computed from `getDay()`, not the list) — not a crash, just a slow accuracy drift as the tool ages. Extend the list in `Fedex_Master_Script.js` before it matters for 2028 planning.

**`Shipping_Time` (new sheet, auto-created on first use)** — a flat origin/destination transit-time cache so repeated estimator runs (or overlapping ZIP codes across different CSVs) don't re-spend Rates API calls:

| Column | Field | Notes |
|---|---|---|
| A | Origin ZIP | From the `CIS_ZIPCODE` script property, default `"34997"` if unset |
| B | Destination ZIP | First 5 digits only (ZIP+4 stripped) |
| C | Transit Days | Integer, mapped from FedEx's `ONE_DAY`..`TEN_DAYS` transit-time enum |
| D | Date Added | Timestamp of the API call that produced this row |

Never pruned or deduplicated — a ZIP pair queried twice writes two rows, and `loadShippingTimeCache()` just keeps whichever one its `Object` key collision resolves to last (JS object insertion order, so effectively the most recently loaded row wins within one run). Not a problem in practice (transit times between two ZIPs rarely change), but worth knowing if the sheet is ever hand-audited.

**Required Script Properties**, none of which overlap with the Track API's `CLIENT_ID`/`CLIENT_SECRET`: `FEDEX_RATES_KEY`, `FEDEX_RATES_SECRET` (Rates API OAuth — `getRatesBearerAuthorization()` returns `null` if either is missing, which `fetchTransitDays()` turns into a thrown error surfaced per-row), `FEDEX_ACCOUNT` or `FEDEX_ACCOUNT_NUMBER` (falls back to the placeholder `"000000000"` if neither is set — the Rates API will reject this, so an unset account number fails loudly per-row rather than silently, but it's worth confirming the property is actually set rather than relying on that failure mode), and `CIS_ZIPCODE` (falls back to `"34997"`).

**Origin ZIP is now surfaced in the UI and overridable per-run (added 2026-08-21).** Every estimate ships from `CIS_ZIPCODE` (CIS Security Solutions' own warehouse ZIP), but before this the operator had no way to see that or to run an estimate from anywhere else — the modal now fetches it via `getEstimatorOriginZip()` on open and displays "Shipping from CIS Security Solutions (ZIP …)", with an adjacent input to override it for that run. `processBatchShippingEstimator()` validates the override client-side (5-digit ZIP or blank), stashes it on `window._estimatorOriginZipOverride` so the recursive continuation calls in `renderShippingEstimatorResults()` keep using the same value across chunks of one run, and passes it as `batchCalculateTransitTimes()`'s new third argument. A blank override falls back to the script property exactly as before. The server always echoes back whichever ZIP it actually used (`results.originZip` — already existed pre-2026-08-21, just never displayed), and the client re-displays it after each response so the UI can never show a stale or wrong value even if the override were somehow rejected.

> [!WARNING]
> **Canada support added 2026-08-21, cross-checked against FedEx's own Rates API OpenAPI spec (`rate.json`, provided by the user the same day) but still NOT verified against a live FedEx account/credentials.** `fetchTransitDays()` hardcoded `countryCode: "US"` for both the shipper and recipient address — with no origin-country override existing at all, it was structurally impossible to quote a Canada-domestic lane (e.g. RTF, the virtual lot holding TJX Canada's Winners/Homesense/Marshalls stock — Section 15's `locId` prefix table — to a Canadian store), regardless of what postal code was typed in. A country selector (`estimator-country-select`, `View_FedEx.html`) now switches BOTH ends to `CA` and switches postal-code validation/auto-guess-scanning to the Canadian format (`[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d`) instead of the 5-digit US regex — threaded through as `batchCalculateTransitTimes()`'s new fourth argument. Canada mode also skips the 5-character truncation `destZip` normally gets (that's a US ZIP+4-stripping step; truncating a 6-character Canadian postal code the same way would cut off its last digit). Canada mode requires an explicit origin postal code — there is no CIS-side default for an RTF-origin lane, so `CIS_ZIPCODE`'s US default is never silently substituted.
>
> **Two things the spec confirmed and one requirement it surfaced:**
> - `countryCode` is a genuine, generic ISO country field (the spec's own examples use `"NO"`, `"ES"`, not just `"US"`), and `CANADIAN_DESTINATION` exists as a named surcharge type — Canada is a real, first-class rating scenario for this API, not something bolted on.
> - Every example response using `serviceType: "FEDEX_GROUND"` uses that exact same enum value for both a plain US-domestic quote AND a Canada-context one (FedEx just relabels the display name, e.g. `"FedEx International Ground"`, based on the lane) — there is no separate Canada-specific serviceType value to worry about getting wrong.
> - **The spec states `customsClearanceDetail` (with at least one `commodities` entry) is required for both "international and intra-country" rating** — "intra-country" being FedEx's term for a domestic-but-non-US lane, i.e. exactly the Canada-to-Canada RTF case this was built for. `fetchTransitDays()` now attaches a placeholder commodity block (`description: "General Merchandise (transit-time estimate only)"`, 1 PCS, 1 LB, nominal `$1 USD` customs value, `countryOfManufacture` set to the request's own country) whenever `countryCode !== "US"`. **This is a placeholder for satisfying the API's rating requirement only — it is NOT a real customs declaration and must never be reused for an actual shipment/label.**
>
> This still assumes an **all-Canada domestic lane** (Canadian origin, Canadian destination) — not a cross-border US↔CA quote, which would need independent per-end country fields this implementation doesn't have. What's still unverified: whether the placeholder commodity values are "good enough" for FedEx's rating engine to actually return a `transitTime`/`transitDays` value rather than erroring on some other required customs field the spec didn't make obvious, and whether the account is enabled for Canadian rating at all. Run one real Canada-mode batch and sanity-check the returned transit days before trusting this operationally.

**Cancel button + stuck-button fix (added 2026-08-21).** Before this, the recursive continuation chain described above had no way to stop once started — no cancel/pause control existed anywhere in the modal — and the "Generate Schedule" button (`btn-generate-schedule`) was only ever set to disabled/spinning at the start of a run; nothing re-enabled it on completion or on a continuation failure, so a failed or finished run left it permanently stuck and the operator couldn't even retry by clicking it again without reloading the page. Fixed by adding a `btn-cancel-schedule` button (`View_FedEx.html`) alongside it, and a `window._estimatorCancelled` flag that `renderShippingEstimatorResults()` (`JS_Handlers.html`) checks before firing each next chunk — since `google.script.run` calls already in flight can't be aborted client-side, cancelling lets the in-progress chunk (up to 100 API calls) finish, then stops before requesting the next one. A new `resetGenerateScheduleButton()` helper is now called on every exit path (success, initial failure, continuation failure, cancel, and the empty-results case) so the button pair always returns to its idle state. Retrying after a cancel or failure re-runs `processBatchShippingEstimator()` from row 0 rather than resuming exactly where it left off — full mid-file resume would need the client to persist `nextIndex` across the retry click — but already-computed ZIP pairs are served from the `Shipping_Time` cache (above), so a retry doesn't re-spend live Rates API calls on rows already done.

---

## 9. Customer/Client Registry

### CUSTOMER_REGISTRY Sheet (7 cols) — Added by `setupV3Registries()` in `Setup_Registry.js`

> [!CAUTION]
> This sheet's real column layout, confirmed against live data 2026-08-11, is **7 columns**, not the 6 `setupV3Registries()` originally wrote — a `Warehouse_Type` column was added at position G (shifting `Handling_Type` to H) directly in the live sheet, outside of any script. `getCustomerRegistry()` (`Service_Read.js`) was silently reading the wrong column for `Handling_Type` until fixed 2026-08-11 — it was returning `Warehouse_Type`'s values under the `Handling_Type` key, and `Handling_Type`'s real data was being dropped entirely. If you add more columns to this sheet by hand again, update `getCustomerRegistry()` to match, or this drift repeats.

| Column | Letter | Field | Notes |
|--------|--------|-------|-------|
| 1 | A | `Parent_Account` | e.g. `"Burlington"`, `"TJX Cos."`, `"AEO Inc"` |
| 2 | B | `Brand_ID` | e.g. `"BURL-US"`, `"AEO"`, `"TJX-CA"` |
| 3 | C | `Brand_Name` | Display name, e.g. `"Burlington"`, `"American Eagle"` |
| 4 | D | `Regex_Aliases` | e.g. `\bBURLINGTON\b`, `\b(AEO|AMERICAN\s*EAGLE)\b` — used directly as `new RegExp(pattern, 'i')`, wrapped in try/catch everywhere it's consumed (a malformed regex in one row is skipped, never crashes the caller) |
| 5 | E | `Target_Board_ID` | **Not yet consumed by any code** as of 2026-08-11 (parsed and stored, nothing routes by it) for outbound purposes, but **the Inbound Report's local/non-local classifier (Section 4E) now scopes its registry lookup to rows whose `Target_Board_ID` includes `INBOUND_PO_BOARD_ID`** — the one place this column is actually read as of 2026-08-12. Can hold a Script Property NAME (e.g. `"OUTBOUND_BOARD_ID"`) or a comma-separated list of them in real data. |
| 6 | F | `Warehouse_Type` | **Consumed as of 2026-08-12** by `classifyInboundOrderOrigin_()` (Section 4E) — any value other than `"Local Warehouse"` marks an inbound order non-local. e.g. `"Local Warehouse"`, `"Virtual_Warehouse"`, `"Direct Drop Ship"`, `"Customer Warehouse"` |
| 7 | G | `Handling_Type` | **Consumed as of 2026-08-12** — see `evaluateRollupStatuses()` below. Values seen in seed data: `"Local Warehouse"`, `"Direct Drop Ship"`, plus aspirational examples `"Inventory Orders"`, `"Roll Outs"`, `"Order Fullfilment"`, `"Stored at RTF"` that no code branches on yet. Only the exact string `"Direct Drop Ship"` currently has any effect. |

> [!IMPORTANT]
> Real data confirmed 2026-08-11 has **multiple rows per Brand_ID** — e.g. Burlington appears twice, once for an inbound-supplier relationship and once for an outbound-retail-destination relationship, each with different `Target_Board_ID`/`Handling_Type`. Any code consuming this sheet must NOT assume one row per brand.

**Where it's actually wired in (as of 2026-08-13):**
1. **Frontend chain classifier** — `getChainFromRecord()` (`JS_Handlers.html`) matches `Regex_Aliases` against card text to group the Logistics Control Tower by brand. Falls back to a hardcoded regex set if the registry is empty/failed to load — see the `[!CAUTION]` on the Section 5 client table above.
2. **Outbound line-item label filtering** — `formatOutboundLineItems()` (`syncAllBoardsToShipmentsTab.js`) additionally filters out any label matching a brand's `Regex_Aliases`, via `isKnownBrandLabel_()` (`Shared_Classifiers.js`). See Section 5.
3. **Rollup drop-ship badge override** — `evaluateRollupStatuses()` (`evaluateRollupStatuses.js:73-91`) matches `entityName` against `Parent_Account`/`Brand_ID`/`Regex_Aliases` and reads `Handling_Type`. If it equals `"Direct Drop Ship"` AND 100% of FedEx child boxes are delivered, the final badge becomes `"COMPLETE"` instead of `"Received and Drops Off"`. This is the ONLY code that reads `Handling_Type` — see the `[!CAUTION]` in Section 4A for what this does and doesn't actually change (it's narrower than the name suggests: it does not exempt anything from receiving/scanning/Limbo, it only changes a badge string at the very end of the FedEx-confirmed-delivered lifecycle).
4. **Inbound local/non-local classification (added 2026-08-12)** — `classifyInboundOrderOrigin_()` (`JS_Render_UI.html`, Section 4E) reads `Regex_Aliases`, `Target_Board_ID`, and `Warehouse_Type` together to decide whether an inbound PO counts toward the Inbound Report's Expected/Received totals and the Control Tower's default inbound view. This is the first consumer of `Target_Board_ID` and `Warehouse_Type` — both were parsed-but-unused as of v7 of this document.

All four are **fail-safe by design**: an empty/missing sheet behaves identically to before this feature existed; one malformed regex row is skipped without affecting others.

### 9A. Registry Precedence Fix & Data Corrections (Added 2026-08-17)

Cross-referencing three new reference tabs the user added to the live workbook — `Delivery_Address` (Customer/Destination/Address/Status), `Transit_Time` (Origin/Destination/lead-time legs by port), and `Order Process` (Employee/Account/Parent_Account/fulfillment routing) — against `CUSTOMER_REGISTRY` surfaced two real bugs, both fixed by `fixTjxCanadaAndTkMaxxRegistry()` (`Setup_Registry.js`):

1. **`getChainFromRecord()` (`JS_Handlers.html`) had no match-precedence logic — first row wins, in sheet order.** `classifyInboundOrderOrigin_()` (Section 4E) already learned this lesson for inbound local/non-local classification (a specific non-local match must beat a broader generic one, regardless of row order); `getChainFromRecord()` — a separate function used for the "Select All Chains/Brands" dropdown and chain grouping across BOTH inbound and outbound — never got the same fix. Since the generic `TJX Cos.` rows (Homesense/Marshalls, `Local Warehouse`) sit before the `TJX CA` rows (same brand words, `Virtual_Warehouse`) in the sheet, a Canada-bound Homesense/Marshalls card always matched the generic US row first and was silently grouped under the wrong parent. Fixed to a two-pass match: any non-`"Local Warehouse"` row is checked before any `"Local Warehouse"` row, independent of sheet order.
2. **That fix alone would have been a regression without also fixing the TJX CA rows' regex.** They shipped with corrupted `Regex_Aliases` values — literal leftover instruction text appended after the real pattern (e.g. `"...TJXC)\b (adjust per-row, keeping each one's existing brand-specific alternative like HOMESENSE\s*(?:CA)?)"`) — and even cleaned up, a bare `\bHOMESENSE\b`/`\bMARSHALLS\b` would now (after the precedence fix above) win over the correct US-local row for every US Homesense/Marshalls card too, not just Canada-bound ones. Fixed to require a co-occurring Canada signal via lookahead: `\bHOMESENSE\b(?=.*\b(?:CA|CANADA|RTF|TJXC)\b)` (same for Marshalls). Winners has no US-side homonym (Canada-only TJX banner), so its pattern stays bare: `\bWINNERS\b`.
3. **TK Maxx was registered under `Parent_Account: "TJX UK"`** with a regex requiring the literal word "AUSTRALIA" (`\bTKMAXX\s*(?:AUSTRALIA|AUS?)\b`), which can't match a plain "TK Maxx" card. `Order Process` (row 19) and `Delivery_Address` (row 6) both show TK Maxx is fulfilled through CREDO — the same Australia-based third party as TJX Australia — confirmed with the user 2026-08-17 there is no real "TJX UK" fulfillment path. Both existing `TK-MAXX` rows are repointed to `Parent_Account: "TJX AU"` with a clean regex (`\b(?:TK\s*MAXX|TKMAXX)\b`) and the same `Warehouse_Type: "Customer Warehouse"` convention as the existing TJX Australia row.

> [!NOTE]
> `Delivery_Address`/`Transit_Time`/`Order Process` were not read by any code as of this pass — they served as the source of truth for the above fixes and as validation input, not as a new runtime data source. No sheet-reading code was added for them.
>
> **Update (2026-08-25):** `Delivery_Address` gained its first code consumer — `getEstimatorRtfOriginZip()` (`Fedex_Master_Script.js`) matches `Destination` (not `Customer` — RTF is a fulfillment location this sheet ships to, never a customer) against `/rtf/i` and pulls a Canadian postal code out of the `Address` column to auto-fill the FedEx batch estimator's Canada-mode origin ZIP. `Transit_Time`/`Order Process` remain unread.

### BRAND_ITEM_CATALOG Sheet (5 cols) — Also from `setupV3Registries()`

| Column | Letter | Field |
|--------|--------|-------|
| 1 | A | `Brand_ID` |
| 2 | B | `Canonical_SKU` |
| 3 | C | `Keywords` (pipe/comma-separated) |
| 4 | D | `Default_Qty` |
| 5 | E | `Label_Color` |

> [!WARNING]
> As of 2026-08-11 this sheet only has the 9 starter/example rows `setupV3Registries()` shipped with — all Burlington-specific security-tag part keywords (`SCORPION`, `48`, `12`, `3.5`, `MILLI`, `DEMI`, `CABLE`, `TETHER`, `DEFAULT`). It will not resolve SKUs for AEO/TJX/Nordstrom/etc. products. Used by `matchCatalogSKU()` in `Service_PO_Ingest.js` as a fallback (see Section 4D-adjacent PDF Injector notes below) — the PRODUCT sheet is checked first and is the more complete, actually-maintained catalog. **Partially addressed 2026-08-13** — see Section 19's note on `populateBrandCatalogKeywords()`, a one-off in `Setup_Registry.js` that fills in a handful of high-confidence literal vendor-code `Keywords` mined from real Trello checklist exports (Burlington individual-unit SKUs + the shared AEO-family `V32` token). Still nowhere near covering TJX/Nordstrom/etc.

### pushOutboundToShippingSchedule.js — Client Configurations

| Client | Config Function | Source Sheet ID | Source Tab | Board Target |
|---|---|---|---|---|
| **AEO** | `runAeoSyncOnly()` | `18wtCbT6pHHgLGxAi6oqvRdH8URHr-zLq` | `2026` | Burlington Outbound Board |
| **Burlington** | `runBurlingtonSyncOnly()` | Script Property `BURLINGTON_SHEET_SYNC` (`10l6c37PE54MWug1C1HQEUtz1dP-s5x2btHDGcxNI2JM`) | `Orders` | Burlington Outbound Board |

### AEO Sheet Layout
| Col A | Col B | Col C | Col D | Col E | Col F | Col G |
|-------|-------|-------|-------|-------|-------|-------|
| Store # | Brand | # Of Units | Need By Date | **Shipping Date** | Location | Tracking |

Confirmed 2026-08-21 against the real source (`AEO Rollout Schedule.xlsx`, tabs `2025`/`2026`, matching the live sheet's `2026` tab config). `pushOutboundToShippingSchedule.js`'s AEO branch reads `row[4]` (Col E, **Shipping Date** — the "ship by" date) for `dateStr`; Col D (Need By Date — the "arrive by" deadline) is intentionally not read. Col D was previously mislabeled in an earlier pass as the date column the app should use, which pulled the wrong (arrive-by) date — the code has since been reading the correct column (E) all along; this table just had the wrong label.

### Burlington Sheet Layout
| Col A | Col B | Col C | Col D | Col E |
|-------|-------|-------|-------|-------|
| Store | Item | Cases | Date | Master Tracking |

Col D (`Date`) is the date the shipment must **arrive in store** — confirmed with the user 2026-08-24. This is distinct from AEO's Col E above, which is already a ship-by date; see the Burl_Transit_Time note immediately below for why that distinction matters.

### Burl_Transit_Time Tab (Added 2026-08-24)
Second tab in the same Burlington spreadsheet (`10l6c37PE54MWug1C1HQEUtz1dP-s5x2btHDGcxNI2JM`) as `Orders` above — a per-store ground-transit lookup that lets `pushOutboundToShippingSchedule.js` push each Trello card's due date back from "arrives in store" to "needs to ship."

| Col A | Col B | Col C | Col D | Col E | Col F | Col G | Col H |
|-------|-------|-------|-------|-------|-------|-------|-------|
| storeNumber | projectName | streetAddress | city | state | postalCode | Distance_Miles | Transit Days |

`Transit Days` is stored as text (e.g. `"5 Days"`) — `getBurlTransitTimeMap_()` (`pushOutboundToShippingSchedule.js`) pulls the leading integer via regex, keyed by `String(storeNumber).trim()`. The 11 rows added 2026-08-24 (postal code sourced from each store's address; transit days from a one-off run of the Batch Shipping Schedule Estimator — Section 8, Engine 4 — against those ZIPs) have no `Distance_Miles` value; that column isn't read by any code path, so leaving it blank is fine.

**Ship By Date computation** — `computeShipByDateStr_(inStoreDateStr, transitDays)` subtracts `transitDays` **business** days (skips weekends + the shared holiday list, `getUsFederalHolidayList_()`) from `Orders` Col D to get the ship-by date. This becomes the Trello card's `due` badge; the raw In Store date stays visible in the description as `Scheduled Date:`, with a new `Ship By Date:` line added alongside it. If a store isn't in `Burl_Transit_Time` (or the sheet date is blank), the card falls back to the pre-2026-08-24 behavior — `due` = the raw In Store date, no `Ship By Date:` line distinction — and the run's log (`storesMissingTransitTime`) lists every store that hit this fallback so gaps in the tab get noticed instead of silently mis-dating a card.

> [!NOTE]
> **Business-day, not calendar-day, subtraction — corrected same day (2026-08-24).** Initially shipped as raw calendar-day subtraction, then switched once it came up that `Burl_Transit_Time`'s FedEx-Rates-API-sourced rows (the 11 added this session) are business-day quotes — Engine 4's own `subtractBusinessDays()` already treats identical FedEx transit-day numbers this way, so calendar-day subtraction was inconsistent (and always produced a LATER, less-buffered ship-by date whenever the transit window crossed a weekend/holiday). `getUsFederalHolidayList_()` (`Fedex_Master_Script.js`) was extracted from inside `subtractBusinessDays()` so both functions share one holiday list instead of drifting out of sync — extend it there before 2028 (see invariant list, Section 17-adjacent note on `subtractBusinessDays()`'s hardcoded 2026/2027 holidays). `computeShipByDateStr_()` deliberately does NOT call `subtractBusinessDays()` itself — that function's ISO-string date-parsing branch has the same UTC-midnight bug `parseTrelloDate()` works around (see that function's comment) and was only ever exercised against M/D/Y-formatted CSV dates, not this file's `YYYY-MM-DD` `Orders` dates. Only the holiday list is shared; the date parsing is not.

> [!NOTE]
> **Burlington-only.** AEO's sheet already stores a ship-by date directly (Col E, AEO Sheet Layout above) — every part of this feature (`transitTimeMap`, `shipByDateStr`, the description line) is gated behind `!config.isAeo` in `pushOutboundToShippingSchedule.js`, so AEO cards render byte-for-byte identical to before this feature existed.

### Label Color Mapping (Burlington Products)
| Product Keyword | Trello Label Color |
|---|---|
| `SCORPION` | Green |
| `48` | Blue |
| `12` | Purple |
| `3.5` | Orange |
| `MILLI` | Yellow |
| `DEMI`, `CABLE`, `TETHER` | Red |
| *(default)* | Sky |

---

## 10. Tracking Number Harvesting

```javascript
function harvestFedExTrackingNumber(descText, commentText) {
  // 1. Concatenate card description + all card comments
  // 2. Strip ALL non-numeric characters
  // 3. Find first 12-digit or 15-digit number
  // 4. Return it (or empty string)
  
  const fullText = (descText + " " + commentText).replace(/[^0-9]/g, " ");
  const matches = fullText.match(/\b(\d{12}|\d{15})\b/g);
  return matches ? matches[0] : "";
}
```

> [!WARNING]
> This regex is intentionally greedy — it grabs the FIRST 12 or 15-digit number found anywhere in the card description or comments. If a card has multiple tracking numbers, only the first is captured as the "Master Tracking" number. Additional tracking numbers are discovered by the MPS Discovery Engine.

### Tracking Number Sanitization
```javascript
function cleanTrackingNumber(val) {
  // Strips ".0" suffix (Excel/Sheets float artifact)
  // Strips ALL non-numeric characters
  return String(val).trim().replace(/\.0+$/, "").replace(/[^0-9]/g, "");
}
```

> [!CAUTION]
> Tracking numbers are stored as TEXT in Sheets but frequently get auto-converted to floats by Google Sheets (e.g., `875021925761` becomes `875021925761.0` or `8.75022E+11`). The `cleanTrackingNumber()` function exists specifically to handle this. **Never remove it.**

---

## 11. Archival System

`archiveCompletedShipments()` runs at the end of every sync cycle.

### Archive Criteria

| Direction | Archive When |
|---|---|
| **Inbound** | Rollup = `RECEIVED` or `RECEIVED AND DROPS OFF`, OR list includes `RECEIVED`/`DONE`/`COMPLETED`, OR list = `ARCHIVED/DELETED`, OR Rollup = `DELIVERED` **and** either (a) the order classifies as non-local/drop-ship (Section 4E's `classifyInboundOrderOriginServer_()`), or (b) the order is a local-warehouse PO whose checklist shows fully-received quantities (`isFullyReceivedFromSummaryServer_()`, `Shared_Classifiers.js`) — both added after this table was first written; see `syncAllBoardsToShipmentsTab.js`'s archive branch, which cites this section's own DELIVERED≠RECEIVED invariant to justify the carve-out |
| **Outbound** | Rollup = `DELIVERED` or `SHIPPED`, OR list = `ARCHIVED/DELETED`, OR (list includes `SHIPPED`/`DELIVERED` AND card is NOT in a "TO BE SHIPPED" list) |

### Archive Process
1. Read all SHIPMENTS rows
2. Identify rows meeting archive criteria
3. Copy qualifying rows to `Shipment_History` tab (with `Date Archived` prepended)
4. Remove archived rows from SHIPMENTS using clear-and-rewrite pattern
5. Skip cards already in Shipment_History (deduplication via Set)

### Shipment_History Schema (11 columns)
| Col A | Col B | Col C | Col D | Col E | Col F | Col G | Col H | Col I | Col J | Col K |
|-------|-------|-------|-------|-------|-------|-------|-------|-------|-------|-------|
| Date Archived | Card ID | Direction | Board Source | Entity/Store | Transit Mode | Scheduled Date | List Status | Line Items | Master Tracking # | Rollup Status |

> [!IMPORTANT]
> The sync function checks `existingHistoryCards` BEFORE inserting new shipment rows. Cards that are in Shipment_History will NOT be re-added to SHIPMENTS. This prevents "zombie cards" from resurrecting after archival.

> [!NOTE]
> **This is status-driven archival only** — a card must reach a recognized terminal `rollupStatus`/list state to qualify. A card that's simply **deleted from Trello outright**, without ever passing through a done list, does NOT meet any of the criteria above and is invisible to this function. That gap is what Section 11A's `pruneDeletedShipmentCards_()` (added 2026-08-13) exists to close — it's a second, independent archival path with its own criterion (card no longer exists on its source board at all), running immediately after this function in the same sync cycle.

---

### 11A. Deleted-Card Pruning & Historical Tagging (Added 2026-08-13)

**The problem.** `archiveCompletedShipments()` (above) only fires when a card's Trello list or rollup status says it's done. A card **deleted outright from Trello** — never moved to a Received/Done list first — never trips that condition, so its SHIPMENTS row sat forever showing a stale in-progress status with a Trello link that 404s. Confirmed live 2026-08-13 with a Purchase Orders board card whose `entityName` had also gone blank (predating later parsing fixes), rendering in the Inbound queue as the generic `"STAGED ORDER"` placeholder with nothing to distinguish it from a real order — and, worse, its checklist quantities kept counting toward the Inbound Report's `Expected`/`Received` totals indefinitely (Section 4E), since nothing ever removed the row.

**Part 1 — `pruneDeletedShipmentCards_(liveCardIdsByBoard, boardsFullyProcessed)`** (`syncAllBoardsToShipmentsTab.js`), called immediately after `archiveCompletedShipments()` in Phase 3 of every sync run:

1. While `syncAllBoardsToShipmentsTab()` fetches each board's cards (Phase 1), it now also builds `liveCardIdsByBoard[boardName]` — the full set of card IDs actually seen on that board this run — and adds the board to `boardsFullyProcessed` **only if its card loop finished without hitting the execution-time budget** (`isTimedOut`).
2. After the normal sync/archive passes, this function walks every remaining SHIPMENTS row. For any row whose `boardSource` is in `boardsFullyProcessed` and whose `cardId` is **not** in that board's `liveCardIdsByBoard` set, the card is gone from that board's live open-card fetch — it's archived to `Shipment_History` (same safe copy-then-clear pattern as `archiveCompletedShipments()`, never a hard delete), and its SHIPMENTS row is removed. As of 2026-08-14, the `rollupStatus` written isn't always the literal string `"CARD DELETED FROM TRELLO"` anymore — see `resolveVanishedCardStatus_()` below.
3. **Guardrail**: a board that was skipped by a fetch error, or cut off mid-fetch by the sync's execution-time budget, has an incomplete `liveCardIds` set for that run — treating "not seen yet" as "deleted" on an incomplete board would wrongly prune live cards this run simply didn't reach. `boardsFullyProcessed` exists specifically to prevent that false positive; a board not in that set is skipped entirely by this function, every run, until it completes a full pass.

> [!NOTE]
> **`resolveVanishedCardStatus_(cardId, direction, creds, knownBoardIds)` (added 2026-08-14).** "Missing from the open-card fetch" used to always mean `"CARD DELETED FROM TRELLO"`, but confirmed with the user their actual completion workflow is: check the Trello due-date checkbox (what they consider "marking complete" — note this checkbox, `dueComplete`, is otherwise never read anywhere in this codebase, it's a pure UI signal to the user), manually move the card to a Delivered list, then archive/close the card in Trello once they're done with it. That last step makes the card vanish from `filter=open` exactly like a genuinely deleted card would, so a **successfully completed shipment was being permanently mislabeled as lost data**. This function does one extra `GET /1/cards/{id}?fields=closed,idBoard` per vanished card (bounded — only cards that actually left a board this run, not the whole board) to tell the cases apart before writing the history row's status:
> - Fetch fails (404/error) → truly gone → `"CARD DELETED FROM TRELLO"` (unchanged behavior).
> - Fetch succeeds, `closed: true` → archived by a human, not deleted → `"RECEIVED"` (inbound) or `"DELIVERED"` (outbound) — the correct terminal status, matching what `archiveCompletedShipments()` would have written if the human had left the card open in a recognized Received/Delivered list instead of archiving it directly.
> - Fetch succeeds, `closed: false`, `idBoard` not one of the 4 known boards (`getBoardMatrix_()`) → still open, just moved somewhere this app doesn't track → `"MOVED OFF TRACKED BOARD"`.
> - Anything else (including missing Trello credentials) → falls back to `"CARD DELETED FROM TRELLO"`, same as before this fix.
>
> All four outcomes still go through the same `historical: true` tagging in Part 2 below, so none of this changes whether the row is treated as done — only whether the record itself, and the "N cards deleted" framing a human reading `Shipment_History` sees, is accurate.

**Part 2 — `historical: true` tagging** (`Service_Read.js`, `buildLogisticsDashboardPayload_()`). `Shipment_History` rows are folded back into the live dashboard payload (`inbound`/`outbound` arrays — Section 14) so the Control Tower's "Show Completed" toggle has something to display. But a history-sourced record's preserved `rollupStatus`/`listStatus` text is whatever it was the moment it got archived — for `pruneDeletedShipmentCards_()` rows, that's the new `"CARD DELETED FROM TRELLO"` string; for older archived rows it can be a stale in-progress status like `"Ordered"` — and neither is a string `isItemCompleted()` (`JS_Handlers.html`) or the Inbound Report's own status parsing recognized as "done." Left alone, a `Shipment_History` record kept rendering as an **active** row (the same misleading `"STAGED ORDER"` placeholder) and kept contributing to the Inbound Report's `Expected`/`Received` totals forever — the exact same symptom Part 1 was built to fix, just re-introduced by folding history back into the live view.

**Fix**: every record built from a `Shipment_History` row is stamped `historical: true` in the payload (`Service_Read.js`). Two consumers now check it, both **before** any status-string logic runs:
- `isItemCompleted(item, isOutboundOverride)` (`JS_Handlers.html`) — `if (item.historical) return true;` is the first line of the function. A historical record is unconditionally treated as complete/terminal, regardless of what its preserved status text says. This also feeds the Section 5A outbound demand aggregator's exclusion guardrail, so a historical outbound record can't inflate outstanding demand either.
- `renderInboundReportModal()`'s per-order loop (`JS_Render_UI.html`) — `if (order.historical) return;` skips the record entirely before origin classification (Section 4E) or quantity parsing even run, so it can never reach `itemMap` (the Expected/Received totals) or the non-local reference list.

> [!IMPORTANT]
> **This is a distinct filter from Section 4E's local/non-local classification, applied earlier in the same function.** A record can be historical-and-local, historical-and-non-local, active-and-local, or active-and-non-local — `historical` is checked and short-circuited on first, so a historical record never reaches origin classification at all. If you're tracing why a specific order isn't appearing in either the counted totals or the non-local reference list, check `historical` before assuming a Section 4E classification bug.

---

## 12. Trigger & Timing Architecture

| Trigger | Function | Frequency | Time Budget |
|---|---|---|---|
| Time-driven | `syncAllBoardsToShipmentsTab()` | Configurable (likely every 15-30 min) | 4.5 min stopwatch |
| Time-driven | `runMPSDiscovery()` | Every 10 min | 4.0 min stopwatch, max 15 masters/run |
| Time-driven | `runMPSBatchAndReassemble()` | Every 3 hr | 4.0 min stopwatch, max 120 boxes/run |
| Time-driven | `keepRenderAwake()` | Every 5 min | Instant (HEAD ping) |
| Time-driven | `runBurlingtonSyncOnly()` | Every 1 hr (`createTimeDrivenTriggers()`, `pushOutboundToShippingSchedule.js`) | No explicit limit |
| Time-driven | `runAeoSyncOnly()` | Every 1 hr (same trigger setup) | No explicit limit |
| Webhook (POST) | `processWebhookPayload()` | Real-time (Trello events) | ~1-3 seconds |
| Manual (Menu) | `runLiveBatch()` | User-triggered | No explicit limit |

### Execution Chain
```
syncAllBoardsToShipmentsTab()
  +-- evaluateRollupStatuses()      <- Called at end of sync
  +-- archiveCompletedShipments()   <- Called at end of sync
  +-- pruneDeletedShipmentCards_()  <- Called immediately after archival (Section 11A, added 2026-08-13)
  +-- warmLogisticsDashboardCache() <- Called at end of sync

runMPSDiscovery()
  +-- warmLogisticsDashboardCache() <- Called after write

runMPSBatchAndReassemble()
  +-- evaluateRollupStatuses()      <- Called after reassembly
  +-- warmLogisticsDashboardCache() <- Called after write
```

---

## 13. Webhook Real-Time Pipeline

```
Trello Card Event
  |
  v
Render.com Proxy Server <- Receives POST from Trello
  (https://trello-webhook-server-763h.onrender.com/trello-webhook)
  |
  v
Google Apps Script doPost(e)   <- Webhook_Receiver.js:2 — CONFIRMED LIVE (see note below)
  |
  +-- Parse payload
  +-- 3-second debounce lock (CacheService per cardId)
  +-- processWebhookPayload(payload)
  |     +-- Extract card data from payload (no extra API calls for outbound —
  |     |    UNLESS the webhook action type itself contains "Check", in which
  |     |    case a checklist-update event fetches checklists regardless of
  |     |    direction)
  |     +-- For Inbound (or any "Check*" action type): Fetch checklists via Trello API (1 call)
  |     +-- Compute rollup status (mirrors sync's logic, including the
  |     |    isFullyPacked RECEIVED fallback — see Section 7's Writer 2 note;
  |     |    kept in sync manually, not shared code, so re-verify after
  |     |    touching either file's status-assignment block)
  |     +-- Upsert to SHIPMENTS
  |     |     +-- If card exists: Update row (preserve non-pending rollup)
  |     |     +-- If new card: Append (skip if card is in completed list)
  |     +-- warmLogisticsDashboardCache()
  |
  +-- Return "OK - Processed"
```

> [!IMPORTANT]
> The webhook version has an **idempotency check** — if the row data hasn't changed, the write is skipped entirely. This prevents unnecessary cache warming cycles.

> [!NOTE]
> ### RESOLVED (2026-08-11, re-confirmed 2026-08-12): the `doPost` collision (formerly P0-1)
> Both `Service_Router.js` and `Webhook_Receiver.js` used to define a top-level `doPost(e)` — a genuine Apps Script global-namespace collision, since only one wins based on file load order in the editor (not visible from local source, not something a `git diff` would ever show you). This is now resolved and explicitly documented in the code itself:
> - **`Webhook_Receiver.js:2`** still defines `doPost(e)` under its original name. Confirmed live: it's the last file in the Apps Script editor's file order as of 2026-08-11.
> - **`Service_Router.js:74`** — the file's own former `doPost` was renamed to `legacyDoPost_(e)`, with an explicit block comment (`Service_Router.js:61-73`) stating why, warning against renaming it back, and pointing at this exact collision as the reason. Its helper `processWebhookPayload` was similarly renamed to `legacyProcessWebhookPayload_` (`Service_Router.js:113`), kept only in case old logic needs to be diffed against later — not deleted outright.
>
> If you ever see a "duplicate doPost" bug report again, or a webhook stops firing after an edit to either file, re-check this exact mechanism first — it's a silent-failure class of bug by design (Apps Script gives no warning on the collision), so it can recur if either rename is ever undone without touching the other file.

> [!NOTE]
> ### RESOLVED (fix shipped before 2026-08-13; repair for pre-fix rows added 2026-08-13): webhook direction misresolution for inbound boards
> `Webhook_Receiver.js`'s direction resolution used to infer a card's `direction` by checking whether the *live Trello board name itself* contained the substring `"inbound"` or `"receiving"` — but none of the four real board names (Section 2) contain either word, including the two genuinely-inbound ones (`Purchase Orders`, `Nicole POs`). The practical effect: **every** webhook-driven update to a Purchase Orders or Nicole POs card was written to SHIPMENTS column B as `"Outbound"`, regardless of the board it actually came from. This board-name-substring check has already been corrected in the current `Webhook_Receiver.js` (direction is resolved the same way the scheduled sync does — via the hardcoded `boardMatrix`, Section 2 — not by sniffing the board name string), so **new** webhook writes are no longer affected.
>
> Rows written by the buggy version before the fix landed were left mis-tagged, though — leaking real inbound POs into the outbound Shipping Report. `fixMisdirectedInboundRows(dryRun)` (`Setup_Registry.js`, added 2026-08-13 — see Section 19) is the one-off repair: it scans SHIPMENTS for rows where `boardSource` matches one of the two known inbound board names but `Direction` (column B) reads `"Outbound"`, and corrects just that column. Defaults to a dry run (logs every mismatched row, writes nothing); pass `false` to apply. Confirmed run live against a real Burlington PO card that had been sitting in the Outbound Shipping Report as a result — 3 rows fixed in that run. Only ever touches column B; every other column is left as-is.

> [!WARNING]
> ### Dead webhook-registration code in `migration.js` — includes a hardcoded live-looking credential
> `migration.js` contains two more Trello-webhook registration functions that are NOT the canonical path (`Webhook_Receiver.js`'s `setupWebhooksForAllBoards()`, which correctly points at the Render.com proxy in the diagram above):
> - **`registerWebhookDirectly()`** (`migration.js:12-36`) registers a webhook pointing directly at the Apps Script `/exec` URL (bypassing the Render proxy entirely — inconsistent with the documented pipeline) for the Burlington board only. It also contains a **hardcoded Trello API key and token in plaintext** (`migration.js:13-14`). If this repository is ever shared, committed to a less-private location, or given wider access, that credential should be **rotated in Trello immediately** and the literal values removed from the file (e.g. replaced with `PropertiesService.getScriptProperties()` lookups, matching the pattern already used everywhere else in this codebase, including in this same file's own `TRELLO_KEY`/`TRELLO_TOKEN` usage elsewhere).
> - **`createTrelloWebhook()`** (`migration.js:84-108`) also targets the raw `/exec` URL and uses placeholder strings (`"TRELLO_KEY"`, `"ORGANIZATION_ID"`) — non-functional as written, not a live risk, but dead/misleading code.
>
> Neither function appears to be called anywhere else in the codebase (confirmed by search) — they look like one-off setup scripts from before the Render proxy pattern was adopted. Recommend removing both once confirmed unused, or at minimum stripping the hardcoded credential from `registerWebhookDirectly()`.

---

## 14. Data Payload Contract (Client to Server)

> [!NOTE]
> **Per-card ".ignore" (added 2026-08-14).** A Trello card labeled `PORTAL: IGNORE` (case-insensitive, `isCardIgnored_()` in `Shared_Classifiers.js`) is excluded from this payload entirely, as if it doesn't exist — un-ignore is just removing the label. Implementation: `formatInboundLineItems()` / `formatOutboundLineItems()` (`Webhook_Receiver.js`, `syncAllBoardsToShipmentsTab.js`) stamp a `PORTAL_IGNORED_MARKER` (`"[PORTAL_IGNORED]"`) at the start of the `summary` column when the label is present; `buildLogisticsDashboardPayload_()` (`Service_Read.js`) filters any row carrying it out before it reaches the client, same mechanism as the existing `Archived/Deleted` filter just above it in that function. The SHIPMENTS row itself — and its K-R readiness/ETA data — is never written to, deleted, or archived either way, so nothing is lost when a card is un-ignored.
>
> **Known gap:** Trello's real-time webhook payload (`action.data.card`) doesn't reliably include the full current label set for every action type — only for label-add/remove actions and some `updateCard` actions. A card ignored via label may not have the marker applied until the next full `syncAllBoardsToShipmentsTab()` run picks it up with a fresh, complete card fetch (`fields=...,labels,...`). The same gap already existed for the inbound origin classifier's label pass-through (Section 4E) — this isn't a new risk, just inherited by a second feature now.
>
> **Real bug found and fixed 2026-08-17: the `.ignore`/`.unignore` comment trigger had no backfill/catch-up path.** Confirmed live: a card ("Timing - Boot & Sleeve Count," Nicole POs) had a clean `.ignore` comment posted 2026-08-14 — the same day this feature shipped — that never took effect; the card kept showing on the dashboard indefinitely with no error anywhere. Unlike the READY/PORT feature (which has `backfillReadyPortFromComments_()`, `Service_Dates.js`, wired into every scheduled sync specifically to catch whatever its real-time webhook missed — see Section 4F), the `.ignore` comment trigger shipped with **no equivalent**: if the real-time `commentCard` webhook ever missed a declaration (posted before that day's deploy landed, a dropped delivery, the 3-second debounce lock in `doPost` colliding with another webhook for the same card, a mid-request execution error), it was lost permanently with no recovery path except noticing and re-posting the comment by hand. Fixed with a new `backfillIgnoreCommentsFromComments_()` (`Shared_Classifiers.js`) — same design as its READY/PORT counterpart (scans each card's comments for the newest `.ignore`/`.unignore`, reconciles the label if it disagrees with the row's current marker state), but **manually run, not wired into the automatic periodic sync** — checking comments costs one extra Trello API call per card, and `.ignore` is a rare, deliberate action, not worth paying that cost every sync cycle the way an open PO's READY/PORT date is. Run it from the Apps Script editor whenever a `.ignore`/`.unignore` comment doesn't seem to have taken effect; safe to re-run.

`getLogisticsDashboardData()` returns this JSON structure to the browser:

```javascript
{
  inbound: [
    {
      cardId: "abc123",           // Trello card ID
      direction: "Inbound",
      boardSource: "Purchase Orders",
      entityName: "Supplier Name",
      transitMode: "Ocean Freight",
      scheduledDate: "08/10/2026",
      listStatus: "IN TRANSIT",
      summary: " * Item 1\n * Item 2",
      masterTracking: "875021925761",
      rollupStatus: "ON THE WAY",   // buildLogisticsDashboardPayload_() always
                                     // .trim().toUpperCase()s this before it
                                     // reaches the client — the client never
                                     // sees the Status Value Table's mixed-case
                                     // literals (e.g. "Received and Drops Off"
                                     // arrives as "RECEIVED AND DROPS OFF").
      historical: false,          // true only for Shipment_History-sourced
                                   // records (added 2026-08-13) — see
                                   // Section 11A. Absent/false for every
                                   // live SHIPMENTS-sourced record.
      // Section 4F Readiness/ETA state machine fields (SHIPMENTS cols K-R,
      // inbound only) — always present alongside the fields above, omitted
      // from this example previously:
      readyToShipDate: "08/12/2026",
      readyToShipBasis: "Port Comment",
      etaDate: "08/20/2026",
      etaBasis: "Transit Lane Table",
      dateState: "READY",
      portOfArrival: "Ontario (GTA)",
      etaOverridden: false
    }
  ],
  outbound: [
    // Same structure but direction = "Outbound" (historical applies here too)
  ],
  stagedLedger: [
    {
      storeName: "Burlington Store",
      storeNum: "1234",
      direction: "Outbound",
      masterTracking: "875021925761",
      entityName: "Burlington Store #1234",
      boardSource: "Multi Piece Tracking",
      rollupStatus: "Active - 5 Pieces"
    }
  ],
  childBoxes: {
    "875021925761": [
      { status: "Delivered - 08/05/2026", tracking: "794644790553" },
      { status: "In Transit", tracking: "794644790554" }
    ]
  },
  packingSpecs: {
    "PRODUCT_NAME": 24  // units per case
  }
}
```

> [!IMPORTANT]
> **`historical` (added 2026-08-13) is stamped only in `buildLogisticsDashboardPayload_()`'s `Shipment_History` branch** (`Service_Read.js`) — it is never set to `true` for a record built from a live SHIPMENTS row, and the field is simply absent (falsy) on those. Client code must treat `undefined`/missing the same as `false`, never assume the key is always present. See Section 11A for the two consumers (`isItemCompleted()`, `renderInboundReportModal()`) and exactly what this flag suppresses.

### Cache Architecture
- **Cache Key**: `LOGISTICS_DASHBOARD_PAYLOAD_V2`
- **TTL**: 6 hours (21600 seconds — Google Apps Script max)
- **Chunking**: Payloads > 90KB are split across multiple CacheService keys (`_0`, `_1`, etc.)
- **Warm Points**: Called after every sync, discovery, batch, and webhook

---

## 15. All Google Sheets Tabs and Column Maps

### SHIPMENTS (18 cols, A–R) — See Section 3

### Multi Piece Tracking (25+ cols)
| A | B | C | D | E | F | G | H | I | ... |
|---|---|---|---|---|---|---|---|---|-----|
| Store Name | Store # | Direction | Master Tracking # | Discovery Status | Box 1 Status | Box 1 Tracking | Box 2 Status | Box 2 Tracking | ... |

### MPS Backend (4 cols, hidden)
| A | B | C | D |
|---|---|---|---|
| Master Tracking | Child Tracking | Status | Last Checked |

### Shipping_Time (4 cols, auto-created) — See Section 8's Engine 4 subsection
Origin/destination ZIP → transit-days cache for the Batch Shipping Schedule Estimator. `A` Origin ZIP, `B` Destination ZIP, `C` Transit Days, `D` Date Added.

### Shipment_History (11 cols) — See Section 11

### Inventory (7 cols)

> [!CAUTION]
> This table was corrected 2026-08-11 against actual source (`Service_Write.js`, `Service_Assembly.js`, `migration.js`). The previous version of this doc documented 6 columns (D = Date Stocked, E = Rack Zone) that do not match what the code actually reads/writes — this is exactly the kind of undocumented drift the `[!CAUTION]` banner at the top of this file warns about.
>
> **Updated 2026-08-20:** `getAllInventory()` returns 8 array elements per row, not 7 — see the table below. Indices 0–6 are the sheet's 7 real columns (A–G) as before; index 7 is a NEW, purely additive field (not a sheet column of its own) carrying column G's real value a second time, for reasons explained in that row.

| Array Index | Sheet Column | Field Name | Description |
|--------|--------|------------|-------------|
| 0 | A | `locId` | Location code (e.g. rack/slot ID, or `ZONE-BUFFER` for Limbo) |
| 1 | B | `sku` | **The product's IDENTITY, not its display name — as of 2026-08-26, this holds the PRODUCT sheet's own column-A text (the Product ID), not the nickname.** From 2026-08-11 through 2026-08-26, `receivePOCardItems()` wrote the nickname here instead (Section 4D's original pipeline) — a mutable display label doing duty as a row's identity, which is what broke name matching, `findCaseConversion_`, and rename-safety; see the v16 changelog entry and Section 17 invariants #67–#69. `resolveCanonicalProductId_()` (`Shared_Classifiers.js`) is what receiving writes now; `getNickname()` (`JS_Handlers.html`) is the ONLY place a nickname should ever reach the UI, resolving ID→nickname at render time. `migrateInventoryToProductIds()` (`Setup_Registry.js`) backfilled rows written during the nickname window, skipping any row `Assemblies` matches on by exact string (Section 18). Also holds the literal string `"Vacant"` for an empty slot, or — for a row that resolves to no product at all (a one-off label like `"H Rack"`, or an assembly-parent aggregate not itself a PRODUCT row) — arbitrary free text, unchanged and untouched by any of the above. |
| 2 | C | `qty` | Quantity at this location |
| 3 | D | `resTag` (reservation/status tag) | e.g. `"Open"` (default, and — **fixed 2026-08-26** — also what `receivePOCardItems()` now writes on receipt into `ZONE-BUFFER`, having previously written the literal string `"PO_RECEIVED"` here; nobody works this column by hand and a special received-only status meant freshly-received Limbo stock silently read as "staged" to any code testing `status !== "Open"`, e.g. `generateLocalTotals()` in `JS_Handlers.html`. The PO/receipt trail lives in the comment column (F) instead — see the `receivedNote` in that row below — and `Audit_Log` still gets its own `PO_RECEIVED` **action** entry, which is unrelated and unaffected: that's the aging anchor `getAgingData()` needs, see invariant #30.), `"Staging"`/`"Staged"`/`"Labeled"` (the Adjust popup's Workflow Status dropdown, `JS_Handlers.html`). **Not a date**, despite the field name previously documented here. |
| 4 | E | `softKitTag` | A kit/bulk-hub type flag: `"None"` (default) or similar. **Fixed 2026-08-25**: `receivePOCardItems()`'s Limbo insert used to write an actual `Date` object (`now`) into this column instead of `"None"` — a real inconsistency, not a documentation gap. Every write site across `Service_Write.js`/`Service_Assembly.js`/`migration.js` was re-audited against this; `receivePOCardItems()` was the only one that had it wrong. This column can now be trusted to always hold the flag string. |
| 5 | F | `comment` / notes — **dual-purpose** | Free-text notes (e.g. `"RCVD from <cardName> on <MM/dd/yyyy HH:mm>"` — the receipt timestamp moved here as part of the same 2026-08-25 fix, since column E couldn't hold it), OR a JSON blob for assembly/kit metadata, appended after a literal `" _SYS_ "` marker (e.g. `"<note> _SYS_ {"t":"B","p":"...","f":{...}}"`). Code detects which by checking `comment.includes('_SYS_')`. |
| 6 | G, but NOT the real value — see index 7 | `rowIdx` (a row NUMBER, not `instanceId`) | **This is `idx + 2` (the row's current sheet position), not column G's actual content.** `setTotalStockByRow()` and several `onclick` handlers (`JS_Render_UI.html`) rely on this being a literal row number — some interpolate it unquoted into inline JS, where a real UUID's hyphens would parse as subtraction and break the handler outright. `Service_Write.js`'s dual-mode functions (`modifySheetRow()`, `moveInventoryItem()`) branch on `typeof` specifically to accept either this row number OR a real instanceId string here, but the client only ever sends the row-number form via this index. |
| 7 | G (real value) | `instanceId` | The row's actual persistent UUID (`Utilities.getUuid()`) from column G. **Added 2026-08-20** — before this, `getAllInventory()` silently never returned column G's real content at all (index 6 above always held the row-number substitute, both before and after this fix), which broke anything trying to match a row by its true identity: confirmed live as the cause of Master Hub Frame-suppression never triggering (`JS_Render_UI.html`, Section 18) and very likely also the reason `moveHubGroup()`'s group-move silently moved nothing server-side, since the client had no real instanceId to send it either. Populated on every current insert path (`addNewItemToLocation`, `receivePOCardItems`, `Service_Assembly.js` frame/child minting) and, as of 2026-08-11, correctly carried forward by `moveInventoryItem()` on a full-row move (fresh UUID minted instead for a partial-quantity move, since the source row survives as a distinct remainder — see invariant below). |

> [!WARNING]
> **`_SYS_` JSON in column F is order-dependent parsing, not a real schema.** Anything writing column F must preserve the `<free text> _SYS_ <JSON>` shape exactly, and anything reading it must always try/catch the `JSON.parse()` — several call sites already do (`removeItemFromLocation`, `moveInventoryItem`, `Service_Assembly.js`), but this is a fragile convention, not a structured column. Do not add a second delimiter convention without updating every reader.

#### `locId` prefixes and the TIMING/RTF "virtual lot" exclusion (fixed 2026-08-12)

`locId` isn't a flat namespace — the prefix determines whether a row is physically on the CIS floor:

| Prefix | Meaning |
|---|---|
| `PWH-*`, `SWH-*`, `PP-*` / `PANDP-*` | Real physical rack/bin locations — the three local warehouses. |
| `ZONE-BUFFER` | Limbo — physically received but not yet put away. Counts as on-hand (it's really here). |
| `TIMING-*`, `RTF-*` | **Virtual lots — not physically at the CIS warehouse, not locally fulfillable.** Both are labeled `(Virtual)` in the app's own warehouse-context menu (`Index.html`). Per the live `CUSTOMER_REGISTRY` sheet, `RTF` specifically holds TJX Canada's inventory (Winners / Homesense CA / Marshalls CA — `Handling_Type: "Stored at RTF"`); `TIMING` is a separate virtual staging lot. All items landed here via the Virtual Registry's "stow anywhere" flow (`commitVirtualStowAction()` → `<warehouse>-OVERFLOW`), never through the real floor maps. |

> [!CAUTION]
> **`getInventoryTotals()` (the "Arbitrated Totalizer", `Service_Read.js`) previously summed TIMING and RTF into `total`/`available`/`staged`/`committed`, silently counting non-local, non-fulfillable stock as On Hand.** Fixed 2026-08-12: rows whose `locId` starts with `TIMING` or `RTF` still accumulate into their own `timing`/`rtf` fields (for anyone who wants visibility into virtual-lot volume specifically — this is also how `generateLocalTotals()` in `JS_Handlers.html`, the TOTALS view's client-side totalizer, has always kept them: as fully separate pools, never merged into a grand total), but are now excluded entirely from `total`, `available`, `committed`, and `staged`. Verified against the live workbook snapshot (`CIS INVENTORY (4).xlsx`, 2026-08-12): 17 SKUs and 109,432 units were being wrongly counted as on-hand before this fix, some (e.g. `PIN TIP PADLOCKS`, `H RACK`) existing *only* virtually with zero real physical stock. This is the same bucket-discipline principle as the earlier `PO_RECEIVED`/staged fix above this table — don't let a status or location that isn't "really here and free to ship" leak into the numbers that drive On Hand.
>
> **Open question, not yet resolved:** a `CUSTOMER_REGISTRY` row exists for `TJX AU` (`Warehouse_Type: "Customer Warehouse"`, `Handling_Type: "Sold to TJX AU and fulfilled/stored by CREDO"` — a third-party fulfillment house, not CIS). Unlike TIMING/RTF, there is no `locId` prefix marking TJX AU-linked stock, so if/when it's ever received into a normal local `locId`, this fix would NOT catch it — Inventory rows carry no customer/brand association at all today, so there's no mechanism to cross-reference a row against `CUSTOMER_REGISTRY`'s `Warehouse_Type`. As of this pass, no Inventory rows reference Australia/Canada by name and the only Australia-named PO in `SHIPMENTS` (`CIS PO 3588 - Celine Australia`, Nicole POs board) is still status `Ordered` with nothing received — so this isn't manifesting in live data yet, but it's a real gap if TJX AU stock is ever physically received and stowed under a normal `locId`.

#### Move Destination Validation & the Floor-Plan Coordinate Scrape (added 2026-08-21)

`moveInventoryItem()`/`moveHubGroup()` (`Service_Write.js`) reject any move destination that doesn't match an existing Inventory row (case-insensitively) or a recognized virtual zone (`ZONE-BUFFER` — `ZONE-STAGED` removed 2026-08-27, see Section 17 invariant #75) — added so a free-text destination field with no enforced dropdown couldn't silently mint a phantom location row on a typo/stray-whitespace/case mismatch. This is deliberately stricter than "does this look like a real locId string."

The set of **real** physical coordinates — every rack/section/level slot on the actual floor plan, whether or not anything has ever been stowed there — is never written to a sheet at all; it's scraped live off the floor-plan SVGs' element `id` attributes by `harvestSymmetricLayoutStructures()` (`JS_Render_Core.html`, called from `JS_State.html`'s `onload`), into `window.scrapedSwhSlots`/`scrapedPwhSlots`/`scrapedPpBins`. This is also what backs the move-destination `<datalist>` (`populateLocationDatalist()`). The scrape has several deliberate exclusions, not incidental noise:
- Group/container ids (e.g. `PWH-PandP-RACKA`, `SWH-RACKA-SEC-04`) are excluded — these represent an entire rack or an entire section, not one addressable slot, and were added to the SVG for layout/visual grouping only. Only the leaf level-slot ids (matching `[-=_]L-\d+`, e.g. `SWH-RACKA-SEC-04-L-01`) are real, individually-stowable coordinates.
- `LAYOUT`/`WALLS`/`BG`/`BACKGROUND`/`LABEL`/`ROLLING`-named elements are excluded as pure SVG decoration, never locations.

**The bug this caused:** a coordinate that's genuinely real (on the floor plan, matches the scrape) but has *never* received anything — so it has no Inventory row at all, not even a `"Vacant"` placeholder — was rejected identically to an actual typo, since the validation only ever checked "does a row exist for this." Fixed by threading a client-computed `isKnownFloorCoordinate(toLoc)` check (`JS_Handlers.html`) through `executeMove()`/`executeGroupMove()` as a new final argument on both server functions: a destination with no existing row is now allowed through (a fresh row gets appended) if the client confirms it matches the scraped slot lists, and still rejected if it doesn't. This deliberately trusts a client-asserted flag rather than re-deriving the scrape's exclusion rules in Apps Script (no DOM to scrape server-side, and the exclusions above are fiddly enough that keeping two independent copies in sync is its own risk) — acceptable because this validation has only ever been typo protection on an internal single-tenant tool, not a security boundary.

### TOTALS (4 cols)
| A | B | C | D |
|---|---|---|---|
| Category | Count | Unit | Last Updated |

### PRODUCT (3 cols)

> [!CAUTION]
> **Corrected 2026-08-26.** This table previously listed 6 columns (A–F: Product ID / Product Name / SKU / Category / UPC / Notes) that do not match `getProductMap()` (`Service_Read.js`), the only reader of this sheet. Only 3 columns are ever read.

| A | B | C |
|---|---|---|
| Product ID (full QuickBooks name) | Nickname | Barcode |

- **Column A** is the canonical identity — the full QuickBooks name, e.g. `NT525S/2AMF (2 Alarm SMALL Scorpion Tag)`. This is what `Inventory` column B now stores (Section 15's Inventory table, Section 4D) and what `Assemblies` matches against by exact string equality (Section 18).
- **Column B, Nickname**, is display-only — short enough to read in a selector, where column A's often-84-character QuickBooks text is not. `getNickname()` (`JS_Handlers.html`) is the only place it should enter the UI. Falls back to column A when blank; a blank nickname means the row is a QuickBooks item that isn't stocked/purchased/sold locally, which is deliberate, not a gap to fill.
- **Column C, Barcode**, is read into `getProductMap()`'s entries but has no confirmed consumer in this codebase as of 2026-08-26 — unverified, not dead-flagged.

### Transit_Time (14 cols, +Q/R — Added 2026-08-17, consumed by `getTransitTimeTable_()`/`findTransitLane_()`, Section 4G)
| A | B | C | D | E | F | G | H | I | J | K | L | M | N |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Origin | Destination | Travel_Type | Load_Type | Season | Port | Port_Keyword | Collection_Days | Port_to_Port_Days | Port_Dwell_Days | Customs_Days | Delivery_Days | Parent_Account | Total_Est_Days |

Plus two hand-added cells outside the main table: `Q1` = header text `"Peak_Start_Date"`, `R1` = header text `"Peak_End_Date"`, with the actual dates one row below in `Q2`/`R2` (live value: Aug 15 – Nov 15, month/day only — see `getPeakSeasonWindow_()`, Section 4G). `Total_Est_Days` (N) is a straight sum of H–L, verified against live data — not business-day-adjusted the way the older Config-sheet port math (this section, above) is.

### Delivery_Address (4 cols — Added 2026-08-17; `Address` col consumed since 2026-08-25 by `getEstimatorRtfOriginZip()`, see Section 9A; `Destination` col consumed since 2026-08-27 by `getDeliveryDestinationCatalog_()` — the guided-RTS/estimator Destination picker, Section 4G)
| A | B | C | D |
|---|---|---|---|
| Customer | Destination | Address | Status |

`Destination` (B) values are matched **exactly** (upper-cased, trimmed) against `DELIVERY_DESTINATION_CLUSTERS` in `Service_Dates.js` to place each dock in a `Transit_Time` cluster — add a key there when a row is added here, or it's silently left out of the picker (and logged).

### Order Process (8 cols — Added 2026-08-17, not yet consumed by any code)
| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| Employee | Account | Parent_Account | Action | Produced | Shipped | Received By | Fulfilled By |

### Assemblies (4 cols) — Kitting Recipes

> [!CAUTION]
> Corrected 2026-08-12 against actual source (`getAssemblyData()` in `Service_Assembly.js`). This table previously documented generic-sounding columns (`Assembly Name`/`Components`/`Qty Per Assembly`/`Notes`) that don't match what the code reads. See Section 18 for the full assembly/kitting system this feeds.

| Column | Letter | Field | Description |
|--------|--------|-------|-------------|
| 1 | A | `parent` | The finished/kitted SKU (must match a `sku` value used elsewhere, e.g. in Inventory or PRODUCT) |
| 2 | B | `component` | A raw-material SKU consumed to build one unit of `parent` |
| 3 | C | `qtyPer` | How many units of `component` are needed per single unit of `parent` (defaults to 1 if blank/non-numeric) |
| 4 | D | `type` | `"Affixed"` (default if blank) — permanently attached component, always pulled from the same location as the build. `"Loose"` or `"Bulk"` — a component sourced from a separately-specified bulk-hub location at build time (see `bulkAllocationsPayload` in Section 18) |

One `parent` SKU can have multiple rows (one per component) — `getAssemblyData()` filters all rows where `parent` matches the requested SKU to reconstruct the full recipe.

### HTS_Data (8 cols)
| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| HTS Code | Description | Duty Rate | Country | Product | Category | Notes | Last Updated |

### QB_Audits (5 cols)
| A | B | C | D | E |
|---|---|---|---|---|
| Date | Type | Reference | Amount | Status |

### Audit_Log (8 cols, not 7 — corrected 2026-08-12)

> [!CAUTION]
> This table previously documented a generic `Timestamp/User/Action/Target/Old Value/New Value/Notes` layout that does not match any actual `appendRow()` call in the codebase. Rewritten 2026-08-12 against every write site in `Service_Write.js` and `Service_Assembly.js` (confirmed identical column order across all of them: `addNewItemToLocation`, `removeItemFromLocation`, `setLocationTotal`, `modifySheetRow`'s ADD/REMOVE/SET_TOTAL branches, `moveInventoryItem`, `buildHardAssembly`, `explodeAssembly`).

| Column | Letter | Index | Field Name | Description |
|--------|--------|-------|------------|-------------|
| 1 | A | 0 | `timestamp` | `new Date()` at write time |
| 2 | B | 1 | `locId` | Location code the action occurred at (this is the log's own location context, e.g. the destination on a `MOVE_IN` row — NOT a generic "Target" column) |
| 3 | C | 2 | `sku` | Product/SKU the action applied to |
| 4 | D | 3 | `action` | One of: `STOW`, `INITIAL_STOW`, `PO_RECEIVED`, `ADD`, `REMOVE`, `SET_TOTAL`, `MOVE_IN`, `MOVE_OUT`, `VERIFIED`, `CONVERT_IN`, `CONVERT_OUT`, `EXPLODE_RESTORE`, `EXPLODE_REMOVE`, `HARD_DELETE`, `SPLIT_OUT`, `SPLIT_IN` (both added 2026-08-26 — `splitInventoryRow()`, `Service_Write.js`; see below and Section 17 invariant #66) |
| 5 | E | 4 | `qtyDelta` | The quantity involved in this specific action (not necessarily the resulting total — e.g. the moved quantity on `MOVE_OUT`/`MOVE_IN`, the adjustment amount on `ADD`/`REMOVE`) |
| 6 | F | 5 | `resultingQty` | The location's quantity AFTER this action, where meaningful (blank string on `MOVE_IN` — the destination's resulting qty isn't tracked per-row the same way) |
| 7 | G | 6 | `userEmail` | `Session.getActiveUser().getEmail()` at write time |
| 8 | H | 7 | `originalArrivalDate` | **Added 2026-08-11 on `MOVE_IN`, extended 2026-08-26 to `SPLIT_IN`.** ISO date string of the item's TRUE original arrival (from `resolveOriginalArrivalDate_()` in `Service_Write.js`), carried forward across moves *and splits* so `getAgingData()`/`calculateInventoryAgeDays()` (`Service_Read.js`, `JS_Handlers.html`) can report real dwell time instead of resetting to ~0 days every time an item is relocated or split. This is the fix for the aging/heatmap bug documented in Section 17 invariant #28 below — **do not remove this column or stop populating it on `MOVE_IN`/`SPLIT_IN`, the aging bug it fixes will silently return.** `SPLIT_IN`'s split-off row is the same physical lot as its source, so without this it would carry no arrival anchor at all (`buildAgingData_()`'s `validActions` had to include `SPLIT_IN` for the same reason — Section 17 #30) or read as freshly arrived. Blank/absent on every other action type; readers must treat a missing column H the same as "no original date available" and fall back to the row's own `timestamp`. |

### Live Tracking
Written by `runLiveBatch()`/`runLiveSelection()` (`Fedex_Master_Script.js`, `TAB_LIVE`) — see Section 8's Four Engines table. Listed here (added 2026-08-21) since this section's own heading promises "All" tabs and this one was previously only mentioned under Section 8.

### Config
Hand-maintained operational config sheet — the port lead-time table (Section 4F), plus (per the README's own note) a viewport diagnostic log and `STAKEHOLDER_EMAILS`, a known but not-yet-split-out mix of concerns. Read/written by `evaluateRollupStatuses.js`, `Service_Dates.js`, and `Service_Write.js`. Listed here (added 2026-08-21) for the same reason as `Live Tracking` above — it was previously only referenced in passing, never given its own entry in the "All tabs" section.

> [!NOTE]
> The Section 1 architecture diagram also names a **`Naming Conv` (5 cols)** sheet. No `.js`/`.html` file in this repo reads or writes a sheet by that name — the only reference anywhere is a passing mention in `Setup_Registry.js` (excluding it from a header-formatting pass). It may exist in the live spreadsheet as pure reference data with no code consumer, but the "5 cols" figure is unverified against any code path — treat it as unconfirmed until someone checks the live sheet directly.

---

## 16. Function Dependency Graph

```
SCHEDULED TRIGGERS
  syncAllBoardsToShipmentsTab()
    +-> formatInboundLineItems()
    +-> formatOutboundLineItems()
    +-> resolveTransitMode()
    +-> harvestFedExTrackingNumber()
    +-> extractStoreInfo()
    +-> evaluateRollupStatuses()
    |     +-> cleanTrackingNumber()
    |     +-> [Email Notification]
    |     +-> [Trello dueComplete API]
    +-> archiveCompletedShipments()
    +-> pruneDeletedShipmentCards_()  <- Added 2026-08-13, see Section 11A
    +-> warmLogisticsDashboardCache()
          +-> buildLogisticsDashboardPayload_()
                +-> [stamps historical:true on Shipment_History-sourced
                     records -- see Section 11A / Section 14]

  runMPSDiscovery()
    +-> fetchAssociatedShipments()
    |     +-> getBearerAuthorization()
    +-> fetchFastBatch()
    |     +-> getBearerAuthorization()
    +-> formatFedExStatus()
    +-> warmLogisticsDashboardCache()

  runMPSBatchAndReassemble()
    +-> fetchFastBatch()
    +-> formatFedExStatus()
    +-> evaluateRollupStatuses()
    +-> warmLogisticsDashboardCache()

WEBHOOK
  doPost()  [Webhook_Receiver.js:2 — confirmed live. Service_Router.js's
             former doPost is retired to legacyDoPost_(), see Section 13]
    +-> processWebhookPayload()
          +-> extractStoreInfo()
          +-> resolveTransitMode()
          +-> harvestFedExTrackingNumber()
          +-> formatInboundLineItems() / formatOutboundLineItems()
          +-> classifyListStatus()  [Shared_Classifiers.js]
          +-> warmLogisticsDashboardCache()

WEB APP
  doGet()  [Service_Router.js]
    +-> include() [HTML template loader]
    +-> getAllInventory()
    +-> getProductMap()
    +-> getAssemblyData()
    +-> getAgingData()
    +-> getHeatmapWindowThresholds()
    +-> getCustomerRegistry()
    +-> getBrandItemCatalog()
    +-> getTransitLaneCatalog()  <- precompiled as precompiledTransitLaneCatalog,
                                    added with the Section 4G v12 pass
                                    (2026-08-17) — this doc's dependency graph
                                    missed it until 2026-08-21

  getLogisticsDashboardData() [called by browser via google.script.run]
    +-> getLargeCache_()
    +-> warmLogisticsDashboardCache()
    +-> buildLogisticsDashboardPayload_()

  buildHardAssembly() / explodeAssembly()  [Service_Assembly.js — see Section 18]
    +-> getAssemblyData()
    +-> SS_API.batchUpdateValues() / batchAppendRows() / batchDeleteRows()
    |     [Service_SheetsAPI.js — Advanced Sheets API v4 batch wrapper, used
    |      when available for performance; falls back to per-cell/per-row
    |      SpreadsheetApp calls if SS_API is undefined (project failed to
    |      load Service_SheetsAPI.js) — NOT gated on the Advanced Service
    |      toggle itself, see Section 19's note on this exact distinction]
```

---

## 17. Invariants — Things That Must NEVER Break

### Data Integrity
1. **Column J (index 9) is the rollup status** — Never move it to another column without updating ALL three writers AND the frontend renderer
2. **Column I (index 8) is the master tracking number** — Used by `evaluateRollupStatuses()` and the MPS system
3. **Column A (index 0) is the Trello card ID** — The primary key for deduplication across sync, webhook, and archival
4. **Column D must stay TEXT format** — `setNumberFormat('@')` prevents tracking-number-like values from becoming scientific notation

### Status Value Strings
5. **Status strings are case-sensitive in some places, case-insensitive in others** — `evaluateRollupStatuses()` uses `.toUpperCase()` for comparison but writes mixed-case values like `"Delivered in Full"` and `"Partially Delivered"`. The frontend badge renderer handles both.
6. **"Delivered in Full"** (renamed 2026-08-26 from "Received and Drops Off") is the ONLY status that triggers email + Trello automation. Never rename it again without updating the automation trigger. The trigger itself fires on which code branch runs (`evaluateRollupStatuses.js`'s `newlyReceivedRows` push), not on a string match against the literal text, so the 2026-08-26 rename alone did not touch the automation — but any *future* rename must preserve that same property.
7. **"EXCEPTION"** is the highest-priority status. It overrides ALL other statuses when ANY child box has an exception.
8. **PARTIAL must be checked before RECEIVED/DELIVERED in any substring match.** Both `"Partially Received"` and `"Partially Delivered"` contain one of those words, so a check that tests for RECEIVED/DELIVERED first will misclassify an in-progress partial shipment as fully terminal. `getRollupRank_()` (`Shared_Classifiers.js`) and every frontend badge-color function check PARTIAL first for exactly this reason — preserve that ordering in any new status-derived logic.

### Status Transition Rules (CRITICAL)
9. **Statuses must ONLY move UP the hierarchy, never down.** See Section 7 Status Hierarchy. A Tier 4 status (RECEIVED, DELIVERED, COMPLETE, Delivered in Full) must NEVER be overwritten by a Tier 3 (Partially Received, Partially Delivered) or lower. (Corrected 2026-08-12: the literal status is `COMPLETE`, not `DROPSHIP COMPLETE` — see Section 7.)
10. **"DELIVERED" must be in the `isManualReceived` preservation set** in `evaluateRollupStatuses()`. Without this, the rollup engine can incorrectly downgrade a carrier-confirmed delivery to "Partially Delivered" based on stale MPS child box data.
11. **For local warehouse inbound, DELIVERED ≠ RECEIVED.** Carrier delivery means goods are at the dock. RECEIVED means a human has verified what actually came and accepted it into inventory via the receiving feature. These are separate states.

### Sync Behavior
11. **The sync function reads ALL 4 boards in a single `UrlFetchApp.fetchAll()` call** — This is a deliberate optimization. Do NOT split it into sequential calls or you'll hit rate limits.
12. **New cards skip history check** — If a card ID exists in `Shipment_History`, it will NOT be re-added to SHIPMENTS. This prevents "zombie" resurrections.
13. **The 4.5-minute stopwatch is critical** — Google Apps Script has a 6-minute execution limit. The 4.5-minute cap ensures the function completes batch writes before being killed.

### FedEx Integration
14. **FedEx OAuth tokens are cached globally via Memcache (`CacheService`)** — Tracking (`FEDEX_TRACK_TOKEN`) and Rates (`FEDEX_RATES_TOKEN`) reuse their tokens across all triggers, executions, and web-app chunks for up to 50 minutes to avoid tripping FedEx's strict 1-hit-per-second-average Auth Threshold. The script uses **Dual Authentication**: `CLIENT_ID`/`CLIENT_SECRET` for Tracking, and `FEDEX_RATES_KEY`/`FEDEX_RATES_SECRET` for Rates and Transit Times.
15. **MPS Discovery caps at 15 masters per run** — This prevents API throttling. The 10-minute trigger spacing ensures all masters get discovered within hours.
16. **MPS Batch caps at 120 boxes per run** — Sorted by `lastChecked` (oldest first) to ensure fair rotation.
17. **LockService is ONLY used for the final sheet write** — API calls run unlocked. Moving the lock earlier will freeze the web app during FedEx calls.

### Webhook
18. **3-second debounce per card ID** — Trello sends rapid-fire webhooks for a single action. The CacheService lock prevents duplicate processing.
19. **Webhook does NOT append completed cards** — If a card's list is RECEIVED/DONE/COMPLETED and it's not already in SHIPMENTS, the webhook skips it. This prevents historical cards from polluting active data.
20. **Webhook preserves non-pending rollup statuses** — If a card already has a meaningful status (not PENDING or STAGED), the webhook won't overwrite it with a *lower-ranked* one (see `getRollupRank_()` in `Shared_Classifiers.js`). Fixed 2026-08-12 — this used to gate on whether *this specific event* carried a shipped/delivered list, which incorrectly reverted legitimate advances (e.g. a checkItem-only webhook computing RECEIVED) that didn't happen to include list data. See the RESOLVED note earlier in this section.
21. **Webhook direction resolution must derive `direction` from the hardcoded `boardMatrix` (Section 2), never from sniffing the live board name string.** A prior version inferred direction from whether the board name contained `"inbound"`/`"receiving"` — none of the four real board names do, so every webhook-driven update to a Purchase Orders/Nicole POs card was silently written as `"Outbound"`. Fixed before 2026-08-13; see the RESOLVED note in Section 13 and the `fixMisdirectedInboundRows()` repair (Section 19) for rows written before the fix.

### Cache
22. **Cache key `LOGISTICS_DASHBOARD_PAYLOAD_V2`** — The `_V2` suffix is a versioning mechanism. If you change the payload structure, bump the version to invalidate old caches.
23. **90KB chunk boundary** — Google CacheService has a 100KB per-key limit. The 90KB chunking leaves headroom. Do NOT increase this.

### Barcode Scanning, Receiving & Drop Ship
24. **Barcode scanning (FedEx box scan-to-deliver) must NEVER produce the literal `RECEIVED` status.** It's expected to write MPS Backend/Multi Piece Tracking and trigger `evaluateRollupStatuses()` + `warmLogisticsDashboardCache()` so SHIPMENTS Column J reflects the newly-scanned box immediately — that's intended, not a violation. What must never happen is the scan-triggered recompute writing the literal `RECEIVED` string; `evaluateRollupStatuses()`'s decision tree only ever preserves an already-set `RECEIVED`, never assigns it — see Section 4B.
25. **The receiving feature (verification) is the ONLY gate for local warehouse inventory.** Carrier delivery (FedEx "Delivered") alone does NOT create inventory entries. The `submitBulkPOReceipt` function in `JS_Handlers.html` — where a human verifies what actually came vs. what was expected — is the mechanism that transitions local warehouse inbound from DELIVERED → RECEIVED.
26. **Drop ships are DESIGNED to be exempt from both barcode scanning AND receiving verification — but this exemption is NOT implemented in code as of 2026-08-12.** See the `[!CAUTION]` in Section 4A: the only drop-ship-aware code today is a narrow badge substitution (`"COMPLETE"`) in `evaluateRollupStatuses()`, gated on `CUSTOMER_REGISTRY`'s `Handling_Type`, that fires only after 100% FedEx delivery confirmation. No code path skips receiving, scanning, or `ZONE-BUFFER` stowing for any card today, drop-ship or not. Treat this invariant as an aspiration to build toward, not a guarantee to rely on — a card that "should" be a drop ship will still go through the full local-warehouse receiving flow.
27. **`submitBulkPOReceipt` must issue a post-roundtrip refresh.** After the server call completes, the client MUST re-fetch data from the server to reconcile local caches with Trello + Sheets reality. Optimistic UI alone is not sufficient. **Status: implemented** (`JS_Handlers.html`, confirmed 2026-08-12 — reconciles from `res.confirmedItems` then calls `refreshData()`).
28. **Checklist/line-item text handling must be resilient.** `formatInboundLineItems()` (duplicated in `syncAllBoardsToShipmentsTab.js` and `Webhook_Receiver.js`, not `JS_Render_UI.html`/`Service_Read.js` — see Section 4C) must never throw on an empty or unusual checklist; the separate `QTY:`/`RCVD:` line-parsers used elsewhere (`JS_Handlers.html`, `JS_Render_UI.html`) must gracefully handle partial quantities, missing descriptions, and non-standard formats. A malformed checklist item or line must NEVER crash the sync or render pipeline.

### Aging / Dwell Time
29. **`Audit_Log` column H (`originalArrivalDate`) must be populated on every `MOVE_IN` row, and must never be repurposed for anything else.** `moveInventoryItem()` (`Service_Write.js`) writes the item's true original arrival date here (resolved by `resolveOriginalArrivalDate_()`, which itself reads column H on prior `MOVE_IN` rows to handle multi-hop moves correctly) so `getAgingData()`/`calculateInventoryAgeDays()` can report real dwell time instead of resetting to ~0 days on every move. Removing this column, leaving it blank, or writing something else into it silently reintroduces the "aging resets on move" bug (see Section 15's Audit_Log table).
30. **`PO_RECEIVED` must stay in `getAgingData()`'s `validActions` list** (`Service_Read.js`). It's the arrival event logged when `receivePOCardItems()` stows items into `ZONE-BUFFER`. Without it, a freshly-received item has no valid aging anchor until its first move — at which point the `MOVE_IN` entry becomes its only match and (absent the column-H fix in invariant #29) would make it look brand-new.

### Historical Records & Deleted-Card Pruning (Added 2026-08-13 — see Section 11A)
31. **Every record built from a `Shipment_History` row must be stamped `historical: true`, and every consumer that grades an order's completion state must check that flag first, before any status-string logic.** `isItemCompleted()` (`JS_Handlers.html`) and `renderInboundReportModal()`'s per-order loop (`JS_Render_UI.html`) both do this today. If a new consumer reads `window.logisticsData.inbound`/`.outbound` and grades completion by status string alone, it will silently mis-treat archived/deleted cards as active — this is the exact bug class Section 11A exists to close, and it can reopen per-consumer if a new one skips the check.
32. **`pruneDeletedShipmentCards_()` must only prune SHIPMENTS rows for boards present in `boardsFullyProcessed`.** A board whose card fetch was cut short by a network error or the sync's execution-time budget has an incomplete `liveCardIdsByBoard` set for that run; treating every card ID this run didn't happen to see as "deleted from Trello" would wrongly archive live, in-progress cards. This guardrail must be preserved in any future refactor of the sync's Phase 1 fetch loop.
33. **`pruneDeletedShipmentCards_()` archives to `Shipment_History` before removing the SHIPMENTS row — it must never hard-delete.** Same recoverability requirement as `archiveCompletedShipments()` (invariant #12's sibling): a card deleted from Trello should still be auditable in the portal's own history, distinguishable from a normally-completed shipment via the `"CARD DELETED FROM TRELLO"` rollup text (Section 7).

### Client Reload Behavior
34. **`BUILD_VERSION` (`Service_Read.js`) no longer drives an automatic client-side page reload.** It did until 2026-08-13 — `JS_Store.html` used to compare every poll's `data.buildVersion` against the value baked into the page at load and call `location.reload()` on mismatch (itself the safe replacement for an even older mechanism that injected an `<img onerror>` payload into rendered data for the client to execute, a real XSS vector). Removed because every forced reload re-triggered Google's own "not verified by Google" banner on the Apps Script web app URL — worse in practice than the stale-client problem it was built to fix. `BUILD_VERSION` is retained and still stamped on every poll response, but is diagnostics-only now (surfaced in `JS_Diagnostics.html`'s environment panel via `window.CIS_BUILD_VERSION`). **Do not silently reintroduce an auto-reload keyed on this value** without first addressing the verification-banner regression it caused — a tablet left open now simply keeps running old JS until someone manually refreshes it, which is the accepted tradeoff, not an oversight.

> **Added 2026-08-21**: a passive, opt-in replacement now exists — `showNewVersionBanner()` (`JS_State.html`), wired from the `logistics` dataset's poll handler (`JS_Store.html`, the one store fetcher whose payload already carries `buildVersion`). On a mismatch it shows a dismissible banner with an "Open in New Tab" button that calls `window.open(location.href, '_blank')` — deliberately never `location.reload()`/`location.href=` on the current tab, since either of those is exactly the fresh top-level `/exec` navigation that re-triggers the banner this invariant exists to avoid. Shown at most once per session (`window._newVersionBannerShown`). Not fully verified to dodge the interstitial itself (unconfirmed whether Google's check keys off *any* fresh navigation regardless of trigger) — but it is confirmed to no longer force a reload on anyone, which was the actual daily-use complaint. This does NOT count as "reintroducing an auto-reload" — no code path here calls `reload()`/reassigns `location.href` automatically.

### Guided Move (Tap-to-Carry)
35. **Superseded by invariant #65 above (2026-08-25) — kept for history.** The `move-qty-<index>`/`move-dest-field` row this describes no longer exists in the card; both the qty and destination inputs moved into the Move popup (`#move-choice-modal`), which passes qty as an explicit call argument rather than reading a DOM field, so the mobile-hide-one-field-not-the-other failure mode below can't recur. ~~The `move-qty-<index>` input (class `move-qty-field`) must always stay visible/editable at every breakpoint, even though its sibling destination input/button (`move-dest-field`/`move-dest-btn`) are intentionally hidden on mobile.~~ `beginMove()` (`JS_Handlers.html`) reads this field's live DOM value as the tap-to-carry quantity, independent of the free-text "type the coordinate" relocate flow it visually sits inside — a coupling that isn't obvious from either flow's own code. Fixed 2026-08-24: the mobile breakpoint (`Styles_Responsive.html`, `@media (max-width: 768px)`) used to hide the entire row (`.move-text-row { display: none }`), which left this field permanently stuck at its default (full on-hand qty) value — `document.getElementById()` still finds a `display:none` element, so `beginMove()` never errored, it just silently couldn't be overridden. Every mobile tap-to-carry move carried the full quantity with no way to dial in a partial amount until this was split apart. If this row is ever restructured again, keep the qty field reachable independent of the destination input, or re-audit every function that reads a `move-qty-` id before hiding it.


### Write-Path Failure Reporting (Added 2026-08-24 — AUDIT_2026-08-24.md Phase 1)
36. **A server write function must never return a hardcoded `{success:true}`.** `modifySheetRow()` (`Service_Write.js`) resolves an Inventory row by instanceId, row number, or location+SKU, and used to end with a bare `if (targetRowIdx > -1) { ...write... }` and no `else` — returning `undefined` having written nothing. Its five callers (`setTotalStock`, `updateStock`, `updateInventoryField`, `updatePalletComment`, `reservePallet`) then each returned a literal `{success:true}` regardless. The floor symptom: an operator opens a pallet whose row was moved or deleted by the concurrent sync between page load and tap, presses SET, the server reports success, `refreshData()` repaints the old number, and they press it again — no toast, no log, no `Audit_Log` entry. `modifySheetRow()` now returns `{success:false, error:'Row not found for <loc>/<sku>...'}` when the row can't be resolved and `{success:true}` otherwise, and all five callers return that result verbatim. **Do not reintroduce a literal success return in any of them.**

37. **Every client mutation must go through `runMutation()` (`JS_State.html`) or attach its own `.withFailureHandler` AND inspect `res.success`.** Apps Script routes any normal return value — including `{success:false}` — to the *success* handler; only a thrown exception reaches `withFailureHandler`. The drawer's Qty / − / + / SET / status / comment controls were each a bare `.withSuccessHandler(() => refreshData())`, so both real server error returns (`"Row data mismatch. The sheet may have been modified."` and `"Server busy. Please try again."`, `Service_Write.js`) were discarded. `runMutation(label, invoke)` attaches both handlers, treats only an explicit `success === false` as failure (so a server still returning `undefined` isn't misreported), toasts the server's own error text, and refreshes from the sheet either way so a failed write never leaves optimistic UI standing.

38. **`receivePOCardItems()` returns `trelloSynced` alongside `success`, and they mean different things.** `success` reports only the Inventory/`Audit_Log` write, which happens under a lock and has **no rollback**. `trelloSynced:false` (with `failedItems[]`) means the stock landed but the Trello checklist did not move. Previously every Trello call in that function was `muteHttpExceptions: true` inside a `catch(e){}` with the response code never read, and the function returned `{success:true}` unconditionally — so an expired token or a 429 mid-batch credited inventory, left the checklist showing the full remaining QTY, showed a green success toast, and the next shift received the same PO again against an unchanged checklist. **Inventory double-counted, with nothing recorded anywhere.** `submitBulkPOReceipt()` (`JS_Handlers.html`) now renders this as a distinct amber warning state that names the failed items and tells the operator to fix the checklist by hand; it deliberately does **not** reset the button label afterwards, so the warning survives on screen. A future caller of `receivePOCardItems()` that checks only `res.success` reopens this bug.

39. **A read failure must never be returned as empty data.** `getAllInventory()` (`Service_Read.js`) used to `return null` from its catch. `getInventoryTotals()` then threw on `data.forEach` inside its own catch-all and degraded to `[]`, and `getAuditWorklist()` threw on `inventory.filter` and degraded to `[]` — so a failed sheet read surfaced to staff as the Inbound Report showing `no match` on every On Hand cell (a reconciliation *finding*), and as **an empty audit queue that reads as "nothing to audit."** `getAllInventory()` now throws; both callers guard explicitly and rethrow. The three consumers all handle a throw correctly: `precompileDataset_()` (`Service_Router.js`) logs to `BOOT_ISSUES_` and falls back to `[]`, `JS_Store.html`'s inventory fetcher has a `withFailureHandler`, and the two client entry points (`openAuditMode()`, the Inbound Report's totals fetch) now do too — the report renders On Hand as `unavailable`, a third state distinct from both `loading...` and `no match`.

40. **Every Trello HTTP call goes through `trelloFetch_()` (`Shared_Classifiers.js`).** Trello's limit is 100 requests per 10s per token; `receivePOCardItems()` issues two requests per checklist item in a tight loop, so a 40-line PO receipt is 80 back-to-back requests. Before this there was not one occurrence of `429`, `retry`, or `backoff` anywhere in the codebase — every site used `muteHttpExceptions` with the status unchecked or checked only for `200`, so a throttled request was indistinguishable from a successful one. `trelloFetch_()` retries 429 and 5xx with exponential backoff (honouring `Retry-After`) and never retries other 4xx — a 401 or 404 won't fix itself, and retrying a POST that already succeeded would double-post a comment. It returns `{ok, code, text, error, attempts}` plus `getResponseCode()`/`getContentText()` shims so the pre-existing `=== 200` call sites are a drop-in rename. **Do not call `UrlFetchApp.fetch` directly against `api.trello.com`.**

41. **A malformed `_SYS_` blob is skipped, but never silently.** Master Hub / assembly structure lives as JSON after a `_SYS_` marker in Inventory column F (Section 18). It was parsed at ~15 server sites and 6 client sites, each with its own `catch(e){}` — so one corrupt blob quietly dropped a pallet out of its build for the explode/move/delete logic, with nothing written anywhere. There is now exactly one path per side: `parseSysBlob_(comment, context)` (`Shared_Classifiers.js`) and `window.parseSysBlob(comment, context)` (`JS_State.html`). Both still return `null` on bad input — callers genuinely need to skip such a row rather than abort a batch — but both log the row and the raw text. These two are a deliberate client/server duplicate pair in separate JS namespaces, like `findEffectiveQtyPer_`; **keep them in sync.**

### Webhook Durability (Added 2026-08-24 — AUDIT_2026-08-24.md Phase 1)
42. **`doPost()` (`Webhook_Receiver.js`) cannot signal failure to Trello, so the `Webhook_Errors` tab is the retry mechanism.** `ContentService` cannot set a non-200 status — the old `createTextOutput("ERROR")` was an HTTP **200** with the body `"ERROR"`, and Trello only retries on non-2xx. Every webhook that threw was permanently lost and invisible until the next scheduled sync happened to paper over it. Failures now append `[Timestamp, Card ID, Error, Raw Payload]` to a `Webhook_Errors` tab (payload truncated to 45,000 chars for the cell limit) so the event can be reconstructed or replayed by hand. `alertOnWebhookErrors()` is built for a daily time-driven trigger and mails `STAKEHOLDER_EMAILS` about rows added since its last run, tracked in Script Properties under `WEBHOOK_ERRORS_LAST_ROW`. **An error log nobody is paged about is not a remedy — keep that trigger installed.**

43. **The webhook de-bounce is keyed on the event, not the card.** It used to drop *any* second event for a card within 3 seconds, so moving a card and labelling it in quick succession lost the second change entirely until the next full sync. `webhookEventKey_()` now hashes `action.id`/`type`/`date`/`data`, so only a byte-identical re-delivery is dropped (20s window); genuinely distinct events are each processed. Note `doPost()` deliberately takes **no** `LockService` lock: that lock is global to the whole Apps Script project, and holding it across `processWebhookPayload()`'s SHIPMENTS read plus Trello calls would make the FedEx engines' own `tryLock(10000)` fail and skip an entire cycle (`Fedex_Master_Script.js`). The event hash, not a lock, is what prevents duplicate processing. **Do not narrow this back to a card-scoped key, and do not wrap `processWebhookPayload()` in a script lock.**


### Mobile / Floor Usability (Added 2026-08-24 — AUDIT_2026-08-24.md Phase 3)
44. **Touch targets in `#detail-view` are 44px, not 32px.** `Styles_Responsive.html` pinned every button/select/input in the drawer — the Qty / − / + / SET row — to `height: 32px`, and `.btn-plus`/`.btn-minus` to 32px square. Apple HIG and WCAG 2.5.5 both put the minimum at 44px, and this is a gloved-hands warehouse app. Measured before/after at 375×812: 32×32 → 44×44 for the +/− buttons, 32px → 44px row height for the qty input and SET. `height` was replaced by `min-height` so a control with wrapped content can still grow. **Do not reintroduce a fixed `height` on these.**

45. **The viewport meta no longer sets `maximum-scale` / `user-scalable`.** `Service_Router.js` sent `maximum-scale=1.0, user-scalable=no` on both templates. iOS Safari ignores both (by design, for accessibility) — which is the only reason pinch-zooming the floor maps worked on the floor iPhones at all. **Android Chrome honors them**, so on those devices the map could not be zoomed, and the PWH floor plan renders each pallet slot at roughly 8px on a 375px screen. That directly contradicted the comment already sitting on `#map-container` in `Styles_Responsive.html`: *"Native pinch-zoom (touch-action: auto) is the way to inspect small map detail now."* The iOS input-auto-zoom that flag also guarded against is handled properly instead by `input, select, textarea { font-size: 16px }` — now under `@media (pointer: coarse)` so it covers touch tablets above the 768px breakpoint too, not only phones.

46. **Modal panels use `dvh`, with the `vh` value kept first as a fallback.** Every modal overlay was `height: 100vh` and every panel `max-height: 88vh`/`90vh`. On iOS Safari `100vh` is the *expanded* viewport (as if the toolbars were hidden), so the panel's action row — Print / Close / Receive — sat underneath the browser chrome. Each inline style now carries the pair `height: 100vh; height: 100dvh`, so engines without `dvh` keep the old value. The shared `portal-modal-overlay` / `-panel` / `-header` / `-body` / `-footer` classes exist so `Styles_Responsive.html` can reach these inline-styled shells at all (hence the `!important`s); below 600px they become full-bleed sheets and the footer picks up `env(safe-area-inset-bottom)`, copying the pattern `.move-carry-bar` already used. **`.portal-modal-panel` must keep `box-sizing: border-box` in that rule** — the panels carry a 1px border inline and default to `content-box`, so `height: 100dvh` made them 100dvh + 2px and pushed the footer just below the fold (measured, not theorised).

47. **The Inbound Report's discrepancy explanation must stay reachable by tap.** It was a multi-sentence paragraph living *only* in a `title="..."` attribute, so on a phone the ⚠ and ? icons were visible with no way whatsoever to read what they meant. The icon is now a real 44px `<button>` toggling a note beneath the row (`toggleInboundReportNote()`, `JS_Render_UI.html`); the `title` is kept as the desktop-hover shortcut. Both are now run through `escapeHtml` — that string interpolates item names containing quotes and apostrophes, which broke the attribute outright (this was the `discrepancyTitle` half of the Phase 5 D4 finding; `itemName`, `po.poName` (both occurrences), `o.poName`, `o.summary`, `o.reason`, `o.status`, `po.status` and `po.originReason` in that same renderer are now escaped too).

48. **Below 600px the Inbound Report renders POs as stacked cards, and the calendar as an agenda list.** Both are layout swaps chosen at render time, not CSS-only:
    - The PO table's status-badge cell has a hard min-content width that pushed it past 375px, and its only container (`#inbound-report-content`) is `overflow-y: auto` **only** — so the "Received" column was clipped off the right edge with no way to scroll to it. Above 600px the table is kept but is now inside a real `overflow-x: auto` container with `min-width: 480px`, so it scrolls rather than clips.
    - `grid-template-columns: repeat(7, 1fr)` is shorthand for `minmax(auto, 1fr)`, and `auto` floors each column at its **min-content** width. The day chips are `white-space: nowrap` store names, so the grid grew to roughly 1100px with no scroll container — only Sun and Mon were reachable. It is now `minmax(0, 1fr)`; but 7 columns at 375px is ~44px per cell, which still cannot hold a store name, so `renderLogisticsCalendarView()` swaps in a vertical agenda (only days that have shipments, no `+N more` truncation, 44px chips) below 600px. A `matchMedia` change listener re-renders on rotation, since the layout is picked at render time.

49. **Hiding the Dashboard's Status/Transit column on mobile requires the inline transit subtext.** The header cells total 40 + 150 + 180 + 150 = 520px of fixed width before the flexible Entity column starts, so every row needed two-axis scrolling on a phone. Below 768px the widths are dropped and the Status/Transit column is hidden — on **outbound** that column's badge is an exact duplicate of the Rollup Status column beside it, so nothing is lost there. But the transit mode (Air/Ocean/FedEx/Truck) lives *only* in that column, for both directions, and is **not** repeated in the row's expanded child panel. `generateRowHtml()` therefore re-emits it as `.logistics-inline-transit` subtext under the entity name, hidden on desktop and revealed below 768px. **If that column is ever hidden by another rule, keep this subtext** or mobile silently loses transit mode. The Scheduled Date column is deliberately kept — it carries the PAST DUE flag and the Trello link.

50. **`.table-wrapper` sets both overflow axes explicitly.** It used to lead with `overflow: hidden` followed by `overflow-y: auto`, which left `overflow-x: hidden` — any wrapper wide enough to need side-scrolling silently clipped its rightmost columns. The Dashboard's wrapper happens to carry an inline `overflow-x: auto` that overrode it, which is why this never showed up there; every other `.table-wrapper` was a trap.

51. **Report printing goes through `printPortalReport()`, not bare `window.print()`.** The app runs inside Apps Script's sandboxed iframe on `*.googleusercontent.com`, and iOS Safari's print from a cross-origin iframe frequently does nothing at all, with no feedback either way. Below 768px the report's markup is opened in a new top-level tab on a light palette (the in-app report is white-on-near-black — unreadable on paper) where the native print sheet works. Desktop keeps `window.print()`. A blocked popup is reported via `showToast` and falls back to `window.print()` rather than silently doing nothing.

52. **`.drawer-handle-tab` is positioned at `top: -26px`, so `#map-container` reserves 26px while the drawer is open.** The tab necessarily overlaps whatever sits above it — the bottom strip of the floor map. The clearance rule uses `:has(#side-panel.drawer.open)` because `#side-panel` is a *later* sibling of `#map-container` and CSS has no previous-sibling combinator; the alternative is adding a class from all three places that toggle `.open` (`JS_Handlers.html`, `JS_Render_Core.html` ×2). Where `:has()` is unsupported the rule is simply dropped and behaviour is exactly what shipped before, so there is nothing to regress.

53. **`receivePOCardItems()` derives expected/already-received quantities from the LIVE Trello checklist, never from the browser payload.** The client sends `oldQty`/`oldRcvd` per item, and the over-receipt guard used to compute `originalExpectedQty` from exactly those numbers. Two stations with the same PO open both held the same stale `oldRcvd`, so both passed the guard and both appended — the guard could not see the other station at all. The function now calls `getExistingCardChecklist(cardId)` up front, overwrites `oldQty`/`oldRcvd` from the live `qty`/`rcvd` for every item that carries an `idCheckItem`, and validates against those. It then re-reads once more under the write lock and aborts if anything moved in between. Everything downstream — the guard, `confirmedItems`, the receipt email totals, and the `| QTY: x | RCVD: y` string written back to Trello — consumes the server-read values, so a stale browser can no longer write a wrong running total into the checklist either. **Items with no `idCheckItem` (the "General Check-in" path) still fall back to the client payload — there is nothing on the card to verify them against.** Residual window, deliberately not closed: the Trello checklist write happens *outside* the lock, so two stations submitting within the same second can still both pass. Closing that fully means holding the script lock across ~2 Trello API calls per line item. See `AUDIT_2026-08-24.md` B6.

54. **Everything written through `SS_API` uses `valueInputOption: "RAW"`.** Pallet comments, PO checklist descriptions and entity names are free text out of Trello. Under `USER_ENTERED` (the previous setting) Sheets parses each value, so a checklist item literally named `-3M SLIDE` or a comment `=2 pallets short` became a formula and rendered `#NAME?` permanently, and a leading apostrophe was silently stripped. Nothing in this codebase writes an intentional formula — there is no `setFormula()` call anywhere and no `"=..."` literal — so there is no case that needs `USER_ENTERED`. `SS_API.commitAtomic()` gets the same guarantee structurally: it emits `userEnteredValue.stringValue`, and only `formulaValue` produces a formula. See `AUDIT_2026-08-24.md` B1.

55. **`SS_API.batchAppendRows()` passes `insertDataOption: "INSERT_ROWS"`.** The API default is `OVERWRITE`, and the `"<sheet>!A1"` range makes Sheets table-detect downward from the top — so a single blank row anywhere in `Inventory` truncates the detected table there and the append lands mid-sheet, overwriting live rows. Do not remove this option, and do not change the range to something that looks more precise: the two settings are load-bearing together. See `AUDIT_2026-08-24.md` B2.

56. **Every assembly write path commits through `commitInventoryMutation_()` (`Service_Assembly.js`) in ONE atomic `Sheets.Spreadsheets.batchUpdate`.** `explodeAssembly`, `explodePartialHub` and `buildHardAssembly` used to commit through three or four *separate* API calls, and a quota error or the 6-minute execution timeout landing between two of them corrupted inventory silently and in opposite directions: the explode paths committed the component restores before the delete, so a failure in between left the components restored **and** the assembly rows standing (inventory doubled); `buildHardAssembly` deleted the consumed component rows in one call and minted the assembly rows in a later one, so a failure in between destroyed stock outright. Both returned `{success:true}`. Request order inside the batch is load-bearing — `updateCells` (pre-delete row indices), then `appendCells` (lands past the last row, shifting nothing), then `deleteDimension` descending. **`Audit_Log` is deliberately written after, outside the atomic set**, because its rows carry a live `new Date()` and a Date cannot go through `updateCells` without also setting a `numberFormat`; a lost log line is a reporting gap, not an inventory error, so it is logged and swallowed rather than failing an operation whose inventory effect already committed correctly. See `AUDIT_2026-08-24.md` B3.

57. **`restoreItemToSheet()` (both copies) tracks rows that exist only as a pending append.** Its third branch queues a brand-new row into `sheetAppends` for a location+component with no existing row and no vacant slot. That branch used to leave the in-memory `data` snapshot untouched, so a second restore of the *same* location+component didn't see the first one and queued a second append — two rows where there should be one merged row. The synthetic row is now pushed onto `data` as well, with a `pendingAppendAt` map from its `data` index to its slot in `sheetAppends`. **A later restore that lands on such a row must amend `sheetAppends[k][2]`, not emit an `Inventory!C<n>` update** — the row has no sheet row number yet, and `data.length + 1` points at an unrelated live row. See `AUDIT_2026-08-24.md` B4.

58. **Quantities from the client are validated as finite on both sides before any write.** `NaN` was the specific hazard: every server-side qty branch decides between "clear/delete the pallet" and "write the number" by testing `newQty <= 0`, and **`NaN <= 0` is false**, so a `NaN` fell through to the else branch and wrote the literal value into column C — reachable from the drawer with any non-numeric entry (`12o`, `abc`, `1.2.3`), because the client only did `Number(rawVal.replace(/,/g,''))`. Server side, `validateQty_()` (`Service_Write.js`) guards `setTotalStock`, `updateStock`, `setTotalStockByRow`, `updateInventoryByRow`, `addNewItemToLocation` and `moveInventoryItem`, returning `{success:false, error}` rather than writing. Client side, `setTotal`/`adjustStock` (`JS_Handlers.html`) refuse to send and toast the bad input. `SS_API._toCellData` throws on a non-finite number as a last line of defence. **The client guard is a UX affordance, not the protection — the server check is, and both must stay.**

  **`0` is a valid quantity and deletes the pallet — deliberately, with no confirmation.** `validateQty_` accepts `0` and `setTotalStock`/`setTotalStockByRow` then take the `newQty <= 0` branch: the row is deleted outright if other items share the location, or blanked to `Vacant` if it's the last one. Confirmed as intended 2026-08-24 — it is the floor's fast path for emptying a slot. Do not add a confirmation dialog and do not "fix" `0` into a rejection; this is the second audit to raise it. Negative values are likewise accepted for `updateStock`/`updateInventoryByRow`, which is how the `−` button works. See `AUDIT_2026-08-24.md` B5.

59. **`modifySheetRow()` runs under the script lock.** It reads the entire data range, computes a target row index from it, then writes to that index — a read-compute-write that was completely unguarded, while its own `*ByRow` twins (`updateInventoryByRow`, `setTotalStockByRow`) have always taken the lock. A concurrent sync or a second station deleting a row inside that window shifted every row below it, so the write landed on the wrong pallet. Uses the same `tryLock(10000)` + `"Server busy. Please try again."` shape as the twins. **Nothing that already holds the script lock may call it** — Apps Script locks are not reentrant, so a nested acquisition deadlocks until timeout. As of 2026-08-24 the only caller in a lock-holding context would be `receivePOCardItems`, which does not call it. See `AUDIT_2026-08-24.md` B7.

60. **Viewport diagnostics go to their own `Diagnostics` tab and must never touch `Config`.** `logDisplayDiagnostic()` used to append `[Timestamp, Width, Height, UserAgent]` into `Config` — the hand-maintained sheet that also holds the port lead-time table (`getPortGroups_`, `Service_Dates.js`) and `STAKEHOLDER_EMAILS`. Beyond unbounded machine-generated growth inside a table humans edit, the real hazard was the creation path: when `Config` was missing it **created it, with diagnostic headers**, and `getPortGroups_()` would then find a `Config` sheet that parses to zero port rows — so every ETA in the app silently fell back forever, because a *missing* Config throws but a *useless* one does not. The `Diagnostics` tab is capped at 1000 rows, oldest-pruned. Legacy diagnostic rows still sitting in `Config` are harmless (`getPortGroups_` skips any row without a recognised leg name) and can be cleared with `migrateDiagnosticsOutOfConfig()` in `Setup_Registry.js`. See `AUDIT_2026-08-24.md` B8.

61. **SHIPMENTS / Shipment_History text columns are read through `cleanText()`, which drops `Date` objects.** `getValues()` returns a real `Date` for any cell Sheets auto-parsed as a date — *including cells in columns that are supposed to hold text* — and nothing between the sheet read and the render layer type-checked it. `String(aDate)` is `"Mon Mar 01 1666 00:00:00 GMT-0500 (…)"`, which is what a calendar chip was observed showing as a store name. `cleanText()` (`buildLogisticsDashboardPayload_`, `Service_Read.js`) drops the value so the caller's `|| "STAGED ORDER"` fallback shows, and **logs the sheet row** so the corrupt source cell can be found — it needs reformatting to Plain text with its real value restored. `cleanStoreEntityName()` (`JS_Handlers.html`) is the second line of defence and rejects both a `Date` and the `"Ddd Mmm D YYYY"` string one stringifies to. **Fixing the code does not fix the data** — a bad cell stays bad until someone edits the sheet. See `AUDIT_2026-08-24.md` B9.

62. **`formatCleanDate()` whitelists date formats; it never falls through to `new Date(str)`.** V8's Date constructor invents dates out of text fragments — measured: `"TJX 5"` → 2001-05-01, `"FedEx 3"` → 2001-03-01, `"Week 5"` → 2001-05-01, `"12"` → 2001-12-01, `"2026"` → 2025-12-31 — so junk in a date column rendered as a confident, plausible, *wrong* date on the calendar, and unparseable text (`"Delivered"`, `"TBD"`) was returned verbatim into a date slot. Accepted now: a real `Date`, `M/D/YYYY` (slash or dash, optional trailing time), and ISO `YYYY-MM-DD`. Everything else is `"-"`. Impossible dates (`02/31`, `13/01`) are rejected via a `Date` round-trip rather than being silently rolled over. `parseDateToTimestamp()` returns `null` for anything `formatCleanDate` rejects and has **no** `new Date(dateStr)` fallback of its own — that fallback was a second copy of the same bug. ISO strings are parsed field-by-field, not through the constructor: `new Date("2026-08-24")` is UTC midnight read back in local time, which previously shifted every ISO date one day earlier in US timezones. See `AUDIT_2026-08-24.md` B10.

63. **`doPost()` authenticates the Render → Apps Script hop via a shared secret, gated on a Script Property.** `Webhook_Receiver.js` has no access to Trello's `X-Trello-Webhook` header — Apps Script's `doPost(e)` exposes only `postData`/`parameter`/`parameters`/`queryString`, and even with the header, Trello signs its HMAC over the **Render** callback URL, not this `/exec` URL, since the real path is `Trello → Render (trello-webhook-server-763h.onrender.com) → Apps Script`. Real Trello-signature verification belongs on the Render server, outside this repo. `isAuthorizedWebhookHop_()` authenticates only the second hop: Render is expected to append `?k=<secret>` to every forwarded call, checked against the `WEBHOOK_HOP_SECRET` Script Property with a constant-time compare (`timingSafeEqual_()`). **If `WEBHOOK_HOP_SECRET` is unset, the check is skipped entirely** — this is deliberate, not a gap: setting the property before Render is actually sending `?k=` would silently reject every real webhook, and per invariant/A6 above a dropped webhook is unrecoverable and invisible until the next scheduled sync. A rejected request is logged to `Webhook_Errors` (same tab as A6) and returns HTTP 200 regardless, same as every other `doPost` response — `ContentService` cannot set a non-200 status. See `AUDIT_2026-08-24.md` D2.

64. **Every `<?!= ... ?>` value injected into `Index.html`'s inline `<script>` block goes through `safeJsonForScriptTag_()` (`Service_Router.js`), never bare `JSON.stringify()`.** `JSON.stringify()` does not escape `<`, U+2028, or U+2029. A cell containing the literal `</script` inside any precompiled dataset — a pallet comment, a PO summary, a customer registry alias — closes the `<script>` tag early at the HTML-parser level and breaks the entire page load with no error surfaced; U+2028/U+2029 are valid JSON string characters but are illegal unescaped inside a JS string literal, so a stray one throws a `SyntaxError` at parse time instead. `safeJsonForScriptTag_()` wraps `JSON.stringify()` and replaces those three characters with their `\u00XX` text escapes — note the replacement strings in source are double-backslashed (`'\\u003c'`), because a single backslash (`'<'`) is itself a JS string-literal escape for the literal `<` character and would silently no-op the fix. `precompileDataset_()` (all nine `window._server*` globals) and the boot-issues log (`window._serverBootIssues`) both route through it. See `AUDIT_2026-08-24.md` D3.
>
> **`#main-container`'s `height: calc(100vh - 54px)` was inert, not a bug — corrected 2026-08-24.** `AUDIT_2026-08-24.md` E1 claimed this hardcoded 54px made the app ~46px taller than the viewport (because `#top-ui` is `height:auto; min-height:54px` and wraps to ~100px below 768px), leaving the bottom of every view unreachable under `body { overflow: hidden }`. **Measured in Chromium at 375×812 against the pre-change stylesheets, that does not reproduce.** `#main-container` also carried `flex: 1`, i.e. `flex-basis: 0%`, which overrides `height` on the flex main axis — `#top-ui` measured 126px and `#main-container` computed to exactly 686px (the true remaining space), not the 758px the `calc()` resolves to. With realistic overflowing drawer content, `#detail-view` scrolled and the last "MOVE TO..." button was fully reachable. The declaration was replaced with `flex: 1 1 auto; min-height: 0` anyway — it was dead code carrying a wrong magic number, and the next person to read it would draw the same false conclusion the audit did — but **this was a cleanup with no behavioural change, and the E1 symptom in the screenshot has a different, still-unidentified cause.** The other half of E1 (base rule should use `dvh`) was already true: `Styles_Base.html` has `body { height: 100dvh }`.

65. **The drawer's per-slot cards (`updateDetails()`, `JS_Render_UI.html`) are `<details class="stock-item-accordion">`, collapsed by default, not always-expanded `<div class="stock-item">`s.** On mobile the drawer is a bottom sheet, and every item used to render fully expanded (status dropdown, kit-assign field, inline qty controls, an inline relocate row, a comment box) all at once — a single item at a location could push the sheet's own Close button off past the fold (confirmed on-device, `PWH-FP-RUP1-SEC-04-ROW-02-L-02`). The qty adjust controls (`-`/`+`/`SET`) and the relocate controls both moved out of the card entirely into two popups: `#adjust-qty-modal` (`openAdjustPopup()`) reuses `adjustStock()`/`setTotal()` unchanged, just painting the same `input-<index>` controls into the modal instead of inline; `#move-choice-modal` (`openMovePopup()`) offers an explicit choice between tap-to-carry (`beginMove()`/`beginGroupMove()`) and typing a destination (`executeMove()`/`executeGroupMove()`), instead of those being two separate always-visible rows fighting for space. **This supersedes invariant #35 below** — the `move-qty-field`/`move-dest-field` pair it warns about no longer exists in the card at all (both moved into the popup, which passes qty explicitly as a call argument instead of reading a DOM field), so the whole failure mode it documents (mobile CSS hiding the destination input while the qty input needed to stay reachable) cannot recur; that section is kept for history, not as an active constraint. `jumpTo()`'s target-card deep link (`JS_Handlers.html`) now sets `targetCard.open = true` before scrolling/glowing, since the target is the `<details>` wrapper itself and would otherwise stay invisible under a collapsed `<summary>`. Bulk-hub pallet cards get the same treatment plus two things normal item cards already had that hub cards didn't: a per-piece qty-adjust trigger inside "Parts on this pallet" (keyed by that piece's own sheet `rowIdx`, captured alongside `instanceId` in the hub-building loop — a bulk child row's SKU column is the **parent** SKU, confirmed in `Service_Assembly.js`, so `adjustStock()`/`setTotal()` work unmodified against it) and a "Jump To" button mirroring the "Jump to Elevation" button rack-summary items already had. New dynamically-generated `onclick` handlers (the popup triggers) are built via `jsCallAttr_()` (`JS_State.html`) — `JSON.stringify()`-based arg quoting plus a blanket `' → &#39;` pass, embedded in a single-quoted `onclick` attribute — rather than the older manual `.replace(/'/g,"\\'")` convention still used elsewhere in this file; both are safe, don't mix them in the same attribute.

### Row Split & Identity (Added 2026-08-26)
66. **SET (`setTotalStockByRow`/`setTotalStock`) is an absolute overwrite, never "remove this many" — `splitInventoryRow()` (`Service_Write.js`) is the only operation that peels part of a row off into a new one, and it must stay that way.** The incident this closes: an operator picked a new Workflow Status, typed a smaller quantity than the row held, and pressed SET — the row became "smaller number @ new status" and the difference was never written anywhere, recoverable only by reading `SET_TOTAL`'s `Audit_Log` line, which itself records only the new total, not the prior value or the delta. `splitInventoryRow()` decrements the source row in place (same instanceId) and appends a new row (fresh instanceId, per the every-batch-gets-its-own-row convention `receivePOCardItems`/`moveInventoryItem`'s partial branch already follow) at the split-off quantity and target status; refuses `splitQty >= currentQty` (that is a status change on the existing row, not a split — the UI points the operator at the dropdown instead) and refuses any row carrying a `_SYS_` blob (a Master Hub piece or assembly Frame — pulling part of a build out is `explodePartialHub()`'s job, Section 18, and mixing the two would either fork or orphan the build). The Adjust popup's SET button visibly turns red and warns the moment the typed number is a partial of the row's total — the UI state that caused the original incident is now impossible to reach silently. Log both halves as `SPLIT_OUT`/`SPLIT_IN` (Section 15's Audit_Log table) — **do not log a split as `SET_TOTAL`/`ADD`/`REMOVE`, or it becomes indistinguishable from the exact bug this closes in any future audit of the log.**

### Name Matching & Product Identity (Added 2026-08-26)
67. **Every name comparison in this codebase goes through `namesMatch`/`namesMatch_` (`JS_State.html`/`Shared_Classifiers.js`) — never raw `.includes()` in either direction.** The prior convention, `a.includes(b) || b.includes(a)`, cannot distinguish a genuine truncation from a sibling in a product family that shares a prefix by design — and this taxonomy has many: `T25-SCREW`/`T25-SCREWDRIVER`, `V32`/`V32-BATTERY`, a tag and that tag's CASE. Measured against the live PRODUCT sheet: 27 such prefix pairs, zero duplicate names — meaning an **exact** key is unambiguous for every product, while a substring test never can be. `namesMatch`/`namesMatch_` are exact after canonicalization (case/whitespace folded, the Trello injector's `[ProductID] Description` bracket form stripped to its Product ID — see Section 4D), with a prefix allowed through **only** behind one of two confirmed mechanical truncation markers: QuickBooks' 84-character export cap (the cut string ends in a literal `"..."`, only trusted at ≥40 characters so a short name that merely ends in dots isn't misread as capped), or an older export's inch-mark cutoff (the longer string resumes with a literal `"` exactly where the shorter one ends). **A plain length floor was tried and rejected** — `"SMART PL 48 AM"` is 14 characters and is still a legitimate, distinct sibling of `"SMART PL 48 AM SLIDE"`; only a marker, not a length, can tell the two cases apart. Applied at `calculateInventoryAgeDays` (`JS_Handlers.html`), `findOnHandForItem_`'s fallback (`JS_Render_UI.html` — now refuses an ambiguous match outright and returns no record, rather than reporting a confidently wrong number on an on-hand report), `resolveOriginalArrivalDate_` (`Service_Write.js`), and `findCaseConversion_` (`Service_Conversions.js`, see #68). Client and server copies must be kept in sync, same as `parseSysBlob`/`parseSysBlob_`.

68. **`findCaseConversion_` (`Service_Conversions.js`) resolves an Inventory SKU back to its PRODUCT-sheet QB name (`getQbNameIndex_`) before prefix-matching a conversion rule against it — it does not match the raw Inventory text.** The rule's `unitPrefix` is a supplier code, which only ever appeared at the start of the *full QB name*. While Inventory held that full name (true for every row before 2026-08-11, and for the 82% of rows still holding it as of 2026-08-26), matching the raw SKU directly happened to work. Once `receivePOCardItems()` started writing the nickname (Section 4D's original pipeline), the raw-text match silently stopped firing for every new receipt — no error, no log, the put-away conversion simply never happened. Confirmed live: both `NT525S/2AMF` products are nicknamed `"2 Alarm SMALL Scorpion Tag"`, sharing no prefix with their rule at all. Resolving to the QB name first makes the rule fire for either shape Inventory might hold (legacy raw text or the current Product-ID identity, Section 4D) without needing the `CASE_CONVERSIONS` table rewritten. **Note separately: `CASE_CONVERSIONS` does not exist in the live workbook** — `setupCaseConversions()` was written but never run, so `getCaseConversions_()` currently returns `[]` and this whole rule-lookup path is dormant; `resolveUnitsPerCase_`/`caseBreakdown_` (same file, Section 17 #70) read the unit-per-case ratio from the product's own QB name instead, precisely because this table isn't populated.

69. **`productIdentityKey_`/`productIdentityKey` (`Shared_Classifiers.js`/`JS_State.html`) is what lets `Audit_Log` history and current `Inventory` identity agree, even though `Inventory` now stores a different vocabulary (Product ID, Section 4D/15) than `Audit_Log` was written in for years (nicknames, at the time each row was logged).** It collapses any of a product's names — Product ID, nickname, the bracketed injector form — to one key: its Product ID, and `namesMatch_`/`namesMatch` (#67) consult it FIRST, before falling back to the plain canonical-key/truncation-marker comparison. Without this, migrating `Inventory` to Product IDs (`migrateInventoryToProductIds()`, Section 4D/19) would have silently broken aging: `Audit_Log`'s old `"v32"` arrival rows would no longer match an Inventory row now reading `"CIS V32 (4-Way Counterfeit Detection Unit - Battery Included)"`, since the two share no literal substring at all. Verified by replaying the real `Audit_Log` against the real workbook before the migration was run live: of the 26 rows the migration was about to rewrite, 26 had a resolvable aging anchor before this fix and only 6 did after — a **20-anchor regression** that would have shipped invisibly, each affected location simply reading "unknown age" on the heatmap for no reason a user could see. Text that isn't a product identity at all (an assembly-parent aggregate like `"100 Sleeve Kit"`, a one-off label like `"H Rack"`) falls through to the plain canonical key unchanged — this function only ever *adds* a match, never removes one. **Resolving at compare-time rather than rewriting `Audit_Log`'s historical text is deliberate**, not a shortcut: the log is an append-only historical record and a rename is not a correction to it, and a FUTURE nickname change would simply re-open the same gap if the fix were a one-off rewrite instead of a standing resolution. Client-side, the index is memoised (`window._productIdIndex`) and must be invalidated in lockstep with `window._nicknameCache` whenever `window.productMap` reloads (`JS_Network.html`) — a rename served from a stale index is the same class of bug this invariant exists to prevent.

70. **`migrateInventoryToProductIds()` (`Setup_Registry.js`) must never rewrite Inventory text that also appears in the `Assemblies` sheet, in either column.** Assembly recipes match their parent and component names by **exact string equality** (`r.parent === parentSku`/`r.child === componentSku`, `Service_Assembly.js` and the render layer, Section 18) — there is no canonical resolution between the recipe and the Inventory row it's matching against, unlike everywhere else in the app after #67–#69. So any Inventory cell whose text is also Assemblies vocabulary is load-bearing: rewriting it to a Product ID would silently detach that stock from its recipe, with no error and no symptom until the next build's pre-flight quietly can't find the component it's actually standing next to. Confirmed live by simulating a real nickname rename against the workbook before running it for real: `"100 Sleeve Kit"` (a genuine PRODUCT row, nicknamed after the rename to match its 20 Assemblies-parent rows) plus `"Burlington Scorpion Tag Case"` and `"2 Alarm SMALL Scorpion Tag (90cm)"` — 9 more rows than the ones already known to be at risk — would all have been silently rewritten and detached without this guard. The check runs AFTER the already-a-Product-ID test (so its count means "breaks prevented," not inflated by rows that were never rewrite candidates) and reports every held row by name, same log shape as every other finding in this function. **Lifting this restriction requires routing assembly matching through `productIdentityKey_` (#69) first** — until then, this guard is what keeps the two sheets from silently diverging.

### Floor Navigation & Stow (Added 2026-08-26)
71. **`window.MAP_REGISTRY` (`JS_State.html`) is the single list of navigable maps — the hamburger menu (`Index.html`) and the in-map selector (`buildMapSelector_()`, `JS_Render_Core.html`) both render from it, and neither hardcodes its own copy of the map list.** Before this, the menu was the only place maps were enumerated, and P&P had drifted to sit as an unrelated tail section under the PWH submenu (`Index.html`) rather than as its own building. The menu now groups the three physical buildings behind one "CIS Warehouses" entry (SWH/PWH/P&P), with Timing Lot and RTF Lot — both virtual, not physical buildings — as peers of that entry rather than nested inside it. **This is a navigation-only change.** `locId` prefixes (`SWH-*`/`PWH-*`/`PP-*`/`PANDP-*`/`ZONE-BUFFER`/`TIMING-*`/`RTF-*`) are completely unchanged — the prefix table earlier in this section, `renderLabels()`'s slot-classification logic, and the map click handler's floor-plan/elevation branching all key off those prefixes exactly as before. Add a new map to `MAP_REGISTRY` and it appears in both the menu and the selector automatically; add it to only one and the two will drift again, which is the exact failure this replaces.

72. **The floor-plan level picker (`openLevelPicker_()`, `JS_Handlers.html`) replaced a tap-COUNT gesture, not a tap-position gesture — the two rects were never meant to be independently tappable.** A stacked floor-plan slot is drawn as two overlapping SVG rects: a full-size outer square for the bottom level (`-L-01`) and a smaller, semi-transparent inset square on top for the top level (`-L-02`), roughly 18px inside 22px at the SVG's native scale — a few real screen pixels at floor-plan zoom on a tablet. The prior gesture (a single tap opened `-L-02` after a 350ms wait; a second tap within that window opened `-L-01` instead) worked around that by ignoring which rect was actually hit, at the cost of a delay on every ordinary tap and a silent wrong-level open on a slightly-slow double tap. The picker instead shows both levels as explicit buttons (labelled by what's actually stored on each — same occupancy filter `updateDetails()` uses, so the two views can't disagree about whether a slot reads empty) and resolves in one tap with no delay. **A slot with no `-L-02` element on the map (confirmed: 7 such PWH floor positions) is never offered a second level** — `openLevelPicker_()` checks `document.getElementById()` for the level id before offering it, so stock can't be routed to a shelf that doesn't exist on that map. `clickTimer`/`lastTapTime`/`lastTapTarget` (`JS_State.html`) backed only the removed gesture and are gone; nothing else read them.

73. **A vacant coordinate's Stow box offers a "From Temp Storage" route alongside the original free-text stow, and that route goes through `executeMove()`, not a bespoke write path.** `ZONE-BUFFER` is where every receipt lands (Section 4A/4D); before this, moving something out of it into a real slot meant either the tap-to-carry guided move or re-typing a SKU that was already recorded on receipt — an empty-coordinate card had no stow-from-buffer option even though the Stow box sitting right below it did. `commitTempStorageStow()` (`JS_Handlers.html`) calls `executeMove('ZONE-BUFFER', sku, ..., locId, qty, instanceId, false)`, so it inherits destination validation (invariant on `moveInventoryItem`'s destination check, Section 15's Move Destination Validation subsection), the known-coordinate assertion, put-away case conversion, and the server-rejection alert — the same guarantees the guided move already has — rather than reimplementing any of them. **Options in the "From Temp Storage" dropdown are keyed by instanceId, not SKU**, because `ZONE-BUFFER` routinely holds several separate rows of the same SKU (one per receipt) that are genuinely distinct batches; picking the second of two same-SKU entries must move that batch, not an arbitrary one matching the SKU. `switchStowMode_()` picks the initially-shown pane by calling it AFTER `list.innerHTML` is set, not via an inline `<script>` tag in the generated markup — a script injected through `innerHTML` never executes, which is a trap specific to this drawer's render-via-string-concatenation pattern (see Section 18's `jsCallAttr_()` note on the same pattern, invariant #65) and worth remembering before adding another dynamically-shown pane here.

74. **Unit/case quantity display (`caseBreakdown_`/`formatQtyWithCases_` in `Service_Conversions.js`, client twin `caseBreakdown`/`caseSubLine` in `JS_State.html`) always takes an explicit `qtyUnit` of `'units'` or `'cases'` — never infers it from context.** The two sides of the app have always disagreed on what a bare number means: a floor Inventory row carrying a case SKU holds a CASE count (Section 16's header comment on `Service_Conversions.js` — "538" means 538 cases), while the `SHIPMENTS` sheet's outbound quantity column is literally labelled "# of Units" (see `Service_Conversions.js`'s own file header for the fuller floor-vs-buffer unit history this decision sits on top of). Comparing the two without normalizing — or worse, displaying one where the other was assumed — is exactly the kind of silent unit confusion a shipping document should never carry. Every caller states which one it's handing in, and the function always returns both: `units` as the number to compare and display as the headline, `cases`/`remainder` alongside it only when a ratio is known. **The ratio itself is resolved from the product's own QuickBooks name** (`"Burlington 48" Siren Tag Case (... 20 units per 1 case)"`), not a second hand-maintained table — because `CASE_CONVERSIONS` does not exist in the live workbook (see #68) and 10 products already state their ratio in the QB name QuickBooks itself is authoritative for. `CASE_CONVERSIONS` still takes priority over the QB-name read when it exists, so running `setupCaseConversions()` later takes over cleanly with no code change. **Returns `null`/`hasRule:false` rather than guessing** when no ratio is known (174 of 184 products) — every caller must render the bare unit count in that case; an invented case count on a shipping card or the Totals view is worse than none. Applied to the Trello shipping-card line items (`pushOutboundToShippingSchedule.js`), the Totals view quantity column, and the Inbound Report's On Hand figure.

### Staging, Drawer Refresh & View Layout (Added 2026-08-27)
75. **There is no such thing as a "staged" location — `ZONE-STAGED` must never be reintroduced.** Staging is a Workflow Status (column D: `Staging`/`Staged`/`Labeled`), not a place: `renderLabels()` (`JS_Render_Core.html`) already recolors a slot's map fill from a row's status alone (`.staging-slot`/`.staged-slot`/`.labeled-slot`), and `generateLocalTotals()` (`JS_Handlers.html`) already routes any non-`Open` status out of `avail` and into `stage` — a pallet marked Staged never needs to move anywhere for either of those to work. The `ZONE-STAGED` virtual zone that used to exist actively broke this: moving a pallet there vacated its real rack slot, so the slot rendered empty instead of turning staged-orange. Removed entirely 2026-08-27 — `View_Staged.html`, `renderStagedView()`, the nav entry, and `ZONE-STAGED` from `VIRTUAL_ZONES` in both `moveInventoryItem()` and `moveHubGroup()` (`Service_Write.js`, see the Move Destination Validation subsection, Section 15). Any future "quick-stage" control must call `updateItemField(loc, sku, 'status', 'Staged', rowIdx)` (or route through the Adjust popup's Workflow Status dropdown, #76 below) — never a move to a zone.

76. **View layout (centered floor-plan vs. top-aligned document) is decided by two classes, `.floor-plan-view` and `.flex-doc-view` (`Styles_Base.html`), not by an id list anywhere.** Before 2026-08-27 this was a `.map-view:not(#totals-view):not(#hts-view):not(#audit-view)...` CSS exclusion chain, hand-duplicated by a *separate* id list inside `changeView()` (`JS_Render_Core.html`) deciding `display:flex` vs `block` — the two had already drifted from each other and from which views actually existed: `open-slots-view` and `wall-audit-view` were missing from the CSS list, so both got flex-centered like an SVG floor plan instead of laid out top-down, which is what produced Open Slots' "half-centered, half not" mobile bug (its `<h2>`/`<p>` shrank-and-centered as flex children while `.metrics-row-wrapper`, `width:100%`, didn't). `changeView()` now reads the SAME two classes the CSS uses (`target.classList.contains('floor-plan-view') || ...('flex-doc-view')`) instead of keeping its own copy. **A real SVG floor/rack map gets `.floor-plan-view`** (centers its content — SWH/PWH/P&P, `Index.html`'s map wrapper divs). **A document view that needs its own internal `flex-direction:column`** (Open Slots, Inventory Totals — both set it inline) **gets `.flex-doc-view`** (stretches, doesn't center). **Every other document view (QB Audit, Wall-to-Wall/Warehouse Audit, Temp Storage, Tariffs, Virtual Registry, FedEx) needs neither** — plain `display:block` is the default now, not something to remember to opt into. Add a new view and get this wrong, and it will centering-bug exactly like Open Slots did; add a new floor-plan map and forget `.floor-plan-view`, and it renders top-left instead of centered. There is deliberately only one place (this class pair) to get it right.

77. **Client-storage-based device/station identity does not belong in this app and must not be reintroduced.** Tried twice in 2026-08-27 and abandoned both times: first a blocking on-load `prompt()` writing to `localStorage` (removed because it re-asked on every load — the write silently never persisted), then a lazy prompt with a `localStorage → sessionStorage → memory` fallback chain (removed at the user's explicit request after being told the truth: it still can't be durable). The reason is structural, not a bug to fix harder: this app is `ANYONE_ANONYMOUS` (`appsscript.json`, `executeAs: USER_DEPLOYING`) with no Google login to key an identity to, and it's served through a cross-origin `googleusercontent.com` iframe where iOS WebKit can partition or block third-party storage outright — no client-storage mechanism (`localStorage`, `sessionStorage`, cookies, IndexedDB) can be made to survive that reliably. `receivePOCardItems()`'s Audit_Log tagging (`Service_Write.js`) no longer accepts or appends a `stationId`. **If per-device attribution is wanted again, it must travel in the URL** — a `?station=` query param on each device's own bookmarked link, read server-side in `doGet()` (`Service_Router.js`) and injected into the page like the other precompiled `window._serverX` values (Section 14) — since a value baked into a bookmark is the only thing here that survives a storage wipe. This has not been built; do not propose a browser-storage-based identity for this app again.

---

## 18. Assembly and Kitting System

**Added 2026-08-12 — previously zero explanation existed anywhere in this doc; `buildHardAssembly`/`explodeAssembly` were only mentioned in passing as instanceId-minting call sites.** Lives in `Service_Assembly.js`.

### What This System Does
Converts raw-material Inventory rows into a finished "kit" SKU (and back), per a recipe defined in the `Assemblies` sheet (see Section 15). Two directions:
- **`buildHardAssembly(locId, parentSku, buildQty, bulkAllocationsPayload)`** — builds `buildQty` units of `parentSku` at `locId`, consuming components per the recipe.
- **`explodeAssembly(locId, sku, qty, instanceId)`** — the inverse: breaks a previously-built kit back down into its components, restoring them to Inventory, everywhere the build has pieces.
- **`explodePartialHub(locId, pId, kitsToExplode)`** (added 2026-08-20) — a scoped inverse: breaks down only `kitsToExplode` worth of ONE build's footprint at ONE location, leaving the same build's other pallets (and the rest of this pallet, if not fully drained) untouched. See the dedicated subsection below.

> [!CAUTION]
> **Recipe matching is EXACT STRING EQUALITY against `Assemblies` columns A/B (`r.parent === parentSku`/`r.child === componentSku`) with no canonical resolution — added as a constraint worth calling out 2026-08-26, once the rest of the app stopped working this way.** Everywhere else, name comparison now goes through `namesMatch`/`productIdentityKey` (Section 17 #67–#69): exact-plus-truncation-marker, with Product ID/nickname/historical-name variants all resolving to the same identity. Assembly recipes do not get that treatment — a component's Inventory SKU must match its `Assemblies` text **exactly, character for character**, or the recipe simply doesn't see that stock. This is why `migrateInventoryToProductIds()` (Section 4D/19) unconditionally skips any Inventory row whose text also appears in `Assemblies` (Section 17 #70) — rewriting such a row to a Product ID, even though that's the correct identity everywhere else in the app now, would silently detach it from its recipe. Lifting this would mean routing `Service_Assembly.js`'s recipe filters through `productIdentityKey_` the same way naming elsewhere already is.

### Two Component Sourcing Modes
Recipe rows (`Assemblies` column D, `type`) split components into two handling paths:
| Type | Sourced From | Behavior |
|---|---|---|
| `"Affixed"` (default) | Same `locId` as the build itself | Deducted directly: `qtyPer × buildQty` pulled from whatever's at `locId` |
| `"Loose"` / `"Bulk"` | A separately-specified bulk-hub location, passed in via `bulkAllocationsPayload` (a JSON map: `{ componentSku: { bulkLocId: qtyToPull, ... }, ... }`) | Deducted from each named bulk location; the caller (client UI) decides which bulk locations to pull from and how much |

`type` is matched case-insensitively but must otherwise be exactly `"Loose"` or `"Bulk"` — anything else (including a typo like `"Looose"`) silently falls through to the `"Affixed"` default with no warning. A component recipe'd for a different build than the current one but sharing that build's location, misclassified this way, gets deducted straight from whatever's physically sitting at the build's own `locId` instead of going through the bulk picker at all — confirmed live 2026-08-19 (a `"Looose"` typo on a Sleeve Kit Accessories recipe row caused its screwdriver component to be silently consumed from a coincidentally-co-located pile, bypassing the picker, the operator's visibility into which pallet it came from, and (before the fix below) the bulk-child linkage that makes it recoverable via `explodeAssembly()`).

**Both `evaluateBuildPreFlight()`'s picker (`JS_Handlers.html`) and `buildHardAssembly()`'s own Loose/Bulk deduction (Step 2) resolve each candidate Inventory row's TRUE identity before matching it against a recipe's component SKU, not just column B.** Column B on a "Bulk" child row (see below) is stamped with the *parent* SKU of whatever build minted it — bookkeeping, not identity. A row's real identity is its `_SYS_.cSku` when `t:"B"`, or column B itself otherwise (plain rows, and Frame rows genuinely represent finished stock of their own SKU). Matching on column B alone — the original behavior — let a build "find" and consume a *different* component that was only bookkept under a matching parent SKU by coincidence (confirmed live 2026-08-19: a "Sleeve Kit Accessories" sub-build's own bulk children — alarm tops, a decoder — were offered by the picker, and reachable by the deduction step, as if they were finished Sleeve Kit Accessories stock). Fixed 2026-08-19 in both places; `t:"B"` rows are now skipped entirely as a deduction/pick target (they're never independently available stock) in favor of the genuine Frame/plain row.

### The `_SYS_` JSON Metadata (ties back to Section 15's Inventory column F convention)
`buildHardAssembly()` mints TWO kinds of linked rows, both using Inventory column F's `<note> _SYS_ <JSON>` convention:
- **One "Frame" row** at `locId`, holding the assembled kit itself: `comment = "_SYS_" + JSON.stringify({ t: "F", cIds: [childUuid1, childUuid2, ...] })`. `t:"F"` marks it as a frame; `cIds` lists the instanceIds of every child "Bulk" row it owns.
- **One "Bulk" child row per bulk-sourced component**, at each `bLoc` it was pulled from: `comment = "_SYS_" + JSON.stringify({ t: "B", pId: parentUuid, pSku: parentSku, cSku: componentSku })`. `t:"B"` marks it as a bulk-allocation child; `pId` links it back to its parent frame's instanceId; `pSku` is bookkeeping only (see above) — never treat it as the row's real identity.

`explodeAssembly()` reverses this by instanceId: it finds the frame row (by `instanceId` param or `locId`+`sku` lookup), restores its `"Affixed"` components back to `locId`, then scans for every row whose `_SYS_` blob has `t:"B"` and `pId` matching the frame's instanceId, restoring each of those components back to wherever they were bulk-allocated from, then deletes the frame row and all its found children.

> [!NOTE]
> **Fully-draining a sub-assembly's Frame via a Loose/Bulk pull now deletes that sub-assembly's own orphaned "Bulk" children too — added 2026-08-19, deliberately one-way.** Multi-level BOMs are common here (e.g. "100 Sleeve Kit" lists "Sleeve Kit Accessories" — itself a previously-built assembly — as one of its own Loose components). When such a pull (`buildHardAssembly()` Step 2) drops the source Frame's quantity to zero, every `t:"B"` row anywhere whose `pId` matches that Frame's instanceId is deleted (with a `CONVERT_OUT` log entry each) rather than left behind as a phantom "Master Hub" for a component that's actually sold out. This is intentionally **not** reversible by exploding the downstream build — re-parenting those rows to the new build instead of deleting them was considered and rejected: it would let `explodeAssembly()` double-restore (the downstream build's own direct bulk-child row for the consumed sub-assembly qty, *plus* the re-parented raw materials) unless the direct row were also suppressed at mint time, which gets materially more complex across the common case of several separate builds partially draining the same Frame. The accepted tradeoff: reversibility only matters while stock remains — once a sub-assembly's Frame hits zero there's nothing left to explode back to anyway. If the Frame only partially drains, its children are untouched and its Master Hub keeps showing normally.

> [!NOTE]
> **`moveInventoryItem()`'s handling of `t:"B"` rows was broken from schema drift until fixed 2026-08-19 — confirmed live, not just theoretical.** It used to rebuild the moved row's `_SYS_` blob from a different, no-longer-minted shape (an `f` frame-location-qty map plus a `p` field, cross-referencing a frame's `b` allocation map) on *every* move of a bulk-child row, full or partial — silently discarding `pId`/`pSku`/`cSku` and replacing them with `{t:"B", p:undefined, f:{}}`. `buildHardAssembly()`/`explodeAssembly()` have only ever used the `pId`/`pSku`/`cSku` shape; nothing in the codebase still mints the `f`/`p`/`b` shape this was written for. Net effect before the fix: moving a bulk-hub row through the UI's MOVE action correctly relocated the quantity but destroyed the row's true component label (rendered as "undefined") and its link back to its Frame (breaking that component's future `explodeAssembly()` restore). Fixed by simply carrying the already-parsed `sysData` object forward unchanged into the destination row's `_SYS_` blob — a bulk-child row's identity and Frame linkage don't change just because it physically relocated, whether the move is full or partial.
>
> **`moveHubGroup(fromLoc, toLoc, instanceIds)`** (`Service_Write.js`, added 2026-08-19) moves several rows in one atomic call, keyed by instanceId — used for relocating a whole "Master Hub" card's worth of rows together (see below) rather than one row at a time. Always moves each row's full quantity (no partial-split concept for a group) and always appends fresh destination rows rather than merging into an existing same-SKU row, since each row's `_SYS_` blob is distinct and merging would silently lose one.

### Drawer Display: Master Hub Cards Group By Build, Not By Row (`JS_Render_UI.html`, reworked 2026-08-19)
`updateDetails()`'s drawer used to render one "Master Hub" card per **parent SKU** present at a location — aggregating every `t:"B"` row sharing that column-B value into one combined quantity/label, regardless of which build minted it or what its real `cSku` was. That both mislabeled mixed-component builds (see the picker fix above) and meant MOVE could only ever reach whichever single underlying row it happened to find first. It now groups by **`pId`** instead — one card per *build's footprint at this exact location* — with an itemized "On This Pallet" breakdown (one line per distinct `cSku` that build dropped here) and a single "Linked (informational only)" reference back to the parent Frame's location. MOVE / MOVE TO… (`executeGroupMove()`/`beginGroupMove()`, `JS_Handlers.html`, via `moveHubGroup()`) relocate every row in that build's group at this location together — never rows belonging to the same build sitting at a *different* location, which stay put. The guided tap-to-carry flow (`moveClipboard`/`processMoveTarget()`/`confirmMove()`) branches on whether `moveClipboard.instanceIds` (array, group carry) or `.instanceId` (single row) is set — see the note below the "Confirmed live 2026-08-20" callout for a bug that hit the single-row side of this branch specifically.

### Partial Explode & Frame-Card Suppression (`Service_Assembly.js` / `JS_Render_UI.html`, added 2026-08-20)

**The problem this fixes:** the Frame row (e.g. "100 Sleeve Kit (Frame)", holding `buildQty` in column C) used to always render as its own normal stock-item card, in addition to any Master Hub card(s) for the same build. When the Frame's card and a Master Hub card for the same `pId` both showed at the same location — a common case, not an edge case — an operator saw e.g. "22 Kits' worth" (the purple card) AND "Current Volume: 22" (the Frame card) side by side, reading as double the actual stock. Full `explodeAssembly()` was also all-or-nothing: it always swept every `t:"B"` row anywhere sharing the frame's `pId`, so exploding one pallet's worth (e.g. releasing just the sleeves without touching the accessory-kit pallet at a different location) wasn't possible.

**Frame-card suppression:** `updateDetails()` now builds `livePIdsWithChildren`, the set of every `pId` that still has at least one `t:"B"` row *anywhere* in `window.inventoryData`. A Frame row (`sysData.t === 'F'`) is filtered out of `normalItems` — never rendered as its own card — whenever its own real instanceId (`item[7]`, **not** `item[6]` — see the Inventory schema table above's row on why `getAllInventory()` returns both) is in that set. A Frame with **zero** live children (e.g. `"Sleeve Assembly"`/`"Boot Assembly"`, both built with 100%-`"Affixed"` recipes — confirmed against the live `Assemblies` data, Section 18's Recipe Consolidation subsection) has no Master Hub card to represent it anywhere, so it keeps rendering exactly as before; otherwise it would become invisible and unexplodable. This is a client-side display rule only — the Frame row itself is untouched in the sheet, and still exists for `explodePartialHub()` to find and eventually delete.
>
> **Confirmed live 2026-08-20: this filter (and the purple card's "Build source" sibling lookup, and `moveHubGroup()`'s group-move) silently did nothing at first**, because `getAllInventory()` didn't yet return a row's real instanceId at all — only a row-number substitute (`item[6]`) that can never equal a `_SYS_` blob's `pId`/UUID values. Fixed by adding `item[7]` (see above); this is the same root cause across all three, not three separate bugs.
>
> **The same root cause resurfaced 2026-08-21 in the single-row guided-move (tap-to-carry) path, reported live as a false "product is missing from ZONE-BUFFER" rejection on Limbo → floor put-aways.** The single-row "MOVE TO…" button (`beginMove()`'s onclick, `JS_Render_UI.html`'s drawer-card template) was still capturing `item[6]` — the row number — as the guided-move clipboard's `instanceId`, instead of `item[7]`. Three downstream re-validation checks then compared that captured value against the *current* snapshot's `r[6]`: `processMoveTarget()`'s single-item branch and its pallet-group `clip.instanceIds` branch (`JS_Handlers.html`), and the tablet-reload carry-restore check (`JS_State.html`'s `onload`). Since `ZONE-BUFFER` is one of the most volatile locations in the sheet — rows constantly appended by receiving and removed by other put-aways — any background poll or reload landing between pickup and confirm shifts row numbers for a still-present, untouched item, so the revalidation would falsely conclude the stock had already moved and cancel the carry. The pallet-group branch was actually broken 100% of the time, not intermittently: its `instanceIds` were already built correctly from `item[7]` but checked against `r[6]`, which can never equal a UUID. Fixed by capturing `item[7] || item[6]` at pickup and accepting a match on either `r[6]` or `r[7]` at all three revalidation sites, so it works whether the clipboard holds a real instanceId or (for the should-be-impossible case of a row missing one) the legacy row-number fallback. **Any future guided/carry-across-refresh feature must capture `item[7]` for identity, never `item[6]`** — `item[6]` remains fine only for same-tick, no-refresh-gap calls (the plain MOVE/LIMBO/STAGED buttons that call `executeMove()` directly, with no pickup-to-confirm gap for a poll to land in).

**`explodePartialHub(locId, pId, kitsToExplode)`** partially reverses ONE Master Hub card:
1. Finds the Frame by `pId`, and only the `t:"B"` rows at exactly `locId` sharing it (this card's pieces — never rows at other locations).
2. Re-derives each piece's effective qty-per-kit server-side (`findEffectiveQtyPer_()`, a duplicate of the client-side walker in `JS_Render_UI.html` — duplicated rather than shared because client and server are separate JS runtimes here). Validates `kitsToExplode` against this card's own max; the client-side input is capped the same way but the server re-validates independently since it's the actual trust boundary for a sheet write.
3. Per piece: subtracts `effectiveQtyPer × kitsToExplode`, restores that amount to a plain (non-`_SYS_`) row at the same location (mint one if none exists), deletes the piece row if it hits 0.
4. Decrements the Frame's column C by `kitsToExplode`, floored at 0 — it is **not** deleted just because this one card emptied out.
5. **Last-piece fold-in:** re-scans the whole sheet for any remaining `t:"B"` row anywhere sharing this `pId`. If none remain, this was genuinely the build's last piece — at that point it ALSO restores the Frame's own `"Affixed"` components (never represented by any Master Hub card, since they're consumed silently at build time with no row of their own) at the Frame's home location, then deletes the Frame. This is what makes "explode every card belonging to a build, one pallet at a time" converge to the same end state as the old always-full `explodeAssembly()`, without a separate "explode everywhere" action — maxing out the input on a build's last remaining card just *is* a full explode.

Audit trail uses `EXPLODE_PARTIAL_RESTORE` (per piece) and `EXPLODE_PARTIAL_REDUCE` (the Frame decrement), distinct from full explode's `EXPLODE_RESTORE`/`EXPLODE_REMOVE` so the two paths are distinguishable in `Audit_Log`.

> [!NOTE]
> **Corrected 2026-08-21.** `getAgingData()`'s `validActions` list (Section 15/17 invariant #30, `Service_Read.js`) previously contained a phantom `"EXPLODE_ASSEMBLY"` entry — a string no code has ever actually written — instead of the real `EXPLODE_RESTORE` action `explodeAssembly()` writes when a component genuinely returns to Inventory. Fixed: `validActions` now includes `EXPLODE_RESTORE` (a true arrival event) but still deliberately excludes `EXPLODE_REMOVE` (a departure/zeroing event — the Frame row going to 0, not something arriving) and both partial-explode actions (`EXPLODE_PARTIAL_RESTORE`/`EXPLODE_PARTIAL_REDUCE` — left out for now, for consistency with the pre-fix state of the full-explode pair; `EXPLODE_PARTIAL_RESTORE` is arguably the same kind of arrival event as `EXPLODE_RESTORE` and a candidate for a future pass, but that's a separate call from fixing the phantom-string bug this note addresses).

**The same double-count also existed in `renderLabels()` (`JS_Render_Core.html`, fixed 2026-08-20) — the floor-plan/elevation view's per-cell labels, a completely separate rendering path from the drawer.** It summed every row's raw quantity per location with no `_SYS_` awareness at all, so a Frame's own `buildQty` (e.g. 22) got added directly on top of its `t:"B"` children's raw component count (e.g. 2,332), showing "Qty: 2,354" for a pallet that's actually 22 kits — confirmed live on the "Cake table" pallet from the same testing pass. Fixed the same way: bulk children grouped by `pId` and shown via `deriveKitEquivalent_()` (e.g. "22 Kits") instead of a raw sum, Frame rows excluded from the total wherever their `pId` still has live children. A location holding both ordinary stock and a Master Hub build shows both segments joined with `" + "` (e.g. `"40 + 22 Kits"`) rather than picking one.

**Purple card additions to go with this** (`JS_Render_UI.html`): an inline "Explode Kits From This Pallet" number input (capped to that card's own kit count) + EXPLODE button, wired to `explodeHubPartial()` (`JS_Handlers.html`) → `explodePartialHub()`; disabled with an inline note (not silently hidden) when `deriveKitEquivalent_()` returns `null` for that card, since there's no reliable per-kit ratio to explode against; a title reorder — piece name leads, parent kit in parens (e.g. *"Sleeve Kit Accessories (100 Sleeve Kit)"*) — specifically when the card's single piece is itself a recipe parent elsewhere (a sub-assembly built in its own right), since standing at that pallet the sub-assembly IS what's physically there; and an "Also part of this build" sibling-location list (Frame's own home location, plus every other location holding a `t:"B"` row for the same `pId`) with jump-to buttons, since a build's bulk children can be split across several separate pallets with no other way to find them from one card.

### Performance: SS_API Batch Writes
Both `buildHardAssembly()` and `explodeAssembly()` prefer `SS_API` (`Service_SheetsAPI.js` — see below) for all Inventory/Audit_Log writes when it's defined, falling back to per-cell/per-row `SpreadsheetApp` calls otherwise. This matters because a single assembly build can touch many rows at once (every affixed component, every bulk allocation, the new frame row, every new child row, plus an `Audit_Log` line for each) — batching these into one or two network calls instead of one-per-cell is the entire reason `SS_API` exists.

### `SS_API` (`Service_SheetsAPI.js`)
A small wrapper around the Advanced Sheets API v4 (`Sheets.Spreadsheets.*`, not `SpreadsheetApp`), exposing three batch methods: `batchUpdateValues(updates)`, `batchAppendRows(sheetName, rows)`, `batchDeleteRows(sheetId, rowIndices)`. Used by `Service_Assembly.js` (both functions above) for performance on multi-row writes. On error, each method logs via `Logger.log` and **re-throws** — it does not silently degrade (see Section 19's note on the related, previously-mischaracterized P3-3 concern). The `if (typeof SS_API !== 'undefined')` guard seen throughout `Service_Assembly.js` checks whether `Service_SheetsAPI.js` loaded as a file in the project at all, NOT whether the Advanced Sheets Service toggle is enabled — those are two different failure modes with different symptoms.

Audit_Log actions logged by this system: `CONVERT_OUT` (component consumed into a build), `CONVERT_IN` (frame/child row minted), `EXPLODE_RESTORE` (component returned to Inventory on explode), `EXPLODE_REMOVE` (the kit itself removed on explode). **Corrected 2026-08-21:** only `CONVERT_IN` and `EXPLODE_RESTORE` are arrival-type events and belong in `getAgingData()`'s `validActions` list (Section 15/18's note above) — `CONVERT_OUT`/`EXPLODE_REMOVE` are departure events and are correctly excluded from it.

### Recipe Consolidation (Added 2026-08-17)

The live `Assemblies` tab previously held a small (16-row) hand-typed draft covering only Sleeve Assembly/Boot Assembly plus a handful of malformed "ADDON" rows (multi-value cells like `Qty_Required: "5,000;11,000"` and a combined parent name `"100 Sleeve Kit ADDON, BOOT ADDON"` — removed by the user before this pass). The user separately maintained a full recipe breakdown across 19 tabs in a standalone `Assemblies.xlsx` workbook (one tab per assembly: `CIS 100 Sleeve Kit`, `Homegoods`, `Sierra 24/27/30 Boots`, `Sierra`, `Homesense`, `TJX NewRelo`, `Cake table`, `RF Labels`, `RF Rollout`, `TJX Rollout`, `Sleeve Assembly`, `Boot Assembly`, and 5 Burlington tag-case tabs) — every tab already used the exact `Parent_Assembly/Component_Part/Qty_Required/Type` columns `getAssemblyData()` reads.

`consolidateAssemblyRecipes()` (`Setup_Registry.js`) flattens all 19 tabs into one 74-row table and replaces the `Assemblies` tab's data rows with it (idempotent, clears + rewrites, same pattern as `setupV3Registries()`). Two corrections were made during consolidation, both confirmed with the user 2026-08-17 before shipping:
- **Component names resolved to PRODUCT's canonical `Full QB SKU Name`** wherever they refer to a real stocked SKU (e.g. `"CIS GEN6 ALM"` → `"CIS GEN6 ALM (AS5518B - Alarm top for GEN6 tether)"`, `"v32"` → `"CIS V32 (4-Way Counterfeit Detection Unit - Battery Included)"`), using the same Nickname/prefix matching as `resolveCanonicalItemName_()` (Section 4D). Where a component instead names another assembly built by this same table (e.g. `"Sleeve Assembly"` inside `"100 Sleeve Kit"`, `"Boot Assembly"` inside the Sierra boot kits, `"RF 500"`...`"RF 11,000"` inside `"RF Roll Out"`), the name is left matching that assembly's own `Parent_Assembly` value exactly — **including one casing fix**: the Sierra 24/27/30 Boots tabs referred to `"Boot assembly"` (lowercase) while the Boot Assembly tab itself is `"Boot Assembly"` (capital A); `buildHardAssembly()`'s Inventory lookup is an exact string match, so this would have silently found zero components to deduct. Normalized to the capitalized form.
- **The three Sierra boot-kit source tabs (24/27/30 Boots) originally all named their `Parent_Assembly` `"24 Boot Kit"`, even the 27/30 tabs** — a copy-paste artifact that would have blended three different recipes under one name via `buildHardAssembly()`'s exact-match filter. The user corrected the source tabs directly (confirmed 2026-08-17) before this consolidation ran; no runtime renaming happens in `consolidateAssemblyRecipes()` itself.

> [!NOTE]
> Several `PRODUCT` `Full QB SKU Name` values are themselves truncated in the live workbook (end in literal `"..."` — a pre-existing data issue, also noted in Section 19's `populateBrandCatalogKeywords()`). Those truncated strings are used as-is in the consolidated recipe table rather than guessed at, since `resolveCanonicalItemName_()` would write that same truncated value to `Inventory` column B at receiving time — the exact-string match stays internally consistent even though the name looks cut off. Fix the source `PRODUCT` rows directly if the full names are wanted.
>
> Multi-level kits need **no code change** — `buildHardAssembly()` is already called level-by-level by warehouse staff (e.g. build `Boot Assembly` into Inventory first, then build `24/27/30 Boot Kit` from it), so a flat recipe table with several parent levels works as-is; nothing in `Service_Assembly.js` recursively explodes a multi-level BOM in one call, and none was needed here.

---

## 19. Utility, Ingestion & One-Off Scripts

**Added 2026-08-12, extended 2026-08-13 (`Setup_Registry.js`'s one-off repair functions, and the `BUILD_VERSION` reload removal below).** These files/functions exist in the project but were never referenced anywhere in this document before those passes. Each is summarized with its actual current status — several are genuinely broken or dead, not just undocumented, which is worth knowing before anyone assumes they're working background infrastructure.

### Active production paths (just weren't named/explained before)

**`Service_PO_Ingest.js` — PDF Purchase Order OCR Ingestion.** Entry point `processUploadedPOFile(payload)`, called from `JS_Handlers.html`'s `handlePOFileUpload()` (a file-upload UI, "Phase 6" per its own header comment). Flow: client base64-encodes an uploaded PDF → server decodes it, runs it through Google Drive's OCR conversion (`Drive.Files.insert(..., {ocr:true})` → `DocumentApp` text extraction, with the temp file cleaned up immediately after) → `parseQuickBooksPOText()` regex-parses the OCR'd text for PO number, date, vendor, and a line-items table (assumes a QuickBooks PO PDF layout specifically — a differently-formatted PDF will silently extract fewer/zero line items, not error) → each line item's SKU is resolved against the PRODUCT sheet first (via `getProductMap()`, same canonical catalog the Trello Injector's autocomplete uses), falling back to `BRAND_ITEM_CATALOG` keyword matching (`matchCatalogSKU()`) only if no direct match. Returns a structured preview (part #, canonical SKU, description, qty) that the client renders in a table — it does not itself write to Trello or Sheets; it's a parse-and-preview step.

**`pushOutboundToShippingSchedule.js`** — already documented in Section 9, minor drift noted here: the Burlington source-sheet ID cited in Section 9's client-config table doesn't exactly match the (truncated-looking) literal in current source. Worth a quick live check next time this file is touched, not urgent on its own.

**`Setup_Registry.js` — one-off setup and repair functions, run manually from the Apps Script editor (added 2026-08-13, previously only `setupV3Registries()` was named in this document, in Section 9).** None of these run on a trigger; all are safe-by-design to re-run (checked-before-write or explicitly documented as idempotent):
- **`setupV3Registries()`** — already documented (Section 9): creates/reseeds `CUSTOMER_REGISTRY` and `BRAND_ITEM_CATALOG`. Re-running **clears and rewrites all data rows** in both (headers preserved) — do not run against a live registry that's been hand-edited since without checking first.
- **`headerAuditLog()`** — writes real header text onto `Audit_Log` row 1 (columns G/H previously shipped with no headers at all, column C had a typo, `"SKY"`). Only touches row 1, never data rows.
- **`formatAllSheetHeaders()`** — bolds and freezes row 1 on every core data sheet (`SHIPMENTS`, `CUSTOMER_REGISTRY`, `BRAND_ITEM_CATALOG`, `Shipment_History`, `Inventory`, `TOTALS`, `QB_Audits`, `Assemblies`, `Multi Piece Tracking`, `MPS Backend`, `PRODUCT`, `HTS_Inputs`, `HTS_Data`) that isn't already formatted that way, and fills the one confirmed-missing header (`Inventory` column G → `Instance_ID`). Calls `headerAuditLog()` internally rather than duplicating it. Deliberately excludes `Config` (an append-only diagnostics log, not something anyone sorts by header) and `Naming Conv` (free-form reference, not tabular).
- **`populateBrandCatalogKeywords()`** — fills specific blank `Keywords` cells in `BRAND_ITEM_CATALOG` (see the Section 9 `[!WARNING]` this partially addresses) with high-confidence literal vendor part codes mined from real Trello checklist exports — matches by `Brand_ID` + `Canonical_SKU` prefix (several `PRODUCT` values are themselves truncated in the live workbook) rather than exact string. Only writes cells that are currently blank, never overwrites a hand-entered keyword.
- **`fixCustomerRegistryGaps()`** — fills a specific known gap in `CUSTOMER_REGISTRY` (the `"AEO Inc" / "TS"` row shipped with blank `Brand_Name`/`Regex_Aliases`, which made `getChainFromRecord()` skip it entirely and misclassify TS Store cards as Burlington via board-name fallback). Only writes the two specific blank cells for that one row.
- **`fixMisdirectedInboundRows(dryRun)`** — the repair for the webhook direction-resolution bug documented in Section 13's RESOLVED note. Scans SHIPMENTS for rows where `boardSource` matches a known inbound board name (`"PURCHASE ORDERS"`, `"NICOLE POS"`) but `Direction` reads `"Outbound"`, and corrects column B only. **Defaults to a dry run** (`dryRun` undefined or `true` → logs every mismatched row, writes nothing); pass `false` to apply. Confirmed run live 2026-08-13 against a real Burlington PO card — 3 rows fixed.
- **`cleanupOrphanedBulkHubChildren(dryRun)`** (added 2026-08-19) — retroactive counterpart to the drain-to-zero cleanup `buildHardAssembly()` now does automatically going forward (Section 18). Deletes any `t:"B"` Inventory row whose `pId` doesn't match any row's instanceId currently in the sheet (i.e. its parent Frame was already fully consumed by builds that ran *before* that fix existed, so nothing ever cleaned up its own bulk children). **Defaults to a dry run**; pass `false` to apply. Needed once to clear out pre-existing orphaned rows (confirmed live 2026-08-19: a fully-consumed Sleeve Kit Accessories build's 9,652 units of raw components); the ongoing case is handled automatically now and shouldn't need re-running unless a Frame row is ever hand-edited/deleted outside the normal build/move/explode paths.
- **`reportNicknameCollisions()`** (added 2026-08-26) — read-only audit, writes only to its own `Nickname_Audit` tab (fully rewritten each run). Reports duplicate nicknames, a nickname that is a prefix of another (the class of bug Section 17 #67 fixes), blank nicknames, Inventory rows resolving only loosely under the OLD substring-match convention (a worklist for what would stop resolving once matching goes strict), and `CASE_CONVERSIONS` rules whose prefix matches a product's QB name but not its nickname (see #68 — these rules die silently once a row is nickname/Product-ID-keyed instead of raw-QB-text-keyed). Meant to run BEFORE any nickname rewrite, as the pre-flight worklist — see Section 4D and the v16 changelog entry.
- **`migrateInventoryToProductIds(dryRun)`** (added 2026-08-26) — see Section 4D for the full pipeline this completes and Section 17 #70 for its Assemblies guard. **Defaults to a dry run**; pass `false` to apply. Rewrites an Inventory SKU cell to its Product ID only when the cell's text is an unambiguous nickname of exactly one product, is not already a Product ID, and does not appear anywhere in `Assemblies`. Idempotent — a second run against already-migrated data reports 0 rewrites. Run live 2026-08-26: 251/17/31/11 (already-correct / rewritten / Assemblies-held / unmatched).

> [!NOTE]
> **RESOLVED — the duplicate `refreshData()` this warning used to describe has been cleaned up.** `JS_Network.html` no longer defines its own `refreshData()`/`loadTodayAudits()`; both now live in exactly one place each — the store's fetchers in `JS_Store.html`, with thin post-write shims (`refreshData()`, `loadTodayAudits()`) over them in `JS_Handlers.html`. If you're touching either of those functions, they're no longer at risk of the GAS global-namespace-shadowing bug class this section otherwise warns about.

### Intentionally removed functionality (not a bug — noted so it isn't "fixed" back in)

**`BUILD_VERSION`-driven client auto-reload, removed 2026-08-13.** `Service_Read.js`'s `BUILD_VERSION` constant used to be compared, on every logistics-dashboard poll, against the value baked into the page at load (`window.CIS_BUILD_VERSION`, `JS_State.html`) — a mismatch triggered `location.reload()` (in `JS_Store.html`) so an open tablet would pick up new JS shortly after a redeploy, without anyone touching it. This was itself already the *safe* replacement for an even older mechanism that injected an `<img onerror>` payload into rendered dashboard data for the client to execute — a real XSS vector against anyone viewing the FedEx ledger while a reload was armed. The safe version worked, but every forced reload re-triggered Google's own "not verified by Google" interstitial banner on the Apps Script web app URL (since a reload is, from Google's perspective, a fresh page load of an unverified app) — worse in daily use than the stale-JS problem it fixed. `BUILD_VERSION` itself was kept (still stamped on every poll response, still visible in `JS_Diagnostics.html`'s environment panel for confirming what's actually deployed to a given device) — only the auto-reload behavior was removed. See Section 17 invariant #34.

### Dead, broken, or unwired-up code — flagged so nobody assumes these are working

> [!WARNING]
> **`OneDrive_Graph_Sync.gs.js` is broken as currently wired — a Script Property name mismatch means it can never find the file it's supposed to sync.** `discoverDualSharedFileIds()` (the one-time "lock in this file's ID" step) writes suffixed property keys: `ONEDRIVE_DRIVE_ID_1`/`ONEDRIVE_ITEM_ID_1` (for one file) and `_2` (for a second file). But `syncOneDriveExcelToSheet()` (the actual recurring sync function, intended to run on a 15-30 min trigger per its own comment) reads the **unsuffixed** `ONEDRIVE_DRIVE_ID`/`ONEDRIVE_ITEM_ID` — properties that `discoverDualSharedFileIds()` never writes. Unless someone has manually copied one file's suffixed values into the unsuffixed property names outside of any script in this repo, this sync has never actually run successfully. Additionally, the intended final step — pushing synced data into the Trello pipeline — is left as a commented-out placeholder (`// 5. TRIGGER YOUR EXISTING TRELLO UPSTREAM LOGIC HERE`), so even a working sync today would only land data in a raw `"OneDrive Import"` sheet tab and go no further. Not referenced anywhere in Section 12's trigger inventory. If this feature is wanted, it needs: (1) the property-name mismatch fixed or the dual-file design simplified to one file, and (2) the Trello push step actually implemented.

**`diagnosticScraper.js`** — manual, developer-run only (no trigger, no menu wiring found). `diagnosticScraper()` cross-references SHIPMENTS rows against live Trello card state (labels/checklists) and writes a human-readable comparison log to a timestamped Drive text file. Read-only against SHIPMENTS/Trello. Useful for spot-checking sync accuracy, not part of any pipeline.

**`jsonscraper.js`** — manual backup utility. `exportAllTrelloBoardsToJson()` dumps every Trello board (cards/lists/checklists) to timestamped JSON files in a Drive folder. Not on a trigger, not called elsewhere. Worth running before any risky Trello-side change (list renames, board restructuring) given how much of this system depends on exact list-name string matching (Section 6, `Shared_Classifiers.js`) — but nothing automates that today.

**`scraper.js`** — manual dev tool. `generateLocationDoc()` scrapes `id=` attributes out of every `Map_*.html` SVG floor-plan file to reverse-engineer the current full list of valid warehouse location codes (PWH/SWH/PP), dumping them into a new Google Doc. Useful when auditing whether Inventory `locId` values still correspond to real map locations after a floor-plan edit. Not part of any pipeline.

**`TrelloInjector.html`'s backend RPC surface** — the checklist-format contract (`"[ProductID] Description | QTY: X | RCVD: Y"`) is documented in Section 4D, but the individual server functions it calls were never enumerated: `getSkuCatalog()`, `getTrelloBoards()`, `getTrelloLists()`, `getTrelloCardsByList()`, `getExistingCardChecklist()`, `createTrelloCard()`, `moveTrelloCard()`, `injectPOChecklist()` (all in `Service_Read.js` — none in `Service_Write.js`). Listed here as a pointer for anyone tracing this feature's full call graph — not re-documenting each function's internals, which are straightforward Trello API wrappers.

**`updateHtsDataSheet.js`** — `syncLocalHtsCacheWithGovernment()` feeds the already-documented `HTS_Data` tab (Section 15) but was never named or explained itself, and isn't in Section 12's trigger inventory (unclear if it runs on a trigger or is manual-only — not confirmed in this pass). Reads a government tariff reference file from Drive (`HTS_FILE_ID` Script Property), prefix-matches HTS codes against it to find base duty rates, and looks for Section 301/232 surcharge footnote codes. **Note**: this pass did not re-verify `HTS_Data`'s exact column semantics against this script's actual read/write indices the way Section 15's Inventory/Audit_Log tables were re-verified — treat the existing `HTS_Data` column table with slightly less confidence than the rest of this document until someone does that same close-reading pass on it specifically.

---

> [!TIP]
> **How to use this document with Gemini**: Feed this entire schema.md as system context along with any source file you're modifying. This gives Gemini the full picture of status values, column positions, function dependencies, and invariants — preventing the "silly changes" that happen when context is missing.
