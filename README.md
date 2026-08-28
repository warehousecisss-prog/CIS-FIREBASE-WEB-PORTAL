# CIS-FIREBASE-WEB-PORTAL

CIS Warehouse Portal, refactored from Google Apps Script to Firebase Functions +
React. **Port in progress** — see `PORT_AUDIT.md` for the honest state of it.

## Read these first

| Document | What it is |
|---|---|
| [`PORT_AUDIT.md`](PORT_AUDIT.md) | Service-by-service map of what is actually ported, stubbed, or missing. Start here. |
| [`PHASE_1_NOTES.md`](PHASE_1_NOTES.md) | What Phase 1 changed: the config spine, the C1–C5 regression fixes, and the auth decision. |
| [`reference/SCHEMA.md`](reference/SCHEMA.md) | The canonical operational contract (v17). **Source of truth** — if code contradicts it, the doc wins. |
| [`reference/AUDIT_2026-08-24.md`](reference/AUDIT_2026-08-24.md) | Known critical bugs in the original, several of which regressed during the port. |
| [`functions/README.md`](functions/README.md) | Backend orientation: layout, configuration, auth, the Sheets rules. |

> `MIGRATION_CHANGELOG.md` marks every backend service `[DONE]`. **Those markers
> are wrong.** Verify against `PORT_AUDIT.md` and the original source.

## Layout

```
functions/     Cloud Functions backend (Express behind exports.api)
frontend/      Vite + React SPA
reference/     Vendored porting contract — SCHEMA, audit, changelog
SRC/           The original Apps Script source, kept locally as the reference
               implementation. Its own git repo; gitignored here.
```

## Getting started

```bash
cd functions && npm install && cp .env.example .env
```

Fill in `functions/.env` (every key is documented there and in `functions/config.js`),
then from the repo root:

```bash
firebase emulators:start --only functions
```

`.env.example` ships `AUTH_DISABLED=true`, which is honoured only under the
emulator, so local requests work without a signed-in browser.

## Two rules that are load-bearing

- **Sheets writes use `valueInputOption: "RAW"`, never `"USER_ENTERED"`.** Every
  value written originates as free text in Trello. `USER_ENTERED` turns a
  checklist item named `-3M SLIDE` into a formula that renders `#NAME?` forever.
- **The write path never reports success when nothing was written.** Mutations
  return `{success: false, error}` when the target row cannot be resolved, and
  callers propagate that verbatim.
