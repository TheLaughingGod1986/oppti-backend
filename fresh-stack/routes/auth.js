const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const crypto = require('crypto');
const logger = require('../lib/logger');
const { serializeSupabaseError } = require('../lib/supabaseErrors');
const { sendPasswordResetEmail, isAvailable: isEmailAvailable } = require('../lib/email');
const { buildAnonymousContext } = require('../lib/anonymousIdentity');
const { buildSiteIdentity } = require('../lib/siteIdentity');
const { getAnonymousTrialContinuity } = require('../services/anonymousTrial');
const {
  ensureSiteMembership,
  fetchAccountByLicenseKey,
  recordSiteAudit,
  resolveCanonicalSite,
  syncLegacySitePointers
} = require('../services/siteQuota');

const { trackAccountCreated } = require('../../src/services/loops');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '30d';

// Generate UUID v4
function generateUUID() {
  return crypto.randomUUID();
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return null;
  return email.replace(/(.{2}).*(@.*)/, '$1***$2');
}

function buildAuthSiteContext(body = {}) {
  return buildSiteIdentity({
    siteHash: body.site_id || body.siteId || body.siteHash || body.installId || null,
    installUuid: body.install_uuid || body.installUuid || body.site_id || body.siteId || body.installId || null,
    siteUrl: body.site_url || body.siteUrl || null,
    siteFingerprint: body.site_fingerprint || body.siteFingerprint || body.fingerprint || null,
    // Allow localhost/dev installs to register/login and link context.
    // This does not grant production quota (generation endpoints still block dev
    // hosts outside explicit trial mode).
    allowDevelopment: true
  });
}

function redactLicenseKey(licenseKey) {
  if (!licenseKey) return null;
  return `${String(licenseKey).slice(0, 8)}...`;
}

function buildAuthWriteTrace({
  connectionSource,
  requestId,
  email,
  siteIdentity
}) {
  const isRegister = connectionSource === 'register';

  return {
    event: `${connectionSource}_write_verification`,
    request_id: requestId || null,
    email: maskEmail(email),
    site_identity: {
      is_valid: Boolean(siteIdentity?.isValid),
      site_hash: siteIdentity?.siteHash || null,
      site_url: siteIdentity?.siteUrl || null,
      site_fingerprint_present: Boolean(siteIdentity?.siteFingerprint)
    },
    license_write: {
      attempted: isRegister,
      operation: isRegister ? 'insert' : 'none',
      success: null,
      error: null
    },
    site_resolution: {
      attempted: Boolean(siteIdentity?.isValid),
      success: null,
      matched_by: null,
      created: null,
      error: null
    },
    site_write: {
      attempted: false,
      success: null,
      error: null
    },
    site_membership: {
      attempted: false,
      success: null,
      action: null,
      error: null
    },
    loops_account_created: {
      attempted: isRegister && Boolean(process.env.LOOPS_API_KEY),
      success: isRegister && !process.env.LOOPS_API_KEY ? false : null,
      skipped: isRegister ? !process.env.LOOPS_API_KEY : true,
      error: isRegister && !process.env.LOOPS_API_KEY ? 'LOOPS_DISABLED' : null
    },
    user_id: null,
    license_key_prefix: null,
    site_id: null,
    final_state: 'started'
  };
}

function emitAuthWriteTrace(connectionSource, trace) {
  const prefix = connectionSource === 'register' ? 'signup' : 'login';
  const hasFailure = Boolean(
    trace?.license_write?.error
    || trace?.site_resolution?.error
    || trace?.site_write?.error
    || trace?.site_membership?.error
    || (connectionSource === 'register' && trace?.loops_account_created?.attempted && trace?.loops_account_created?.success === false)
  );
  const level = trace?.final_state === 'success' && !hasFailure
    ? 'info'
    : hasFailure ? 'error' : 'warn';

  logger[level](`[${prefix}] ${connectionSource}_write_verification`, trace);
}

async function fireLoopsAccountCreated({ email, requestId }) {
  const trace = {
    attempted: Boolean(process.env.LOOPS_API_KEY),
    success: null,
    skipped: !process.env.LOOPS_API_KEY,
    error: !process.env.LOOPS_API_KEY ? 'LOOPS_DISABLED' : null
  };

  if (!process.env.LOOPS_API_KEY) {
    logger.info('[signup] account_created_loops_skipped', {
      email: maskEmail(email),
      request_id: requestId || null,
      reason: 'LOOPS_API_KEY missing'
    });
    return trace;
  }

  try {
    await trackAccountCreated({ email, firstName: '', isWooCommerce: false, imagesUnprocessed: 0 });
    trace.success = true;
    trace.error = null;
    logger.info('[signup] account_created_loops_succeeded', {
      email: maskEmail(email),
      request_id: requestId || null
    });
    return trace;
  } catch (error) {
    trace.success = false;
    trace.error = error.message;
    logger.error('[signup] account_created_loops_failed', {
      email: maskEmail(email),
      request_id: requestId || null,
      error: error.message,
      status: error.status || null
    });
    return trace;
  }
}

async function attachSiteContextForAccount({
  supabase,
  account,
  siteIdentity,
  requestId,
  connectionSource
}) {
  const trace = {
    site_resolution: {
      attempted: Boolean(siteIdentity?.isValid),
      success: null,
      matched_by: null,
      created: null,
      error: null
    },
    site_write: {
      attempted: false,
      success: null,
      error: null
    },
    site_membership: {
      attempted: false,
      success: null,
      action: null,
      error: null
    },
    legacy_site_pointer_sync: null,
    legacy_license_pointer_sync: null
  };

  if (!supabase || !account || !siteIdentity?.isValid) {
    return { site: null, sharedSite: false, existingAccount: null, error: null, trace };
  }

  logger.info('[site] attach_site_context_started', {
    connection_source: connectionSource,
    request_id: requestId || null,
    account_id: account.id || null,
    license_key_prefix: redactLicenseKey(account.license_key),
    site_hash: siteIdentity.siteHash || null,
    site_url: siteIdentity.siteUrl || null
  });

  const resolved = await resolveCanonicalSite(supabase, siteIdentity, {
    createIfMissing: true,
    legacyLicenseKey: account.license_key,
    account,
    requestId
  });

  trace.site_resolution.success = !resolved.error;
  trace.site_resolution.matched_by = resolved.matchedBy || null;
  trace.site_resolution.created = Boolean(resolved.created);
  trace.site_resolution.error = resolved.error || null;
  trace.site_write.attempted = Boolean(resolved.diagnostics?.site_write_attempted);
  trace.site_write.success = resolved.diagnostics?.site_write_succeeded ?? null;
  trace.site_write.error = resolved.diagnostics?.site_write_error || null;
  trace.site_membership.attempted = Boolean(resolved.diagnostics?.membership?.attempted);
  trace.site_membership.success = resolved.diagnostics?.membership?.success ?? null;
  trace.site_membership.action = resolved.diagnostics?.membership?.action || null;
  trace.site_membership.error = resolved.diagnostics?.membership?.error || null;

  if (resolved.error) {
    logger.error('[site] attach_site_context_failed', {
      connection_source: connectionSource,
      request_id: requestId || null,
      account_id: account.id || null,
      site_hash: siteIdentity.siteHash || null,
      error: resolved.error,
      site_write_error: resolved.diagnostics?.site_write_error || null
    });
    return { site: null, sharedSite: false, existingAccount: null, error: resolved.error, trace };
  }

  const site = resolved.site;
  const sharedSite = Boolean(site?.license_key && site.license_key !== account.license_key);
  const existingAccount = sharedSite
    ? await fetchAccountByLicenseKey(supabase, site.license_key)
    : null;

  const membershipDiagnostics = {};
  await ensureSiteMembership(supabase, {
    siteId: site.id,
    userId: account.id,
    role: sharedSite ? 'member' : 'owner',
    invitedByUserId: sharedSite ? existingAccount?.id || null : account.id,
    diagnostics: membershipDiagnostics
  });
  trace.site_membership.attempted = Boolean(
    membershipDiagnostics.membership?.attempted || trace.site_membership.attempted
  );
  trace.site_membership.success = membershipDiagnostics.membership?.success ?? trace.site_membership.success;
  trace.site_membership.action = membershipDiagnostics.membership?.action || trace.site_membership.action;
  trace.site_membership.error = membershipDiagnostics.membership?.error || trace.site_membership.error;

  const pointerDiagnostics = {};
  await syncLegacySitePointers(supabase, {
    site,
    account,
    diagnostics: pointerDiagnostics
  });
  trace.legacy_site_pointer_sync = pointerDiagnostics.legacy_site_pointer_sync || null;
  trace.legacy_license_pointer_sync = pointerDiagnostics.legacy_license_pointer_sync || null;

  await recordSiteAudit(supabase, {
    siteId: site.id,
    actorUserId: account.id,
    eventType: sharedSite ? `${connectionSource}_joined_existing_site` : `${connectionSource}_site_linked`,
    severity: sharedSite ? 'warn' : 'info',
    requestId,
    metadata: {
      site_hash: site.site_hash,
      canonical_domain: site.canonical_domain,
      existing_license_key: sharedSite ? site.license_key : null
    }
  });

  logger.info('[site] attach_site_context_completed', {
    connection_source: connectionSource,
    request_id: requestId || null,
    account_id: account.id || null,
    site_id: site.id || null,
    site_hash: site.site_hash || null,
    shared_site: sharedSite,
    matched_by: trace.site_resolution.matched_by,
    created: trace.site_resolution.created,
    site_write_success: trace.site_write.success,
    site_membership_success: trace.site_membership.success
  });

  return {
    site,
    sharedSite,
    existingAccount,
    error: null,
    trace
  };
}

async function observeAnonymousSignupMerge({
  supabase,
  account,
  site,
  requestId,
  connectionSource,
  anonymousContext
}) {
  if (!supabase || !account?.id || !site?.id) {
    return;
  }

  const continuity = await getAnonymousTrialContinuity(supabase, {
    siteId: site.id,
    siteHash: site.site_hash || null
  });

  logger.info('[Auth] Anonymous signup merge result', {
    connection_source: connectionSource,
    account_id: account.id,
    site_id: site.id,
    site_hash: site.site_hash || null,
    anon_id: anonymousContext?.anonId || null,
    anonymous_usage_found: continuity.hasAnonymousUsage,
    anonymous_usage_used: continuity.used,
    anonymous_usage_limit: continuity.limit,
    anonymous_usage_source: continuity.source
  });

  if (!continuity.hasAnonymousUsage) {
    return;
  }

  await recordSiteAudit(supabase, {
    siteId: site.id,
    actorUserId: account.id,
    eventType: `${connectionSource}_anonymous_trial_merged`,
    severity: 'info',
    requestId,
    metadata: {
      site_hash: site.site_hash || null,
      anon_id: anonymousContext?.anonId || null,
      anonymous_usage_used: continuity.used,
      anonymous_usage_limit: continuity.limit,
      anonymous_usage_source: continuity.source
    }
  });
}

function createAuthRouter({ supabase }) {
  const router = express.Router();

  // Register new user
  // If site_id is provided, checks if site already has a license (for credit sharing)
  router.post('/register', async (req, res) => {
    const sendRegisterResponse = (payload) => {
      const code = payload?.code || payload?.error || null;
      logger.info('[Auth] Register response', {
        success: Boolean(payload?.success),
        code,
        requestId: req.id || null
      });
      return res.status(200).json(payload);
    };

    logger.info('[Auth] Register request received', {
      email: req.body?.email ? maskEmail(req.body.email) : null,
      hasPassword: Boolean(req.body?.password),
      hasSiteId: Boolean(req.body?.site_id || req.body?.siteId || req.body?.siteHash || req.body?.installId),
      requestId: req.id || null
    });
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(8),
      name: z.string().optional(),
      site_id: z.string().optional(),
      site_url: z.string().optional(),
      site_fingerprint: z.string().optional(),
      anon_id: z.string().optional(),
      install_uuid: z.string().optional(),
      blog_id: z.number().optional(),
      network_id: z.number().optional(),
      is_multisite: z.boolean().optional(),
      plugin_version: z.string().optional(),
      wordpress_version: z.string().optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return sendRegisterResponse({
        success: false,
        error: 'INVALID_REQUEST',
        code: 'INVALID_REQUEST',
        message: 'Invalid request data',
        details: parsed.error.flatten(),
      });
    }

    if (!supabase) {
      return sendRegisterResponse({
        success: false,
        error: 'SERVICE_UNAVAILABLE',
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again later.',
      });
    }

    const { email, password, name, site_id, site_url } = parsed.data;
    const registerTrace = buildAuthWriteTrace({
      connectionSource: 'register',
      requestId: req.id || null,
      email,
      siteIdentity: buildAuthSiteContext(parsed.data)
    });

    try {
      const siteIdentity = buildAuthSiteContext(parsed.data);
      const anonymousContext = buildAnonymousContext({
        req,
        body: parsed.data,
        siteIdentity
      });
      if (siteIdentity.isValid) {
        const preflight = await resolveCanonicalSite(supabase, siteIdentity, {
          createIfMissing: false,
          legacyLicenseKey: null,
          account: null,
          requestId: req.id || null
        });

        if (preflight.error === 'AMBIGUOUS_SITE_MATCH') {
          registerTrace.site_resolution.success = false;
          registerTrace.site_resolution.error = preflight.error;
          registerTrace.final_state = 'ambiguous_site_match';
          emitAuthWriteTrace('register', registerTrace);
          return sendRegisterResponse({
            success: false,
            error: 'AMBIGUOUS_SITE_MATCH',
            code: 'AMBIGUOUS_SITE_MATCH',
            message: 'This site matched multiple existing records and needs manual review before it can be linked.'
          });
        }

        if (preflight.error === 'DEVELOPMENT_SITE_NOT_ALLOWED') {
          registerTrace.site_resolution.success = false;
          registerTrace.site_resolution.error = preflight.error;
          registerTrace.final_state = 'development_site_not_allowed';
          emitAuthWriteTrace('register', registerTrace);
          return sendRegisterResponse({
            success: false,
            error: 'DEVELOPMENT_SITE_NOT_ALLOWED',
            code: 'DEVELOPMENT_SITE_NOT_ALLOWED',
            message: 'Development and localhost sites cannot claim production free quota.'
          });
        }
      }

      // Check if user already exists
      const { data: existing } = await supabase
        .from('licenses')
        .select('email')
        .eq('email', email)
        .maybeSingle();

      if (existing) {
        logger.info('[Auth] Register rejected: user exists', { email, requestId: req.id || null });
        registerTrace.final_state = 'user_exists';
        emitAuthWriteTrace('register', registerTrace);
        return sendRegisterResponse({
          success: false,
          error: 'USER_EXISTS',
          code: 'USER_EXISTS',
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
        registerTrace.license_write.success = false;
        registerTrace.license_write.error = serializeSupabaseError(error);
        registerTrace.final_state = 'license_insert_failed';
        emitAuthWriteTrace('register', registerTrace);
        logger.error('[Auth] Registration error:', error);
        logger.error('[Auth] Registration error details:', JSON.stringify(error, null, 2));
        return sendRegisterResponse({
          success: false,
          error: 'REGISTRATION_FAILED',
          code: 'REGISTRATION_FAILED',
          message: 'Failed to create account',
          details: error.message || 'Unknown error'
        });
      }

      registerTrace.license_write.success = true;
      registerTrace.license_write.error = null;
      registerTrace.user_id = user.id;
      registerTrace.license_key_prefix = redactLicenseKey(user.license_key);
      registerTrace.loops_account_created = await fireLoopsAccountCreated({
        email,
        requestId: req.id || null
      });

      let siteLink = { site: null, sharedSite: false, existingAccount: null, error: null, trace: null };
      if (siteIdentity.isValid) {
        siteLink = await attachSiteContextForAccount({
          supabase,
          account: user,
          siteIdentity,
          requestId: req.id || null,
          connectionSource: 'register'
        });
      }
      registerTrace.site_resolution.success = siteLink.trace?.site_resolution?.success ?? registerTrace.site_resolution.success;
      registerTrace.site_resolution.matched_by = siteLink.trace?.site_resolution?.matched_by || null;
      registerTrace.site_resolution.created = siteLink.trace?.site_resolution?.created ?? null;
      registerTrace.site_resolution.error = siteLink.trace?.site_resolution?.error || registerTrace.site_resolution.error;
      registerTrace.site_write.attempted = siteLink.trace?.site_write?.attempted ?? false;
      registerTrace.site_write.success = siteLink.trace?.site_write?.success ?? null;
      registerTrace.site_write.error = siteLink.trace?.site_write?.error || null;
      registerTrace.site_membership.attempted = siteLink.trace?.site_membership?.attempted ?? false;
      registerTrace.site_membership.success = siteLink.trace?.site_membership?.success ?? null;
      registerTrace.site_membership.action = siteLink.trace?.site_membership?.action || null;
      registerTrace.site_membership.error = siteLink.trace?.site_membership?.error || null;
      registerTrace.site_id = siteLink.site?.id || null;

      if (siteLink.site) {
        await observeAnonymousSignupMerge({
          supabase,
          account: user,
          site: siteLink.site,
          requestId: req.id || null,
          connectionSource: 'register',
          anonymousContext
        });
      }

      if (siteLink.error === 'AMBIGUOUS_SITE_MATCH') {
        registerTrace.final_state = 'ambiguous_site_match';
        emitAuthWriteTrace('register', registerTrace);
        return sendRegisterResponse({
          success: false,
          error: 'AMBIGUOUS_SITE_MATCH',
          code: 'AMBIGUOUS_SITE_MATCH',
          message: 'This site matched multiple existing records and needs manual review before it can be linked.'
        });
      }

      if (siteLink.error === 'DEVELOPMENT_SITE_NOT_ALLOWED') {
        registerTrace.final_state = 'development_site_not_allowed';
        emitAuthWriteTrace('register', registerTrace);
        return sendRegisterResponse({
          success: false,
          error: 'DEVELOPMENT_SITE_NOT_ALLOWED',
          code: 'DEVELOPMENT_SITE_NOT_ALLOWED',
          message: 'Development and localhost sites cannot claim production free quota.'
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

      logger.info('[Auth] Register successful', {
        email: user.email,
        userId: user.id,
        shared_site: Boolean(siteLink.sharedSite),
        requestId: req.id || null
      });
      registerTrace.final_state = 'success';
      emitAuthWriteTrace('register', registerTrace);

      return sendRegisterResponse({
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
          site: siteLink.site || null,
          shared_site: siteLink.sharedSite,
          existing_email: maskEmail(siteLink.existingAccount?.email || null)
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
        site: siteLink.site || null,
        shared_site: siteLink.sharedSite,
        existing_email: maskEmail(siteLink.existingAccount?.email || null)
      });
    } catch (err) {
      registerTrace.final_state = 'server_error';
      registerTrace.server_error = err.message;
      emitAuthWriteTrace('register', registerTrace);
      logger.error('[Auth] Registration error:', err);
      return sendRegisterResponse({
        success: false,
        error: 'SERVER_ERROR',
        code: 'SERVER_ERROR',
        message: 'An error occurred during registration',
      });
    }
  });

  // Login
  router.post('/login', async (req, res) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string(),
      site_id: z.string().optional(),
      site_url: z.string().optional(),
      site_fingerprint: z.string().optional(),
      anon_id: z.string().optional(),
      install_uuid: z.string().optional(),
      blog_id: z.number().optional(),
      network_id: z.number().optional(),
      is_multisite: z.boolean().optional(),
      plugin_version: z.string().optional(),
      wordpress_version: z.string().optional()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        code: 'INVALID_REQUEST',
        message: 'Invalid request data',
        details: parsed.error.flatten(),
      });
    }

    if (!supabase) {
      return res.status(503).json({
        error: 'SERVICE_UNAVAILABLE',
        code: 'SERVICE_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again later.',
      });
    }

    const { email, password } = parsed.data;
    const loginTrace = buildAuthWriteTrace({
      connectionSource: 'login',
      requestId: req.id || null,
      email,
      siteIdentity: buildAuthSiteContext(parsed.data)
    });

    try {
      // Find user by email
      const { data: user, error } = await supabase
        .from('licenses')
        .select('*')
        .eq('email', email)
        .maybeSingle();

      if (error || !user) {
        loginTrace.final_state = 'invalid_credentials';
        emitAuthWriteTrace('login', loginTrace);
        return res.status(401).json({
          error: 'INVALID_CREDENTIALS',
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        });
      }

      // Check if user has a password (not a license-only account)
      if (!user.password_hash) {
        loginTrace.final_state = 'no_password';
        emitAuthWriteTrace('login', loginTrace);
        return res.status(401).json({
          error: 'NO_PASSWORD',
          code: 'NO_PASSWORD',
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
        loginTrace.final_state = 'invalid_credentials';
        emitAuthWriteTrace('login', loginTrace);
        return res.status(401).json({
          error: 'INVALID_CREDENTIALS',
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
        });
      }

      logger.info('[Auth] Login successful', { email, userId: user.id });
      loginTrace.user_id = user.id;
      loginTrace.license_key_prefix = redactLicenseKey(user.license_key);

      // Check account status
      if (user.status !== 'active') {
        loginTrace.final_state = 'account_inactive';
        emitAuthWriteTrace('login', loginTrace);
        return res.status(403).json({
          error: 'ACCOUNT_INACTIVE',
          code: 'ACCOUNT_INACTIVE',
          message: 'Your account is not active',
          status: user.status,
        });
      }

      const siteIdentity = buildAuthSiteContext(parsed.data);
      const anonymousContext = buildAnonymousContext({
        req,
        body: parsed.data,
        siteIdentity
      });
      let siteLink = { site: null, sharedSite: false, existingAccount: null, error: null, trace: null };
      if (siteIdentity.isValid) {
        siteLink = await attachSiteContextForAccount({
          supabase,
          account: user,
          siteIdentity,
          requestId: req.id || null,
          connectionSource: 'login'
        });
      }
      loginTrace.site_resolution.success = siteLink.trace?.site_resolution?.success ?? loginTrace.site_resolution.success;
      loginTrace.site_resolution.matched_by = siteLink.trace?.site_resolution?.matched_by || null;
      loginTrace.site_resolution.created = siteLink.trace?.site_resolution?.created ?? null;
      loginTrace.site_resolution.error = siteLink.trace?.site_resolution?.error || loginTrace.site_resolution.error;
      loginTrace.site_write.attempted = siteLink.trace?.site_write?.attempted ?? false;
      loginTrace.site_write.success = siteLink.trace?.site_write?.success ?? null;
      loginTrace.site_write.error = siteLink.trace?.site_write?.error || null;
      loginTrace.site_membership.attempted = siteLink.trace?.site_membership?.attempted ?? false;
      loginTrace.site_membership.success = siteLink.trace?.site_membership?.success ?? null;
      loginTrace.site_membership.action = siteLink.trace?.site_membership?.action || null;
      loginTrace.site_membership.error = siteLink.trace?.site_membership?.error || null;
      loginTrace.site_id = siteLink.site?.id || null;

      if (siteLink.site) {
        await observeAnonymousSignupMerge({
          supabase,
          account: user,
          site: siteLink.site,
          requestId: req.id || null,
          connectionSource: 'login',
          anonymousContext
        });
      }

      if (siteLink.error === 'AMBIGUOUS_SITE_MATCH') {
        loginTrace.final_state = 'ambiguous_site_match';
        emitAuthWriteTrace('login', loginTrace);
        return res.status(409).json({
          error: 'AMBIGUOUS_SITE_MATCH',
          code: 'AMBIGUOUS_SITE_MATCH',
          message: 'This site matched multiple existing records and needs manual review before it can be linked.'
        });
      }

      if (siteLink.error === 'DEVELOPMENT_SITE_NOT_ALLOWED') {
        loginTrace.final_state = 'development_site_not_allowed';
        emitAuthWriteTrace('login', loginTrace);
        return res.status(403).json({
          error: 'DEVELOPMENT_SITE_NOT_ALLOWED',
          code: 'DEVELOPMENT_SITE_NOT_ALLOWED',
          message: 'Development and localhost sites cannot claim production free quota.'
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

      loginTrace.final_state = 'success';
      emitAuthWriteTrace('login', loginTrace);

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
          site: siteLink.site || null,
          shared_site: siteLink.sharedSite,
          existing_email: maskEmail(siteLink.existingAccount?.email || null)
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
        site: siteLink.site || null,
        shared_site: siteLink.sharedSite,
        existing_email: maskEmail(siteLink.existingAccount?.email || null)
      });
    } catch (err) {
      loginTrace.final_state = 'server_error';
      loginTrace.server_error = err.message;
      emitAuthWriteTrace('login', loginTrace);
      logger.error('[Auth] Login error:', err);
      return res.status(500).json({
        error: 'SERVER_ERROR',
        code: 'SERVER_ERROR',
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
          code: 'UNAUTHORIZED',
          message: 'No authentication token provided',
        });
      }

      const token = authHeader.substring(7); // Remove 'Bearer '

      if (!supabase) {
        return res.status(503).json({
          error: 'SERVICE_UNAVAILABLE',
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service temporarily unavailable. Please try again later.',
        });
      }

      // Verify token
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        return res.status(401).json({
          error: 'INVALID_TOKEN',
          code: 'INVALID_TOKEN',
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
          code: 'USER_NOT_FOUND',
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
        code: 'SERVER_ERROR',
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
        code: 'INVALID_REQUEST',
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
        code: 'INVALID_REQUEST',
        message: 'Invalid request data. Password must be at least 8 characters.',
        details: parsed.error.flatten(),
      });
    }

    const { email, token, newPassword } = parsed.data;

    try {
      if (!supabase) {
        return res.status(503).json({
          error: 'SERVICE_UNAVAILABLE',
          code: 'SERVICE_UNAVAILABLE',
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
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired reset token',
        });
      }

      // Check if token matches
      if (!user.password_reset_token || user.password_reset_token !== token) {
        logger.warn('[Auth] Invalid reset token', { email, tokenProvided: token.substring(0, 8) + '...' });
        return res.status(400).json({
          error: 'INVALID_TOKEN',
          code: 'INVALID_TOKEN',
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
            code: 'TOKEN_EXPIRED',
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
          code: 'UPDATE_FAILED',
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
        code: 'SERVER_ERROR',
        message: 'An error occurred while resetting your password',
      });
    }
  });

  return router;
}

module.exports = { createAuthRouter };
