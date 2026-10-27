# OpptiAI operating report contract

Project: **358941, Optti AI Alt text**, GMT. Definitions below are proposed
operating definitions, not approved catalog metrics (the live catalog was empty).

## Read the right numbers

- **0** means a successful, complete query over a verified instrumented population
  found no qualifying action. An empty schema, missing event producer, failed or
  truncated export, unresolved consent, or unverified release is **U**, never 0.
- **U** is represented as `{ "value": null, "status": "U", "reason": "..." }`.
- **Unclassified** is a product-attribution bucket, not a substitute product and
  not permission to discard a row. Conflicting slug/product fields stay here.
- Observed delivery counts are diagnostic counts of ingested events, not total
  customer usage. Report them separately from completeness-gated customer metrics.
- Exclude `wporg_downloads_daily`, `wporg_stats_snapshot` and SDK/system events
  from meaningful product activity. WP.org downloads cannot be installation or
  activation denominators and cannot be joined to a browser click.
- A WordPress installation is the reporting identity. Do not label this a count
  of unique people or cross-product accounts. Neither a host nor a WordPress user
  ID is an acceptable substitute for reliable identity linkage.

## Event and property contract

| Product | plugin_slug | First successful persisted action |
| --- | --- | --- |
| alt_text | beepbeep-ai-alt-text-generator | alt_generated |
| title_meta | opptiai-titles | title_meta_generated |
| internal_linking | opptiai-internal-linking | link_inserted |
| website | absent | No plugin-success metric |

`generation_completed` is backend generation output, not proof it was saved in
WordPress. Never add it to `alt_generated` or `title_meta_generated`. Do not sum a
batch summary and item successes. Count successful **actions**, not titles plus
meta fields as two successes. Repeat generation of the same item is a new action;
attachment ID alone is not a deduplication key.

Required v2 context: `telemetry_schema=opptiai_usage_v2`, `telemetry_source`,
`plugin_slug`, `product`, `site_install_id`, `journey_id`, `environment`,
`telemetry_consent`, `is_test`. Successful actions require an `operation_id` or
stable `$insert_id`; retries of an operation must retain that identity.
`is_first_generation`/`is_returning_user` describe consenting install success
history, not a claim about a person's lifetime usage. Include `generation_mode`
on generation events and an allowlisted `error_code` on failures. Missing fields
remain missing; do not synthesize false/zero values for unknown history.

Account identifiers are optional pseudonyms. Titles and Internal Linking retain
independent anonymous telemetry IDs, so cross-plugin account retention remains U
until an explicit, consented account linkage is designed and verified. Do not
join by email, guessed host matches or PostHog person aliases. Internal Linking
must never export page content, titles, page IDs or private URLs; QA host checks
run locally and export only `is_test`.

## Consent, environments and automation

Keep opt-out/default-denied behavior in WordPress. Alt Text requires provenance
from the Settings opt-in; an old activation-written `yes` does not count. Backend
Alt Text telemetry additionally requires `X-Telemetry-Consent: yes` and the same
`X-Telemetry-Install-ID` as the plugin's event. Credentials cannot imply consent.
Missing client environment is `unknown`, never inferred from the backend server's
production environment. This intentionally stops legacy non-consented backend
capture; generation/auth/billing behavior is unaffected.

The website retains its existing cookieless pre-choice capture policy. Events
identify ephemeral vs consented browser scope. The authenticated backend mirror
is gated on accepted consent. Preview and known QA campaigns receive `is_test`.
Ephemeral website sessions are not a reliable plugin activation denominator.

Live audit found server capture labelled `$virt_traffic_type=Automation` with no
raw browser user agent. That label alone cannot distinguish QA from real plugin
usage. Historical rows remain unresolved. For new v2 plugin events only, accept
Automation transport when source is `wordpress`/`backend`, explicit consent is
true, explicit `is_test` is false and stable installation attribution exists.
Bot/AI traffic, explicit QA/internal flags, staging/development/local/unknown
environments and known sandbox hosts never enter customer metrics. Do not change
PostHog's virtual bot fields or impersonate a browser to make metrics pass.

## Reusable queries and calculation runner

[Delivery/attribution table](https://us.posthog.com/project/358941/insights/GRtA1jAH)
is saved on the existing Growth dashboard. It covers rolling latest 24h,
preceding 24h and seven-day context. It is explicitly an **observed delivery
and property-coverage audit**, not a customer usage KPI. It exposes unresolved
rows instead of dropping them. Missing groups mean no observed rows, not proof
of zero real-world actions.

For every scheduled report, capture one explicit local UTC upper bound and use
half-open windows `[start,end)`. Do not compare a rolling seven-day numerator with
a 90-day denominator when the seven-day denominator is absent. Compare like
windows; keep long-term context separate. Saved rolling tiles use the PostHog
clock; exact-bound report exports should use the generator:

```sh
node fresh-stack/scripts/operating-report.js delivery-query 2026-10-27T08:55:00Z
node fresh-stack/scripts/operating-report.js cohort-query bounds.json
node fresh-stack/scripts/operating-report.js calculate export.json
```

`bounds.json`: `{ "start": "2026-09-01T00:00:00Z", "end": "2026-10-27T08:55:00Z" }`.
The SQL generator deliberately exports allowlisted pseudonymous fields only.
Cohort exports must include complete history back to instrumented activation,
not just the seven-day context window. Use pagination/time partitions if the
10,000-row cap is reached; never calculate a first-ever action from truncated
history. SQL result rows must be mapped into `{uuid,event,timestamp,properties}`
with `insert_id` renamed to `$insert_id` before calculation.

`export.json` contains `rows`, `querySucceeded: true`, `truncated: false`, and
`options: { start, end, product, coverage }`. Coverage flags are all false/absent
until supported by recorded release and ingestion evidence:

- `productionVerified`: this exact instrumented release has ingested real
  production actions with expected properties (schema presence is insufficient).
- `successComplete`: every successful persistence path emits the canonical event,
  with stable operation IDs and no known delivery gaps for the cohort.
- `activationComplete`: observed eligible activation cohort and event-time
  timestamps are complete. Pre-consent activation/install counts stay U.
- `historyComplete`: lifetime/cohort history is complete for these identities.

A failed/truncated export automatically clears coverage in the CLI. Keep a
private evidence record of the UTC bounds, exact query, response status, row
count, release SHA/version and coverage justification for each report. Public
repositories must not contain customer identities or raw event exports.

## Calculation definitions

Activation conversion: first observed `plugin_activated` per installation in
specified cohort interval, followed by a persisted success in `[activation,
activation+7d)`. Only entrants with the full seven days observed enter the
conversion denominator. No eligible entrants means U. Median time to first value
uses those linked converted entrants and event timestamps, in seconds. A negative
clock interval is not a zero-second success.

Repeat successful action: two distinct successful operations on the installation,
with at least one post-first operation in the report interval. Same-day repeats
count. A repeated transport delivery does not.

Day-7 retention: first successful action cohort, successful return in
`[first+7d, first+8d)`. Only cohorts with all eight days observed enter the
denominator. This is day-7 retention, not any return within seven days.

Lifecycle: identities with success in the current interval are New if they have
no earlier success in complete observed history, Returning if their latest prior
success is in the immediately preceding equal-length interval, and Resurrected
if it is older. Do not infer New from a seven-day export alone. The JS runner
implements these custom installation/operation definitions; it does not purport
to reproduce PostHog's standard person-based lifecycle/funnel definitions.

## Release gate and workflow integration

All five repositories are in scope. Inspect backend #49, Alt Text #64, Titles
#39 and Internal Linking #15 before applying follow-ups. Keep actively edited PR
branches independent; stacked follow-ups must state their dependencies.

Before merge/deploy: all CI checks pass, actual WordPress staging validates
opt-out/opt-in/revocation, single/bulk/autopilot writes, scan and persisted-link
success/failure, repeat/retry behavior, and QA event ingestion. Staging events
must retain `environment=staging` and `is_test=true`. After deploy, query actual
production events by the released version and operation ID; only then open the
corresponding coverage flags. Never send a fabricated production/customer event
as proof. Never merge/deploy solely because tests or a schema list are green.

The ChatGPT conversation **OpptiAI Daily Health & Growth** was located, but its
assistant report bodies are returned as opaque content references by the current
reader. Its scheduler is not exposed among local automations. This document and
the saved PostHog table are the integration contract; changing that external
scheduled report has not been verified. The separate local morning signup
check is not the full daily operating report and was not silently repurposed.
