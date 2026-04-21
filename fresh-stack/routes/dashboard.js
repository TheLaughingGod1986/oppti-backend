const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const logger = require('../lib/logger');
const { getQuotaStatus } = require('../services/quota');
const { getUsageLogs } = require('../services/usage');

function createDashboardRouter({ supabase }) {
  const router = express.Router();

  // POST /dashboard/login
  router.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    const { data: license } = await supabase
      .from('licenses')
      .select('*')
      .eq('email', email)
      .single();

    if (!license) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });

    if (license.password_hash) {
      const ok = await bcrypt.compare(password || '', license.password_hash);
      if (!ok) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }

    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const { error: sessionError } = await supabase.from('dashboard_sessions').insert({
      license_key: license.license_key,
      session_token: sessionToken,
      expires_at: expiresAt.toISOString()
    });

    if (sessionError) {
      logger.error('[session] dashboard_session_create_failed', {
        table: 'dashboard_sessions',
        success: false,
        license_key_prefix: license.license_key ? `${license.license_key.substring(0, 8)}...` : null,
        email: license.email || null,
        error: sessionError.message
      });
      return res.status(500).json({
        error: 'SESSION_CREATE_FAILED',
        message: sessionError.message || 'Failed to create dashboard session'
      });
    }

    logger.info('[session] dashboard_session_create_succeeded', {
      table: 'dashboard_sessions',
      success: true,
      license_key_prefix: license.license_key ? `${license.license_key.substring(0, 8)}...` : null,
      email: license.email || null,
      expires_at: expiresAt.toISOString()
    });

    return res.json({ session_token: sessionToken, expires_at: expiresAt.toISOString() });
  });

  // POST /dashboard/logout
  router.post('/logout', async (req, res) => {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '') || req.body?.session_token;
    if (!token) return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing session token' });
    await supabase.from('dashboard_sessions').delete().eq('session_token', token);
    return res.json({ success: true });
  });

  // GET /dashboard/stats
  router.get('/stats', async (req, res) => {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    const session = await supabase
      .from('dashboard_sessions')
      .select('license_key, expires_at')
      .eq('session_token', token)
      .single();
    if (session.error || !session.data) return res.status(401).json({ error: 'INVALID_SESSION' });

    const licenseKey = session.data.license_key;
    const quota = await getQuotaStatus(supabase, { licenseKey });
    if (quota.error) return res.status(quota.status || 500).json(quota);

    return res.json({
      license_key: licenseKey,
      credits_used: quota.credits_used,
      credits_remaining: quota.credits_remaining,
      total_limit: quota.total_limit,
      reset_date: quota.reset_date,
      plan_type: quota.plan_type
    });
  });

  // GET /dashboard/logs
  router.get('/logs', async (req, res) => {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    const session = await supabase
      .from('dashboard_sessions')
      .select('license_key')
      .eq('session_token', token)
      .single();
    if (session.error || !session.data) return res.status(401).json({ error: 'INVALID_SESSION' });

    const licenseKey = session.data.license_key;
    const { data, error } = await supabase
      .from('debug_logs')
      .select('*')
      .eq('license_key', licenseKey)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: 'SERVER_ERROR', message: error.message });
    return res.json({ logs: data || [] });
  });

  // GET /dashboard/usage/export - simple CSV of usage logs
  router.get('/usage/export', async (req, res) => {
    const token = req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    const session = await supabase
      .from('dashboard_sessions')
      .select('license_key')
      .eq('session_token', token)
      .single();
    if (session.error || !session.data) return res.status(401).json({ error: 'INVALID_SESSION' });
    const licenseKey = session.data.license_key;

    const logsResult = await getUsageLogs(supabase, { licenseKey, limit: 500 });
    if (logsResult.error) return res.status(500).json({ error: 'SERVER_ERROR', message: logsResult.error.message });
    const logs = logsResult.data || [];
    const header = ['created_at', 'site_hash', 'user_email', 'credits_used', 'endpoint', 'status'];
    const csvLines = [header.join(',')];
    logs.forEach((log) => {
      csvLines.push([
        log.created_at,
        log.site_hash,
        log.user_email,
        log.credits_used,
        log.endpoint,
        log.status
      ].join(','));
    });
    res.setHeader('Content-Type', 'text/csv');
    res.send(csvLines.join('\n'));
  });

  return router;
}

module.exports = { createDashboardRouter };
