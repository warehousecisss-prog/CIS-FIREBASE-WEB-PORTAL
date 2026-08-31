// API Layer for interacting with Firebase Cloud Functions
import { getIdToken } from './auth';

/**
 * The emulator's function URL embeds the project id, so it cannot be a literal
 * without hardcoding an environment -- which is exactly how the placeholder
 * "cis-warehouse-portal" (a project that does not exist) ended up baked in
 * here. It now comes from the same env var the Firebase config uses, with the
 * old placeholder kept ONLY as an emulator fallback so local work keeps running
 * with no .env at all.
 *
 * In production the base is the relative `/api`, which depends on the Hosting
 * rewrite `{"source": "/api/**", "function": "api"}` in firebase.json. Without
 * that rewrite every call is answered with index.html instead -- see
 * DEPLOYMENT.md section 6.
 */
const EMULATOR_PROJECT = import.meta.env.VITE_FIREBASE_PROJECT_ID || 'cis-warehouse-portal';
const API_BASE_URL = import.meta.env.DEV
  ? `http://localhost:5001/${EMULATOR_PROJECT}/us-central1/api`
  : '/api';

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

  // Attach the caller's identity. Fetched per request rather than cached: the
  // SDK refreshes the token as it nears expiry, so this is always current and
  // cheap. See auth.js getIdToken().
  //
  // A null token is NOT an error here -- under the emulator with
  // AUTH_DISABLED=true the backend accepts unauthenticated calls, which is how
  // local development works. Against a deployed backend the same request gets a
  // 401 carrying "Authentication required. Sign in with your work Google
  // account.", which the error path below surfaces verbatim.
  const token = await getIdToken();
  if (token) {
    options.headers.Authorization = `Bearer ${token}`;
  }

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
