# Frontend Migration Changelog

## Phase 1 & 2: Infrastructure & Design System
- Scaffoled Vite + React project in `frontend/`.
- Configured `react-router-dom` in `App.jsx` and `main.jsx`.
- Added Zustand state management in `src/store/useStore.js`.
- Refactored `api.js` to point to Firebase Cloud Functions with a unified `fetchFromFirebase` helper.
- Consolidated legacy CSS (`Styles_Base`, `Styles_Components`, `Styles_Responsive`) into `index.css`.
- Extracted and created modular UI components:
  - `Button.jsx`
  - `Card.jsx`
  - `Modal.jsx`
  - `Toast.jsx`
  - `DataGrid.jsx`

## Phase 3: Trello PO Injector
- Ported the Trello PO Injector to a new React view: `src/views/TrelloInjectorView.jsx`.
- Replaced the DOM-heavy HTML with React state and components.
- Added the PDF Drag-and-Drop upload zone.
- Implemented dummy board/list/card fetching logic.
- **NEW FEATURE ADDED:** Integrated Email Notifications UI config (To/CC logic based on Trello Board) for new POs.

## Phase 4: Core Dashboards & Data Views
- Ported the Logistics Control Tower (Dashboard) to `src/views/DashboardView.jsx` with state-driven tabs, filters, and a data table.
- Ported the FedEx Master Ledger to `src/views/FedExView.jsx` with filtering and the bulk staging accordion.
- Created `LimboView.jsx` and `StagedView.jsx` as modular placeholder components.
- Wired all views into the `App.jsx` React Router setup.

## Phase 5: SVG Interactive Maps
- Wrote a NodeJS conversion script (`convertMaps.mjs`) to process all 14 legacy SVG map layouts.
- Auto-converted raw HTML/SVG attributes to camelCase React properties (e.g. `stroke-width` -> `strokeWidth`, `clip-path` -> `clipPath`).
- Wrapped map SVGs into inline React components.
- Injected dynamic `getSlotClass(id)` logic on all `id` matching `<rect>` and `<g>` tags to compute live CSS states (`occupied-slot`, `heat-fresh`, etc.) driven by `inventoryMap` and `heatmapMode` props.
