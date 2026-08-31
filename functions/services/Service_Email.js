const nodemailer = require('nodemailer');
const logger = require('firebase-functions/logger');
const config = require('../config');

/**
 * ============================================================================
 * OUTBOUND EMAIL
 * ============================================================================
 * The Apps Script original sends mail with `MailApp.sendEmail()`, which needs
 * no configuration at all -- it uses the executing account's Gmail quota. There
 * is no equivalent in Cloud Functions, so this is a nodemailer transport driven
 * by the SMTP_* config keys.
 *
 * THIS FILE USED TO HARDCODE `smtp.ethereal.email` WITH PLACEHOLDER
 * CREDENTIALS. Phase 1 declared SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS /
 * SMTP_FROM in config.js, and nothing read any of them -- so every outbound
 * mail authenticated as `ethereal.user@ethereal.email` with the literal
 * password `ethereal_password` and failed. Fixed 2026-08-28.
 *
 * The transport is built LAZILY and cached. Building it at module load would
 * run during Cloud Functions' deploy-time analysis pass and at every cold
 * start, including for the many requests that never send mail.
 */

let transporter = null;
let transportUnavailableReason = null;

/**
 * Builds (once) the nodemailer transport from config.
 *
 * Returns null rather than throwing when SMTP_HOST is unset. Mail is a
 * best-effort side channel everywhere it is used here -- a receipt
 * notification, a PO copy to a supplier -- and none of those should take down
 * the operation whose result the operator is waiting on. The caller reports
 * `success:false` with a reason instead.
 *
 * @return {?Object} a nodemailer transport, or null when unconfigured.
 */
function getTransport() {
  if (transporter) return transporter;
  if (transportUnavailableReason) return null;

  const host = config.get('SMTP_HOST');
  if (!host) {
    transportUnavailableReason =
      'SMTP_HOST is not configured, so this backend cannot send mail. Set ' +
      'SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS in functions/.env.';
    logger.warn('Service_Email: ' + transportUnavailableReason);
    return null;
  }

  const port = parseInt(config.get('SMTP_PORT'), 10) || 587;
  const user = config.get('SMTP_USER');
  const pass = config.get('SMTP_PASS');

  transporter = nodemailer.createTransport({
    host: host,
    port: port,
    // 465 is implicit TLS; 587 and 25 negotiate STARTTLS after connecting.
    secure: port === 465,
    auth: (user || pass) ? {user: user, pass: pass} : undefined
  });
  return transporter;
}

/**
 * @return {string} the From header.
 */
function fromAddress() {
  return config.get('SMTP_FROM');
}

/**
 * One place every outbound message goes through, so the "not configured" and
 * "send failed" paths read the same everywhere.
 *
 * @param {Object} mailOptions nodemailer message.
 * @param {string} label what this message is, for logs.
 * @return {Promise<{success: boolean, messageId?: string, message?: string}>}
 */
async function send_(mailOptions, label) {
  const tx = getTransport();
  if (!tx) {
    return {success: false, message: transportUnavailableReason};
  }
  try {
    const info = await tx.sendMail(Object.assign({from: fromAddress()}, mailOptions));
    logger.info('Service_Email: sent ' + label, {messageId: info.messageId});
    return {success: true, messageId: info.messageId};
  } catch (error) {
    logger.error('Service_Email: failed to send ' + label, {error: error.message});
    return {success: false, message: 'Failed to send email: ' + error.message};
  }
}

/**
 * Sends an email notification for PO events.
 *
 * @param {string} to Primary recipient.
 * @param {string} cc CC recipient (optional).
 * @param {string} type "PO_UPLOADED" or "PO_DELIVERED".
 * @param {Object} poData Data about the Purchase Order.
 * @return {Promise<Object>}
 */
async function sendPONotification(to, cc, type, poData) {
  const subject = type === 'PO_UPLOADED' ?
    `New PO Uploaded: ${poData.poNumber} (${poData.vendor})` :
    `PO Marked Delivered: ${poData.poNumber} (${poData.vendor})`;

  const text = type === 'PO_UPLOADED' ?
    `A new Purchase Order has been uploaded to the system.\n\nPO Number: ${poData.poNumber}\nVendor: ${poData.vendor}\nExpected Date: ${poData.expectedDate}` :
    `A Purchase Order has been marked as Delivered.\n\nPO Number: ${poData.poNumber}\nVendor: ${poData.vendor}\nDelivered On: ${new Date().toLocaleDateString('en-US')}`;

  return send_({to, cc, subject, text}, 'PO notification');
}

/**
 * Sends one message with attachments. Used by
 * Service_PO_Ingest.emailPOPdfToSupplier, whose Apps Script original builds a
 * Blob and hands it to `MailApp.sendEmail(..., {attachments:[blob]})`.
 *
 * @param {{to: string, cc?: string, subject: string, text?: string,
 *          html?: string, attachments?: Array<Object>}} message
 * @param {string} [label]
 * @return {Promise<Object>}
 */
async function sendWithAttachments(message, label) {
  return send_(message, label || 'attachment mail');
}

/**
 * Sends one arbitrary message. The general-purpose entry point, for callers
 * whose Apps Script original is a bare `MailApp.sendEmail({to, subject,
 * htmlBody})` with no attachment and no PO payload -- Service_Rollup's
 * delivered-in-full notification, for one.
 *
 * `sendWithAttachments` above is the same passthrough under a narrower name;
 * both exist so a call site reads as what it actually does rather than
 * borrowing a misleading one.
 *
 * @param {{to: string, cc?: string, subject: string, text?: string,
 *          html?: string, attachments?: Array<Object>}} message
 * @param {string} [label]
 * @return {Promise<Object>}
 */
async function sendMail(message, label) {
  return send_(message, label || 'mail');
}

/** Test seam: drop the cached transport so config changes take effect. */
function __resetTransportForTests() {
  transporter = null;
  transportUnavailableReason = null;
}

module.exports = {
  sendPONotification,
  sendWithAttachments,
  sendMail,
  __resetTransportForTests
};
