// API Layer for interacting with Firebase Cloud Functions
const API_BASE_URL = import.meta.env.DEV ? 'http://localhost:5001/cis-warehouse-portal/us-central1/api' : '/api';

/**
 * Every backend failure -- a service refusal (422), an unported call (501), an
 * unhandled throw (500) -- answers with `{success:false, error}` where `error`
 * is the service's own text (functions/http/wrappers.js). This used to throw
 * `API Error: 422 Unprocessable Content` and drop the body on the floor, which
 * defeated the entire point of preserving that string on the server: the
 * operator saw a status code instead of "Row not found for SWH-A-01/WIDGET-X.
 * The pallet may have been moved or deleted by another station."
 *
 * That is AUDIT_2026-08-24.md A1/A2 reappearing one layer further out, so the
 * thrown Error now carries the server's text as its message, plus `status` and
 * the parsed `body` for callers that need the partial-success fields
 * (receivePOCardItems' `failedItems[]`, findOrCreatePOCardAndInject's
 * `requiresManualReview`).
 */
async function fetchFromFirebase(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, options);

  // Read the body once, as text, before deciding anything: an error response
  // is normally JSON but a proxy or an emulator crash can return HTML, and
  // response.json() on that throws a parse error that hides the real status.
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch (e) {
    parsed = null;
  }

  if (!response.ok) {
    const detail =
      (parsed && (parsed.error || parsed.message)) ||
      (raw ? raw.slice(0, 500) : `${response.status} ${response.statusText}`);
    const err = new Error(detail);
    err.status = response.status;
    err.body = parsed;
    // Set by the route wrapper: 'read' | 'mutation' | 'unimplemented'.
    err.routeKind = response.headers.get('X-CIS-Route-Kind');
    err.notImplemented = !!(parsed && parsed.notImplemented);
    console.error(`API ${method} ${endpoint} failed (${response.status}): ${detail}`);
    throw err;
  }

  return parsed;
}

export const API = {
  // Boot
  getBootDataset: () => fetchFromFirebase('/boot'),
  getMe: () => fetchFromFirebase('/me'),

  // Reads
  getInventory: () => fetchFromFirebase('/inventory'),
  getInventoryTotals: () => fetchFromFirebase('/inventory/totals'),
  getAgingData: () => fetchFromFirebase('/inventory/aging'),
  getLogisticsDashboardData: () => fetchFromFirebase('/logistics-dashboard'),

  // Mutations
  updateShipment: (shipmentData) => fetchFromFirebase('/shipment', 'POST', shipmentData),
  processUploadedPOFile: (payload) => fetchFromFirebase('/po-ingest', 'POST', payload),
  submitDiagnosticReport: (payload) => fetchFromFirebase('/diagnostics', 'POST', payload),
};
