# Phase 1 — Infra spine + critical regressions

**Date:** 2026-08-28
**Baseline:** `700024b` (PORT_AUDIT.md added)
**Scope:** config/infra spine, C1–C5 from `PORT_AUDIT.md`, auth decision.
Phase 2 (`Shared_Classifiers`, Write/Read parity) deliberately **not** started.

---

## Auth decision

**Firebase Auth with the Google provider, domain-locked, rejecting with 401.**
Decided 2026-08-28.

The browser signs in with `GoogleAuthProvider`; the ID token travels as
`Authorization: Bearer <token>`; `attachIdentity` (`functions/auth.js`) verifies
it with `admin.auth().verifyIdToken()`, requires `email_verified`, and checks
the address against `ALLOWED_EMAIL_DOMAINS` / `ALLOWED_EMAILS`. `requireAuth`
then 401s anything without a resolved identity. Both are applied to every route
on the Express app, and `triggerEmailNotification` (a separate `onRequest`, so
it inherits nothing) runs the same gate inline.

### Why, and what was rejected

The Apps Script original deploys `ANYONE_ANONYMOUS` but runs inside a Google
login, which is the only reason `Session.getActiveUser().getEmail()` returns a
real operator address for every `Audit_Log` row. Cloud Functions has no ambient
identity, so the port has to reconstruct it explicitly.

- **Cloud IAP** — rejected. It would give Google-managed identity at the edge
  with no client-side auth code, but it does not cover Firebase Hosting: it
  needs the frontend moved behind a load balancer or Cloud Run. That is a
  deploy-topology change. IAP also does not run in the Firebase emulator, so
  local dev would need a bypass path regardless.
- **Anonymous, no attribution** — rejected. It keeps every mutation endpoint
  publicly callable and leaves `Audit_Log`'s operator column meaningless, which
  guts the wall-to-wall audit and the receiving flow.

### Enforcement details

- **Fail closed on the allowlist.** `ALLOWED_EMAIL_DOMAINS` is a *required*
  config key. An empty allowlist rejects everyone and logs an error; it never
  degrades to "any Google account is fine".
- **A bad token is a 401, not a downgrade to anonymous.** A caller who sent
  credentials and got them wrong should hear about it.
- **Emulator escape hatch.** `AUTH_DISABLED=true` bypasses verification, but
  only when `FUNCTIONS_EMULATOR === 'true'`. Deployed code ignores the flag
  entirely, so a stray `AUTH_DISABLED` in a production `.env` cannot open the
  API. Bypassed requests are attributed to `DEV_OPERATOR_EMAIL`
  (`emulator-operator@localhost`), deliberately non-routable so local writes are
  identifiable in the sheet.

### C5 — operator identity

`getActiveUserEmail()` used to be three copies of a constant stub
(`Service_Write`, `Service_Assembly`, `Service_Diagnostics`), returning
`system@cis-portal.app` / `portal-backend@automated.local`. All three now import
one accessor from `functions/auth.js`.

It **throws** when identity is unresolvable rather than substituting a
placeholder. An audit trail that names nobody is worse than a request that fails
loudly, because the sheet then looks correct. `Service_Diagnostics` is the one
exception — it uses the non-throwing `getActiveUserEmailOrNull()`, because a
crash report should still land when the caller's session has expired. Genuinely
unattended callers (scheduled sync, webhooks) pass the exported `SYSTEM_ACTOR`
constant explicitly, so "no operator" is always a deliberate choice at the call
site.

### Still outstanding for auth

**The frontend has no sign-in yet.** `frontend/src/api.js` sends no
`Authorization` header, so against a deployed backend every call now 401s. Local
dev works because `.env.example` ships `AUTH_DISABLED=true`. Wiring this up
needs the `firebase` JS SDK added to `frontend/package.json` — **a new
dependency, which needs your approval**, so it was not done here.

---

## Config / infra spine

### New files

| File | Role |
|---|---|
| `.firebaserc` | Project alias `default` → `cis-warehouse-portal`, confirmed against `frontend/src/api.js:2`. |
| `functions/admin.js` | The one and only `firebase-admin` `initializeApp()`, guarded on `admin.apps.length`. |
| `functions/config.js` | Every runtime config key as structured data — description, required flag, default, aliases, and the `SRC/src` line it came from. |
| `functions/auth.js` | Token verification, allowlist, `getActiveUserEmail`. |
| `functions/.env.example` | Dummy-valued template documenting every key. |
| `functions/README.md` | Backend orientation: layout, config, auth, the Sheets rules, the write-path contract. |
| `functions/.eslintrc.js` | See "Incidental fixes" below. |

### How config is loaded

The Firebase CLI auto-loads `functions/.env` (and `functions/.env.<projectId>`)
into `process.env` for both the emulator and deploys. No `functions.config()`,
no Secret Manager binding. **Moving the `secret: true` keys into Secret Manager
via `defineSecret` is a deploy-topology change and was deliberately left for
your call.**

Validation is lazy by design. Cloud Functions loads every module during
deploy-time analysis and at each cold start, so throwing on `require` would
break `firebase deploy` and stop the emulator booting. Instead: `config.get()`
returns the default, `config.require()` throws at the point of use naming the
key, and a single warning line names any unset required keys on the first
request.

> That warning fires on **first request**, not at module load. The emulator's
> function-discovery pass runs without `.env` injected, so warning at load time
> reported all four required keys missing against a fully-populated `.env` —
> exactly the false alarm that teaches people to ignore warnings.

### Config keys

Enumerated by grepping `SRC/src` for `PropertiesService…getProperty`. Every key
is declared in `functions/config.js` with its originating `SRC/src` line.

**Required** (unset ⇒ named in the cold-start warning, throws at point of use):

| Key | Notes |
|---|---|
| `BATCH_SHEET_ID` | The original could fall back to the bound spreadsheet; Cloud Functions cannot, so this is mandatory. |
| `TRELLO_KEY` | `TRELLO_API_KEY` accepted as an alias. |
| `TRELLO_TOKEN` | `TRELLO_API_TOKEN` accepted as an alias. |
| `ALLOWED_EMAIL_DOMAINS` | port-only. Required so the allowlist cannot be empty by accident. |

**Optional, with defaults carried over verbatim from the original's hardcoded
`||` fallbacks:** `TRELLO_ORG_ID`, `INBOUND_PO_BOARD_ID`,
`INBOUND_NICOLE_BOARD_ID`, `BURLINGTON_OUTBOUND_BOARD_ID`, `OUTBOUND_BOARD_ID`,
`BURLINGTON_OUTBOUND_TO_BE_SHIPPED`, `BURLINGTON_SHEET_SYNC`, `FEDEX_ACCOUNT`,
`CIS_ZIPCODE`, `RXO_DRY_RUN`, `GLOBAL_SURCHARGE_RATE`.

**Optional, no default:** `TRELLO_BOT_MEMBER_ID`, `FEDEX_CLIENT_ID`,
`FEDEX_CLIENT_SECRET`, `FEDEX_RATES_KEY`, `FEDEX_RATES_SECRET`,
`RXO_CLIENT_ID`, `RXO_CLIENT_SECRET`, `RXO_API_KEY`, `RXO_SCOPE`,
`RXO_PARTNER_CODE`, `WEBHOOK_HOP_SECRET`, `HTS_FILE_ID`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET`, `ONEDRIVE_DRIVE_ID`, `ONEDRIVE_ITEM_ID`.

**port-only (no Apps Script ancestor):** `ALLOWED_EMAIL_DOMAINS`,
`ALLOWED_EMAILS`, `AUTH_DISABLED`, `DEV_OPERATOR_EMAIL`, `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.

#### Two renames

- **FedEx Track API credentials.** `SRC/src/Fedex_Master_Script.js:12-13` names
  them just `CLIENT_ID` / `CLIENT_SECRET`. Far too generic for a process
  environment shared with the Firebase runtime, so `FEDEX_CLIENT_ID` /
  `FEDEX_CLIENT_SECRET` are primary and the bare names resolve as aliases —
  existing Script Property values lift across unchanged.
- **Trello key/token.** Both naming conventions are accepted because
  `SRC/src/Service_Write.js:1565-1566` reads `TRELLO_API_KEY`/`TRELLO_API_TOKEN`
  first while everything else reads `TRELLO_KEY`/`TRELLO_TOKEN`.

#### Deliberately *not* config

The original writes these back with `setProperty`, making them runtime state.
They need a real store (Firestore) when their owning script is ported, and are
listed in `config.RUNTIME_STATE_KEYS`:

`WEBHOOK_ERRORS_LAST_ROW` · `FR_WATCH_SEEN_DOCS` · `LAST_SYNCED_MODIFIED_TIME` ·
the write-back half of `TRELLO_BOT_MEMBER_ID`.

`STAKEHOLDER_EMAILS` is also not a config key — it lives in the workbook's
`Config` tab (`SRC/src/Service_Write.js:1376`).

### Node engine

`functions/package.json` `engines.node`: `18` → **`22`**. Node 18 is EOL and
Cloud Functions is pushing 20/22.

---

## Critical regressions fixed

### C1 — `USER_ENTERED` → `RAW`

`functions/services/Service_SheetsAPI.js`. Both `batchUpdateValues` and
`batchAppendRows` now use `valueInputOption: "RAW"`, matching
`SRC/src/Service_SheetsAPI.js:20-35,59-89`. The original's explanatory comment
is carried across verbatim. `grep -rn "USER_ENTERED" functions/` returns
nothing.

**Also brought over in the same call:** `insertDataOption: "INSERT_ROWS"` on
`batchAppendRows`. This is AUDIT B2 rather than C1, but it is one field in the
same request object the C1 fix touches, and the API default (`OVERWRITE`)
combined with the `!A1` range means a single blank row anywhere in `Inventory`
truncates table detection and the append lands mid-sheet, overwriting live rows.
Knowingly leaving a data-destroying default in a line I was already editing
seemed worse than the small scope creep. Flagging it explicitly since it is one
step past the letter of C1.

### C2 — silent write-failure path (AUDIT A1)

`modifySheetRow()` now always returns a result object:

- no row resolved → `{success: false, error: 'Row not found for <loc>/<sku>. The
  pallet may have been moved or deleted by another station.'}`, logged
- thrown exception → `{success: false, error: e.toString()}`
- otherwise → `{success: true}`

**Return-contract parity vs `SRC/src/Service_Write.js`** (comments and
whitespace stripped):

| Caller | SRC | Port | |
|---|---|---|---|
| `setTotalStock` | `return modifySheetRow(…)` | `return modifySheetRow(…)` | match |
| `updateStock` | `return modifySheetRow(…)` | `return modifySheetRow(…)` | match |
| `updateInventoryField` | `return modifySheetRow(…)` | `return modifySheetRow(…)` | match |
| `updatePalletComment` | `return modifySheetRow(…)` | `return modifySheetRow(…)` | match |
| `reservePallet` | `return modifySheetRow(…)` | `return modifySheetRow(…)` | match |

Before this change: `setTotalStock`, `updateStock` and `reservePallet` returned
a hardcoded `{success: true}`; `updateInventoryField` and `updatePalletComment`
returned **`undefined`**, which the client's `res.success !== false` check reads
as success — so a comment saved onto a vanished row looked identical to one that
landed.

Two remaining deltas against SRC inside `modifySheetRow`, both Phase 2:

1. **No lock.** SRC takes `LockService.getScriptLock().tryLock(10000)` and
   returns `{success:false, error:"Server busy. Please try again."}` on
   contention (AUDIT B7). Apps Script's `LockService` has no Node counterpart;
   this needs a Firestore transaction or a distributed lock, which is its own
   design decision.
2. **`validateQty_` is missing.** SRC's `setTotalStock`/`updateStock` reject
   non-finite quantities up front (AUDIT B5). `validateQty_` is one of the ten
   `Service_Write` functions PORT_AUDIT already lists as not ported, so it stays
   Phase 2 — but note that until it lands, `NaN` can still reach column C.

Also fixed here: the callback is now **awaited**. Several callbacks are `async`
(they append to `Audit_Log`), and the previous fire-and-forget call let
`modifySheetRow` resolve before the audit write had left the process — in Cloud
Functions the container is free to freeze at that point, so the row simply never
landed.

### C3 — `getSpreadsheetId()` placeholder

Now `config.require('BATCH_SHEET_ID')`. A missing value throws naming the key
instead of returning `"PLACEHOLDER_SHEET_ID"` for every read and write to 404
against.

### C4 — hardcoded `sheetId: 0`

`SS_API.getSheetMetadata(name)` / `SS_API.getSheetId(name)` resolve the real
numeric gid via `spreadsheets.get` (fields-masked to `sheets.properties`, so it
is a cheap call) and cache it per process. A tab that is not found triggers one
refetch, then throws listing the known tabs — deliberately no fallback, because
any default is a guess and the failure mode of a guessed gid is destroyed data
in an unrelated tab.

All three hardcoded call sites replaced: `Service_Write.js` `modifySheetRow`,
`moveInventoryItem`, and `cleanUpVacantRows`. `batchDeleteRows` now also rejects
a non-integer `sheetId` argument rather than passing a guess to the API.

This incidentally fixes a latent crash: `Service_Assembly.js` already called
`SS_API.getSheetMetadata("Inventory")` in two places, and that function did not
exist.

### C5 — operator identity

Covered under **Auth decision** above.

---

## Incidental fixes

Small, reported rather than quietly folded in:

- **`npm run lint` had never worked.** There was no ESLint config file at all,
  while `firebase.json` runs `npm --prefix "$RESOURCE_DIR" run lint` as a
  `predeploy` hook — so `firebase deploy` would have aborted before it started.
  Added `functions/.eslintrc.js` on `eslint:recommended` (not
  `eslint-config-google`, which is in devDependencies but would turn the ported
  Apps Script formatting into ~thousands of deploy blockers and simply get the
  hook disabled). Now green: 0 errors, 8 warnings, all pre-existing.
- **`Service_Assembly.js` line 2 was a guaranteed runtime crash.**
  `const { getUuid } = require('crypto')` destructures `undefined` — the module
  exports `randomUUID`, not `getUuid` — so all four call sites in `buildAssembly`
  and `explodeAssembly` would throw `getUuid is not a function`. Replaced with
  the same local helper `Service_Write.js` already uses. I was in the file for
  C5 and leaving a known crash behind seemed worse than the scope creep.
  `Service_Read.js:2` has the same dead import, but nothing calls it there, so
  it was left alone for Phase 2.

---

## Verification

`firebase emulators:start --only functions`, `.env` copied from `.env.example`:

| Check | Result |
|---|---|
| Boots with a populated `.env` | ✅ no throw, no missing-config warning |
| Boots with `BATCH_SHEET_ID` blanked | ✅ no throw; warns `Missing required configuration: BATCH_SHEET_ID` |
| `GET /me`, `AUTH_DISABLED=true` | ✅ `200` `{"email":"emulator-operator@localhost","emulatorBypass":true}` |
| `GET /me`, no token, bypass off | ✅ `401` "Authentication required." |
| `GET /me`, garbage bearer token | ✅ `401` "Invalid or expired sign-in." |
| `grep -rn "USER_ENTERED" functions/` | ✅ no matches |
| `npm run lint` | ✅ exit 0 |

---

## Not done — still open

**Phase 1 items with a dependency on you:**

- Frontend sign-in (needs the `firebase` JS SDK — a new dependency).
- Secret Manager for the `secret: true` keys (deploy-topology change).

**Explicitly out of Phase 1 scope, unchanged:**

- `Shared_Classifiers`, Write/Read parity — Phase 2.
- `SS_API.commitAtomic` (AUDIT B3, the atomic assembly commit) — present in
  `SRC/src/Service_SheetsAPI.js`, not ported, because its only callers are the
  assembly write paths that are Phase 2 work.
- `LockService` equivalent (AUDIT B7).
- `validateQty_` and the other nine missing `Service_Write` functions.
- CORS is still `origin: true`. Acceptable while every route is bearer-token
  gated — a cross-origin page cannot read another origin's ID token — but it
  should be narrowed to the Hosting domain. Marked with a TODO in `index.js`.
- `scheduledSync` is still a one-line log.
