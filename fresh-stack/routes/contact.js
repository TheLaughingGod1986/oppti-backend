const express = require('express');
const { z } = require('zod');
const logger = require('../lib/logger');
const { sendContactEmail, isAvailable: isEmailAvailable } = require('../lib/email');

/**
 * Create contact form router
 * This endpoint accepts anonymous submissions with site headers for abuse prevention
 * @param {Object} options
 * @param {Object} options.redis - Redis client for rate limiting
 * @returns {express.Router}
 */
function createContactRouter({ redis }) {
  const router = express.Router();

  // Rate limiting: 3 submissions per hour per site
  const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  const RATE_LIMIT_MAX = 3;
  const rateLimitMap = new Map(); // In-memory rate limiting (site hash -> timestamps)

  /**
   * Check rate limit for a site
   */
  function checkRateLimit(siteHash) {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    
    const timestamps = rateLimitMap.get(siteHash) || [];
    const recent = timestamps.filter(ts => ts >= windowStart);
    
    if (recent.length >= RATE_LIMIT_MAX) {
      return false; // Rate limit exceeded
    }
    
    recent.push(now);
    rateLimitMap.set(siteHash, recent);
    
    // Clean up old entries periodically
    if (Math.random() < 0.01) {
      for (const [key, times] of rateLimitMap.entries()) {
        const filtered = times.filter(ts => ts >= windowStart);
        if (filtered.length === 0) {
          rateLimitMap.delete(key);
        } else {
          rateLimitMap.set(key, filtered);
        }
      }
    }
    
    return true; // Within rate limit
  }

  /**
   * Validate email format
   */
  function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * POST /api/contact
   * Submit contact form (anonymous, requires site headers)
   */
  router.post('/', async (req, res) => {
    try {
      // Require site headers for abuse prevention (not full auth)
      const siteHash = req.header('X-Site-Hash');
      const siteUrl = req.header('X-Site-URL');
      const siteFingerprint = req.header('X-Site-Fingerprint');

      if (!siteHash || !siteUrl) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'Site headers (X-Site-Hash, X-Site-URL) are required for abuse prevention'
        });
      }

      // Check rate limit
      if (!checkRateLimit(siteHash)) {
        return res.status(429).json({
          error: 'RATE_LIMIT_EXCEEDED',
          message: 'Rate limit exceeded. Please wait before submitting another message.',
          retry_after: 3600 // 1 hour in seconds
        });
      }

      // Validate request body
      const schema = z.object({
        name: z.string().min(1, 'Name is required'),
        email: z.string().email('Invalid email address format'),
        subject: z.string().min(1, 'Subject is required'),
        message: z.string().min(10, 'Message must be at least 10 characters'),
        wp_version: z.string().optional(),
        plugin_version: z.string().optional()
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        const errors = parsed.error.flatten().fieldErrors;
        const firstError = Object.values(errors)[0]?.[0] || 'Invalid request data';
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: firstError,
          details: errors
        });
      }

      const { name, email, subject, message, wp_version, plugin_version } = parsed.data;

      // Additional email validation
      if (!isValidEmail(email)) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Invalid email address format'
        });
      }

      // Check if email service is available
      if (!isEmailAvailable()) {
        logger.error('[Contact] Email service not available (RESEND_API_KEY not set)');
        return res.status(503).json({
          error: 'SERVICE_UNAVAILABLE',
          message: 'Email service is not configured. Please contact support directly.'
        });
      }

      // Optional headers (if user is authenticated)
      const licenseKey = req.header('X-License-Key') || null;
      const userId = req.header('X-WP-User-ID') || null;

      // Send email
      const emailResult = await sendContactEmail({
        name,
        email,
        subject,
        message,
        wpVersion: wp_version,
        pluginVersion: plugin_version,
        siteUrl,
        siteHash,
        licenseKey,
        userId
      });

      if (!emailResult.success) {
        logger.error('[Contact] Failed to send email', {
          error: emailResult.error,
          siteHash: siteHash.substring(0, 8) + '...'
        });
        return res.status(500).json({
          error: 'SEND_FAILED',
          message: 'Failed to send message. Please try again later.'
        });
      }

      logger.info('[Contact] Contact form submitted successfully', {
        email,
        subject,
        siteHash: siteHash.substring(0, 8) + '...',
        hasLicense: !!licenseKey
      });

      return res.status(200).json({
        success: true,
        message: 'Your message has been sent successfully. We\'ll get back to you soon!'
      });

    } catch (error) {
      logger.error('[Contact] Unexpected error processing contact form', {
        error: error.message,
        stack: error.stack
      });
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred. Please try again later.'
      });
    }
  });

  return router;
}

module.exports = {
  createContactRouter
};
