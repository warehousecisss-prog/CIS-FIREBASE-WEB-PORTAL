/**
 * ESLint config for the Functions codebase.
 *
 * There was no config file at all, while firebase.json runs `npm run lint` as a
 * predeploy hook -- so every `firebase deploy` would have aborted before it
 * started. This is the minimum that makes that hook meaningful.
 *
 * Deliberately eslint:recommended and not eslint-config-google (which is in
 * devDependencies): the ported services still carry the original's Apps Script
 * formatting, and turning ~2000 style complaints into deploy blockers would
 * just get the hook disabled. The rules kept are the ones that catch real bugs
 * -- undefined identifiers, unreachable code, duplicate keys. Tighten toward
 * the Google style guide once the port is at parity.
 */
module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script'
  },
  extends: ['eslint:recommended'],
  rules: {
    // Callback params and caught errors are frequently unused in the ported
    // code; flag genuinely dead locals only.
    'no-unused-vars': ['warn', {args: 'none', caughtErrors: 'none'}],
    // The original swallows exceptions in ~40 places (AUDIT A5). That is a
    // known finding with its own remediation plan, not something to block
    // deploys on today.
    'no-empty': ['warn', {allowEmptyCatch: true}],
    // Both of these fire only inside not-yet-ported service bodies
    // (Service_Assembly's restoreItemToSheet, a regex in Service_PO_Ingest).
    // Neither is a defect; downgraded so the predeploy hook is green today
    // rather than being switched off.
    'no-inner-declarations': 'warn',
    'no-useless-escape': 'warn'
  },
  ignorePatterns: ['node_modules/', '.eslintrc.js']
};
