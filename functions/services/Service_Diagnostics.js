const SS_API = require('./Service_SheetsAPI');
const { logger } = require('firebase-functions');

const EVENT_LOG_SHEET = "Event_Log";
const EVENT_LOG_HEADERS = [
  "Timestamp", "Station", "User_Email", "Build_Version", "Current_View",
  "Note", "Error_Count", "Store_Summary", "Boot_Issues", "Environment", "Event_Trace"
];

function getActiveUserEmail(context) {
  return context && context.auth && context.auth.token && context.auth.token.email 
    ? context.auth.token.email 
    : 'portal-backend@automated.local';
}

async function submitDiagnosticReport(payload, context) {
  try {
    if (!payload) return { success: false, error: "Empty payload." };

    const env = payload.env || {};
    const events = Array.isArray(payload.events) ? payload.events : [];

    let errorCount = 0;
    const traceLines = events.map(function(e) {
      if (e && e.cat === 'ERROR') errorCount++;
      return [
        (e && e.iso) || '',
        '[' + ((e && e.cat) || '?') + ']',
        (e && e.msg) || '',
        (e && e.detail) ? ('— ' + e.detail) : '',
        (e && e.view) ? ('(view: ' + e.view + ')') : ''
      ].join(' ').trim();
    });

    let trace = traceLines.join('\n');
    if (trace.length > 45000) {
      trace = '…(older events trimmed)…\n' + trace.slice(trace.length - 45000);
    }

    const storeSummary = Object.keys(payload.store || {}).map(function(k) {
      const s = payload.store[k] || {};
      return k + '=' + s.state + '(age:' + (s.ageSeconds === null || s.ageSeconds === undefined ? 'never' : s.ageSeconds + 's') + ', n:' + s.size + ')';
    }).join('  |  ');

    const userEmail = getActiveUserEmail(context);
    const bootIssues = Array.isArray(payload.bootIssues) ? payload.bootIssues : [];

    const row = [
      new Date().toISOString(),
      env.station || '',
      userEmail,
      env.buildVersion || '',
      env.currentView || '',
      payload.note || '',
      errorCount,
      storeSummary,
      bootIssues.length ? bootIssues.join('\n') : '',
      JSON.stringify(env),
      trace
    ];

    try {
        await SS_API.batchAppendRows(EVENT_LOG_SHEET, [row]);
    } catch (e) {
        // If the sheet doesn't exist, we might get an error. In a more complete
        // implementation we'd check and create the sheet. For now, we'll log it.
        logger.error("Failed to write to Event_Log sheet. Does it exist?", { error: e.toString() });
        return { success: false, error: "Failed to write Event_Log: " + e.toString() };
    }

    logger.info("📝 Diagnostic report filed by " + (env.station || 'unknown station') +
               " — " + events.length + " events, " + errorCount + " error(s).");
    return { success: true };
  } catch (e) {
    logger.error("submitDiagnosticReport failed", { error: e.toString() });
    return { success: false, error: e.toString() };
  }
}

module.exports = {
  submitDiagnosticReport
};
