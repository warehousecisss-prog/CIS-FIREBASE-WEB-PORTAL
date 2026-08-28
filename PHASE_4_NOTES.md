# Phase 4 — the write-path lock, and `Service_Dates` parity

**Date:** 2026-08-28
**Baseline:** `371ac57` (end of Phase 3)
**Scope:** two units. Unit A is the write-path lock (AUDIT B7). Unit B is
`Service_Dates` parity.

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
- **Three write paths SRC leaves unlocked are still unlocked here** —
  `moveInventoryItem`, `moveHubGroup`, `removeItemFromLocation`. This is
  faithful to SRC, but `moveInventoryItem` is arguably the most dangerous of the
  lot: it reads the whole sheet, computes, and then does several writes, appends
  and deletes. Adding `withInventoryLock` to them is now a one-line change each.
  Deliberately **not** done — it is a behaviour change beyond the stated scope
  and beyond what the original does. Flagged for a decision.
