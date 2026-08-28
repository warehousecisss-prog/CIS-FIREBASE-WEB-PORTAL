const nodemailer = require('nodemailer');
const logger = require('firebase-functions/logger');

// Note: In production, configure transport with a real SMTP service (e.g. SendGrid, Mailgun, or Google Workspace)
// For local testing, you can use ethereal.email or a mock transport.
const transporter = nodemailer.createTransport({
  host: 'smtp.ethereal.email',
  port: 587,
  auth: {
    user: 'ethereal.user@ethereal.email', // Replace with config/env vars
    pass: 'ethereal_password'
  }
});

/**
 * Sends an email notification for PO events.
 * @param {string} to - Primary recipient email
 * @param {string} cc - CC recipient email (optional)
 * @param {string} type - "PO_UPLOADED" or "PO_DELIVERED"
 * @param {object} poData - Data regarding the Purchase Order
 */
async function sendPONotification(to, cc, type, poData) {
  const subject = type === 'PO_UPLOADED' 
    ? `New PO Uploaded: ${poData.poNumber} (${poData.vendor})`
    : `PO Marked Delivered: ${poData.poNumber} (${poData.vendor})`;

  const text = type === 'PO_UPLOADED'
    ? `A new Purchase Order has been uploaded to the system.\n\nPO Number: ${poData.poNumber}\nVendor: ${poData.vendor}\nExpected Date: ${poData.expectedDate}`
    : `A Purchase Order has been marked as Delivered.\n\nPO Number: ${poData.poNumber}\nVendor: ${poData.vendor}\nDelivered On: ${new Date().toLocaleDateString()}`;

  const mailOptions = {
    from: '"Warehouse Portal" <noreply@warehouse-portal.com>',
    to,
    cc,
    subject,
    text
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info(`Email sent successfully: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    logger.error('Error sending email notification', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendPONotification
};
