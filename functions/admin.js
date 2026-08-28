/**
 * ============================================================================
 * FIREBASE ADMIN SDK -- SINGLE SHARED INITIALISATION
 * ============================================================================
 * `admin.initializeApp()` throws if it runs twice in the same process. Node
 * caches modules by resolved path, so requiring this file from anywhere gives
 * every caller the same initialised app. Nothing else in functions/ should call
 * initializeApp().
 *
 * No credential is passed: inside Cloud Functions and inside the emulator the
 * Admin SDK picks up Application Default Credentials from the runtime, which is
 * the same identity Service_SheetsAPI authenticates its Sheets client with.
 */

const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp();
}

module.exports = admin;
