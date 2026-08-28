# Phase 4 — the write lock, Service_Dates/Conversions/Assembly parity, and B3

**Date:** 2026-08-28
**Baseline:** `371ac57` (end of Phase 3)
**Scope:** five units. Unit A is the write-path lock (AUDIT B7). Unit B is
`Service_Dates` parity. Unit C locks the three move paths SRC leaves open.
Unit D is `Service_Conversions` parity, plus four aging-anchor bugs it uncovered.
Unit E is `Service_Assembly` parity and `SS_API.commitAtomic` (AUDIT B3).

---

# UNIT A — the write-path lock

## 1. What was actually wrong

Every inventory write is three steps against a Google Sheet:

```
read the whole Inventory tab  ->  work out which row  ->  write that row
```

Nothing in Sheets makes those one operation. Two writers that overlap — two
floor stations, or a station and the background sync — both read the same
snapshot, both compute a row number from it, and the second write lands on top
of the first. If a row was inserted or deleted in between, the second write
lands on a **different pallet**. Nobody is told either way.

The original prevented this with `LockService.getScriptLock()`. Apps Script has
no equivalent in Node, so the port has had no lock at all since it was written.

## 2. All eight SRC lock sites, accounted for

The brief listed seven. There are eight, and one of the five in
`Service_Write.js` is not the function the brief named. Verified by line number
against `SRC/src/`:

| SRC site | Function | Shape | Status here |
|---|---|---|---|
| `Service_Write.js:752` | `modifySheetRow` | `tryLock(10000)` | **Ported** — `withInventoryLock` around the whole read-compute-write. |
| `Service_Write.js:973` | `updateInventoryByRow` | `tryLock(10000)` | **Ported by inheritance** — this port delegates to `updateStock` → `modifySheetRow`, which holds the lease. See below. |
| `Service_Write.js:1027` | `setTotalStockByRow` | `tryLock(10000)` | **Ported by inheritance**, same route. |
| `Service_Write.js:1118` | `splitInventoryRow` | `tryLock(10000)` | **Ported** — after validation, as SRC orders it. |
| `Service_Write.js:1506` | **`receivePOCardItems`** | `waitLock(10000)` | **Ported**, with the re-check block that was missing entirely (§4). |
| `Fedex_Master_Script.js:319` | `runMPSDiscovery` (`:250`) | `tryLock(10000)` | **Not ported** — the whole file is unported. |
| `Fedex_Master_Script.js:416` | `runMPSBatchAndReassemble` (`:346`) | `tryLock(10000)` | **Not ported** — same file. |
| `Setup_Registry.js:1298` | `migrateInventoryToProductIds` (`:1208`) | `tryLock(30000)` | **Not ported** — `Setup_Registry.js` is one-off manual repair tooling, "port on demand" in `PORT_AUDIT.md`. |

Two corrections to the brief, both checked in source:

- **`Service_Write.js:1506` is `receivePOCardItems`, not `processAuditAction`.**
  `processAuditAction` (`SRC/src/Service_Write.js:38`) takes no lock of its own
  at all — it calls `setTotalStock`, which calls `modifySheetRow`, which does.
  It is covered, but by inheritance, not directly.
- **That site uses `waitLock`, not `tryLock`.** The difference matters: a
  receipt that has already read Trello, resolved products and composed a receipt
  email should *wait its turn* rather than throw that work away.
  `withInventoryLock` does exactly that — it retries for the same 10s budget
  before refusing.

### Why the `*ByRow` twins inherit rather than take their own lease

SRC locks them directly because in Apps Script they are standalone
implementations. In this port they are two-line delegations to
`updateStock` / `setTotalStock`, which reach `modifySheetRow`. Taking a second
lease there would be harmless — `lock.js` is reentrant within a request, unlike
Apps Script's, which deadlocks (SCHEMA invariant #59) — but it would put the
lock somewhere the critical section isn't. Pinned by test: Part D asserts both
twins return "Server busy" and touch the sheet zero times while a lease is held.

## 3. What was built — `functions/lock.js`

One module, one export: `withInventoryLock(fn, {label})`. A **lease lock** in a
single Firestore document, `_portal_locks/inventory`.

It is marked in its own header as **disposable scaffolding**. The intended end
state for this project is Postgres, which does per-row locking properly and
automatically inside every transaction. When that lands, this file should delete
in one go — remove `lock.js`, remove the `withInventoryLock(...)` line at each
of its three call sites, done. That is why the whole mechanism is one function
with one argument shape instead of acquire/release pairs sprayed across the
write path.

Three outcomes, and they are deliberately different:

| Situation | What happens |
|---|---|
| Lease free | `fn()` runs, result returned unchanged, lease released in a `finally`. |
| Someone else holds it | `fn()` **never runs**. Returns `{success:false, error:"Server busy. Please try again."}` after waiting out the same 10s budget SRC used. |
| Firestore unreachable | `fn()` runs **unlocked**, result tagged `lockDegraded:true`, error logged. See §3.3. |

### 3.1 The TTL, and why it is not optional

Apps Script releases a script lock when the script ends, whatever happens to it.
Cloud Functions gives no such guarantee: a container can be frozen the instant
it responds, or killed outright, and a `finally` block runs in neither case. A
lock with no expiry would wedge the entire write path **permanently** the first
time a writer died mid-write — every station on the floor stuck on "Server busy"
forever, fixable only by hand.

**TTL = 60 seconds**, chosen against the platform limit rather than guessed:

- Cloud Functions' default request timeout is 60s. A request cannot outlive it,
  so a lease older than 60s belongs to something that is definitionally no
  longer running. That makes 60s the **shortest** TTL that can never expire
  underneath a writer still working — and a TTL that expires early is worse than
  no lock, because it hands the lock to a second writer while the first is
  mid-write, which is precisely the collision this exists to prevent.
- It is also the **longest** an abandoned lease can block the floor.

If the function timeout is ever raised above 60s, `LEASE_TTL_MS` must be raised
to match. `release()` logs an error if it finds its own lease already expired,
so that mistake is visible rather than silent.

### 3.2 Reentrancy — a footgun defused rather than reproduced

SCHEMA invariant #59: *"Nothing that already holds the script lock may call
`modifySheetRow` — Apps Script locks are not reentrant, so a nested acquisition
deadlocks until timeout."* That is a live trap in the original, documented in
prose because it could not be fixed.

Here it is fixed. `lock.js` tracks ownership with Node's `AsyncLocalStorage` (a
core module — no dependency), and a nested `withInventoryLock` inside a call
that already holds the lease simply runs its body. Pinned by test.

### 3.3 Contention vs. "I can't tell" — the one real judgement call

**If Firestore is unreachable, the write proceeds unlocked**, logs an error
naming the likely cause, and carries `lockDegraded: true` on its result (which
the route wrappers' rule 5 passes through to the client verbatim).

The alternative — refusing every write when the lock store is down — makes
Firestore a hard dependency of every inventory adjustment in the building. A
misconfiguration would stop the warehouse, and it would announce itself as
*"Server busy. Please try again."*, which sends the operator looking at the
wrong problem entirely. Failing open is never worse than the status quo (this
write path was completely unlocked until now), and the failure is loud in two
places, so it cannot rot unnoticed.

**Contention never fails open.** If the store answers and the answer is
"someone else holds it", the write is refused. A Firestore `ABORTED` — which is
what a transaction collision looks like — is classified as contention, not as a
broken store, so heavy load cannot silently switch the lock off exactly when it
matters most. Pinned by test.

A 60s circuit breaker follows an unreachable-store failure, so a project where
Firestore is not enabled does not pay a 4s timeout on every single write.

### 3.4 What the lock does *not* replace

**The Phase 2 row-data-mismatch guard stays, and is not redundant.** The lease
serialises *our* writers only. People edit that spreadsheet by hand in the
Sheets UI, and a row shifted by a human typing directly into it is invisible to
any lock. That guard is the only thing that catches it. Pinned by test (Part D
asserts the guard still fires with the lock free).

## 4. `receivePOCardItems` was missing the re-check, not just the lock

Worth calling out separately, because it is a real bug this unit closes rather
than a mechanical port.

SRC takes its late-stage lock and then **re-reads the Trello checklist** before
writing, comparing it against what was validated at the top of the function.
Everything in between — the first checklist read, the product-map lookup,
building the rows, composing the receipt email — is a window in which another
station could have received against the same card. If anything moved, SRC aborts
before writing: no Inventory rows, no `Audit_Log` rows, no Trello writes.

The port had **neither the lock nor the re-check**. `grep` for `recheck`,
`re-verify` or `Another station received` in `functions/services/` returned
nothing. Both are now in, with SRC's three error strings carried across
verbatim.

"Late-stage" is the point (SCHEMA invariant #17): the Trello read, the product
lookup and the email body all still run **unlocked**. Only the sheet write is
serialised. Holding a project-wide lock across network calls would freeze every
other station on the floor for the duration.

This narrows the race, it does not eliminate it — the Trello checklist rewrite
still happens outside the lease, so two stations submitting inside the same
second can both get through. Closing that completely means holding the lock
across ~2 Trello API calls per line item, which invariant #17 explicitly
forbids. SRC makes the same trade and records it in the same place
(`AUDIT_2026-08-24.md` B6, SCHEMA #53).

## 5. F2 — `ZONE-STAGED` removed from `moveInventoryItem`

`VIRTUAL_ZONES` was `['ZONE-BUFFER', 'ZONE-STAGED']`; SRC is `['ZONE-BUFFER']`,
changed 2026-08-27 (SCHEMA v17 item 1). Staging is a workflow **status**
(column D), not a destination. `moveHubGroup` in this port already had the
correct list, which is what made the divergence visible in Phase 3.

Now matches SRC. A move to `ZONE-STAGED` is refused like any other unrecognized
destination instead of being silently accepted as an always-vacant zone. Pinned
by test both ways (`ZONE-STAGED` refused, `ZONE-BUFFER` still accepted).

## 6. Verification

### `npm run test:lock` — new, 26 checks, four parts

`functions/test/lock_contract.js`. The parts prove different things on purpose:

- **Part A — the decision.** `decideAcquire` in isolation, including the exact
  expiry boundary and a garbage `expiresAt` (which must read as expired, not as
  permanently held).
- **Part B — the behaviour**, against an in-memory store that serialises its own
  operations the way a Firestore transaction does.
- **Part D — the wiring.** The real `Service_Write` entry points with `SS_API`
  stubbed out. Parts A–C prove the lock works; without this they prove nothing
  about whether the write path *uses* it.
- **Part C — the real Firestore round-trip**, against the Firestore emulator.
  Skipped with a loud notice when `FIRESTORE_EMULATOR_HOST` is unset, so
  `npm test` still passes on a machine without it.

`npm run test:lock:emulator` runs all four against a real Firestore emulator.
That needs **Java 21+**; the emulator jar is compiled for it and this machine's
Java 8 fails with `UnsupportedClassVersionError`. Temurin 21 JRE is installed
side-by-side at `C:\Users\Michael\.jdks\jdk-21.0.12.1+1-jre` — nothing on `PATH`
was changed and Java 8 is untouched. Set `JAVA_HOME` to that directory for the
run.

It needs **no Google credentials and no real Firestore database**: the emulator
is entirely local. `firebase.json` gained an `emulators.firestore` block (local
dev only — no `firestore` deploy section was added, so deploy topology is
unchanged).

Full transcript, `npm run test:lock:emulator`:

```
PART A -- decideAcquire
PART B -- withInventoryLock behaviour
PART D -- the write path actually takes the lock
PART C -- real Firestore transactions (emulator)

  transcript:
  serialised, no interleave: station-A read -> station-A wrote -> station-B read -> station-B wrote
  contended: station-B waited 10114ms then -> {"success":false,"error":"Server busy. Please try again."}
  abandoned lease, 1s before TTL: -> {"success":false,"error":"Server busy. Please try again."}
  same lease, past its 60s TTL: -> {"success":true,"wrote":"station-B"}
  body threw: lease released, next writer unblocked immediately
  nested withInventoryLock: ran at depth 2, one acquisition total
  store unreachable: -> {"success":true,"wrote":1,"lockDegraded":true,"lockDegradedReason":"5 NOT_FOUND: The database (default) does not exist"}
  lock free: setTotalStock -> {"success":true}, sheet calls: 3
  lock held: setTotalStock -> {"success":false,"error":"Server busy. Please try again."}, sheet calls: 0
  splitInventoryRow: bad status refused in 0ms without the lock; valid request under a held lock -> {"success":false,"error":"Server busy. Please try again."}
  hand-edited sheet, lock free: -> {"success":false,"error":"Row data mismatch. The sheet may have been modified."}
  move to ZONE-STAGED -> {"success":false,"error":"Unknown destination 'ZONE-STAGED' -- it doesn't match any existing location or recognized zone. Move rejected rather than creating a new one."}
  3 concurrent writers, real transactions: station-B in -> station-B out -> station-C in -> station-C out -> station-A in -> station-A out
  real live lease -> {"success":false,"error":"Server busy. Please try again."}
  real expired lease -> taken over, then released: {"success":true,"wrote":"station-B"}
  stored lease: {"token":"264d0cd7-...","label":"modifySheetRow SWH-A-01/WIDGET-X-100","acquiredAt":1787939267955,"expiresAt":1787939327955}

26 checks, 0 failures
LOCK CONTRACT OK
```

The two acceptance criteria, by line:

- **Two concurrent writers do not both proceed, and the loser is told.**
  `lock held: setTotalStock -> {"success":false,"error":"Server busy. Please try
  again."}, sheet calls: 0` — the refused writer did not read or write the sheet
  even once. And on real Firestore: `3 concurrent writers, real transactions:
  station-B in -> station-B out -> station-C in -> ...` — never two inside at
  once.
- **An abandoned lock expires rather than wedging the write path forever.**
  `abandoned lease, 1s before TTL: -> Server busy` then `same lease, past its
  60s TTL: -> {"success":true}`. Repeated against real Firestore: `real expired
  lease -> taken over, then released`.

### Everything else

| Check | Result |
|---|---|
| `npm run lint` | ✅ exit 0, 6 pre-existing warnings, unchanged |
| `npm run test:parity` | ✅ 1492 comparisons, 0 differences |
| `npm run test:routes` | ✅ 82 checks, 0 failures |
| `npm run test:lock` | ✅ 22 checks (Part C skipped, no emulator) |
| `npm run test:lock:emulator` | ✅ 26 checks, 0 failures |
| `firebase emulators:start --only functions` | ✅ clean boot, 3 functions loaded |

Emulator route probe, confirming the lock added no cost to anything that fails
before the sheet — validation still runs first, so a bad request never waits on
another station's write:

```
GET  /me                        -> 200   kind=read       (1687ms cold start)
POST /inventory/set-total       -> 422   141ms   {"error":"New total must be a number — got \"12o\"."}
POST /inventory/update-stock    -> 422    17ms   {"error":"Adjustment must be a number — got \"abc\"."}
POST /inventory/split           -> 422    16ms   {"error":"Unrecognized workflow status 'Nonsense'."}
POST /inventory/move            -> 422    10ms   {"error":"Destination location is required."}
POST /no-such-route             -> 404     6ms
```

### What is *not* proven, and cannot be here

An end-to-end inventory write through `modifySheetRow` against a real
spreadsheet. That needs Application Default Credentials and a real
`BATCH_SHEET_ID`, neither of which exists on this machine (the pre-existing
limit recorded in `PHASE_3_NOTES.md` §6). Part D drives the real service code
with the Sheets boundary stubbed, which proves the lock is wired into the write
path; it does not prove the resulting write reaches Google.

## 7. Still open after Unit A

- **Firestore must be enabled on `cis-warehouse-portal` before deploy.** It is
  not, as far as anyone remembers, and the CLI on this machine is not
  authenticated so it could not be checked. Native mode. Until it is, the lock
  fails open on every write and logs an error each cooldown period — correct
  behaviour, but it means no lock.
- **The function's service account needs `Cloud Datastore User`** to read and
  write `_portal_locks`. The default App Engine service account normally has
  Editor, which covers it; worth confirming after the first deploy.
- **A standing constraint for whoever ports `Webhook_Receiver.js`.** SCHEMA
  invariant #43 is explicit that `doPost` takes **no** lock deliberately, and
  that `processWebhookPayload()` must never be wrapped in one — in Apps Script
  the project-wide lock held across a SHIPMENTS read plus Trello calls made the
  FedEx engines' own `tryLock(10000)` fail and skip an entire cycle. The same
  reasoning applies to `withInventoryLock`: it is the same project-wide scope.
  Duplicate-webhook suppression is the event hash, not a lock.
- ~~**Three write paths SRC leaves unlocked are still unlocked here**~~ —
  **DECIDED AND DONE 2026-08-28**, see §Unit C below.

---

# UNIT B — `Service_Dates` parity

## 1. What landed

Fourteen functions and two constant tables that had no counterpart in the port,
plus three fixes inside functions that were already there. The headline is
`estimateShipByDateV2` — the reverse calculation, *"I must have this by DATE,
what is the last day it can leave?"* — whose route answered **501** until now.

| Ported | What it is |
|---|---|
| `estimateShipByDateV2` | The reverse estimator. `POST /shipping/estimate-ship-by` is live. |
| `getDeliveryDestinationCatalog_` | The literal receiving-dock list the Destination dropdown renders. |
| `resolveTransitDestinationCluster_` | Dock name → lane-table cluster. |
| `DELIVERY_DESTINATION_CLUSTERS`, `DELIVERY_ADDRESS_SHEET` | The hand-maintained dock→cluster map. |
| `fetchCardComments_` | A card's comments, newest first. |
| `findLatestReadyPortInfo_` | Newest parseable READY/PORT or sailing-schedule declaration on a card. |
| `getTrelloMemberInfo_`, `identifyTrelloBotAccount` | Which Trello account the credentials belong to. |
| `getLastAutoDueForCard_`, `markEtaOverridden_` | Read/write of the override columns Q and R. |
| `detectMissedDueDateOverrides_` | Sync-side safety net for a due-date change the webhook missed. |
| `backfillReadyPortFromComments_` | Sync-side safety net for a READY/PORT comment the webhook missed. |
| `setupShipmentDateColumns` | One-off: creates SHIPMENTS K–R plus the basis dropdown. |
| `clearTransitTimeCache` | Port-only. See §5. |

`computeShipmentDates_` and `getPeakSeasonWindow_` were flagged in the brief as
"present but check the body". Both are at parity — `computeShipmentDates_`
exactly, `getPeakSeasonWindow_` except for its logging, which is §4 below.

## 2. F4 was three missing pieces, not two

Phase 3 recorded two. There were three, and the third is the worst of them.

**(a) `estimateShippingWindowV2` had lost its `port` parameter.** SRC is 6-arg
`(readyDateStr, travelType, origin, destination, port, loadType)`; the port was
5-arg. Restored.

**(b) `findTransitLane_` had no `opts.port` narrowing and no destination-cluster
resolution.** Without them, a destination fed by more than one entry port
resolved to whichever lane the slowest-wins default picked, and a literal dock
name like `RTF` matched no cluster at all. Restored.

**(c) — NOT previously recorded — `findTransitLane_`'s free-text path had lost
its exact-`Port`-first match.** SRC tries three things in order: the lane's own
`Port` column (exact), then an exact match in `Port_Keyword`'s comma-separated
aliases, then a substring match in those aliases. The port had only the last two.

That first step is not a micro-optimisation, it is a bug fix from 2026-08-21
with its own `[!CAUTION]` block in SCHEMA §4G. Two lanes can legitimately share
an alias: Ontario's *"LA to Toronto (IPI)"* lane lists `Los Angeles` among its
keywords because the route physically passes through LA. So a Florida-bound
shipment declared as "Los Angeles" matched **both** lanes, and the slowest-wins
tiebreak silently resolved it to the Ontario/IPI lane — **68 days instead of
39**, with no error, no override, reproducing identically on every recompute.

This matters more than (a) or (b) because of *which* path it is on:
`resolveEtaAndBasis_` only ever calls `findTransitLane_` with `portText`, never
`destination`. So (a) and (b) affect the calculator UI, while (c) affects **every
ETA the system recomputes on every sync, for every inbound row already in
flight**. It was live in this port.

All three are caught by the parity harness — see §6, which includes the failure
output from deliberately reintroducing each one.

`POST /shipping/estimate-window`'s `logger.warn` admitting the gap is deleted.

## 3. Two more gaps in the same area

**`TRAVEL_TYPE_LABELS` was missing `TRUCKING: "Full Truckload (FTL)"`.** An FTL
lane in `Transit_Time` would have reached the Transit Type dropdown with no
label.

> Note for you: SCHEMA §4G's prose lists `Travel_Type` as
> "(`OCEAN`/`AIR`/`FEDEX`)" and does not mention `TRUCKING`, but
> `SRC/src/Service_Dates.js:468-473` has it. **The doc is behind the code here.**
> `reference/SCHEMA.md` is a vendored copy of the original project's contract, so
> editing it in this repo would silently fork it from upstream — flagging it for
> you to fix there instead of changing it here.

**`getTransitLaneCatalog` was missing `deliveryDestinations`.** That array *is*
the Destination dropdown since the 2026-08-27 switch to literal docks. Without
it the picker has nothing to render, so the guided 5-step flow dead-ends at
step 4 — the route existed and returned a 200, which is why this was invisible.

## 4. Three smaller things found while porting

**`getPeakSeasonWindow_` had lost every one of its log lines.** It has two
silent-fallback paths — headers not found, or dates unparseable — and both make
every date read as "Standard" season. SCHEMA §4G records that a *documentation*
error about which columns those headers live in caused exactly that for two days
in August 2026, and it went unnoticed precisely because nothing said anything.
SRC logs both. Restored.

**Two operator-facing error strings said `undefined`.** `postReadyPortComment_`
and `pushEtaToTrelloDue_` both build `"Trello … failed (" + res.status + ")"`,
but the shared `trelloFetch_` transport returns `code`, not `status`. Every
Trello failure message in this file read *"Trello comment post failed
(undefined)"*. Fixed to `res.code`.

**`formatDateCell_` returned the literal string `"NaN/NaN/NaN"`** for an Invalid
Date, where SRC's `Utilities.formatDate` throws. Everything in this file is
written to a sheet cell as RAW text, so that string would have landed in the ETA
column and stayed there. Now returns `""`. Unreachable today (every caller passes
a `parseDateCell_` result, which is `null` for anything unparseable) — fixed
because "unreachable" and "harmless if reached" are different claims.

## 5. Deliberate deviations from SRC

**`identifyTrelloBotAccount` does not write its own answer back.** SRC ends with
`PropertiesService.setProperty("TRELLO_BOT_MEMBER_ID", member.id)` — it
reconfigures itself. There is no equivalent here: config comes from `.env`, which
a running function cannot write, and `PHASE_1_NOTES.md` already lists the
write-back half of this key in `config.RUNTIME_STATE_KEYS` for that reason. So it
**returns** the member ID with an explicit `action` string telling the operator
what to set, and warning that pointing it at a personal account silently
*disables* override detection rather than enabling it. Writing it to Firestore
was considered and rejected: nothing reads it from there, so it would have looked
done while doing nothing.

**Timezone.** SRC formats dates with
`Utilities.formatDate(date, ss.getSpreadsheetTimeZone(), "MM/dd/yyyy")` — the
spreadsheet's timezone. There is no equivalent, so the port formats in the
container's (UTC on Cloud Functions). This is consistent rather than merely
different: `parseDateCell_` parses in the same zone, so a value read from the
sheet as text and written back round-trips to the same calendar day, and the
Sheets v4 API returns formatted strings rather than `Date` objects.

**Module-level caches outlive the request.** SRC memoizes the lane table, the
peak window and the port groups "for the life of this script execution" — one
request. In Cloud Functions the same `let` lives for the life of the
**container**, which can be hours across many requests, so a hand-edit to
`Transit_Time` is not picked up until it recycles. Acceptable (it is a
rarely-edited reference table and the alternative is re-reading the sheet on
every lookup) but real, so `clearTransitTimeCache()` exists to invalidate it.
Nothing calls it yet; the scheduled sync is the natural caller.

**`detectMissedDueDateOverrides_` writes once, not per row.** SRC does a
`setValue` per flagged row inside the loop. This collects them and issues one
`batchUpdateValues`. Same result; a 400-row sweep is one API call rather than 400.

**`setupShipmentDateColumns` needed a new `SS_API` method.** SRC sets the header
bold and attaches a data-validation dropdown to the basis column, neither of
which `spreadsheets.values.*` can do. Added `SS_API.batchUpdateSheet(requests)` —
a thin passthrough to `spreadsheets.batchUpdate`. Its doc comment carries two
warnings: it bypasses the `RAW` rule (`updateCells` carries its own
`userEnteredValue`, which Sheets parses like `USER_ENTERED` — AUDIT B1), so
values still go through `batchUpdateValues`; and one call is **atomic**, which is
the property `commitAtomic` (AUDIT B3) needs and four sequential `values.*` calls
cannot give.

The dropdown is not cosmetic — SRC's comment is explicit that constraining the
basis column *at entry* is the point, because a free-typed value falls outside
`RTS_BASES` and `computeShipmentDates_` silently rewrites it to `ESTIMATE` on the
next pass, losing a `SUPPLIER_CONFIRMED` the operator meant.

## 6. Verification

### `npm run test:parity:dates` — new, 45,850 comparisons across 16 functions

`functions/test/parity_Service_Dates.js`, same shape as the Phase 2
`Shared_Classifiers` harness: run SRC's original in a sandboxed VM alongside the
port and diff every output.

Most of `Service_Dates` is not pure — but it reads sheets through exactly two
boundaries, `SpreadsheetApp` on the SRC side and `SS_API` on the port side. Stub
both with the **same synthetic workbook** and everything above that line becomes
deterministic and directly comparable. That is what makes `findTransitLane_`,
both estimators and `computeShipmentDates_` testable rather than merely reviewed.

The synthetic `Transit_Time` table is built to expose the specific bugs:

- **Ontario (GTA) fed by four ports** at 39/43/45/53/68 days, so a lookup that
  ignores `port` returns something visibly wrong.
- **An "LA to Toronto (IPI)" lane carrying `Los Angeles` in its `Port_Keyword`**
  next to a Florida lane whose actual `Port` *is* `Los Angeles` — the 2026-08-21
  collision, reconstructed.
- **Peak-Season rows for some lanes and not others**, so the "skip the season
  filter rather than return nothing" rule is exercised on a FedEx lane that only
  ever has Standard rows.
- A lane with a blank `Total_Est_Days`, a junk row with no origin, an unmapped
  `Delivery_Address` dock, and an unparseable `Config` day count.

```
ran 45850 comparisons across 16 functions
SERVICE_DATES PARITY OK — every output identical to SRC
```

### The harness was mutation-tested, because a green test proves nothing until it can go red

Each of the three F4 pieces was deliberately removed again and the harness re-run:

| Mutation | Result |
|---|---|
| `opts.port` narrowing removed | **1428 differences.** Asking for `Vancouver` (43 days) returned the `LA to Toronto (IPI)` lane (68 days). |
| exact-`Port`-first match removed | **7 differences**, every one a `Los Angeles` lookup: SRC → Florida lane, 39 days; port → Ontario/IPI lane, 68 days. The original bug, exactly. |
| destination-cluster resolution removed | **2884 differences.** `destination: "RTF"` returned `null` instead of the Ontario (GTA) lane. |

The file was restored and re-verified green after each.

### What the harness deliberately does NOT cover

Anything that writes (`applyReadyPortDeclaration_`, `updateShipmentReadiness`,
`setupShipmentDateColumns`) or makes a Trello call (`fetchCardComments_`,
`findLatestReadyPortInfo_`, `getTrelloMemberInfo_`, `postReadyPortComment_`,
`pushEtaToTrelloDue_`). Comparing those means asserting on mock call sequences
rather than on answers, which tests the mock. **They were reviewed line-by-line
against SRC and are not covered by an executed test** — saying so rather than
letting the comparison count imply otherwise.

### Everything else

| Check | Result |
|---|---|
| `npm run lint` | ✅ exit 0, the same 6 pre-existing warnings |
| `npm run test:parity` (Shared_Classifiers) | ✅ 1492 comparisons, 0 differences |
| `npm run test:parity:dates` | ✅ 45850 comparisons, 0 differences |
| `npm run test:routes` | ✅ 82 checks, 0 failures |
| `npm run test:lock` | ✅ 22 checks, 0 failures |
| `firebase emulators:start --only functions` | ✅ clean boot, 3 functions |

`POST /shipping/estimate-ship-by` against the emulator — real service refusals
now, where this answered **501** before:

```
POST /shipping/estimate-ship-by  -> 422  {"success":false,"error":"Enter a valid must-arrive-by date."}
POST /shipping/estimate-ship-by  -> 422  {"success":false,"error":"Select a transit type, origin, and destination."}
POST /shipping/estimate-window   -> 422  {"success":false,"error":"Enter a valid ready-to-ship date."}
POST /shipping/estimate-window   -> 422  {"success":false,"error":"Select a transit type, origin, and destination."}
```

Anything past validation reaches `Transit_Time` and therefore needs the Google
credentials this machine does not have — the pre-existing limit from
`PHASE_3_NOTES.md` §6. The lane logic behind it is what the 45,850 parity
comparisons cover.

### Route body shapes, for whoever wires the frontend

`POST /shipping/estimate-window` takes
`{readyDateStr, travelType, origin, destination, port, loadType}`;
`POST /shipping/estimate-ship-by` takes the same with `arriveByDateStr` in place
of `readyDateStr`. Both are recorded in `functions/test/routes_contract.js`.

## 7. `backfillIgnoreCommentsFromComments_` unblocked

Ported into `Shared_Classifiers`, where it belongs. It had been waiting on
`fetchCardComments_` and `SHIPMENTS_COL` since Phase 2.

The `require` sits **inside** the function rather than at the top of the file:
`Shared_Classifiers` is at the bottom of the dependency graph and `Service_Dates`
requires it, so a top-level import would be a cycle. Same idiom as
`Service_Write`'s `readLiveChecklistState_`.

It stays **manually run**, not wired into any sync — SCHEMA §12 is explicit that
checking comments costs one extra Trello call per card and `.ignore` is a rare
deliberate action. No route, for the same reason.

## 8. Correction to the brief

`estimateShipByDateV2` is **SCHEMA §4G** ("Detailed Transit-Lane Engine & Guided
RTS Flow"), not §8 Engine 4. §8's Engine 4 is `batchCalculateTransitTimes()` —
the *FedEx Batch Shipping Schedule Estimator*, the CSV-upload tool in the FedEx
view that calls FedEx's Rates API. That one is still a **501**, waiting on
`Fedex_Master_Script.js`. They are different features that both produce a
"ship-by date", which is presumably how they got conflated. The stale reference
in `functions/http/routes/shipping.js` is corrected too.

## 9. Still open after Unit B

- **The 501 count is now 9, not 10.** `estimateShipByDateV2` is live; the
  remaining nine are `explodePartialHub`, `emailPOPdfToSupplier`,
  `batchCalculateTransitTimes`, `getEstimatorOriginZip`,
  `getEstimatorRtfOriginZip`, `syncLocalHtsCacheWithGovernment`,
  `getRxoConfigStatus`, `rxoRunDiagnostics`, `rxoTestShipmentLookup`.
- **`detectMissedDueDateOverrides_` and `backfillReadyPortFromComments_` are
  ported but not called by anything.** Both are sync-side safety nets and
  `syncAllBoardsToShipmentsTab.js` is unported. `detectMissedDueDateOverrides_`
  has a call-order requirement recorded in its doc comment: after the sync
  rewrites column F, before `refreshAllShipmentDateStates()`.
- **`Service_Conversions` parity is now the largest remaining service gap** —
  `caseBreakdown_`, `resolveUnitsPerCase_`, `formatQtyWithCases_`, and
  `findCaseConversion` still prefix-matching the raw SKU instead of resolving it
  to the QB name first.
- **`SS_API.commitAtomic` (AUDIT B3)** is still unported, and
  `SS_API.batchUpdateSheet` (added here) is the primitive it needs. It becomes
  blocking the moment `Service_Assembly` parity starts.

---

# UNIT C — locking the three move paths

**Decided by you 2026-08-28**, after Unit A flagged it. This is the one place in
the port that deliberately does **more** than SRC, so it is recorded separately
rather than folded into Unit A.

## Why SRC not having it is not a reason

`LockService` appears nowhere in `moveInventoryItem`, `moveHubGroup` or
`removeItemFromLocation` in `SRC/src/Service_Write.js`. Unit A therefore left
them alone: matching the original is the default, and diverging from it is a
decision, not a default.

But of everything on this write path they have the **widest**
read-compute-write. `moveInventoryItem` takes one full-sheet snapshot and then
performs, off row indices derived from that single snapshot:

- a source-row quantity update (or a vacate, or a delete),
- a destination update *or* an append,
- an `Audit_Log` append,
- and for a hub move, the same again per component row.

A concurrent SET on the same pallet lands inside that window and one of the two
writes disappears with nobody told — which is precisely the failure AUDIT B7 is
about. Closing it on the quantity paths while leaving it open on the widest one
would have been a half-fix.

`removeItemFromLocation` is worse in kind rather than in width: it **deletes
rows**. A row index resolved from a snapshot that another writer has since
shifted deletes the *wrong pallet*, rather than merely overwriting a number.

## What changed

Three call sites, same shape as Unit A's — the body renamed to
`…Locked_` and the public function reduced to a `withInventoryLock(...)`
wrapper, so the lock stays one deletable line per site when the Postgres
migration removes `functions/lock.js` wholesale.

**Validation stays outside the lease**, as it does for `splitInventoryRow`:

- `moveInventoryItem` — `validateQty_` and the empty-destination check already
  ran before the sheet read, and still do.
- `moveHubGroup` — its two argument checks (`instanceIds` non-empty,
  destination non-blank) were **hoisted above** the sheet read. SRC reads first
  and validates second; neither check looks at the snapshot, so running them
  first changes no answer, and it stops a request that is going to be refused
  from holding the project-wide lock across a full-sheet read while being
  refused.

## What this costs

An operator can now see *"Server busy. Please try again."* on a move. They
could not before — because there was nothing to be busy with. That is the
trade, and it is the same one Unit A made on the quantity paths.

**If you ever diff this port against the original, expect this difference and
know it was deliberate.** Every one of the six call sites carries a source
comment saying so.

## Verification

`npm run test:lock` grew from 22 to 27 checks. The five new ones pin, for each
of the three paths, that a held lease means **zero** sheet calls — not a failed
write, no read either:

```
lock held: moveInventoryItem       -> {"success":false,"error":"Server busy. Please try again."}, sheet calls: 0
lock held: moveHubGroup            -> {"success":false,"error":"Server busy. Please try again."}, sheet calls: 0
lock held: removeItemFromLocation  -> {"success":false,"error":"Server busy. Please try again."}, sheet calls: 0
```

plus two that pin what must **not** have changed: validation still refuses a bad
quantity or a blank destination in under a second with the lease held (i.e.
without waiting the full 10s budget), and all three still reach the sheet
normally when the lease is free.

Reentrancy was re-checked across the newly-locked set: none of the three calls
another locked function, and the only nesting anywhere on the write path is
`processAuditAction` → `setTotalStock` → `modifySheetRow`, which
`functions/lock.js` handles by design (SCHEMA invariant #59).

| Check | Result |
|---|---|
| `npm run lint` | ✅ exit 0, the same 6 pre-existing warnings |
| `npm run test:parity` | ✅ 1492 + 45850 comparisons, 0 differences |
| `npm run test:routes` | ✅ 82 checks, 0 failures |
| `npm run test:lock` | ✅ 27 checks, 0 failures |

## Where the write lock now stands

Every read-compute-write in `Service_Write.js` that touches Inventory runs under
the lease:

| Path | Lease | Source |
|---|---|---|
| `modifySheetRow` (and `setTotalStock`, `updateStock`, `updateInventoryField`, `updatePalletComment`, `reservePallet`, both `*ByRow` twins, `processAuditAction`) | ✅ | SRC |
| `splitInventoryRow` | ✅ | SRC |
| `receivePOCardItems` (late-stage) | ✅ | SRC |
| `moveInventoryItem` | ✅ | **beyond SRC** |
| `moveHubGroup` | ✅ | **beyond SRC** |
| `removeItemFromLocation` | ✅ | **beyond SRC** |
| `addNewItemToLocation` | ❌ | append-only — no read-compute-write to protect |
| `cleanUpVacantRows` | ❌ | see below |

`cleanUpVacantRows` is the one remaining gap and it is deliberate for now: it is
a housekeeping sweep that deletes every row whose SKU is "Vacant", and it is
unlocked in SRC too. It should probably take the lease as well — flagging rather
than folding it in, since it was not part of what you approved.

---

# UNIT D — `Service_Conversions` parity, and four aging-anchor bugs it uncovered

The unit was scoped as "port the five missing case-conversion functions". Half
of it turned out to be that; the other half is what tracing one of those
functions' dependencies exposed in code that was already marked done.

## 1. `Service_Conversions` — what landed

| Ported | What it is |
|---|---|
| `resolveUnitsPerCase_` | How many units are in one case of this product, or `null`. |
| `FLOOR_CASE_SKUS_` | The four Burlington case SKUs, by hand — see below. |
| `caseBreakdown_` | Splits a quantity into units + cases + remainder. |
| `formatQtyWithCases_` | `"1,250 (25 cases)"` for plain-text surfaces. |
| `setupCaseConversions` | One-off: creates and seeds the CASE_CONVERSIONS tab. |
| `reportConversionGap` | How much buffer stock is convertible right now. |
| `CASE_CONVERSIONS_HEADERS`, `clearCaseConversionsCache` | Supporting. |

### `findCaseConversion` — the 2026-08-26 fix, restored

This is the one that mattered. The port was prefix-matching the **raw Inventory
SKU**. That worked only while Inventory held the full QuickBooks name — and
since 2026-08-11 `receivePOCardItems()` writes the **nickname** there instead.

A nickname does not start with the supplier code. Both `NT525S/2AMF` products
are nicknamed *"2 Alarm SMALL Scorpion Tag"*, which shares **no prefix at all**
with the rule keyed on `NT525S/2AMF`. So for everything received after that
date, the put-away conversion simply never fired: no error, no log, units
quietly stayed units.

SRC resolves the SKU back to its QB name first, which makes the rule fire for
either shape — legacy rows holding raw QB text, and new rows holding the
nickname — without rewriting the conversion table or backfilling Inventory.
Restored, and it is the thing the new parity harness is built around.

### `FLOOR_CASE_SKUS_` is a hand-maintained list, deliberately

`resolveUnitsPerCase_` has two sources: the CASE_CONVERSIONS sheet first, then
this fixed list. SRC's comment explains why the list is not derived: it used to
scrape `"(N per case)"` out of the QuickBooks name, and the 2026-08-28 name
rewrite folded the full QB spec into every Inventory SKU string, so the scrape
started firing on ADM adhesive packs (sold *as* the pack → rendered qty × 100)
and Epson ERC ribbons (stored as individual ribbons → qty × 48). No string rule
separates *"48 loose ribbons live in this box"* from *"the box of 48 IS the
unit"*. It is a per-product fact, so it is listed by hand. Carried across as-is.

> **Worth knowing:** the CASE_CONVERSIONS tab **does not exist in the live
> workbook** — `setupCaseConversions()` was written in the original but never
> run. So `getCaseConversions()` returns `[]` and the sheet-driven half of this
> feature is dormant on both sides. `resolveUnitsPerCase_`'s second source is
> what keeps the display helpers working meanwhile. Not a port defect; recorded
> because "it's ported" and "it's doing anything" are different claims.

## 2. Four aging-anchor bugs, found by following one dependency

`resolveUnitsPerCase_` calls `namesMatch_`. Checking who else does led to
`resolveOriginalArrivalDate` (`Service_Write.js`) and `buildAgingData_`
(`Service_Read.js`) — **the only two places in the portal that decide how old
the stock in a location is.** Everything the heatmap colours comes out of them.

Both were wrong, in four separate ways, all silent:

**(a) `EXPLODE_ASSEMBLY` is a string nothing ever writes.** Both functions
listed it as a valid anchor action. Every explode path in `Service_Assembly.js`
logs **`EXPLODE_RESTORE`** (`:183`, `:200`, `:209`) — which is what SRC lists.
So every component row an explode returned to the floor had **no age anchor at
all**, and its location read as unknown age on the heatmap forever.

**(b) `SPLIT_IN` was missing from both lists.** `splitInventoryRow` mints a
brand-new Inventory row, so a location holding only split-off rows had no anchor
either. What makes this one notable: **this port already contains the comment
saying it had to be added.** `splitInventoryRow`'s docblock was copied across
verbatim, including the sentence *"the reason SPLIT_IN had to be added to
buildAgingData_'s validActions and to resolveOriginalArrivalDate's own
relevantActions"*. The comment was ported; the code was not.

**(c) `resolveOriginalArrivalDate` used a two-way substring test** where SRC
uses `namesMatch_`. SRC replaced it for a stated reason: a move's carried-forward
arrival date is the item's dwell clock, and substring matching donates a
**sibling's** date within the same product family — `T25-SCREW` matching
`T25-SCREWDRIVER`.

**(d) The carried-date branch checked `MOVE_IN` only** in both functions. So
even once `SPLIT_IN` was recognised, a split-off row would have reset its dwell
clock to the moment of the split instead of inheriting the lot's true arrival.

SCHEMA invariant #69 is about precisely this class of failure — it records that
an earlier version of the identity work would have shipped a 20-anchor
regression invisibly, *"each affected location simply reading 'unknown age' on
the heatmap for no reason a user could see."* All four fixed, and all four now
pinned by an executed test rather than by prose.

## 3. Nothing was priming the product-identity index

`namesMatch_` consults `productIdentityKey_`, which reads the PRODUCT index.
Phase 2 split SRC's synchronous sheet read into an async `primeQbNameIndex()`
plus a sync cache read, and deliberately made an unprimed read warn once rather
than fail — so a missing prime would be *findable*.

It was never found, because **nothing in the codebase called
`primeQbNameIndex()` at all.** The index was empty in every request, so every
name comparison silently degraded to plain-key matching — which is the exact
weakening invariant #69 exists to prevent, and it would have quietly undone
fix (c) above.

Now awaited at the two call sites that need it (`resolveOriginalArrivalDate`,
and `findCaseConversion`/`resolveUnitsPerCase_`). It memoizes, so it costs one
PRODUCT read per container.

## 4. One place the port is deliberately BETTER than SRC

While building the harness, SRC turned out to blank its entire aging map when
Audit_Log contains a single unparseable timestamp:

```js
let parsedDate = ... new Date(Date.parse(rawTimestamp));
if (parsedDate) {                                   // an Invalid Date is TRUTHY
  const entry = { date: parsedDate.toISOString(), … };   // RangeError
```

`new Date('garbage').toISOString()` throws `RangeError: Invalid time value`,
which escapes the `forEach` into `buildAgingData_`'s `catch (e) { return {}; }`.
**One bad row anywhere in the log and every location on the heatmap reads
"unknown age"**, with nothing surfaced anywhere.

The port guards with `!isNaN(getTime())` and skips only the offending row. That
was already true before this unit — it is not something I changed — but it is a
real behavioural divergence, so it is now **asserted explicitly** in
`parity_Aging.js` rather than quietly excluded from the corpus. If SRC is ever
fixed upstream, that assertion fails and tells you to fold the row back in.

**This is a live bug in the original**, worth fixing there independently of the
port.

## 5. Smaller notes

- **`SS_API.batchUpdateSheet` gained its second caller.** `setupCaseConversions`
  needs `addSheet` + a bold header + a frozen row, none of which
  `spreadsheets.values.*` can do. Same primitive Unit B added for
  `setupShipmentDateColumns`, and the one `commitAtomic` (AUDIT B3) will need.
- **`reportConversionGap` returns data instead of streaming to `Logger.log`.**
  Same deviation and same reasoning as the other manual-harness functions:
  there is no Logger to read here.
- **`formatQtyWithCases_` pins its thousands separators to `en-US`.** SRC leaves
  it to the runtime locale. A Cloud Functions container's default is whatever
  the image says, and this string is written into a Trello card a human reads —
  `"1.250"` meaning one thousand two hundred and fifty is a genuinely dangerous
  thing to render on a shipping document.
- **No new routes.** None of these functions has a client call site in SRC.
  `setupCaseConversions` creates a sheet and `reportConversionGap` is a manual
  read; both are exported and neither is reachable over HTTP, deliberately.

## 6. Verification

Two new harnesses, both mutation-tested.

### `npm run test:parity:conversions` — 7,401 comparisons across 7 functions

The synthetic PRODUCT sheet is built around the failure this feature actually
had: `NT525S/2AMF` nicknamed *"2 Alarm SMALL Scorpion Tag"*, sharing no prefix
with its own conversion rule. The SKU corpus carries all three vocabularies the
2026-08-11 and 2026-08-28 changes left behind — raw QB names, nicknames, floor
case SKUs, the folded form, and the cap-truncated form.

Bridges two structural differences: SRC defines `getQbNameIndex_` *inside*
`Service_Conversions.js` and reads PRODUCT synchronously, where the port moved
it to `Shared_Classifiers` and split it async; and SRC relies on Apps Script's
single global namespace, reproduced by evaluating both files into one context.

| Mutation | Result |
|---|---|
| QB-name resolution removed from `findCaseConversion` | **116 differences** — every nickname returning `null` where SRC finds the rule. The 2026-08-26 bug, exactly. |

### `npm run test:parity:aging` — 198 comparisons + 1 verified divergence

| Mutation | Result |
|---|---|
| `EXPLODE_RESTORE` → `EXPLODE_ASSEMBLY` | **3 differences** |
| `SPLIT_IN` removed from both lists | **5 differences** |
| `namesMatch_` → the two-way substring test | **29 differences** |
| carried-date branch back to `MOVE_IN` only | **5 differences** |

Restored and re-verified green after each.

### Everything else

| Check | Result |
|---|---|
| `npm run lint` | ✅ exit 0, the same 6 pre-existing warnings |
| `npm run test:parity` (all four harnesses) | ✅ 1492 + 45850 + 7401 + 198 comparisons, 0 differences |
| `npm run test:routes` | ✅ 82 checks, 0 failures |
| `npm run test:lock` | ✅ 27 checks, 0 failures |
| `firebase emulators:exec --only functions` | ✅ clean boot, exit 0, routes answer correctly |

Total executed parity comparisons across the project: **54,941**.

## 7. Still open after Unit D

- **`Service_Assembly` parity** is now the largest remaining service gap:
  `commitInventoryMutation_`, `findEffectiveQtyPer_`, `explodePartialHub`. It
  lands together with `SS_API.commitAtomic` (AUDIT B3) or not at all —
  `batchUpdateSheet` is now in place as the primitive.
- **The sync/webhook functions** remain the largest body of unported code.
- **`primeQbNameIndex` is called at two sites, not globally.** If a third caller
  needs `namesMatch_`, it must await the prime too. A boot-time prime would be
  tidier but would put a PRODUCT read on the cold-start path of every request,
  including ones that never compare a name.

---

# UNIT E — `Service_Assembly` parity and `SS_API.commitAtomic` (AUDIT B3)

These were always going to land together or not at all, exactly as the brief
said: `explodePartialHub` → `commitInventoryMutation_` → `commitAtomic`.

## 1. What was actually wrong

Every assembly write path committed through **three or four separate Sheets API
calls**. A quota error, a network fault or a timeout landing between two of them
corrupts inventory in a way nothing reports:

| Path | The old call sequence | What a failure in the middle does |
|---|---|---|
| `buildHardAssembly` | update → **delete** → append → log-append | The consumed components are gone and the assembly was never minted. **Stock destroyed.** |
| `explodeAssembly` | update → append → log-append → **delete** | The components are restored *and* the assembly rows are still standing. **Stock doubled.** |

Both were live in this port. `buildHardAssembly` is the worse of the two —
losing stock outright is unrecoverable without a manual count, where doubling at
least shows up as an implausible number.

`explodePartialHub` did not exist here at all; its route answered 501.

## 2. What landed

| Ported | What it is |
|---|---|
| `SS_API.commitAtomic` | One `spreadsheets.batchUpdate` carrying updates + appends + deletes. The API applies it all-or-nothing. |
| `SS_API._a1ToGridRange`, `SS_API._toCellData` | Its two internals — A1 → GridRange, and one value → one typed CellData. |
| `commitInventoryMutation_` | The single commit point all three assembly paths now go through. |
| `findEffectiveQtyPer_` | Walks the recipe tree, multiplying `qtyPer` down through nested levels. |
| `explodePartialHub` | Partial explode of ONE Master Hub card at ONE location. `POST /assembly/explode-partial-hub` is live. |

All three write paths were rewired to collect their updates/appends/deletes/logs
and commit once at the end.

### Two guarantees, and neither replaces the other

- **`functions/lock.js`** (Unit A) stops *two writers interleaving*.
- **`commitAtomic`** stops *one writer half-finishing*.

A build can still fail — but it now fails having changed nothing, rather than
having deleted the components it was about to consume.

### `Audit_Log` stays outside the atomic set, deliberately

A missing log line is a reporting gap; a half-applied inventory change is a
data-integrity failure. The log append runs after the commit, and a failure
there is logged and swallowed rather than being allowed to report a failed
operation whose inventory effect already landed correctly.

SRC's stated reason is narrower — its log rows carry a live `new Date()`, and a
Date cannot go through `updateCells` without also setting a `numberFormat`, so
it would land as a bare `45000`. This port writes ISO strings, so that specific
constraint does not bite here, but the reporting-gap reasoning stands on its
own and the structure is kept.

`_toCellData` **throws** on a Date rather than coercing one, so if a future
caller does route a Date through `commitAtomic` it fails loudly instead of
writing a serial number into a cell.

## 3. The assembly paths also take the write lease

Same reasoning you approved for the move paths in Unit C, applied consistently:
all three read the whole Inventory sheet, compute row indices from that one
snapshot, and then write, append and delete against those indices. `commitAtomic`
makes that commit atomic; it does **not** stop a second writer from having
shifted the rows in between.

Leaving brand-new code (`explodePartialHub`) unlocked while `moveInventoryItem`
is locked would have been shipping a known hole, so all three are wrapped. Same
`…Locked_` split as everywhere else, so the lock stays one deletable line per
site. **Flagging it because it is another step beyond SRC** — say the word and
I will take it back out.

## 4. Verification

Two new harnesses. The important thing about the first is *what it compares*.

### `npm run test:parity:assembly` — 34 comparisons, 21 write scenarios

Both sides return `{success:true}` on the happy path, which proves nothing. So
this compares **what they write**: both are given a recording `SS_API` — SRC
through the global it already probes for, the port through a require.cache stub
— and the two streams of Sheets operations are diffed. A match means the same
cell updates, the same appended rows, the same deleted row indices, in the same
order, in the same single atomic call.

Scenarios include the vacate-vs-delete branch, bulk split across two locations,
a build with no recipe, a malformed payload, a partial explode with children
remaining elsewhere, the last-pallet case that folds into a full explode, more
kits than available, and a malformed `_SYS_` blob.

Two things are normalised and the harness says so: freshly-minted UUIDs become
`<uuid-N>` **in order of first appearance**, so reuse across rows still has to
match; and timestamps become `<ts>`, since SRC writes `Date` objects where the
port writes ISO strings.

| Mutation | Result |
|---|---|
| B3 reverted — four separate calls, restores before the delete | **13 differences** |
| `findEffectiveQtyPer_` stops recursing into nested kits | **2 differences** |
| `explodePartialHub` trusts `kitsToExplode` without the `maxKits` ceiling | **2 differences** |

A fourth mutation (reordering the keys of the `ops` object) changed nothing, and
correctly did not fail — the ordering guarantee lives inside `commitAtomic`, not
in its callers. That pointed at a real coverage gap, which is what the second
harness is for.

### `npm run test:parity:commit` — 17 comparisons

The assembly harness *stubs* `commitAtomic`, so nothing there covered what it
actually does. This one drives the **real** function on both sides — SRC's
through a stubbed `Sheets.Spreadsheets` global, the port's through a stubbed
`googleapis` — and diffs the emitted `requests` array.

Two invariants inside it are load-bearing and invisible from outside:

1. **updates → appends → deletes.** An append lands at the end of the sheet, so
   it must be emitted before any delete; a delete first shifts the rows the
   updates and appends were computed against.
2. **Deletes descending and de-duplicated.** Deleting row 5 shifts row 9 up to
   row 8, so an ascending list silently deletes the wrong rows.

| Mutation | Result |
|---|---|
| deletes sorted ascending | **3 differences** |
| duplicate delete indices no longer de-duplicated | **1 difference** |
| a non-finite number written instead of refused | **2 differences** |
| a Date coerced instead of throwing | **1 difference** |
| a numeric-looking string routed through `numberValue` | **1 difference** |

That last mutation initially passed, which was a **corpus gap, not a pass**: no
test string parsed as a number. Added `'12'`, `'0012'`, `'3.50'`, `'1e3'` — a
SKU like `0012` retyped as a number renders as `12` and the leading zeros are
gone for good. It fails correctly now.

### Everything else

| Check | Result |
|---|---|
| `npm run lint` | ✅ exit 0, 7 warnings (**was 6** — see below) |
| `npm run test:parity` (six harnesses) | ✅ 54,992 comparisons, 0 differences |
| `npm run test:routes` | ✅ 82 checks, 0 failures |
| `npm run test:lock` | ✅ 27 checks, 0 failures |
| `firebase emulators:exec --only functions` | ✅ clean boot, exit 0 |

**The lint warning count went 6 → 7.** The new one is
`no-inner-declarations` on `explodePartialHub`'s nested `restoreItemToSheet` —
identical to the pre-existing warning on `explodeAssembly`'s copy of the same
helper, and matching SRC's structure. Hoisting it would mean threading seven
closure variables through as parameters. Left nested, and flagged here so the
count changing is not a surprise.

## 5. Still open after Unit E

- **The sync/webhook functions** are now the largest body of unported code by a
  wide margin: `syncAllBoardsToShipmentsTab` (35KB), `Webhook_Receiver` (33KB),
  `evaluateRollupStatuses` (20KB), `pushOutboundToShippingSchedule` (35KB),
  `Service_Router` (12KB).
- **`Fedex_Master_Script.js`** (31KB) still accounts for four of the remaining
  eight 501 routes.
- **`Service_PO_Ingest`** is missing `extractTextFromPdfBlob` — the actual
  `pdf-parse` invocation — so PO ingest cannot read a PDF at all.
- **`cleanUpVacantRows` is still unlocked** (flagged in Unit C, unchanged).
