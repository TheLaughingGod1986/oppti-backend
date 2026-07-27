# PostHog Analytics Audit — 2026-07-16

## Scope and evidence

This audit covers the `oppti-backend` repository only. It was completed before
the analytics implementation was changed.

The repository does not contain the WordPress plugin or React dashboard source.
There are no backend capture calls for `plugin_opened`, `dashboard_viewed`,
`signup_started`, `signup_succeeded`, `generation_started`, `alt_generated`,
or the alt-text interaction events (`displayed`, `copied`, `saved`, `applied`).
PostHog browser initialization, autocapture, session replay, React effects,
route listeners, and form button state therefore cannot be verified here.

Live PostHog project tools were not exposed to this Codex session. Existing
dashboards, funnels, event consumers, and production rows remain unverified.

## Event inventory before repair

| Event | Source | Trigger and authority | Origin | Expected frequency | Current properties | Duplicate / classification risk | environment | is_internal | correlation_id | schema |
|---|---|---|---|---|---|---|---|---|---|---|
| `generation_completed` | `fresh-stack/routes/altText.js` | Successful non-cached single `/api/alt-text` response; backend authority for one generated image | Backend | Once per successful image request | request ID, site URL/domain, auth/quota/plan, outcome | Named like a job event but emitted per image; frontend starts can therefore be lower; request retries can produce another event unless the same stable insert ID is used | No central guarantee | No | No | No |
| `generation_failed` | `fresh-stack/routes/altText.js` | OpenAI generation exception | Backend | Once per failed image request | request ID, site URL/domain, auth state, outcome/error code | No stable insert ID; legacy name does not distinguish job/item | No central guarantee | No | No | No |
| `generation_blocked_no_credits` | `fresh-stack/routes/altText.js` | Quota reservation rejected | Backend | Once per rejected request | request ID, entitlement properties, outcome | No stable insert ID | No central guarantee | No | No | No |
| `credits_exhausted` | `fresh-stack/routes/altText.js` | Successful request consumes final credit | Backend | Once per quota transition/request | request ID, entitlement properties, outcome | A retried response can repeat it; transition semantics are not encoded | No central guarantee | No | No | No |
| `checkout_started` | `fresh-stack/routes/billing.js` | Stripe checkout session successfully created | Backend | Once per checkout attempt | correlation/checkout attempt IDs, account/site/plan/source properties | Good attempt-level key exists in local flow, but common properties are not attached centrally | Caller supplied | Caller supplied | Yes | No |
| `checkout_completed` | `fresh-stack/routes/billing.js` | Stripe `checkout.session.completed` webhook | Backend | Once per Stripe event | Stripe and checkout attribution properties | Stripe webhook retries; individual paths supply insert IDs inconsistently | Caller supplied | Caller supplied | Usually | No |
| `subscription_activated` | `fresh-stack/routes/billing.js` | Relevant Stripe subscription webhook | Backend | Once per Stripe event/state transition | Stripe and subscription properties | Webhook replay risk unless `$insert_id` is always the Stripe event ID | Caller supplied | Caller supplied | Sometimes | No |
| `payment_succeeded` | `fresh-stack/routes/billing.js` | Successful invoice/payment webhook | Backend | Once per Stripe event | billing properties plus `stripe_event_id`; `$insert_id = stripe_event_id` | Low: PostHog insert ID is stable | Caller supplied | Caller supplied | Sometimes | No |

`src/services/loops.js` also sends a Loops event named
`generation_completed`. It is not a PostHog capture and must not be counted as
a second PostHog producer.

## Likely root causes supported by code

1. The backend legacy `generation_completed` event is item-scoped, while its
   name implies job scope. The reported 13 completions versus 4 starts is
   consistent with starts being job-scoped elsewhere and completions being
   image-scoped here. Live event rows are still required to prove this is the
   complete production cause.
2. The single endpoint has no explicit `generation_mode`; any
   `feature_used = bulk_generation` classification is emitted by code outside
   this repository or inferred in PostHog. Backend callers can currently send
   fragile mode/source strings without central validation.
3. Common `environment`, `is_internal`, version, install, session, correlation,
   and schema properties are assembled independently. The generation helper
   omits most of them.
4. Generation events lack stable `$insert_id` values, so client/API retries can
   create duplicate analytics even where quota reservation is idempotent.
5. No backend `signup_succeeded` event exists. The three local events were
   emitted by the frontend/plugin or another service. The backend account insert
   is the authoritative success boundary and should emit a stable event keyed by
   account ID.
6. No backend `dashboard_viewed` event exists. Re-render, Strict Mode, duplicate
   listeners, and route-entry behavior must be repaired in the frontend repo.

## Target event model

- `generation_job_started`: once per run/job.
- `generation_item_completed`: once per successfully generated image.
- `generation_job_completed`: once per run/job after all items reach a terminal
  state.
- `generation_job_failed`: once when a job cannot complete.
- `alt_text_generated`: canonical successful alt-text output metric, once per
  generated image. A cache hit is not a new generated output.

For the synchronous single-image endpoint, one request is both one job and one
item. Bulk jobs use the job ID as `generation_run_id` and the stable client item
ID/index as `generation_item_id`.

Controlled generation modes are `single`, `bulk`, `regeneration`, `automatic`,
and `unknown`.

## Migration constraint

Legacy events must remain during validation. Versioned replacement events should
be dual-written, dashboards moved to schema-versioned events, old/new counts
compared by run/item ID, and legacy writes removed only after consumers and
production parity are confirmed.
