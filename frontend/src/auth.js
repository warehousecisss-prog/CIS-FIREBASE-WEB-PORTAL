import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
} from 'firebase/auth';

/**
 * ============================================================================
 * BROWSER SIGN-IN
 * ============================================================================
 * The missing half of the 2026-08-28 auth decision. The backend has verified
 * bearer tokens since Phase 1 -- `functions/auth.js` checks the token, checks
 * the email domain, and answers 401 to anything else -- but the browser had no
 * way to obtain one, so every deployed call was a 401. This closes that.
 *
 * WHAT THE ORIGINAL DID, AND WHY THIS IS DIFFERENT
 * -----------------------------------------------
 * Apps Script web apps run AS a Google-authenticated user by definition;
 * `Session.getActiveUser()` just works and there is no sign-in code anywhere in
 * SRC. Firebase Hosting serves an anonymous static bundle, so identity has to
 * be established explicitly and then attached to every request. There is
 * nothing in the original to port here -- this is new, and it is new because
 * the platform changed, not because a feature was added.
 *
 * CONFIG COMES FROM THE ENVIRONMENT, NOT FROM A LITERAL
 * ----------------------------------------------------
 * Every value below is read from a Vite env var (`frontend/.env`), so no
 * placeholder project id can be accidentally committed and shipped -- the exact
 * trap `.firebaserc` and `api.js` fell into with "cis-warehouse-portal", a
 * project that does not exist.
 *
 * These values are NOT secrets. A Firebase web config identifies a project; it
 * does not grant access to it. Access is decided server-side by the token check
 * in `functions/auth.js` and by Firestore/Sheets permissions. Google publishes
 * them in their own quickstarts for this reason. Keeping them in `.env` is
 * about not hardcoding an environment, not about hiding a credential.
 *
 * FAILURE MODE IS DELIBERATE
 * --------------------------
 * If the config is absent, this does NOT throw at import time -- that would
 * white-screen the whole app with a stack trace in the console and nothing on
 * the page. Instead `isConfigured()` reports false and `AuthGate` renders a
 * plain explanation of which variables are missing. A misconfigured deploy
 * should say so in English.
 * ============================================================================
 */

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

/** The keys that must be present for sign-in to work at all. */
const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];

/** @return {Array<string>} the env var names that are missing. */
export function missingConfigKeys() {
  return REQUIRED_KEYS
    .filter((k) => !firebaseConfig[k])
    .map((k) => 'VITE_FIREBASE_' + k.replace(/([A-Z])/g, '_$1').toUpperCase());
}

/** @return {boolean} */
export function isConfigured() {
  return missingConfigKeys().length === 0;
}

let app = null;
let auth = null;

/**
 * Initialises lazily and once. Called by everything below rather than run at
 * module scope, so an unconfigured build still loads and can explain itself.
 *
 * @return {?Object} the Auth instance, or null when unconfigured.
 */
function getAuthInstance() {
  if (!isConfigured()) return null;
  if (!auth) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    // Survive a page reload. Warehouse tablets get reloaded constantly and
    // re-authenticating on every refresh would be its own usability bug.
    // Failure here is not fatal -- it degrades to session-only persistence.
    setPersistence(auth, browserLocalPersistence).catch((e) => {
      console.warn('Could not set local auth persistence; sign-in will not survive a reload.', e);
    });
  }
  return auth;
}

/**
 * Signs in with Google. A popup rather than a redirect: a redirect throws away
 * in-progress UI state, and the portal is used mid-task on the floor.
 *
 * @return {Promise<Object>} the signed-in user.
 */
export async function signIn() {
  const a = getAuthInstance();
  if (!a) throw new Error('Firebase is not configured; cannot sign in.');
  const provider = new GoogleAuthProvider();
  // Always show the account chooser. Shared floor devices otherwise silently
  // reuse whoever signed in last, and every Audit_Log row would name the wrong
  // operator -- the exact identity problem AUDIT C5 is about.
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(a, provider);
  return result.user;
}

/** @return {Promise<void>} */
export async function signOut() {
  const a = getAuthInstance();
  if (a) await fbSignOut(a);
}

/**
 * Subscribes to sign-in state.
 *
 * @param {Function} callback (user|null) => void
 * @return {Function} unsubscribe.
 */
export function onAuthChange(callback) {
  const a = getAuthInstance();
  if (!a) {
    // Unconfigured: report "signed out" once so the UI can render its
    // explanation instead of hanging on a spinner forever.
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(a, callback);
}

/** @return {?Object} the current user, or null. */
export function currentUser() {
  const a = getAuthInstance();
  return a ? a.currentUser : null;
}

/**
 * The current user's ID token, for the Authorization header.
 *
 * NOT cached here. The SDK caches it internally and refreshes it when it is
 * close to expiring, so calling this per request is cheap and always current.
 * Caching it ourselves would reintroduce the expiry bug the SDK exists to
 * handle -- an hour into a shift, every request would start failing with a 401
 * that looks like a permissions problem.
 *
 * @return {Promise<?string>} the token, or null when signed out.
 */
export async function getIdToken() {
  const a = getAuthInstance();
  if (!a || !a.currentUser) return null;
  try {
    return await a.currentUser.getIdToken();
  } catch (e) {
    console.error('Could not obtain an ID token; the request will be sent unauthenticated ' +
      'and the server will answer 401.', e);
    return null;
  }
}
