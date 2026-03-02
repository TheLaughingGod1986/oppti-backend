const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const crypto = require('crypto');
const logger = require('../lib/logger');
const { sendPasswordResetEmail, isAvailable: isEmailAvailable } = require('../lib/email');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '30d';

// Generate UUID v4
function generateUUID() {
  return crypto.randomUUID();
}

function createAuthRouter({ supabase }) {
  const router = express.Router();

  // Register new user
  // If site_id is provided, checks if site already has a license (for credit sharing)
  router.post('/register', async (req, res) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(8),
      name: z.string().optional(),
      site_id: z.string().optional(),
      site_url: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Invalid request data',
        details: parsed.error.flatten(),
      });
    }

    const { email, password, name, site_id, site_url } = parsed.data;

    try {
      // If site_id provided, check if this site already has a license
      // This enables credit sharing across all WordPress users on the same site
      if (site_id) {
        const { data: existingSite } = await supabase
          .from('sites')
          .select('license_key, site_url')
          .eq('site_hash', site_id)
          .eq('status', 'active')
          .maybeSingle();

        if (existingSite) {
          // Site already has a license - get that license for credit sharing
          const { data: siteLicense } = await supabase
            .from('licenses')
            .select('*')
            .eq('license_key', existingSite.license_key)
            .single();

          if (siteLicense && siteLicense.plan === 'free') {
            // Site already using free plan - return error
            return res.status(409).json({
              error: 'SITE_HAS_LICENSE',
              message: 'This site is already connected to a free account. All users on this site share the same credits. Log in with the existing account or upgrade to a paid plan.',
              code: 'free_plan_exists',
              existing_email: siteLicense.email ? siteLicense.email.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
            });
          }
        }
      }

      // Check if user already exists
      const { data: existing } = await supabase
        .from('licenses')
        .select('email')
        .eq('email', email)
        .maybeSingle();

      if (existing) {
        return res.status(409).json({
          error: 'USER_EXISTS',
          message: 'An account with this email already exists',
        });
      }

      // Hash password
      const password_hash = await bcrypt.hash(password, 10);

      // Generate license key
      const license_key = generateUUID();

      // Create user account (stored as a license with plan='free')
      const { data: user, error } = await supabase
        .from('licenses')
        .insert({
          license_key,
          email,
          password_hash,
          plan: 'free',
          status: 'active',
          max_sites: 1,
          billing_day_of_month: new Date().getUTCDate(),
          billing_cycle: 'monthly',
          billing_anchor_date: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        logger.error('[Auth] Registration error:', error);
        logger.error('[Auth] Registration error details:', JSON.stringify(error, null, 2));
        return res.status(500).json({
          error: 'REGISTRATION_FAILED',
          message: 'Failed to create account',
          details: error.message || 'Unknown error'
        });
      }

      // If site_id provided, link site to this license.
      // Uses upsert so that if a trial site row already exists for this
      // site_hash, we attach it to the new license instead of duplicating.
      if (site_id) {
        const { error: siteError } = await supabase
          .from('sites')
          .upsert({
            license_key: user.license_key,
            site_hash: site_id,
            site_url: site_url || 'unknown',
            status: 'active',
            activated_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString()
          }, { onConflict: 'site_hash' });

        if (siteError) {
          logger.warn('[Auth] Failed to link site record:', siteError);
          // Don't fail registration, just log warning
        } else {
          logger.info('[Auth] Site linked to license', { site_id, license_key: user.license_key });
        }
      }

      // Generate JWT token
      const token = jwt.sign(
        {
          user_id: user.id,
          email: user.email,
          license_key: user.license_key,
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      return res.status(201).json({
        success: true,
        message: 'Account created successfully',
        data: {
          token,
          user: {
            id: user.id,
            email: user.email,
            license_key: user.license_key,
            plan: user.plan,
            status: user.status,
          },
        },
        // Keep top-level for backward compatibility
        token,
        user: {
          id: user.id,
          email: user.email,
          license_key: user.license_key,
          plan: user.plan,
          status: user.status,
        },
      });
    } catch (err) {
      logger.error('[Auth] Registration error:', err);
      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'An error occurred during registration',
      });
    }
  });

  // Login
  router.post('/login', async (req, res) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Invalid request data',
        details: parsed.error.flatten(),
      });
    }

    const { email, password } = parsed.data;

    try {
      // Find user by email
      const { data: user, error } = await supabase
        .from('licenses')
        .select('*')
        .eq('email', email)
        .maybeSingle();

      if (error || !user) {
        return res.status(401).json({
          error: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        });
      }

      // Check if user has a password (not a license-only account)
      if (!user.password_hash) {
        return res.status(401).json({
          error: 'NO_PASSWORD',
          message: 'This account uses license key authentication. Please contact your administrator for the license key.',
        });
      }

      // Verify password
      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) {
        logger.warn('[Auth] Login failed - password mismatch', { 
          email,
          hasPasswordHash: !!user.password_hash,
          passwordHashLength: user.password_hash?.length || 0
        });
        return res.status(401).json({
          error: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        });
      }
      
      logger.info('[Auth] Login successful', { email, userId: user.id });

      // Check account status
      if (user.status !== 'active') {
        return res.status(403).json({
          error: 'ACCOUNT_INACTIVE',
          message: 'Your account is not active',
          status: user.status,
        });
      }

      // Generate JWT token
      const token = jwt.sign(
        {
          user_id: user.id,
          email: user.email,
          license_key: user.license_key,
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      return res.json({
        success: true,
        message: 'Login successful',
        data: {
          token,
          user: {
            id: user.id,
            email: user.email,
            license_key: user.license_key,
            plan: user.plan,
            status: user.status,
          },
        },
        // Keep top-level for backward compatibility
        token,
        user: {
          id: user.id,
          email: user.email,
          license_key: user.license_key,
          plan: user.plan,
          status: user.status,
        },
      });
    } catch (err) {
      logger.error('[Auth] Login error:', err);
      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'An error occurred during login',
      });
    }
  });

  // Get current user info
  router.get('/me', async (req, res) => {
    try {
      // Get token from Authorization header
      const authHeader = req.header('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'UNAUTHORIZED',
          message: 'No authentication token provided',
        });
      }

      const token = authHeader.substring(7); // Remove 'Bearer '

      // Verify token
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        return res.status(401).json({
          error: 'INVALID_TOKEN',
          message: 'Invalid or expired token',
        });
      }

      // Get user from database
      const { data: user, error } = await supabase
        .from('licenses')
        .select('id, email, license_key, plan, status, max_sites, billing_day_of_month, created_at')
        .eq('id', decoded.user_id)
        .maybeSingle();

      if (error || !user) {
        return res.status(404).json({
          error: 'USER_NOT_FOUND',
          message: 'User account not found',
        });
      }

      return res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          license_key: user.license_key,
          plan: user.plan,
          status: user.status,
          max_sites: user.max_sites,
          created_at: user.created_at,
        },
      });
    } catch (err) {
      logger.error('[Auth] Get user error:', err);
      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'An error occurred',
      });
    }
  });

  // Forgot password (placeholder - would send email in production)
  router.post('/forgot-password', async (req, res) => {
    logger.info('[Auth] Forgot password request received', { 
      email: req.body?.email,
      siteUrl: req.body?.siteUrl,
      requestId: req.id || 'no-id'
    });

    const schema = z.object({
      email: z.string().email(),
      siteUrl: z.string().url().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn('[Auth] Forgot password validation failed', { 
        errors: parsed.error.flatten(),
        body: req.body 
      });
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Invalid email address',
      });
    }

    const { email, siteUrl } = parsed.data;

    try {
      // Check if user exists (only if Supabase is available)
      let userExists = false;
      let resetToken = null;
      let resetLink = null;

      if (supabase) {
        const { data: user } = await supabase
          .from('licenses')
          .select('id, email')
          .eq('email', email)
          .maybeSingle();

        if (user) {
          userExists = true;
          
          // Generate reset token (crypto.randomUUID for simplicity)
          resetToken = crypto.randomUUID();
          
          // Store reset token in database (if columns exist)
          const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
          
          const { error: updateError } = await supabase
            .from('licenses')
            .update({ 
              password_reset_token: resetToken,
              password_reset_expires: expiresAt
            })
            .eq('id', user.id);

          if (updateError) {
            if (updateError.code === '42703') { // Column doesn't exist
              logger.warn('[Auth] Password reset columns not found - run migration 002_add_password_reset.sql', { 
                error: updateError.message 
              });
            } else {
              logger.error('[Auth] Could not store reset token in DB', { error: updateError.message });
            }
          } else {
            logger.info('[Auth] Reset token stored in database', { 
              email, 
              userId: user.id,
              token: resetToken.substring(0, 8) + '...'
            });
          }

          // Build reset link
          const baseUrl = siteUrl ? new URL(siteUrl).origin : 'http://localhost:8080';
          resetLink = `${baseUrl}/wp-admin/admin.php?page=optti&reset-password&token=${resetToken}&email=${encodeURIComponent(email)}`;
        }
      } else {
        // Supabase not available - dev mode: generate token anyway
        resetToken = crypto.randomUUID();
        const baseUrl = siteUrl ? new URL(siteUrl).origin : 'http://localhost:8080';
        resetLink = `${baseUrl}/wp-admin/admin.php?page=optti&reset-password&token=${resetToken}&email=${encodeURIComponent(email)}`;
        logger.warn('[Auth] Supabase not available - dev mode only', { email });
      }

      // Send email if service is available and user exists
      let emailSent = false;
      if (userExists && resetLink && isEmailAvailable()) {
        const emailResult = await sendPasswordResetEmail(email, resetLink);
        emailSent = emailResult.success;
        
        if (emailSent) {
          logger.info('[Auth] Password reset email sent successfully', { email });
        } else {
          logger.warn('[Auth] Failed to send password reset email', { 
            email, 
            error: emailResult.error 
          });
        }
      }

      // In development mode or if email service not configured, return reset link
      const isDev = process.env.NODE_ENV !== 'production';
      const hasEmailService = isEmailAvailable();

      if (isDev || !hasEmailService || !emailSent) {
        // Return reset link for development/testing or if email failed
        return res.json({
          success: true,
          message: userExists || !supabase 
            ? (emailSent 
                ? 'Password reset link has been sent to your email' 
                : 'Password reset link generated (dev mode)')
            : 'If an account exists with this email, you will receive password reset instructions',
          data: {
            resetLink: resetLink,
            note: hasEmailService && !emailSent 
              ? 'Email service failed. Use this link to reset your password.' 
              : 'Email service not configured. Use this link to reset your password.',
            emailSent: emailSent
          }
        });
      }

      // Email sent successfully - don't reveal if email exists
      return res.json({
        success: true,
        message: 'If an account exists with this email, you will receive password reset instructions',
      });

    } catch (err) {
      logger.error('[Auth] Forgot password error:', err);
      // Don't reveal if email exists on error
      return res.json({
        success: true,
        message: 'If an account exists with this email, you will receive password reset instructions',
      });
    }
  });

  // Reset password
  router.post('/reset-password', async (req, res) => {
    logger.info('[Auth] Reset password request received', { 
      email: req.body?.email,
      requestId: req.id || 'no-id'
    });

    const schema = z.object({
      email: z.string().email(),
      token: z.string().min(1),
      newPassword: z.string().min(8).or(z.string().min(8)),
      password: z.string().min(8).optional(), // Alias for newPassword
    });

    const parsed = schema.safeParse({
      ...req.body,
      newPassword: req.body.newPassword || req.body.password
    });

    if (!parsed.success) {
      logger.warn('[Auth] Reset password validation failed', { 
        errors: parsed.error.flatten(),
        body: req.body 
      });
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'Invalid request data. Password must be at least 8 characters.',
        details: parsed.error.flatten(),
      });
    }

    const { email, token, newPassword } = parsed.data;

    try {
      if (!supabase) {
        return res.status(503).json({
          error: 'SERVICE_UNAVAILABLE',
          message: 'Password reset service is not available. Database connection required.',
        });
      }

      // Find user by email and validate reset token
      const { data: user, error: userError } = await supabase
        .from('licenses')
        .select('id, email, password_reset_token, password_reset_expires')
        .eq('email', email)
        .maybeSingle();

      if (userError || !user) {
        // Don't reveal if email exists
        return res.status(400).json({
          error: 'INVALID_TOKEN',
          message: 'Invalid or expired reset token',
        });
      }

      // Check if token matches
      if (!user.password_reset_token || user.password_reset_token !== token) {
        logger.warn('[Auth] Invalid reset token', { email, tokenProvided: token.substring(0, 8) + '...' });
        return res.status(400).json({
          error: 'INVALID_TOKEN',
          message: 'Invalid or expired reset token',
        });
      }

      // Check if token has expired
      if (user.password_reset_expires) {
        const expiresAt = new Date(user.password_reset_expires);
        const now = new Date();
        if (now > expiresAt) {
          logger.warn('[Auth] Expired reset token', { email, expiresAt });
          return res.status(400).json({
            error: 'TOKEN_EXPIRED',
            message: 'Reset token has expired. Please request a new password reset.',
          });
        }
      }

      // Hash the new password
      const password_hash = await bcrypt.hash(newPassword, 10);

      // Update password and clear reset token
      const { error: updateError } = await supabase
        .from('licenses')
        .update({ 
          password_hash,
          password_reset_token: null,
          password_reset_expires: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id);

      if (updateError) {
        logger.error('[Auth] Failed to update password', { 
          email, 
          error: updateError.message 
        });
        return res.status(500).json({
          error: 'UPDATE_FAILED',
          message: 'Failed to update password. Please try again.',
        });
      }

      logger.info('[Auth] Password reset successful', { email, userId: user.id });

      return res.json({
        success: true,
        message: 'Password has been reset successfully. You can now log in with your new password.',
      });

    } catch (err) {
      logger.error('[Auth] Reset password error:', err);
      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'An error occurred while resetting your password',
      });
    }
  });

  return router;
}

module.exports = { createAuthRouter };
