# Plugin / Backend Site Contract

## Purpose

The backend now enforces quota and billing entitlements at the canonical site level. The WordPress plugin must therefore provide stable site identity signals on auth, generation, usage, and checkout flows.

## Required request fields

These signals should be sent whenever available.

| Field | Transport | Required for | Notes |
|---|---|---|---|
| `site_id` / `site_hash` | JSON body or `X-Site-Key` / `X-Site-Hash` | auth, generation, usage, billing | Existing stable site identifier from plugin local storage |
| `site_url` | JSON body or `X-Site-URL` | auth, generation, billing | Used for normalization and duplicate detection |
| `site_fingerprint` | JSON body or `X-Site-Fingerprint` | auth, generation, billing | Strong reinstall/reconnect signal |
| `install_uuid` | JSON body or `X-Install-UUID` | auth, generation, billing | Preferred canonical install identifier |
| `plugin_version` | JSON body / metadata | auth, generation | Audit/debug visibility |
| `wordpress_version` | JSON body / metadata | auth | Audit/debug visibility |
| `request_idempotency_key` | header/body (`Idempotency-Key`) | generation | Prevent duplicate debit on retries |

## Optional request fields

| Field | Purpose |
|---|---|
| `blog_id` / `network_id` / `is_multisite` | multisite diagnostics |
| WordPress user id / email | audit/debug only, not canonical entitlement owner |
| `trigger_feature`, `trigger_location`, `source_page` | upgrade funnel attribution |

## Current plugin behavior

Already present in current plugin/backend contract:

- `X-Site-Hash` / `X-Site-Key`
- `X-Site-URL`
- `X-Site-Fingerprint`
- local site identifier option (`beepbeepai_site_id`)
- local trial usage option (`bbai_trial_usage_{site_hash}`)

## Required backend expectations

### Auth (`/auth/register`, `/auth/login`)

Send:

- `site_id`
- `install_uuid`
- `site_url`
- `site_fingerprint`
- `plugin_version`
- `wordpress_version`
- optional multisite fields

Backend behavior:

- resolve or create canonical site
- create/join membership instead of minting a second site quota
- return `shared_site` + masked `existing_email` when joining an already-linked site

### Generation (`/api/alt-text`)

Send:

- `X-Site-Key` or `X-Site-Hash`
- `X-Site-URL`
- `X-Site-Fingerprint`
- `Idempotency-Key` for retried requests

Backend behavior:

- resolve canonical site
- reserve quota atomically
- finalize debit/release
- keep trial and free quota site-owned

### Billing (`/billing/checkout`)

Send:

- site identity headers
- checkout attribution context (`target_plan`, `trigger_feature`, `trigger_location`, `source_page`)

Backend behavior:

- prefer backend-created Checkout Sessions
- embed metadata:
  - `account_id`
  - `user_id`
  - `license_key`
  - `site_id`
  - `site_hash`
  - `email`
  - `plan`
  - `source=app`

## Install UUID requirement

If the plugin does not already persist a dedicated install UUID, it should now do so. Requirements:

- stable for the WordPress installation
- persisted locally in plugin/site options
- sent on auth, generation, and checkout requests
- not regenerated on each user login

This materially improves reinstall resilience and duplicate-site prevention.

## Validation rules

Backend validation:

- normalize URL and host
- reject localhost/dev hosts in production unless explicitly allowed
- prefer install UUID over weaker signals
- do not silently create duplicate sites when domain-only matches are ambiguous

## Compatibility with older plugin versions

Older plugin versions may send only:

- `site_hash`
- `site_url`
- `site_fingerprint`

Compatibility behavior:

- backend still resolves site using the strongest available signal
- site-owned quota model still works, but reinstall matching is weaker without install UUID
- static Payment Link fallback remains supported, but attribution quality is worse

## Trust model

- plugin-provided site identity is a strong hint, not proof of ownership
- multiple matching signals should converge on one canonical site
- Stripe metadata is supportive attribution, not the sole source of truth
