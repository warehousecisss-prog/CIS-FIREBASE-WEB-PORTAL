// API Layer for interacting with Firebase Cloud Functions
const API_BASE_URL = import.meta.env.DEV ? 'http://localhost:5001/cis-warehouse-portal/us-central1/api' : '/api';

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

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Failed to fetch ${endpoint}:`, error);
    throw error;
  }
}

export const API = {
  getInventory: () => fetchFromFirebase('/inventory'),
  getLogisticsDashboardData: () => fetchFromFirebase('/logistics-dashboard'),
  updateShipment: (shipmentData) => fetchFromFirebase('/shipment', 'POST', shipmentData),
  processUploadedPOFile: (payload) => fetchFromFirebase('/po-ingest', 'POST', payload),
  submitDiagnosticReport: (payload) => fetchFromFirebase('/diagnostics', 'POST', payload),
};
