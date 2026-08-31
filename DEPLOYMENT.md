# Deployment Preparation

**Written:** 2026-08-31, at the end of Phase 5.
**Audience:** you, doing this for the first time, on a project that does not
exist yet.

This is the single checklist for getting the ported backend running on a real
Firebase project. It is written to be worked through top to bottom. Where a step
can go wrong quietly, it says so.

Nothing here has been done yet — there is no Firebase project, no Firestore, no
deployed function. Everything below is the *first* time.

---

## 0. Before anything: the one thing to fix in the OLD system

**This is not about the port. It affects the Apps Script portal you are running
today, and it is still happening every hour.**

Every time the hourly sync archives a completed shipment, every shipment listed
below it on the SHIPMENTS tab inherits **a different shipment's ETA data** —
its estimated arrival, its ready-to-ship date, its port, its "someone overrode
this" flag. Archive four shipments in one cycle and six survivors end up wrong.
It compounds.

The cause: the SHIPMENTS sheet is 18 columns wide. Columns A–J are the shipment;
K–R are all the date/ETA tracking. When the old code removes a finished row it
slides **A–J** up to close the gap and leaves K–R where they are. The two halves
of every row below come apart.

The port fixes this. The original does not. If ETAs on the current dashboard
have ever looked inexplicably wrong, this is the likeliest reason.

**Nothing to do here for the deployment** — just don't be surprised, and
consider whether the old system should keep running once the new one is live.

---

## 1. Create the Firebase project

1. Go to the Firebase console and create a project. Note the **project ID** (not
   the display name) — it looks like `cis-warehouse-portal-4a1b`.
2. Upgrade it to the **Blaze (pay-as-you-go)** plan. Cloud Functions v2 requires
   it. At this workload the cost is small, but it is not the free tier.

Then replace the placeholder project name in **three** files. All three
currently say `cis-warehouse-portal`, which is **not a real project**:

| File | What to change |
|---|---|
| `.firebaserc` | the `default` alias |
| `frontend/src/api.js` (line 2) | the production API base |
| `functions/package.json` | the `test:lock:emulator` script's `--project` |

> **Why this matters:** deploying against a placeholder either fails outright or,
> worse, succeeds against someone else's project name if it happens to exist.

---

## 2. Enable Firestore

Firestore is used for exactly two things, both small:

- the **inventory write lock** (`functions/lock.js`) — stops two people writing
  the same pallet at the same moment
- the **webhook de-bounce** (`functions/webhook_dedupe.js`) — stops Trello's
  duplicate deliveries being processed twice

Create the Firestore database in **Native mode**, in the same region you will
deploy functions to.

**If you skip this:** the code does not crash. It fails open, loudly — writes
proceed unlocked, an error is logged, and results are tagged
`lockDegraded: true`. That is deliberate, but it is a degraded mode, not a
supported one.

### One easily-missed step: a TTL policy

Set a **TTL policy** on the collection `webhook_dedupe`, on the field
`expiresAt`. (Firestore console → the collection → TTL.)

Without it, nothing breaks — reads are by document ID, so speed is unaffected —
but the collection grows by one tiny document per Trello event, forever. This is
housekeeping, not correctness. Do it now so it isn't discovered in a year.

---

## 3. Service account access to the spreadsheets

The functions run as a **service account**, not as you. It cannot see anything
in your Drive by default. The old Apps Script ran as *you*, which is why this
step never existed before.

Find the service account address in the Firebase console (Project settings →
Service accounts). It looks like
`firebase-adminsdk-xxxxx@<project-id>.iam.gserviceaccount.com`.

**Share these with it:**

| Spreadsheet | Access | Needed for |
|---|---|---|
| The main operational workbook (`BATCH_SHEET_ID`) | **Editor** | Everything. Non-negotiable. |
| The AEO sheet (Power Automate updates it) | Viewer | Step 5 only — the outbound push |
| The Burlington sheet (your Python script uploads it) | Viewer | Step 5 only — the outbound push |

> The two external sheets are only needed when you do Step 5 (the AEO/Burlington
> push). You already have a service account set up for the Python script; this
> is the same kind of sharing.

**A quiet failure to watch for:** if the Burlington upload creates a *new*
spreadsheet each run rather than updating one, the ID changes and sharing
lapses. It must write into a **stable** Google Sheet (converted, not a raw
`.csv` file sitting in Drive).

---

## 4. Configuration keys

These live in `functions/.env` for local work, and should move to **Secret
Manager** for anything marked *secret* before real use (see Open Decisions).

`functions/config.js` is the authoritative list, with a description and the
original source line for every key. The ones you must set:

### Required — nothing works without these

| Key | What it is |
|---|---|
| `BATCH_SHEET_ID` | The operational workbook's spreadsheet ID |
| `TRELLO_KEY` | Trello API key |
| `TRELLO_TOKEN` | Trello API token |

### Webhook — set these two together, or neither

| Key | What it is |
|---|---|
| `TRELLO_API_SECRET` | The **OAuth secret** from trello.com/app-key — not the key, not the token |
| `WEBHOOK_CALLBACK_URL` | The exact URL you register with Trello, e.g. `https://us-central1-<project>.cloudfunctions.net/trelloWebhook` |

> **Read this before setting them.** Trello signs each webhook using the body
> **plus the callback URL**. If `WEBHOOK_CALLBACK_URL` differs from what you
> registered by even a trailing slash, **every webhook is rejected** — and Trello
> does not re-send on request, so those events are gone.
>
> The code is deliberately inert until both are set: it logs a warning and
> accepts deliveries. So the safe order is: **deploy → register the webhook →
> confirm real card changes are landing → only then set these two and redeploy →
> confirm again.**

### Email (outbound notifications)

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. If unset, email
fails soft with a logged reason rather than crashing.

### Optional

`TRELLO_BOT_MEMBER_ID` — only if you set up a dedicated automation Trello
account. Without it, the system detects "someone changed this due date by hand"
by comparing values instead of identities, which works.

Board IDs (`INBOUND_PO_BOARD_ID` etc.) already have correct defaults.

### Retired — delete if present

`WEBHOOK_HOP_SECRET`. It authenticated the Render.com proxy, which no longer
exists.

---

## 5. Config on the spreadsheet itself

The workbook needs a tab named **`Config`**, two columns (key, value), used for
notification recipients:

| Key | Used by |
|---|---|
| `FEDEX_STAKEHOLDER` | "PO Delivered in Full" emails |
| `STAKEHOLDER_EMAILS` | Receiving notifications, and the fallback for the above |

**If neither is set**, the delivered-in-full email is **skipped** and an error is
logged naming the tracking numbers nobody was told about. The status update and
the Trello card completion still happen — only the notification is lost. The old
system emailed whoever owned the script; a scheduled cloud function has no such
person, and inventing one seemed worse than saying so loudly.

Also create a tab named **`Webhook_Errors`** with headers
`Timestamp | Card ID | Error | Raw Payload`. Failed webhooks write their raw
payload there so the event can be replayed by hand. Without the tab, failures
still get logged, just less recoverably.

---

## 6. Hosting: the `/api` rewrite

`firebase.json` currently has only the single-page-app catch-all. The frontend
calls `/api/...`, so **every API call in production would be answered with the
HTML page instead**, which surfaces as a confusing JSON parse error rather than a
404.

Add to `hosting.rewrites`, **before** the catch-all (order matters — first match
wins):

```json
{ "source": "/api/**", "function": "api" }
```

This was deliberately left undone because it is a deploy-topology change and
there was no project to decide it against. Now there is.

---

## 7. Sign-in (currently blocking)

`frontend/src/api.js` sends no `Authorization` header, because the **Firebase JS
SDK has not been added to the frontend** — a new dependency, which needed your
approval.

Until that lands, **every deployed API call returns 401.** Local development
works via `AUTH_DISABLED=true`; that must never be set on a real project.

This is the one item on this list that blocks a *usable* deployment. The backend
is ready; the browser has no way to say who it is.

---

## 8. Deploy

```bash
cd "C:/Users/Michael/Desktop/WEB PORTAL FIREBASE SRC" && npm --prefix functions test
```

Run the full test suite first. It should end `EXIT=0` with every suite OK.

```bash
firebase deploy --only functions
```

Four functions deploy:

| Function | What it is |
|---|---|
| `api` | Every SPA route (71 of them) |
| `trelloWebhook` | The real-time Trello endpoint |
| `triggerEmailNotification` | Standalone PO email endpoint |
| `scheduledSync` | The hourly full sync — 9-minute timeout |

`firebase deploy` runs `npm run lint` first. It should pass with 0 errors and 10
warnings; the warnings are pre-existing and expected.

---

## 9. Register the Trello webhook

**The Render.com proxy is gone.** Point Trello directly at the function. Nothing
needs to stay awake, and the 5-minute keep-alive ping is no longer needed —
delete that trigger from the old Apps Script project when you retire it.

For each of the four boards, register a webhook with:

- `callbackURL` = `https://us-central1-<project>.cloudfunctions.net/trelloWebhook`
- `idModel` = the board ID

Trello validates the endpoint with a `HEAD` request first; the function answers
`200`, so registration should succeed immediately. If it does not, the URL is
wrong — check it in a browser, it should say `Trello Webhook Active`.

Then do the confirm-before-locking sequence from §4: verify real card changes
appear in SHIPMENTS **before** setting `TRELLO_API_SECRET`.

---

## 10. First-run verification, in order

1. `GET /me` with a signed-in token → returns your email. (Auth works.)
2. `GET /boot` → returns the nine datasets and `bootIssues: []`. **A non-empty
   `bootIssues` names exactly which dataset failed and why** — that is the first
   place to look if the portal loads but a view is empty.
3. Move a card on Trello → the SHIPMENTS row updates within seconds.
4. Wait for the hourly sync, or trigger it manually → check the logs for
   `syncAllBoardsToShipmentsTab complete in Ns` with a sensible summary.
5. Check Firestore for a `webhook_dedupe` collection appearing. (Confirms the
   de-bounce is live and not silently degraded.)

---

## When you want the AEO / Burlington push (Phase 5, Step 5)

Not yet ported. Independent of everything above — it is a one-way push from your
two external sheets to Trello cards and never touches SHIPMENTS.

What it will need:

1. Both sheets shared with the service account (§3).
2. Two new config keys for their spreadsheet IDs (currently hardcoded in the
   original).
3. A confirmation that the Burlington Python upload writes to a **stable**
   Google Sheet with a fixed ID and an `Orders` tab, and that the AEO sheet keeps
   its `2026` tab.
4. The `Burl_Transit_Time` tab on the Burlington sheet, if ship-by dates are to
   be computed rather than falling back to the raw in-store date.

The original also carries two manual repair scripts (`repairStaleDueDates`,
`runBurlingtonSyncDryRun`) that are useful during first setup and can be ported
alongside.

---

## Open decisions, carried forward

These are recorded rather than decided. None blocks deployment except #3.

| # | Item | Recommendation |
|---|---|---|
| 1 | **Secrets are plain env vars**, not Secret Manager | Move `TRELLO_TOKEN`, `TRELLO_API_SECRET`, `SMTP_PASS` before real use |
| 2 | **CORS is `origin: true`** (any origin) | Narrow to the Hosting domain. Safe today only because every route is token-gated |
| 3 | **Frontend sign-in missing** | Add the `firebase` JS SDK. **Blocks a usable deployment** |
| 4 | **Scanned-PDF purchase orders** | The original OCR'd scanned POs via Google Drive; the port reads text-layer PDFs only and refuses scans honestly. Needs a new dependency (Cloud Vision) if you want it back |
| 5 | **Three writers, one status column** | The sync, the webhook and the rollup engine all write SHIPMENTS column J with no lock. Same as the original — neither widened nor narrowed. Worth deciding once real load exists |
| 6 | **`cleanUpVacantRows` is unlocked** | Low priority; a housekeeping sweep, not a hot path |
| 7 | **Malformed webhook JSON returns 400** | The platform's body parser rejects it before our code runs. Arguably correct (a truncated delivery is what a retry fixes) but it means that one case isn't captured to `Webhook_Errors` |
| 8 | **No RXO test-bench page** | The old `?page=rxo` bench has no SPA route. Backend `Service_RXO` is ~80% ported |

---

## What is NOT covered by any test

Said plainly, because the test numbers are large and could imply more than they
prove. **57,298 automated comparisons against the original** cover logic. They
do **not** cover:

- that Trello or Google Sheets calls actually succeed against the live APIs —
  every transport is simulated
- the schedule actually firing
- Trello rate limits or pagination at real volume
- the frontend, which is still ~10% ported (shell and map graphics only; the
  views are placeholders)

The first real deployment is therefore also the first real test of the
connections. Work through §10 in order and the failures will be
self-identifying.
