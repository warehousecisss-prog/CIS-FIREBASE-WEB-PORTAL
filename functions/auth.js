/**
 * ============================================================================
 * AUTHENTICATION -- Firebase Auth (Google provider), domain-locked
 * ============================================================================
 * Decision (2026-08-28): Firebase Auth with the Google provider. The browser
 * signs in with GoogleAuthProvider and sends the resulting ID token as
 * `Authorization: Bearer <token>`; this module verifies it with the Admin SDK
 * and checks the resolved email against a configured allowlist. Unauthenticated
 * mutation requests are rejected with 401 -- no warn-only mode.
 *
 * Why this shape
 * --------------
 * The Apps Script original is deployed ANYONE_ANONYMOUS but runs inside a
 * Google login, which is why `Session.getActiveUser().getEmail()` returns a
 * real operator address for every Audit_Log row. Cloud Functions has no such
 * ambient identity, so the port has to reconstruct it explicitly. Verifying a
 * Google ID token at the edge of the Express app is the closest equivalent and
 * changes no deploy topology (Cloud IAP would have required moving Hosting
 * behind a load balancer).
 *
 * Three checks, all of which must pass:
 *   1. `verifyIdToken` -- signature, expiry, audience, issuer. This also
 *      rejects a token minted for a different Firebase project.
 *   2. `email_verified` -- a Google-provider token for a Workspace account
 *      always carries this; refusing unverified emails stops a self-serve
 *      account with a spoofed address from being attributed in Audit_Log.
 *   3. allowlist -- ALLOWED_EMAIL_DOMAINS (a required config key, so the list
 *      cannot end up empty by accident) plus optional ALLOWED_EMAILS.
 *
 * Emulator escape hatch
 * ---------------------
 * AUTH_DISABLED=true bypasses all of the above, but ONLY when
 * FUNCTIONS_EMULATOR === 'true'. Deployed code ignores the flag entirely, so a
 * stray AUTH_DISABLED in a production .env cannot open the API. Requests in
 * that mode are attributed to DEV_OPERATOR_EMAIL, which is deliberately not a
 * real address so local writes are identifiable in Audit_Log.
 */

const logger = require('firebase-functions/logger');
const admin = require('./admin');
const config = require('./config');

/**
 * Actor written to Audit_Log by genuinely unattended paths -- scheduled syncs,
 * webhook handlers -- which have no operator to attribute. Must be passed
 * explicitly; getActiveUserEmail() never falls back to it. The port's previous
 * behaviour was to use this constant for EVERY write, which is exactly the
 * regression C5 describes.
 */
const SYSTEM_ACTOR = 'system@cis-portal.app';

/** @return {boolean} whether the emulator-only auth bypass is active. */
function isAuthBypassed() {
  return process.env.FUNCTIONS_EMULATOR === 'true' && config.flag('AUTH_DISABLED');
}

/**
 * @param {string} email
 * @return {boolean} whether the address passes the configured allowlist.
 */
function isAllowedEmail(email) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return false;

  const explicit = config.list('ALLOWED_EMAILS').map((e) => e.toLowerCase());
  if (explicit.includes(addr)) return true;

  const domains = config.list('ALLOWED_EMAIL_DOMAINS').map((d) => d.replace(/^@/, '').toLowerCase());
  if (domains.length === 0) {
    // Fail closed. ALLOWED_EMAIL_DOMAINS is a required key precisely so this
    // branch means "misconfigured", never "everyone is welcome".
    logger.error('Auth allowlist is empty: set ALLOWED_EMAIL_DOMAINS. Rejecting all requests.');
    return false;
  }
  const domain = addr.slice(addr.lastIndexOf('@') + 1);
  return domains.includes(domain);
}

/**
 * @param {import('express').Request} req
 * @return {string|null} the bearer token, or null.
 */
function readBearerToken(req) {
  const header = req.get ? req.get('Authorization') : (req.headers || {}).authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : null;
}

/**
 * Express middleware. Verifies the bearer token when one is present and hangs
 * the resolved identity off `req.auth`. Does NOT reject on its own -- that is
 * requireAuth's job -- so a route can opt out of auth by simply not using it.
 * A token that is present but bad is still a hard 401 here: a caller who sent
 * credentials and got them wrong should hear about it, not be silently
 * downgraded to anonymous.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
async function attachIdentity(req, res, next) {
  if (isAuthBypassed()) {
    req.auth = {
      uid: 'emulator',
      email: config.get('DEV_OPERATOR_EMAIL'),
      name: 'Emulator Operator',
      bypassed: true
    };
    return next();
  }

  const token = readBearerToken(req);
  if (!token) {
    req.auth = null;
    return next();
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const email = String(decoded.email || '').trim().toLowerCase();

    if (!email) {
      return res.status(403).json({
        success: false,
        error: 'Signed-in account has no email address. Sign in with your work Google account.'
      });
    }
    if (decoded.email_verified === false) {
      return res.status(403).json({
        success: false,
        error: 'Email address is not verified. Sign in with your work Google account.'
      });
    }
    if (!isAllowedEmail(email)) {
      logger.warn('Rejected sign-in outside the allowlist', { email });
      return res.status(403).json({
        success: false,
        error: 'Account ' + email + ' is not authorised for this portal.'
      });
    }

    req.auth = {
      uid: decoded.uid,
      email,
      name: decoded.name || '',
      bypassed: false
    };
    return next();
  } catch (e) {
    logger.warn('ID token verification failed', { error: e.message });
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired sign-in. Please sign in again.'
    });
  }
}

/**
 * Express middleware. 401 unless attachIdentity resolved an identity.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 * @return {*} the 401 response, or next().
 */
function requireAuth(req, res, next) {
  if (req.auth && req.auth.email) return next();
  return res.status(401).json({
    success: false,
    error: 'Authentication required. Sign in with your work Google account.'
  });
}

/**
 * The verified operator email, for the Audit_Log operator column and the
 * receiving payload. Replaces the constant stub that Service_Write,
 * Service_Assembly and Service_Diagnostics each carried a copy of (AUDIT C5).
 *
 * Throws rather than substituting a placeholder. Silently writing
 * "system@cis-portal.app" into an operator column is precisely the failure this
 * replaces -- an audit trail that names nobody is worse than a request that
 * fails loudly, because the sheet then looks correct. Unattended callers that
 * legitimately have no operator pass SYSTEM_ACTOR explicitly.
 *
 * Accepts either an Express request (`req.auth`, set by attachIdentity) or an
 * onCall-style context (`context.auth.token.email`), so services do not need to
 * know which entry point invoked them.
 *
 * @param {Object} context Express req or callable context.
 * @return {string} verified email address.
 */
function getActiveUserEmail(context) {
  if (context) {
    if (context.auth && context.auth.email) return context.auth.email;
    if (context.auth && context.auth.token && context.auth.token.email) {
      return context.auth.token.email;
    }
  }
  throw new Error(
      'Operator identity unavailable: this action must be called through an ' +
      'authenticated request. Pass the Express req (or an onCall context) into the ' +
      'service, or pass SYSTEM_ACTOR explicitly for unattended jobs.');
}

/**
 * Non-throwing variant for log/telemetry paths where a missing identity should
 * not fail the request.
 *
 * @param {Object} context Express req or callable context.
 * @return {string|null} verified email address, or null.
 */
function getActiveUserEmailOrNull(context) {
  try {
    return getActiveUserEmail(context);
  } catch (e) {
    return null;
  }
}

module.exports = {
  SYSTEM_ACTOR,
  attachIdentity,
  requireAuth,
  getActiveUserEmail,
  getActiveUserEmailOrNull,
  isAllowedEmail,
  isAuthBypassed
};
