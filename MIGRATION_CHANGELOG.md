# Migration Changelog

This document tracks the progress of porting the CIS Warehouse Portal codebase to Firebase + React.

## Initialization Phase
- **[DONE]** Scaffolded `WEB PORTAL FIREBASE SRC` folder structure.
- **[DONE]** Initialized Vite + React frontend skeleton (including `TopNav`, `SidePanel`, `ViewMenu`, `App.jsx`).
- **[DONE]** Initialized Firebase Functions and Hosting configuration (`firebase.json`, `functions/package.json`).
- **[DONE]** Created frontend `api.js` to abstract backend calls.

## Backend Service Porting
- **[DONE]** `Service_SheetsAPI.js`: Ported native GAS Advanced Sheets Service to Node.js using `googleapis`.
- **[DONE]** `Service_Assembly.js`: Ported to async Node.js `SS_API` for fast kit builds/explosions.
- **[DONE]** `Service_Conversions.js`: Ported to async Node.js `planCaseConversion` using `SS_API`.
- **[DONE]** `Service_Dates.js`: Ported Trello ETA state-machine logic to native Node.js.
- **[DONE]** `Service_Diagnostics.js`: Ported to use async Node.js log sinks.
- **[DONE]** `Service_PO_Ingest.js`: Ported PO parser to use `pdf-parse` library in Node.js instead of Google Drive API OCR.
- **[DONE]** `Service_RXO.js`: Ported RXO integration to Node.js `fetch` and `process.env`.
- **[DONE]** `Service_Read.js`: Ported caching engine to in-memory `Map`, Trello card injectors to native `fetch`, and legacy `SpreadsheetApp` to `SS_API` for fast dashboards.
- **[DONE]** `Service_Validate.js`: Ported validation logic to use `SS_API` (Node.js/Firebase) instead of native `SpreadsheetApp`.
- **[DONE]** `Service_Write.js`: Fully ported 1300+ lines of complex inventory mutations (move, receive, convert, fedex) to async Node.js `SS_API` and `fetch` based Trello requests.

## Frontend Views Porting
- **[PENDING]** Dashboard View
- **[PENDING]** FedEx View
- **[PENDING]** SVG Map Components
- **[PENDING]** Trello PO Injector
