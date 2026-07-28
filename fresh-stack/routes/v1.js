const express = require('express');

/**
 * Thin /v1/* aliasing layer over the existing, already-idempotent
 * routers — no new business logic, no new credit-charging paths.
 *
 * Every handler here just rewrites the request URL and re-dispatches into
 * the same Express router instance already mounted at /api/titles,
 * /api/alt-text, /api/jobs and /api/billing, so auth, quota
 * reserve/finalize, and rate limiting all stay exactly as they are today.
 *
 * @param {import('express').Router} params.titlesRouter  Router mounted at /api/titles.
 * @param {import('express').Router} params.altTextRouter Router mounted at /api/alt-text.
 * @param {import('express').Router} params.jobsRouter    Router mounted at /api/jobs.
 * @param {import('express').Router} params.billingRouter Router mounted at /api/billing.
 */
function createV1Router({ titlesRouter, altTextRouter, jobsRouter, billingRouter }) {
  const router = express.Router();

  /** Re-dispatch this request into `targetRouter` as if it had hit `newPath`. */
  function forwardTo(targetRouter, newPath) {
    return (req, res, next) => {
      req.url = newPath;
      targetRouter(req, res, next);
    };
  }

  // ── Optimisation ───────────────────────────────────────────────────
  // Titles' /generate endpoint already returns { title, meta } together —
  // /v1/optimise/title, /meta-description and /metadata are three names
  // for the same underlying call so each plugin surface can use whichever
  // reads best in its UI.
  router.post('/optimise/title', forwardTo(titlesRouter, '/generate'));
  router.post('/optimise/meta-description', forwardTo(titlesRouter, '/generate'));
  router.post('/optimise/metadata', forwardTo(titlesRouter, '/generate'));

  // Alt Text's main generate route is POST / (mounted at /api/alt-text).
  router.post('/optimise/alt-text', forwardTo(altTextRouter, '/'));

  // Bulk submission — module is inferred from the existing payload shape
  // (image items vs. page items) the same way /api/jobs already does.
  router.post('/optimise/bulk', forwardTo(jobsRouter, '/'));

  // ── Jobs ───────────────────────────────────────────────────────────
  router.post('/jobs', forwardTo(jobsRouter, '/'));
  router.get('/jobs/:jobId', (req, res, next) => forwardTo(jobsRouter, `/${req.params.jobId}`)(req, res, next));
  router.post('/jobs/:jobId/cancel', (req, res, next) => forwardTo(jobsRouter, `/${req.params.jobId}/cancel`)(req, res, next));
  router.post('/jobs/:jobId/retry', (req, res, next) => forwardTo(jobsRouter, `/${req.params.jobId}/retry`)(req, res, next));

  // ── Account ──────────────────────────────────────────────────────────
  // Credits: the same shared site_quotas status every plugin already reads
  // via its own /quota endpoint (titles.js's is used here since its
  // response shape is already the superset — feature_type, credits_used,
  // credits_remaining, plan, reset_date).
  router.get('/account/credits', forwardTo(titlesRouter, '/quota'));

  // Account overview: existing billing/info shape (plan, status, billing
  // cycle) is the closest existing endpoint to a general "account" view.
  router.get('/account', forwardTo(billingRouter, '/info'));

  return router;
}

module.exports = { createV1Router };
