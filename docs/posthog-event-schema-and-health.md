# PostHog Event Schema, Funnel, and Telemetry Health

## Production filter

Every production insight and dashboard must use both predicates:

```text
properties.environment = 'production'
AND properties.is_internal = false
```

Do not use `is_internal` alone.

## Common schema (version 2)

All server events receive:

- `environment`: `production`, `staging`, `local`, or `test`
- `is_internal`: boolean
- `plugin_version`
- `app_version`
- `site_install_id`
- `session_id`
- `correlation_id`
- `event_schema_version`: `2`

Generation events also require:

- `generation_run_id`
- `generation_item_id` for item/output events
- `generation_mode`: `single`, `bulk`, `regeneration`, `automatic`, or
  `unknown`
- `item_count`
- `completed_item_count`
- `failed_item_count`
- `duration_ms`
- `success`
- `error_code` on failures
- `source`

PostHog `$insert_id` is stable at the event's authority boundary:

- job event: `<event>:<generation_run_id>`
- item event: `<event>:<generation_run_id>:<generation_item_id>`
- signup success: `signup_succeeded:<account_id>`
- Stripe webhook: Stripe event ID

## Alt-text event definitions

`alt_text_generated` is the canonical metric for a newly produced successful
alt-text output. It is backend-authoritative, image-scoped, and is not emitted
for a cache hit.

The following events are separate UI facts and must be frontend-authoritative:

- `alt_text_displayed`: generated text becomes visible to the user.
- `alt_text_copied`: the user activates copy and the copy succeeds.
- `alt_text_saved`: the plugin persists the text in its own draft/state store.
- `alt_text_applied`: WordPress attachment alt metadata is successfully updated.

These must never be inferred from `generation_job_completed`.

## Canonical funnel contract

| Event | Exact trigger / authority | Unit | Required event-specific properties | Deduplication |
|---|---|---|---|---|
| `plugin_opened` | Plugin boot completes and usable UI is shown; frontend | session | `session_id`, `source` | Once per plugin session |
| `dashboard_viewed` | Router enters dashboard route; frontend | route entry | `page_view_id`, `session_id`, `route` | Stable `page_view_id`; never render-driven |
| `signup_started` | First accepted form submit; frontend | attempt | `signup_attempt_id` | Disable submit while pending |
| `signup_succeeded` | Account insert succeeds; backend | account | `account_id`, `signup_attempt_id` | Account-stable insert ID |
| `first_generation_started` | First authoritative job start for identity; derived insight | user/site | generation job schema | PostHog first occurrence |
| `first_generation_completed` | First successful job completion; derived insight | user/site | generation job schema | PostHog first occurrence |
| `alt_text_generated` | New alt output produced; backend | item | generation item schema | Run + item insert ID |
| `returned_within_7_days` | Qualifying plugin/dashboard session 1–7 days after activation; derived | user/site | activation timestamp | Derived, not client-captured |
| `upgrade_cta_clicked` | User activates upgrade CTA; frontend | click | `cta_source`, `target_plan` | Click ID |
| `upgrade_modal_opened` | Modal becomes visible after closed state; frontend | open | `modal_open_id`, `cta_source` | Modal-open ID |
| `checkout_started` | Stripe checkout session created; backend | attempt | `checkout_attempt_id`, checkout session ID, plan | Checkout attempt insert ID |
| `checkout_completed` | Verified Stripe checkout webhook; backend | transaction | Stripe event/session IDs | Stripe event insert ID |
| `subscription_activated` | Verified active/trialing subscription transition; backend | subscription transition | Stripe event/subscription IDs, plan | Stripe event insert ID |

Every row above uses schema version 2 and the common production properties.

## Dashboard migration

1. Export/list every insight, dashboard, funnel, cohort, and alert consuming
   legacy generation/signup/alt events.
2. Keep legacy `generation_completed` during a validation window.
3. Build parallel insights from `event_schema_version = 2`.
4. Compare:
   - legacy completions to `generation_item_completed`, not job completions;
   - successful new outputs to `alt_text_generated`;
   - unique run IDs for job starts/completions.
5. Move the canonical funnel and production dashboard to version 2.
6. Keep a temporary old/new parity dashboard for at least one normal product
   usage cycle.
7. Remove legacy writes only after consumers are migrated and unexplained
   variance is below the agreed threshold.

## Telemetry health queries (HogQL specifications)

Apply the production filter and a rolling 24-hour window unless stated
otherwise.

### Completed jobs without starts

```sql
SELECT c.properties.generation_run_id, count() AS completions
FROM events c
LEFT JOIN events s
  ON s.event = 'generation_job_started'
 AND s.properties.generation_run_id = c.properties.generation_run_id
WHERE c.event = 'generation_job_completed'
  AND c.properties.environment = 'production'
  AND c.properties.is_internal = false
  AND c.timestamp >= now() - INTERVAL 24 HOUR
  AND s.uuid IS NULL
GROUP BY c.properties.generation_run_id
```

Alert when count is greater than 0 for 15 minutes.

### Duplicate terminal events

Group `generation_job_completed` by `generation_run_id`, and
`generation_item_completed`/`alt_text_generated` by run ID plus item ID.
Alert when any group has `count() > 1`.

### Duplicate signup successes

Group `signup_succeeded` by `account_id`. Alert immediately when `count() > 1`
for schema version 2.

### Invalid or missing schema properties

Create one insight counting events where any of these are true:

- `environment` is null or outside the controlled set
- `is_internal` is null
- `event_schema_version` is null, non-numeric, or not in the supported set
- generation event `generation_mode` is outside the controlled set
- generation/checkout event `correlation_id` is null
- checkout start lacks `checkout_attempt_id` or Stripe checkout session ID
- login failure lacks `error_code`

Alert when invalid schema events exceed 0.5% of schema-version-2 traffic or 5
events in one hour, whichever occurs first.

### Suspicious environment and dashboard traffic

- Flag `environment = 'production'` events whose domain is localhost, a private
  IP, `.test`, `.local`, TasteWP, or a configured internal-test domain.
- For `dashboard_viewed`, use a window function partitioned by distinct ID and
  session ID; flag consecutive events less than 2 seconds apart with different
  or missing `page_view_id`.

Alert when more than 1 suspicious production-host event occurs, or when more
than 5% of dashboard views are implausibly repeated in one hour.

## Frontend privacy configuration

The plugin/frontend repository must separately verify:

- autocapture is disabled or restricted to an approved element allowlist;
- session replay masks all text inputs and images/content by default;
- password, token, API-key, billing, raw response, and image content fields are
  blocked before capture;
- local analytics is disabled by default, or always marked `local` and
  `is_internal = true`.
