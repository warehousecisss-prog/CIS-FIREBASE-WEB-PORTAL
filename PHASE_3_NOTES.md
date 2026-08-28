# Phase 3 — the HTTP route layer

**Date:** 2026-08-28
**Baseline:** `210ac20` (end of Phase 2)
**Scope:** one route per server call the SPA makes, a common `runMutation`
wrapper, and `index.js` split into something that stays readable.

Phase 4 (`Service_Dates` parity, sync/webhook functions, frontend views) not
started.

---

## 1. How the route list was derived

Not from the SPA and not from my guess. The contract is what the **original's
client actually invokes**, so it was extracted mechanically:

1. Every top-level `function name(...)` declared in `SRC/src/*.js` → the set of
   things Apps Script exposes to `google.script.run`.
2. Every call of the form `.name(` in `SRC/src/*.html`, plus `Index.html`'s
   `<?= name() ?>` scriptlets, intersected with that set.

Both the `google.script.run.withSuccessHandler(...).fn(...)` chains and the
`runQuery('label', function (r) { r.fn(...) })` closures are covered, because
the intersection does not care which shape the call site uses.

**Result: 64 distinct server functions.** That list, with the SRC call site and
the argument order each one is called with, is encoded as data in
`functions/test/routes_contract.js` (`CONTRACT`) so it is machine-checked
rather than prose that drifts.

> Two of those 64 turned out to be called with **more arguments than the ported
> service accepts**. Both are in §4.

---

## 2. The `runMutation` contract

`functions/http/wrappers.js`. Named to match `window.runMutation` /
`window.runQuery` in `SRC/src/JS_State.html`, which exist for the same reason
one layer out: AUDIT A1/A2, the server's real error strings being discarded on
the way to the operator.

Five rules, all tested (§6):

| # | Rule |
|---|---|
| 1 | **`context` is the Express `req`, passed straight into the service.** That is what `getActiveUserEmail(context)` reads, so every `Audit_Log` row written under a route is attributed to the signed-in operator. |
| 2 | **`{success:false}` → non-2xx carrying the service's own text verbatim.** Both spellings are honoured — `Service_Write`/`Assembly`/`Dates`/`Diagnostics` return `error`, `Service_Read`/`PO_Ingest` return `message` (§4, F10). A wrapper that only knew `error` would blank all 55 of `Service_Read`'s refusals. |
| 3 | **A refusal is a 422, a throw is a 500.** Never a 200, never a generic "Internal Server Error". 422 says the request was well-formed and authenticated and the service declined it for a business reason it has already explained; 500 stays reserved for a genuine fault so it is findable as one in the logs. |
| 4 | **A mutation resolving to `undefined`/`null` is a 500, not a success.** That is AUDIT A1 exactly — `modifySheetRow` falling off the end while the caller answered `{success:true}`. Phase 1 fixed the service; this makes it unreintroducible from the route layer. Reads are held to the same standard. |
| 5 | **The whole result object is echoed.** Partial outcomes survive — `receivePOCardItems`' `trelloSynced:false` + `failedItems[]`, `findOrCreatePOCardAndInject`'s `requiresManualReview`. Only `error` is normalised. |

### Why 422 rather than per-error status codes

Mapping "Row not found" → 409, "Server busy" → 503 and so on means matching on
error *text*, which breaks the first time someone rewords a message. A single
deliberate code keeps the status honest ("refused, see the body") and leaves the
client discriminating on the string the service actually wrote — which is what
the original's client does too.

### `notImplemented`, not 404

Ten of the 64 calls have no ported service behind them. They still get a real
route, answering **501** with the original function name and what it is waiting
on. A 404 is indistinguishable from a typo'd path and sends whoever hits it
looking in the wrong place; a 501 naming `Fedex_Master_Script.js` is a finished
answer.

### Read vs mutation

Reads are `GET`, mutations are `POST`, and every response carries
`X-CIS-Route-Kind: read | mutation | unimplemented`. The header means a HAR or a
log line is self-describing without pattern-matching the path.

---

## 3. Route inventory — 71 routes

`index.js` now holds app assembly, the auth middleware and `/me`; everything
else lives under `functions/http/`:

```
functions/http/wrappers.js            runMutation / runQuery / notImplemented
functions/http/routes/index.js        the registry
functions/http/routes/boot.js         GET /boot  (see §5)
functions/http/routes/catalog.js      boot reads + reference data
functions/http/routes/inventory.js    inventory reads + the drawer mutations
functions/http/routes/audit.js        the wall-to-wall audit flow
functions/http/routes/assembly.js     build / explode
functions/http/routes/trello.js       injector + receiving/outbound cards
functions/http/routes/po.js           PO ingest
functions/http/routes/shipping.js     Service_Dates + FedEx
functions/http/routes/diagnostics.js  diagnostics + the RXO test harness
```

`attachIdentity` and `requireAuth` stay on the **app**, not the routers: an
`app.use()` cannot be forgotten by a new route module, whereas a per-router
`requireAuth` is one omission away from an open mutation endpoint.

Routes are mounted flat rather than under per-domain prefixes — `/inventory`
and `/logistics-dashboard` are already live, and `/shipment`, `/po-ingest` and
`/diagnostics` are already spelled out in `frontend/src/api.js`. Prefixing
would have broken all five for tidiness.

### The 64 SRC client calls

| SRC function | Route | |
|---|---|---|
| `getProductMap` | GET /products/map | |
| `getAssemblyData` | GET /assembly/data | |
| `getHeatmapWindowThresholds` | GET /heatmap-thresholds | |
| `getAllInventory` | GET /inventory | |
| `getAgingData` | GET /inventory/aging | |
| `getSkuLastUpdatedMap` | GET /inventory/sku-last-updated | |
| `getTodayAudits` | GET /audits/today | |
| `getLogisticsDashboardData` | GET /logistics-dashboard | |
| `getInventoryTotals` | GET /inventory/totals | |
| `setTotalStock` | POST /inventory/set-total | |
| `setTotalStockByRow` | POST /inventory/set-total-by-row | |
| `updateStock` | POST /inventory/update-stock | |
| `updateInventoryByRow` | POST /inventory/update-stock-by-row | |
| `addNewItemToLocation` | POST /inventory/add-item | |
| `updateInventoryField` | POST /inventory/update-field | |
| `updatePalletComment` | POST /inventory/comment | |
| `moveInventoryItem` | POST /inventory/move | **F1** |
| `moveHubGroup` | POST /inventory/move-hub-group | |
| `splitInventoryRow` | POST /inventory/split | |
| `removeItemFromLocation` | POST /inventory/remove | |
| `getAuditWorklist` | GET /audits/worklist | |
| `processAuditAction` | POST /audits/action | |
| `bulkVerifyAuditLocations` | POST /audits/bulk-verify | |
| `markAuditComplete` | POST /audits/complete | |
| `buildHardAssembly` | POST /assembly/build | |
| `explodeAssembly` | POST /assembly/explode | |
| `explodePartialHub` | POST /assembly/explode-partial-hub | **501** |
| `getTrelloBoards` | GET /trello/boards | |
| `getTrelloLists` | GET /trello/boards/:boardId/lists | |
| `getTrelloBoardLabels` | GET /trello/boards/:boardId/labels | |
| `getInboundPoBoardLabels` | GET /trello/inbound-po-board/labels | |
| `getTrelloCardsByList` | GET /trello/lists/:listId/cards | |
| `getCardLabels` | GET /trello/cards/:cardId/labels | |
| `getExistingCardChecklist` | GET /trello/cards/:cardId/checklist | |
| `getCardShippingReference` | GET /trello/cards/:cardId/shipping-reference | |
| `createTrelloCard` | POST /trello/cards | |
| `moveTrelloCard` | POST /trello/cards/move | |
| `updateCardLabels` | POST /trello/cards/labels | |
| `setCardShippingReference` | POST /trello/cards/shipping-reference | |
| `findOrCreatePOCardAndInject` | POST /trello/po-card/find-or-create | **F3** |
| `injectPOChecklist` | POST /trello/po-card/inject-checklist | |
| `getCustomerRegistry` | GET /customer-registry | |
| `getSkuCatalog` | GET /sku-catalog | |
| `getInjectorUrl` | GET /injector-url | |
| `receivePOCardItems` | POST /receiving/po-card-items | |
| `processPackedOutboundCard` | POST /outbound/process-packed-card | |
| `processUploadedPOFile` | POST /po-ingest | |
| `reresolvePOForVendor` | POST /po-ingest/reresolve | |
| `emailPOPdfToSupplier` | POST /po-ingest/email-supplier | **501** |
| `updateShipmentReadiness` | POST /shipment | |
| `estimateShippingWindowV2` | POST /shipping/estimate-window | **F4** |
| `estimateShipByDateV2` | POST /shipping/estimate-ship-by | **501** |
| `stageBulkFedExTrackingNumbers` | POST /fedex/stage-tracking | |
| `markFedExChildDeliveredInSheet` | POST /fedex/mark-child-delivered | |
| `batchCalculateTransitTimes` | POST /fedex/batch-transit-times | **501** |
| `getEstimatorOriginZip` | GET /fedex/estimator-origin-zip | **501** |
| `getEstimatorRtfOriginZip` | GET /fedex/estimator-rtf-origin-zip | **501** |
| `fetchPrecompiledHtsData` | GET /hts/precompiled | |
| `syncLocalHtsCacheWithGovernment` | POST /hts/sync | **501** |
| `submitDiagnosticReport` | POST /diagnostics | |
| `logDisplayDiagnostic` | POST /diagnostics/display | |
| `getRxoConfigStatus` | GET /rxo/config-status | **501** |
| `rxoRunDiagnostics` | POST /rxo/diagnostics | **501** |
| `rxoTestShipmentLookup` | POST /rxo/shipment-lookup | **501** |

### The other 7 routes

Not SRC client calls, and each is here for a stated reason:

| Route | Why |
|---|---|
| `GET /boot` | §5 — the SPA replacement for the original's precompiled page load. |
| `GET /shipping/transit-lane-catalog` | `getTransitLaneCatalog()` is precompiled into `Index.html` as `window._serverTransitLaneCatalog` (`Service_Router.js:78`); the cascading Transit Type → Origin → Destination → Port dropdowns read it. No template pass in the SPA ⇒ it needs an endpoint. |
| `GET /products/list`, `GET /brand-item-catalog` | Exported by the services, consumed server-side in SRC. Cheap, and beside their siblings. |
| `POST /inventory/reserve` | `reservePallet` is an exported `Service_Write` mutation on the same `modifySheetRow` contract with no SRC client call site. Reachable so the next caller does not invent a second way in. |
| `POST /inventory/clean-vacant-rows` | Housekeeping sweep; a menu action in SRC. |
| `GET /diagnostics/validate-registries` | `validateRegistrySheets`; a menu action in SRC. |

### 10 unported calls behind 501s

`explodePartialHub` · `emailPOPdfToSupplier` · `estimateShipByDateV2` ·
`batchCalculateTransitTimes` · `getEstimatorOriginZip` ·
`getEstimatorRtfOriginZip` · `syncLocalHtsCacheWithGovernment` ·
`getRxoConfigStatus` · `rxoRunDiagnostics` · `rxoTestShipmentLookup`

Three whole files account for seven of them: `Fedex_Master_Script.js`,
`updateHtsDataSheet.js`, and the missing half of `Service_RXO.js`. Worth noting
that the ported `Service_RXO` exports the three **live** lookups
(`getRxoShipmentDetails` / `getRxoOrderStatus` / `getRxoCustomerInvoices`) plus
`rxoTestHarness` — and `RXO_Test.html` calls **none** of them. The ported half
and the used half are disjoint.

---

## 4. What was found wrong along the way

Ten findings. Four were fixed (F1, F3, F7, F8); the rest are reported.

### F1 — `moveInventoryItem` had lost `clientAssertsKnownCoordinate` — **FIXED**

`SRC/src/Service_Write.js:274` takes **7** parameters ending in
`clientAssertsKnownCoordinate`, and `JS_Handlers.html:4511` passes it:

```js
.moveInventoryItem(fromLoc, toLoc, sku, qty, isHubMove, instanceId,
                   isKnownFloorCoordinate(toLoc))
```

The port's signature ended `..., instanceOrRowId, context)` — `context`
occupying the 7th slot, the parameter itself gone, and the `else if
(!clientAssertsKnownCoordinate)` branch collapsed into an unconditional
rejection. Effect: **every move to a real floor coordinate that has never held
anything failed** with *"Unknown destination … Move rejected rather than
creating a new one."* The client has already checked that coordinate against
the SVG-scraped slot list; the whole point of the flag is to tell the server
"no row is not the same as no such place".

Fixed, because the route cannot honour the client contract without it. The sister
function `moveHubGroup` still had its copy of the parameter and its `else if`,
which is what made the divergence obvious.

### F2 — `moveInventoryItem`'s `VIRTUAL_ZONES` still contains `ZONE-STAGED` — reported

Port: `['ZONE-BUFFER', 'ZONE-STAGED']`. SRC: `['ZONE-BUFFER']`, with a comment
dated 2026-08-27 — *"staging is a status (column D), not a destination; no
client-side path can send a move here anymore, and the server should reject one
just as it would any other unrecognized destination"*. Not fixed: it is a
behaviour change the route layer does not need, and it is one token, so it is
better decided deliberately than folded into a route commit.

### F3 — `findOrCreatePOCardAndInject` was creating Trello labels — **FIXED**

Two problems in one block:

- `SRC/src/Service_Read.js:1211` takes `(parsedPO, idLabel)` and
  `TrelloInjector.html:786` passes the ingest UI's Customer Label dropdown
  value. The port's signature was `(parsedPO)`.
- In place of SRC's "resolve `idLabel`, else match an **existing** board label
  by exact vendor name, else leave the card unlabeled", the port did
  `POST /cards/{id}/labels` with a colour and a name — i.e. it **created a new
  label** — gated on `parsedPO.labelColor`, a field nothing in the parse path
  ever sets.

That created-label behaviour is exactly what SRC's comment says was removed on
2026-08-21, after the Purchase Orders board was found carrying both
`BURLINGTON INVENTORY` and a typo'd `BURLINTON INVENTORY`, and a fresh
`Nordstrom` beside the board's real `NORDSTROM`.

Fixed. It is a blocker for the route contract (the second argument has to go
somewhere), and it is an **outward-facing side effect on a live Trello board**,
which is not something to expose a new endpoint to and then write a note about.

### F4 — `estimateShippingWindowV2` has lost its `port` parameter — reported

`SRC/src/Service_Dates.js:885` is
`(readyDateStr, travelType, origin, destination, port, loadType)`; the port is
5-arg with no `port`, and its `findTransitLane_` is missing both SRC's
`opts.port` narrowing block and `resolveTransitDestinationCluster_`. So a
destination fed by more than one port resolves to whatever the slowest-wins
default picks — the precise bug `JS_Handlers.html:2322` says splitting
Destination and Port into two steps was introduced to fix.

This is `Service_Dates` parity (Phase 4), not route work. The route accepts
`port`, does **not** pretend it was honoured, and `logger.warn`s naming the
supplied port and destination whenever one is sent.

### F5 — `getAllInventory` drops the Instance_ID column — reported

Port reads `Inventory!A:F` and returns 7 fields. SRC reads columns 1–7 and
returns **8**, the last being column G (`Instance_ID`), with a comment
explaining that index 6 must stay the row number for the dual-mode
`modifySheetRow`/`moveInventoryItem` typeof dispatch, and that index 7 is the
row's *stable* identity — needed by `JS_Render_UI`'s Master Hub
frame-suppression and sibling-location logic, and by `moveHubGroup`.

Consequence: `POST /inventory/move-hub-group` exists but the client has no way
to obtain the `instanceIds` it takes. Reported rather than fixed — it is
`Service_Read` parity and changes a payload shape the (placeholder) frontend
reads.

### F6 — `getAllInventory` returns `null` where SRC rethrows — reported

AUDIT A4, called out in SRC's own catch block: returning `null` made
`getInventoryTotals()` and `getAuditWorklist()` fail inside *their* catch-alls
and degrade to `{}`/`[]`, so a fetch failure reached the operator as a data
finding — "no match" on every On Hand cell, an empty audit queue reading as
"nothing to audit". SRC throws `"Could not read the Inventory sheet: …"`.

Not fixed (Service_Read parity), but the wrapper's rule 4 converts the `null`
into a **500**, so it can no longer arrive as `200 null`. `GET /boot` also
records it in `bootIssues` rather than serving it as an empty warehouse.

### F7 — the old `/inventory` route's aging injection never worked — **FIXED**

The previous handler did:

```js
inv.forEach(row => { row.agingDays = diffDays; });
res.json(inv);
```

`row` is an **Array**, and `JSON.stringify` drops non-index properties on
arrays — so `agingDays` has never once reached the browser. SRC does not do
this either: `JS_Store.html` fetches `getAgingData()` as its own call and the
render layer joins the two.

`GET /inventory` now returns `getAllInventory()` verbatim and `GET
/inventory/aging` serves `getAgingData()`, matching SRC's split.

### F8 — `frontend/src/api.js` was discarding the error body — **FIXED**

```js
if (!response.ok) throw new Error(`API Error: ${response.status} ${response.statusText}`);
```

Every string the wrapper works to preserve died here. The operator would have
seen `API Error: 422 Unprocessable Content` instead of *"Row not found for
SWH-A-01/WIDGET-X-100. The pallet may have been moved or deleted by another
station."* — AUDIT A1/A2 reappearing one layer further out.

`fetchFromFirebase` now reads the body once as text (an error response is
normally JSON but a proxy or a crashed emulator can return HTML, and
`response.json()` on that throws a parse error that hides the real status),
and throws an `Error` whose `message` is the server's own text, with `status`,
the parsed `body`, `routeKind` and `notImplemented` attached.

**This is frontend code and therefore outside the stated Phase 3 scope.** It is
~25 lines, it is the client half of the acceptance criterion, and the route work
is not demonstrable end-to-end without it. Flagging rather than burying it. No
view wiring was touched.

### F9 — Hosting has no `/api` rewrite — reported, needs your call

`frontend/src/api.js` uses `/api` as its production base URL, but
`firebase.json`'s `hosting.rewrites` is only the SPA catch-all
(`"source": "**" → /index.html`). There is no
`{"source": "/api/**", "function": "api"}`, so in production **every** call
would be answered with `index.html`. Adding it changes deploy topology, which
is on your ask-first list.

### F10 — two spellings of the failure key — handled

`success:false` comes with `error` in `Service_Write` (41), `Service_Dates`
(28), `Service_Assembly` (7), `Service_Diagnostics` (3), `Service_Email` (1),
and with `message` in `Service_Read` (55) and `Service_PO_Ingest` (6). Not
worth unifying by touching 141 return sites; the wrapper reads either and
normalises to `error` while leaving the original key in place.

---

## 5. `GET /boot`

`Service_Router.js:70-78` calls `precompileDataset_()` nine times and inlines
the JSON straight into `Index.html`, where it lands as `window._serverInventory`,
`_serverProductMap`, `_serverTransitLaneCatalog` and so on. Those globals are
read all over `JS_Render_UI`/`JS_Handlers`, and `JS_Diagnostics.html` ships
`window._serverBootIssues` with every crash report.

Firebase Hosting serves a static bundle. There is no template pass, so without
this route the SPA either makes nine round trips before it can paint, or each
view fetches its own slice and they disagree with each other.

`/boot` is a faithful port of `precompileDataset_`, not a new idea: the same
nine getters, the same fallback values, and the same "one failure degrades to
its fallback and is recorded in `bootIssues` rather than taking the whole boot
down". Everything in it is also available on its own route; this is the batched
form. Calls are sequential, not `Promise.all` — these getters share `SS_API`'s
per-process metadata cache and read overlapping ranges of one spreadsheet, and
nine concurrent Sheets reads from a cold container is the fastest way to meet a
429 (`Shared_Classifiers`' backoff only covers Trello).

---

## 6. Verification

### `npm run test:routes` — new, 82 checks

`functions/test/routes_contract.js`, two parts:

- **Part A, coverage.** All 64 SRC client calls resolve to a registered route at
  the recorded method and path, plus an explicit assertion for the five paths
  `frontend/src/api.js` hard-codes. A renamed path fails the test naming the SRC
  call site that breaks.
- **Part B, the wrapper contract.** A real HTTP server over the real
  `wrappers.js`, driven with fake services. No new dependencies — `express` is
  already a runtime dependency and the server is driven with Node's own `fetch`.

```
PART A -- route coverage
  64 SRC client calls mapped, 71 routes registered

PART B -- wrapper contract
  transcript:
    POST /t/refused-error      -> 422  {"success":false,"error":"Row not found for SWH-A-01/WIDGET-X-100. The pallet may have been moved or deleted by another station."}
    POST /t/refused-message    -> 422  {"success":false,"message":"Missing Trello credentials.","error":"Missing Trello credentials."}
    POST /t/refused-partial    -> 422  {"success":false,"error":"Trello sync incomplete.","trelloSynced":false,"failedItems":["LINE-1","LINE-7"]}
    POST /t/refused-blank      -> 422  {"success":false,"error":"The server refused the request but gave no reason. Check the function logs."}
    POST /t/undefined          -> 500  {"success":false,"error":"Returns undefined returned no result. Nothing was written; this is a server bug, not a rejected request."}
    POST /t/throws             -> 500  {"success":false,"error":"Throws failed: Could not read the Inventory sheet: quota exceeded"}
    POST /t/ok                 -> 200  {"success":true,"written":1}
    GET /t/read-refused        -> 422  {"success":false,"message":"No Board ID provided.","error":"No Board ID provided."}
    GET /t/read-ok             -> 200  [["SWH-A-01","WIDGET-X-100",12]]
    POST /t/unported           -> 501  {"success":false,"error":"estimateShipByDateV2() is not ported yet. Waiting on: Service_Dates parity.","notImplemented":true,...}

82 checks, 0 failures
ROUTE CONTRACT OK
```

### Emulator, `AUTH_DISABLED=true`

Live requests against `firebase emulators:start --only functions`. The 422s
below are **real services refusing** — `validateQty_` and the destination guard
in `Service_Write`, the credential guard in `Service_Read` — not fixtures:

```
$ curl -X GET  /me
  <- 200 OK                      X-CIS-Route-Kind: read
  {"success":true,"email":"emulator-operator@localhost","name":"Emulator Operator","emulatorBypass":true}

$ curl -X POST /inventory/set-total   -d '{"locId":"SWH-A-01","sku":"WIDGET-X-100","newQty":"12o"}'
  <- 422 Unprocessable Entity    X-CIS-Route-Kind: mutation
  {"success":false,"error":"New total must be a number — got \"12o\"."}

$ curl -X POST /inventory/update-stock -d '{"locId":"SWH-A-01","sku":"WIDGET-X-100","adjustment":"abc"}'
  <- 422 Unprocessable Entity    X-CIS-Route-Kind: mutation
  {"success":false,"error":"Adjustment must be a number — got \"abc\"."}

$ curl -X POST /inventory/move        -d '{"fromLoc":"SWH-A-01","toLoc":"","sku":"W","moveQty":1}'
  <- 422 Unprocessable Entity    X-CIS-Route-Kind: mutation
  {"success":false,"error":"Destination location is required."}

$ curl -X POST /trello/cards          -d '{"listId":"","cardName":""}'
  <- 422 Unprocessable Entity    X-CIS-Route-Kind: mutation
  {"success":false,"message":"Missing List ID or Card Name.","error":"Missing List ID or Card Name."}

$ curl -X POST /shipping/estimate-ship-by
  <- 501 Not Implemented         X-CIS-Route-Kind: unimplemented
  {"success":false,"error":"estimateShipByDateV2() is not ported yet. Waiting on: Service_Dates parity -- SCHEMA §8 Engine 4 ...","notImplemented":true,...}

$ curl -X POST /no-such-route
  <- 404 Not Found
  {"success":false,"error":"No route for POST /no-such-route."}
```

The `/trello/cards` line is the one to look at for rule 2: `Service_Read`
answered with `message`, and the response carries **both** the original key and
the normalised `error`.

### Emulator, `AUTH_DISABLED=false` — auth still gates every new route

```
GET  /me                  [no token]    -> 401  {"success":false,"error":"Authentication required. Sign in with your work Google account."}
POST /inventory/set-total [no token]    -> 401  {"success":false,"error":"Authentication required. Sign in with your work Google account."}
GET  /trello/boards       [no token]    -> 401  {"success":false,"error":"Authentication required. Sign in with your work Google account."}
POST /inventory/set-total [bad token]   -> 401  {"success":false,"error":"Invalid or expired sign-in. Please sign in again."}
```

### Everything else

| Check | Result |
|---|---|
| `npm run lint` | ✅ exit 0, 6 pre-existing warnings, unchanged |
| `npm run test:parity` | ✅ 1492 comparisons, 0 differences |
| `npm run test:routes` | ✅ 82 checks, 0 failures |
| `firebase emulators:start --only functions` | ✅ clean boot, 3 functions loaded |
| All route modules + `index.js` load | ✅ 71 routes registered |

### One thing the emulator cannot prove locally

`GET /inventory` against the emulator hangs for 60s and then times out. It is
not the route: with no Application Default Credentials on the machine,
`googleapis` falls back to the GCE metadata server (`169.254.169.254`) looking
for a token and gets no answer. `functions/.env` also carries a placeholder
`BATCH_SHEET_ID`. **Any Sheets-backed route is unexercisable locally until
`gcloud auth application-default login` is run and a real sheet id is set** —
pre-existing, orthogonal to Phase 3, and worth knowing before the next phase.

---

## 7. Incidental

- **`express.json({limit:'10mb'})`.** `/po-ingest` carries a base64-encoded PO
  PDF; the 100kb default would have rejected a scanned multi-page PO with a 413
  whose body says nothing about size.
- **JSON 404 and a JSON error handler.** Express answers an unmatched route with
  an HTML `Cannot POST /whatever` page and an unhandled error with an HTML stack
  page — and a body-parser failure (malformed JSON, over-limit payload) never
  reaches the wrappers at all. Both now use the same `{success:false, error}`
  envelope, so the client's error path gets a parseable body for a 404 the same
  as for a 422.
- **`npm test`** added, running parity then routes.

---

## 8. Still open

**Unchanged and still needing your decision (both restated in §9/§10 of the
handover, not decided here):**

- **No lock on the write path (AUDIT B7).**
- **`SS_API.commitAtomic` (AUDIT B3) not ported.** It is now one step closer to
  blocking: `POST /assembly/explode-partial-hub` is the first route to 501 on it.

**New, from this phase:**

- **F9 — the `/api` Hosting rewrite** (deploy topology, your call).
- **F2, F4, F5, F6** — service parity gaps, reported not fixed.

**Carried forward:**

- Frontend sign-in (needs the `firebase` JS SDK — a new dependency). Until it
  lands, the SPA sends no `Authorization` header and every deployed call 401s;
  local dev works on `AUTH_DISABLED=true`.
- Secret Manager for the `secret: true` config keys.
- CORS is still `origin: true`.
- `scheduledSync` is still a one-line log.
- Phase 4: `Service_Dates` parity, `Service_Conversions` parity, sync/webhook
  functions, `Fedex_Master_Script`, frontend views.
