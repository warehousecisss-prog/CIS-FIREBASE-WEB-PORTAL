# Cloud Functions backend

Node backend for the CIS Warehouse Portal, ported from the Apps Script project
in `SRC/src/`. `reference/SCHEMA.md` is the operational contract; where code and
the doc disagree, the doc wins.

## Layout

| File | Role |
|---|---|
| `index.js` | HTTP entry points. Express app behind `exports.api`, plus the standalone email trigger and the (still stubbed) scheduled sync. |
| `admin.js` | The one and only `firebase-admin` `initializeApp()`. Require it for its side effect; never call `initializeApp()` anywhere else. |
| `config.js` | Every runtime config key, with its description and the `SRC/src` line it came from. The only module that reads `process.env`. |
| `auth.js` | Firebase Auth (Google provider) token verification, the domain allowlist, and `getActiveUserEmail()`. |
| `lock.js` | The inventory write lease — the Node stand-in for Apps Script's `LockService`. Deliberately disposable; read its header before touching it. |
| `services/` | Ported service modules. `Service_SheetsAPI.js` is the Sheets boundary; everything else goes through it. |

## Running locally

1. `cp .env.example .env` and fill in real values. Dummy values are enough to
   boot the emulator — `AUTH_DISABLED=true` in the template keeps local requests
   working without a signed-in browser.
2. From the repo root:

```bash
firebase emulators:start --only functions
```

Nothing throws at module load when config is missing. You get one warning line
per cold start naming the unset required keys, and an explicit error at the
point a request actually needs one. That is deliberate: throwing on require
would break `firebase deploy`'s analysis pass and stop the emulator booting.

## Configuration

The Firebase CLI loads `functions/.env` (and `functions/.env.<projectId>`) into
`process.env` for both the emulator and deploys. That is the whole mechanism —
there is no `functions.config()` usage and no Secret Manager binding yet.

Read config through `config.js`, never `process.env` directly:

```js
const config = require('./config');

config.require('BATCH_SHEET_ID');   // value, or throws naming the key
config.get('CIS_ZIPCODE');          // value or documented default
config.flag('RXO_DRY_RUN');         // "true"/"1"/"yes" -> boolean
config.list('ALLOWED_EMAIL_DOMAINS'); // comma-separated -> array
```

`functions/.env.example` lists every key with a dummy value and a comment
explaining what it is and where it came from. `config.js` carries the same
information as structured data, including which `SRC/src` line each key was
found on.

### Keys that are required

`BATCH_SHEET_ID`, `TRELLO_KEY`, `TRELLO_TOKEN`, `ALLOWED_EMAIL_DOMAINS`.
Everything else is either optional or has a default carried over verbatim from
the original's hardcoded `||` fallback.

### Two renames from the original

- **FedEx Track API credentials.** `SRC/src/Fedex_Master_Script.js:12-13` calls
  them `CLIENT_ID` / `CLIENT_SECRET`. Those names are too generic for a shared
  process environment, so `FEDEX_CLIENT_ID` / `FEDEX_CLIENT_SECRET` are primary
  here; the bare names still resolve as aliases so existing Script Property
  values lift across unchanged.
- **Trello key/token aliases.** `TRELLO_API_KEY` / `TRELLO_API_TOKEN` are
  accepted alongside `TRELLO_KEY` / `TRELLO_TOKEN`, because
  `SRC/src/Service_Write.js:1565-1566` reads the first pair and everything else
  reads the second.

### What is *not* config

The original writes these back with `setProperty`, so they are runtime state and
need a real store (Firestore) when their owning script is ported. They must not
go in `.env`:

`WEBHOOK_ERRORS_LAST_ROW`, `FR_WATCH_SEEN_DOCS`, `LAST_SYNCED_MODIFIED_TIME`,
and the write-back half of `TRELLO_BOT_MEMBER_ID`. They are listed in
`config.RUNTIME_STATE_KEYS`.

`STAKEHOLDER_EMAILS` is not a config key either — it lives in the workbook's
`Config` tab (`SRC/src/Service_Write.js:1376`).

## Auth

Firebase Auth with the Google provider, domain-locked, rejecting with 401.
Decided 2026-08-28; rationale and the alternatives considered are in
`PHASE_1_NOTES.md`.

The browser signs in with `GoogleAuthProvider` and sends the ID token as
`Authorization: Bearer <token>`. `attachIdentity` verifies it with
`admin.auth().verifyIdToken()`, requires `email_verified`, and checks the
address against `ALLOWED_EMAIL_DOMAINS` / `ALLOWED_EMAILS`. `requireAuth` then
401s anything without a resolved identity. Both are applied to every route.

Services take a `context` argument — pass the Express `req` straight through —
and call `getActiveUserEmail(context)` for the `Audit_Log` operator column.
That function **throws** rather than substituting a placeholder: an audit trail
that names nobody is worse than a request that fails loudly, because the sheet
then looks correct. Genuinely unattended callers (scheduled syncs, webhooks)
pass `SYSTEM_ACTOR` explicitly.

`GET /me` returns the resolved identity, for verifying the wiring without
performing a mutation.

## The Sheets boundary

`services/Service_SheetsAPI.js` is the only module that talks to the Sheets API.
Two rules it enforces, both load-bearing:

- **Writes use `valueInputOption: "RAW"`, never `"USER_ENTERED"`.** Every value
  written is free text originating in Trello. `USER_ENTERED` turns a checklist
  item named `-3M SLIDE` or a comment `=2 pallets short` into a formula that
  renders `#NAME?` permanently, and strips leading apostrophes. Nothing in this
  codebase writes an intentional formula. See `AUDIT_2026-08-24.md` B1.
- **Deletes take a resolved numeric gid, never a literal.** Use
  `SS_API.getSheetId('Inventory')`. Gid 0 is whichever tab was created first,
  not necessarily `Inventory`, and a wrong gid deletes rows out of the wrong
  tab. `batchDeleteRows` rejects a non-integer gid rather than guessing.

Appends also pass `insertDataOption: "INSERT_ROWS"` — the API default is
`OVERWRITE`, and a single blank row anywhere in `Inventory` truncates table
detection so an overwrite-mode append lands mid-sheet and destroys live rows
(`AUDIT_2026-08-24.md` B2).

## Write-path contract

Mutations return a result object and never report success when nothing was
written (`AUDIT_2026-08-24.md` A1). `modifySheetRow()` returns
`{success: false, error: 'Row not found for <loc>/<sku>…'}` when no row
resolves, and every caller returns that verbatim. Do not add a caller that
returns a hardcoded `{success: true}`.

## The write lock

`lock.js`. One export, `withInventoryLock(fn, {label})`, holding a **lease** in
a single Firestore document (`_portal_locks/inventory`). It replaces
`LockService.getScriptLock()`, which has no Node counterpart
(`AUDIT_2026-08-24.md` B7, SCHEMA invariant #59). Project-wide, one writer at a
time — the same scope the original used, because the write path resolves rows
by scanning a full-sheet snapshot, so a per-row lock would not protect the scan
that decides *which* row to take.

Three things to know before touching it:

- **It is deliberately disposable scaffolding.** The intended end state is
  Postgres, which does this properly per row. Keep the whole mechanism behind
  the one function so it deletes in one go. Do not add a second entry point.
- **The lease expires (60s).** A Cloud Functions container can be frozen or
  killed after responding, so `finally` is not a guarantee and a lock with no
  expiry would wedge the write path permanently. If the function timeout is
  ever raised above 60s, raise `LEASE_TTL_MS` to match.
- **It fails OPEN, loudly.** If Firestore is unreachable the write proceeds
  unlocked, logs an error, and carries `lockDegraded: true` on the result.
  Refusing every write when the lock store is down would turn a
  misconfiguration into a warehouse-wide outage, and it would announce itself
  as "Server busy", which points at the wrong problem. *Contention* never fails
  open.

The row-data-mismatch guard in `modifySheetRow` is **not** made redundant by
the lock and must stay: the lease only serialises our own writers, and people
edit that spreadsheet by hand.

Requires Firestore to be enabled on the project (Native mode). Verify with
`npm run test:lock:emulator` — needs Java 21+ on `PATH`, no credentials, no
real database.
