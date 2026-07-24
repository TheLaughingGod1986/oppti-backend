const express = require('express');
const logger = require('../lib/logger');
const { createAccountDashboardService } = require('../services/accountDashboard');

function createAccountDashboardRouter({ supabase, getStripe, service } = {}) {
  const router = express.Router();
  const accountService = service || createAccountDashboardService({ supabase, getStripe });

  function accountRoute(routeName, handler) {
    return async (req, res) => {
      if (!req.user && !req.license) {
        return res.status(401).json({
          error: 'UNAUTHORIZED',
          code: 'UNAUTHORIZED',
          message: 'Authentication required'
        });
      }

      try {
        const payload = await handler(req);
        logger.info('[account-api] request_completed', {
          route: routeName,
          method: req.method,
          status: 200,
          auth_state: req.authMethod || 'authenticated',
          request_id: req.id || null
        });
        return res.json(payload);
      } catch (error) {
        const status = Number(error.status) || 500;
        logger.error('[account-api] request_failed', {
          route: routeName,
          method: req.method,
          status,
          code: error.code || 'SERVER_ERROR',
          auth_state: req.authMethod || 'authenticated',
          request_id: req.id || null
        });
        return res.status(status).json({
          error: error.code || 'SERVER_ERROR',
          code: error.code || 'SERVER_ERROR',
          message: status >= 500 ? 'Unable to load account data' : error.message
        });
      }
    };
  }

  router.get('/dashboard', accountRoute('dashboard', async (req) => accountService.getDashboard(req)));
  router.get('/me/subscriptions', accountRoute('me.subscriptions', async (req) => ({
    ok: true,
    subscriptions: await accountService.getSubscriptions(req)
  })));
  router.get('/me/sites', accountRoute('me.sites', async (req) => ({
    ok: true,
    sites: await accountService.getSites(req)
  })));
  router.post('/me/sites/detach', accountRoute('me.sites.detach', async (req) => (
    accountService.detachSite(req)
  )));
  router.get('/me/plugins/stats', accountRoute('me.plugins.stats', async (req) => accountService.getPluginStats(req)));
  router.get('/me/plugins/:pluginName/stats', accountRoute('me.plugins.stats.by_plugin', async (req) => (
    accountService.getPluginStats(req, req.params.pluginName)
  )));
  router.get('/me/licenses', accountRoute('me.licenses', async (req) => ({
    ok: true,
    licenses: await accountService.getLicenses(req)
  })));
  router.get('/me/invoices', accountRoute('me.invoices', async (req) => ({
    ok: true,
    invoices: await accountService.getInvoices(req)
  })));
  router.get('/organizations', accountRoute('organizations', async (req) => ({
    ok: true,
    organizations: await accountService.getOrganizations(req)
  })));
  router.post('/organizations', accountRoute('organizations.create', async (req) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      const error = new Error('Organization name is required');
      error.status = 400;
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
    return accountService.createOrganization(req, name);
  }));

  return router;
}

module.exports = { createAccountDashboardRouter };
