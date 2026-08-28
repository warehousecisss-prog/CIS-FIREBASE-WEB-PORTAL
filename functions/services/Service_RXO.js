const SS_API = require('./Service_SheetsAPI');
const { logger } = require('firebase-functions');

const RXO_ENV = 'UAT'; 
const RXO_HOSTS = {
  UAT: 'https://api-uat-rxoconnect.rxo.com',
  PROD: 'https://api-rxoconnect.rxo.com' 
};

function rxoBaseUrl_() {
  return RXO_HOSTS[RXO_ENV];
}

function rxoIsDryRun_() {
  return process.env.RXO_DRY_RUN === 'true';
}

function rxoProps_() {
  return {
    clientId: process.env.RXO_CLIENT_ID,
    clientSecret: process.env.RXO_CLIENT_SECRET,
    apiKey: process.env.RXO_API_KEY,
    scope: process.env.RXO_SCOPE,
    partnerCode: process.env.RXO_PARTNER_CODE 
  };
}

const tokenCache = new Map();

async function getRxoBearerToken() {
  if (rxoIsDryRun_()) return 'DRY-RUN-TOKEN';

  const cacheKey = 'rxo_token_' + RXO_ENV;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const rxo = rxoProps_();
  if (!rxo.clientId || !rxo.clientSecret) {
    logger.warn('RXO credentials not yet configured in environment variables.');
    return null;
  }

  const url = rxoBaseUrl_() + '/oAuthAPI/rest/v1/token';
  
  const bodyParams = new URLSearchParams();
  bodyParams.append('grant_type', 'client_credentials');
  bodyParams.append('client_id', rxo.clientId);
  bodyParams.append('client_secret', rxo.clientSecret);
  bodyParams.append('scope', rxo.scope || '');

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  if (rxo.apiKey) {
    headers['apikey'] = rxo.apiKey;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: bodyParams.toString()
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error('RXO auth failed', { status: response.status, body: text });
      return null;
    }

    const json = await response.json();
    const token = json.access_token;
    
    tokenCache.set(cacheKey, {
      token: token,
      expiresAt: Date.now() + (6900 * 1000) 
    });
    
    return token;
  } catch (e) {
    logger.error('RXO auth network failure', { error: e.toString() });
    return null;
  }
}

async function rxoHeaders_() {
  const token = await getRxoBearerToken();
  if (!token) return null;
  const rxo = rxoProps_();
  return {
    'Authorization': 'Bearer ' + token,
    'apikey': rxo.apiKey || '', 
    'Content-Type': 'application/json'
  };
}

async function rxoFetch_(url, options) {
  if (rxoIsDryRun_()) {
    return {
      status: 200,
      text: async () => JSON.stringify({ mocked: true, note: 'RXO_DRY_RUN is on — no network call was made.', requestedUrl: url })
    };
  }
  return await fetch(url, options);
}

async function rxoRequest_(stage, method, url, options) {
  options = options || {};
  const fetchOptions = Object.assign({ method: method }, options);

  let response;
  let code;
  let body;
  try {
    response = await rxoFetch_(url, fetchOptions);
    code = response.status;
    body = await response.text();
  } catch (e) {
    await rxoLogCall_(stage, method, url, 'FETCH_ERROR', e.toString());
    logger.error('RXO ' + stage + ' threw', { error: e.toString() });
    return null;
  }

  await rxoLogCall_(stage, method, url, code, body);

  if (code < 200 || code >= 300) {
    logger.error('RXO ' + stage + ' failed', { code, body });
    return null;
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    return body;
  }
}

async function rxoLogCall_(stage, method, url, statusCode, body) {
  try {
    const snippet = String(body || '').substring(0, 500);
    const row = [new Date().toISOString(), stage, method, url, rxoIsDryRun_() ? 'Y' : 'N', statusCode, snippet];
    
    try {
        await SS_API.batchAppendRows('RXO_API_LOG', [row]);
    } catch (e) {
        logger.warn('RXO_API_LOG write failed (does sheet exist?)', { error: e.toString() });
    }
  } catch (e) {
    logger.error('RXO_API_LOG error', { error: e.toString() });
  }
}

async function getRxoShipmentDetails(identifierType, identifierValue) {
  const headers = await rxoHeaders_();
  if (!headers) return null;
  const rxo = rxoProps_();
  const url = rxoBaseUrl_() + '/shipmentAPI/rest/v1/shipmentDetails'
    + '?partnerIdentifierCode=' + encodeURIComponent(rxo.partnerCode)
    + '&' + identifierType + '=' + encodeURIComponent(identifierValue);
  return await rxoRequest_('shipmentDetails', 'GET', url, { headers: headers });
}

async function getRxoOrderStatus(idType, idValue, opts) {
  const headers = await rxoHeaders_();
  if (!headers) return null;
  const rxo = rxoProps_();
  opts = opts || {};
  let url = rxoBaseUrl_() + '/eventAPI/rest/v1/OrderStatus'
    + '?partnerCode=' + encodeURIComponent(rxo.partnerCode)
    + '&' + idType + '=' + encodeURIComponent(idValue);
  if (opts.eventName) url += '&eventName=' + encodeURIComponent(opts.eventName);
  if (opts.fromDate) url += '&fromDate=' + encodeURIComponent(opts.fromDate);
  if (opts.toDate) url += '&toDate=' + encodeURIComponent(opts.toDate);
  return await rxoRequest_('orderStatus', 'GET', url, { headers: headers });
}

async function getRxoCustomerInvoices(requestBody) {
  const headers = await rxoHeaders_();
  if (!headers) return null;
  const url = rxoBaseUrl_() + '/invoiceAPI/rest/v1/Customer';
  return await rxoRequest_('invoices.customer', 'POST', url, { headers: headers, body: JSON.stringify(requestBody) });
}

async function rxoHealthCheck(path) {
  const headers = await rxoHeaders_();
  if (!headers) return null;
  const url = rxoBaseUrl_() + path;
  return await rxoRequest_('healthCheck:' + path, 'GET', url, { headers: headers });
}

async function rxoTestHarness() {
  const dryRun = rxoIsDryRun_();
  logger.info('=== RXO Test Harness — ' + (dryRun ? 'DRY RUN' : 'LIVE (' + RXO_ENV + ')') + ' ===');

  const rxo = rxoProps_();
  const missing = Object.keys(rxo).filter(k => !rxo[k]);
  if (!dryRun && missing.length) {
    logger.error('STAGE 0 [FAIL] Missing Env Vars: ' + missing.join(', '));
    logger.info('Set RXO_DRY_RUN to "true" to exercise the pipeline without real credentials, or fill these in.');
    return;
  }
  logger.info('STAGE 0 [PASS] Credentials present' + (dryRun ? ' (dry run — not checked)' : ''));

  const token = await getRxoBearerToken();
  logger.info('STAGE 1 [' + (token ? 'PASS' : 'FAIL') + '] Token acquisition');
  if (!token) {
    logger.info('See RXO_API_LOG for the raw auth response.');
    return;
  }

  const healthEndpoints = {
    shipment: '/shipmentAPI/rest/v1/health_check',
    events: '/eventAPI/rest/v1/event_health_check',
    invoices: '/invoiceAPI/rest/v1/health_check'
  };
  
  for (const name of Object.keys(healthEndpoints)) {
    const res = await rxoHealthCheck(healthEndpoints[name]);
    logger.info('STAGE 2 [' + (res !== null ? 'PASS' : 'FAIL') + '] ' + name + ' health check');
  }

  const details = await getRxoShipmentDetails('shipmentnumber', 'S26G011426');
  logger.info('STAGE 3 [' + (details ? 'PASS' : 'FAIL') + '] shipmentDetails lookup');
  if (details) {
    logger.info(JSON.stringify(details));
  }

  logger.info('=== Done. Full request/response trail: RXO_API_LOG sheet tab. ===');
}

module.exports = {
  getRxoShipmentDetails,
  getRxoOrderStatus,
  getRxoCustomerInvoices,
  rxoTestHarness
};
