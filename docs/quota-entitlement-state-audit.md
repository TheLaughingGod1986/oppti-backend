# Quota And Entitlement State Audit

## Scope

This repository is the BeepBeep AI backend. It contains no WordPress plugin PHP,
`bbai-admin.js`, `alt-library-filters.js`, `nai-dashboard.js`, templates, modals,
or admin CSS. Those frontend consumers cannot be directly changed or statically
tested from this workspace.

The backend quota decision is already authoritative in
`fresh-stack/services/quota.js`, with the site-owned V2 implementation in
`fresh-stack/services/siteQuota.js` and a legacy fallback through
`usage_logs`/`quota_summaries`.

## Sources And Risks

| Source file | Current quota source | Classification | Risk | Fix |
| --- | --- | --- | --- | --- |
| `fresh-stack/services/siteQuota.js` | `site_quotas` plus active subscription/plan; reconciled read against usage | Canonical | Low | Expose canonical token fields to the entitlement builder. |
| `fresh-stack/services/quota.js` | V2 resolver, or legacy `quota_summaries` / `usage_logs` fallback | Canonical gateway | Low | Expose legacy lifecycle/token fields consistently. |
| `fresh-stack/routes/usage.js` | `getQuotaStatus()`, previously rendered as duplicated `usage.*` and top-level credit fields | Duplicated response shape | High | Return additive `data.entitlement_state` for plugin bootstrap/refetch. |
| `fresh-stack/routes/altText.js` | Fresh `getQuotaStatus()` after single generation; reservation payload on denial | Partly canonical | High | Return additive `entitlement_state` on cache hits, successful generation, and quota denial; refresh authenticated denial state. |
| `fresh-stack/services/bulkAltTextProcessor.js` | Per-item reservations without a final UI quota snapshot | Stale after bulk work | High | Attach final `entitlement_state` to the completed job record. |
| `fresh-stack/routes/jobs.js` | Preflight `enforceQuota()` rejection snapshot | Partial/inferred | Medium | Resolve and return `entitlement_state` on a bulk quota gate rejection. |
| `fresh-stack/services/dashboardStateTruth.js` | `getQuotaStatus()` copied into `credits` | Duplicated projection | High | Return the same `entitlement_state` alongside existing dashboard state. |
| `fresh-stack/routes/dashboard.js` | `getQuotaStatus()` copied into stats fields | Duplicated projection | Medium | Return `entitlement_state` additively from dashboard stats. |
| `fresh-stack/services/anonymousTrial.js` | Site trial/legacy trial counters | Canonical for guest trial | Medium | Convert the returned trial status through the shared entitlement builder. |
| `fresh-stack/routes/auth.js` | Account/site linkage plus refreshed `getQuotaStatus()` | Canonical when available | Medium | Return `entitlement_state` additively; plugin must consume it or fall back to `GET /api/usage`. |
| WordPress Dashboard, ALT Library, Autopilot, shell, banners, modals and localized JS | Not present in this repository | Unknown / unpatched | Critical | Consume only `entitlement_state`; remove independent credit capability decisions in the plugin repository. |

## Canonical API State

`fresh-stack/services/entitlementState.js` builds one UI-safe state object from
the authoritative quota result:

```json
{
  "plan": "free",
  "plan_type": "free",
  "token_limit": 50,
  "tokens_used_this_month": 50,
  "total_tokens_used": 50,
  "tokens_remaining": 0,
  "can_generate": false,
  "can_autopilot": false,
  "is_logged_in": true,
  "is_trial": false,
  "is_unlimited": false,
  "reset_date": "2026-06-25T00:00:00.000Z",
  "last_generation_at": "2026-05-25T20:26:56.000Z",
  "upgrade_required": true,
  "quota_state": "exhausted",
  "message": "Monthly credits exhausted."
}
```

No license keys, Stripe identifiers, email addresses, or private tokens are
included in this object.

## Response Surfaces

The following additive response fields now provide canonical state:

| API surface | Field |
| --- | --- |
| `GET /api/usage` authenticated or guest trial | `data.entitlement_state` |
| `POST /api/alt-text` generated, cached, or quota-denied response | `entitlement_state` |
| completed bulk job returned by `GET /api/jobs/:jobId` | `entitlement_state` |
| bulk submission denied for quota | `entitlement_state` when status refresh succeeds |
| `GET /api/dashboard/state-truth` | `entitlement_state` |
| `GET /api/dashboard/stats` | `entitlement_state` |
| successful `POST /auth/register` or `POST /auth/login` | `entitlement_state` when the immediate quota refresh succeeds |

Existing response fields are retained for compatibility; new frontend work
must treat them as display/backward-compatibility fields, not independent
capability sources.

## Required Plugin Follow-Up

The WordPress plugin repository must localize a single state value such as
`window.bbaiEntitlements`, sourced from `data.entitlement_state`, and replace
quota decisions in Dashboard, ALT Library, Autopilot, shell banners, and
modals with `can_generate`, `can_autopilot`, and `tokens_remaining`.

Generation and bulk completion handlers must replace the global state from
the returned `entitlement_state`, rerender counters, and disable consuming
actions at zero. Signup/login handlers must consume their returned
`entitlement_state`, falling back to `GET /api/usage` only if it is absent, and
replace guest/trial state without a page reload.

Library row/count/loading/pagination rendering and UI analytics events
(`entitlement_state_loaded`, `paywall_shown`, `upgrade_clicked`,
`review_completed`, and any conflict detector) remain frontend work because
their code is not present here.

The existing server-side PostHog transport now observes generation outcomes it
can establish without UI inference: `generation_completed`,
`generation_failed`, `generation_blocked_no_credits`, and
`credits_exhausted` on the successful generation that reduces remaining
credits to zero. Events use the site hash identity and quota properties only;
they do not include account email or license/payment secrets.
