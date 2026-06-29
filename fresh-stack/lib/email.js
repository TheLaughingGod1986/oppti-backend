const { Resend } = require('resend');
const logger = require('./logger');

let resend = null;

// Initialize Resend client if API key is available
const apiKey = process.env.RESEND_API_KEY;
const DEFAULT_CONTACT_EMAIL = 'benoats86@gmail.com';
const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@alttext.ai';

function configuredEmails(...values) {
  const emails = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    for (const email of String(value).split(',').map((item) => item.trim()).filter(Boolean)) {
      if (!emails.includes(email)) {
        emails.push(email);
      }
    }
  }

  return emails;
}

function firstConfiguredEmail(...values) {
  return configuredEmails(...values)[0] || null;
}

function getContactRecipientEmails(to) {
  const recipients = configuredEmails(
    DEFAULT_CONTACT_EMAIL,
    to,
    process.env.RESEND_CONTACT_EMAIL,
    process.env.CONTACT_SUPPORT_EMAIL,
    process.env.SUPPORT_EMAIL,
    process.env.CONTACT_EMAIL
  );

  return recipients;
}

function getContactRecipientEmail(to) {
  return firstConfiguredEmail(...getContactRecipientEmails(to));
}

if (apiKey) {
  try {
    resend = new Resend(apiKey);
    logger.info('[Email] Resend client initialized', { fromEmail });
  } catch (error) {
    logger.error('[Email] Failed to initialize Resend', { error: error.message });
  }
} else {
  logger.warn('[Email] RESEND_API_KEY not set - email service disabled');
}

/**
 * Send password reset email
 * @param {string} to - Recipient email address
 * @param {string} resetLink - Password reset link
 * @param {string} siteName - Site name (optional)
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendPasswordResetEmail(to, resetLink, siteName = 'AltText AI') {
  if (!resend) {
    return {
      success: false,
      error: 'Email service not configured (RESEND_API_KEY not set)'
    };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: [to],
      subject: 'Reset Your Password - AltText AI',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reset Your Password</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 24px;">Reset Your Password</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <p style="margin-top: 0;">Hello,</p>
            <p>We received a request to reset your password for your ${siteName} account.</p>
            <p>Click the button below to reset your password:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" style="display: inline-block; background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: 600;">Reset Password</a>
            </div>
            <p style="font-size: 14px; color: #666;">Or copy and paste this link into your browser:</p>
            <p style="font-size: 12px; color: #999; word-break: break-all; background: #fff; padding: 10px; border-radius: 4px; border: 1px solid #ddd;">${resetLink}</p>
            <p style="font-size: 14px; color: #666; margin-top: 30px;">This link will expire in 1 hour.</p>
            <p style="font-size: 14px; color: #666;">If you didn't request a password reset, you can safely ignore this email.</p>
            <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
            <p style="font-size: 12px; color: #999; margin: 0;">This is an automated message from ${siteName}. Please do not reply to this email.</p>
          </div>
        </body>
        </html>
      `,
      text: `
Reset Your Password - AltText AI

Hello,

We received a request to reset your password for your ${siteName} account.

Click the link below to reset your password:
${resetLink}

This link will expire in 1 hour.

If you didn't request a password reset, you can safely ignore this email.

---
This is an automated message from ${siteName}. Please do not reply to this email.
      `.trim()
    });

    if (error) {
      logger.error('[Email] Failed to send password reset email', { 
        to, 
        error: error.message 
      });
      return {
        success: false,
        error: error.message
      };
    }

    logger.info('[Email] Password reset email sent', { 
      to, 
      messageId: data?.id 
    });

    return {
      success: true,
      messageId: data?.id
    };
  } catch (error) {
    logger.error('[Email] Error sending password reset email', { 
      to, 
      error: error.message 
    });
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Send contact form email
 * @param {Object} params - Contact form data
 * @param {string} params.to - Recipient email address (support email)
 * @param {string} params.name - User's name
 * @param {string} params.email - User's email address
 * @param {string} params.subject - Email subject
 * @param {string} params.message - Message content
 * @param {string} params.wpVersion - WordPress version (optional)
 * @param {string} params.pluginVersion - Plugin version (optional)
 * @param {string} params.siteUrl - Site URL (optional)
 * @param {string} params.siteHash - Site hash (optional)
 * @param {string} params.licenseKey - License key if available (optional)
 * @param {string} params.userId - WordPress user ID if available (optional)
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendContactEmail({
  to,
  name,
  email,
  subject,
  message,
  wpVersion,
  pluginVersion,
  siteUrl,
  siteHash,
  licenseKey,
  userId,
  includeLogs,
  diagnosticBundle
}) {
  if (!resend) {
    return {
      success: false,
      error: 'Email service not configured (RESEND_API_KEY not set)'
    };
  }

  const recipientEmails = getContactRecipientEmails(to);
  const recipientEmail = recipientEmails[0];

  // Build metadata section
  let metadataHtml = '';
  if (wpVersion || pluginVersion || siteUrl || siteHash || licenseKey || userId) {
    metadataHtml = `
      <div style="background: #f5f5f5; padding: 15px; border-radius: 4px; margin-top: 20px; font-size: 12px; color: #666;">
        <strong>System Information:</strong><br>
        ${wpVersion ? `WordPress Version: ${wpVersion}<br>` : ''}
        ${pluginVersion ? `Plugin Version: ${pluginVersion}<br>` : ''}
        ${siteUrl ? `Site URL: ${siteUrl}<br>` : ''}
        ${siteHash ? `Site Hash: ${siteHash.substring(0, 8)}...<br>` : ''}
        ${licenseKey ? `License Key: ${licenseKey.substring(0, 8)}...<br>` : ''}
        ${userId ? `User ID: ${userId}<br>` : ''}
      </div>
    `;
  }

  const diagnosticText = includeLogs && diagnosticBundle
    ? String(diagnosticBundle).slice(0, 20000)
    : '';
  const diagnosticHtml = diagnosticText
    ? `
      <div style="background: #fff; padding: 15px; border-radius: 4px; margin-top: 20px; font-size: 12px; color: #444; border: 1px solid #ddd;">
        <strong>Attached diagnostics:</strong>
        <pre style="white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">${diagnosticText
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')}</pre>
      </div>
    `
    : '';

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: recipientEmails,
      replyTo: email, // Allow replying directly to the user
      subject: `Contact Form: ${subject}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Contact Form Submission</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 24px;">Contact Form Submission</h1>
          </div>
          <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
            <p style="margin-top: 0;"><strong>From:</strong> ${name} &lt;${email}&gt;</p>
            <p><strong>Subject:</strong> ${subject}</p>
            <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
            <div style="background: white; padding: 20px; border-radius: 4px; border-left: 4px solid #667eea;">
              <p style="margin: 0; white-space: pre-wrap;">${message.replace(/\n/g, '<br>')}</p>
            </div>
            ${metadataHtml}
            ${diagnosticHtml}
            <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
            <p style="font-size: 12px; color: #999; margin: 0;">This is an automated message from the AltText AI contact form. You can reply directly to this email to respond to ${name}.</p>
          </div>
        </body>
        </html>
      `,
      text: `
Contact Form Submission - AltText AI

From: ${name} <${email}>
Subject: ${subject}

Message:
${message}

${wpVersion || pluginVersion || siteUrl || siteHash || licenseKey || userId ? `\nSystem Information:\n${wpVersion ? `WordPress Version: ${wpVersion}\n` : ''}${pluginVersion ? `Plugin Version: ${pluginVersion}\n` : ''}${siteUrl ? `Site URL: ${siteUrl}\n` : ''}${siteHash ? `Site Hash: ${siteHash.substring(0, 8)}...\n` : ''}${licenseKey ? `License Key: ${licenseKey.substring(0, 8)}...\n` : ''}${userId ? `User ID: ${userId}\n` : ''}` : ''}
${diagnosticText ? `\nAttached diagnostics:\n${diagnosticText}\n` : ''}

---
This is an automated message from the AltText AI contact form. You can reply directly to this email to respond to ${name}.
      `.trim()
    });

    if (error) {
      logger.error('[Email] Failed to send contact form email', { 
        to: recipientEmails,
        sender: fromEmail,
        replyTo: email,
        error: error.message 
      });
      return {
        success: false,
        error: error.message
      };
    }

    logger.info('[Email] Contact form email sent', { 
      to: recipientEmail,
      recipients: recipientEmails,
      sender: fromEmail,
      replyTo: email,
      subject,
      messageId: data?.id 
    });

    return {
      success: true,
      messageId: data?.id,
      recipientEmail,
      recipientEmails
    };
  } catch (error) {
    logger.error('[Email] Error sending contact form email', { 
      to: recipientEmails,
      sender: fromEmail,
      replyTo: email,
      error: error.message 
    });
    return {
      success: false,
      error: error.message
    };
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Send the free image SEO audit PDF report.
 */
async function sendImageSeoAuditEmail({
  to,
  siteUrl,
  normalizedDomain,
  summary,
  pdfBuffer
}) {
  if (!resend) {
    return {
      success: false,
      error: 'Email service not configured (RESEND_API_KEY not set)'
    };
  }

  const score = Number(summary?.score || 0);
  const pagesScanned = Number(summary?.pagesScanned || 0);
  const imagesScanned = Number(summary?.imagesScanned || 0);
  const missingAltPercent = Number(summary?.missingAltPercent || 0);
  const weakAltCount = Number(summary?.weakAltCount || 0);
  const scoreBand = summary?.scoreBand || 'Review needed';
  const topIssues = Array.isArray(summary?.topIssues) ? summary.topIssues.slice(0, 3) : [];
  const domain = normalizedDomain || siteUrl;
  const pluginUrl = process.env.WP_ALT_TEXT_PLUGIN_URL || 'https://wordpress.org/plugins/beepbeep-ai-alt-text-generator/';
  const topIssuesHtml = topIssues.length
    ? `<ul style="margin: 10px 0 0; padding-left: 20px;">${topIssues.map((item) => `<li>${escapeHtml(item.issue)}: ${Number(item.count || 0)} image${Number(item.count || 0) === 1 ? '' : 's'}</li>`).join('')}</ul>`
    : '<p style="margin: 10px 0 0;">No major issue pattern was found in the crawled sample.</p>';
  const topIssuesText = topIssues.length
    ? topIssues.map((item) => `- ${item.issue}: ${Number(item.count || 0)} image${Number(item.count || 0) === 1 ? '' : 's'}`).join('\n')
    : '- No major issue pattern was found in the crawled sample.';

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: [to],
      subject: `Your Image SEO Audit report for ${domain}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Your Image SEO Audit</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1f2937; max-width: 640px; margin: 0 auto; padding: 24px;">
          <div style="background: #111827; padding: 28px; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 24px;">Your Image SEO Audit is ready</h1>
          </div>
          <div style="background: #f9fafb; padding: 28px; border-radius: 0 0 10px 10px;">
            <p style="margin-top: 0;">Hi,</p>
            <p>Your public-page image SEO audit for <strong>${escapeHtml(domain)}</strong> is attached as a PDF.</p>
            <div style="background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 18px; margin: 22px 0;">
              <p style="margin: 0 0 8px;"><strong>Overall score:</strong> ${score}/100 (${escapeHtml(scoreBand)})</p>
              <p style="margin: 0 0 8px;"><strong>Pages scanned:</strong> ${pagesScanned}</p>
              <p style="margin: 0 0 8px;"><strong>Images found:</strong> ${imagesScanned}</p>
              <p style="margin: 0 0 8px;"><strong>Missing alt text:</strong> ${missingAltPercent}%</p>
              <p style="margin: 0;"><strong>Weak or review-needed alt text:</strong> ${weakAltCount} images</p>
            </div>
            <p style="margin-bottom: 6px;"><strong>Top issue patterns from the crawl:</strong></p>
            ${topIssuesHtml}
            <p>The attached report now includes a page-priority list, grouped image examples so repeated icons do not dominate the audit, and a short action plan for fixing the highest-impact items first.</p>
            <p>For a deeper WordPress media-library cleanup, install the BeepBeep AI Alt Text plugin and scan the source uploads directly.</p>
            <p style="margin: 28px 0;">
              <a href="${pluginUrl}" style="display: inline-block; background: #7B5CFF; color: white; padding: 12px 18px; border-radius: 8px; text-decoration: none; font-weight: 700;">Get the WordPress plugin</a>
            </p>
            <p style="font-size: 14px; color: #6b7280;">You can reply to this email if you want help interpreting the report.</p>
            <p>Thanks,<br>Ben</p>
          </div>
        </body>
        </html>
      `,
      text: `
Your Image SEO Audit is ready

Your public-page image SEO audit for ${domain} is attached as a PDF.

Overall score: ${score}/100 (${scoreBand})
Pages scanned: ${pagesScanned}
Images found: ${imagesScanned}
Missing alt text: ${missingAltPercent}%
Weak or review-needed alt text: ${weakAltCount} images

Top issue patterns:
${topIssuesText}

The attached report includes a page-priority list, grouped image examples, and a short action plan. For a deeper WordPress media-library cleanup, install the BeepBeep AI Alt Text plugin:
${pluginUrl}

Thanks,
Ben
      `.trim(),
      attachments: [
        {
          filename: `image-seo-audit-${String(domain).replace(/[^a-z0-9.-]+/gi, '-').slice(0, 80)}.pdf`,
          content: pdfBuffer
        }
      ]
    });

    if (error) {
      logger.error('[Email] Failed to send image SEO audit email', {
        to,
        domain,
        error: error.message
      });
      return { success: false, error: error.message };
    }

    logger.info('[Email] Image SEO audit email sent', {
      to,
      domain,
      messageId: data?.id
    });

    return {
      success: true,
      messageId: data?.id
    };
  } catch (error) {
    logger.error('[Email] Error sending image SEO audit email', {
      to,
      domain,
      error: error.message
    });
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendPasswordResetEmail,
  sendContactEmail,
  sendImageSeoAuditEmail,
  getContactRecipientEmail,
  getContactRecipientEmails,
  isAvailable: () => !!resend
};
