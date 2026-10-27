# Before/after evidence — 27 October 2026

Audit boundary: **2026-10-27 08:55:00 UTC**. Latest 24h starts Oct 26 08:55;
preceding 24h starts Oct 25 08:55; seven-day context starts Oct 20 08:55.
Live PostHog project 358941 was queried and the saved insight was executed back.
No raw customer identities or URLs are included here.

| Measure | Before | After this work | Remaining limit |
| --- | --- | --- | --- |
| Website delivery | Product often absent | Live audit resolves known web/legacy product attribution: 8 website_visit rows latest 24h, 11 preceding 24h, 50 in 7d | Observed deliveries, not unique humans; 47/50 seven-day visit rows have Regular transport, 3 Bot |
| Alt Text delivery | Missing product produced U/ambiguity | Legacy slug reliably attributes 13 alt_generated rows in 7d, all with install/account/journey IDs | All 13 have Automation transport, no operation ID; real-customer totals remain U |
| Backend success attribution | Generic generation_completed conflated with Alt Text | 30/31 seven-day completion rows explicitly Unclassified; only 1 has a plugin/install ID | Latest 24h: 13 generic completions, all Unclassified. Do not relabel by event name |
| Titles/Meta | Schema name mistaken for delivery | Actual last-30d ingestion inspected: one title_meta_generated row, Oct 6, development | No production success delivery verified; U |
| Internal Linking | No proven ingestion | Query inspected actual product/slug rows across 30d; no rows returned | Producer/delivery coverage and rollout unverified; U |
| Activation conversion / median first value | Unreliable linking/timing | Tested installation/operation calculation and explicit coverage gates | U until release ingestion, valid cohort denominator and complete activation history exist |
| Repeat success / 7d retention / lifecycle | Missing history and immature cohorts conflated with zero | Tested deduplication, full follow-up eligibility, New/Returning/Resurrected definitions | U until sufficient complete history; no invented cohort counts |
| Aggregate downloads in activity | Could inflate activity and denominators | Query excludes wporg_downloads_daily and wporg_stats_snapshot | Downloads remain available as separate acquisition context only |

Instrumentation follow-ups add canonical product, stable anonymous install and
journey fields, explicit consent/environment/QA tags, operation IDs and generation
mode. Backend capture is now explicitly opt-in with identity matching to the
plugin. Titles lifecycle delivery preserves original queued event timestamps.
These are source/test changes, **not a claim that production is fixed**.

No customer KPI has been promoted from U to a verified production value solely
because of these changes. What is measurable now is actual delivered-row volume,
legacy product attribution and property coverage. Staging, deployment, production
read-back and external daily-report scheduler integration remain release gates.

## Validation and release state

Follow-up PRs: backend #50, website #40, Alt Text #71 (stacked on #64),
Titles #44 (stacked on #39), Internal Linking #18 (stacked on #15). Existing
backend #49 was inspected; it remains separate authentication work.

Local verification: backend 827 tests / 96 suites; website 175 tests / 30 files,
typecheck, lint (0 errors, 80 warnings), production build; Alt Text 217 PHPUnit
tests / 701 assertions (4 deprecations) plus image-input, first-value and telemetry
context regressions; Titles 147 JS tests / 19 suites, smoke/build and PHP consent,
privacy, persistence and timing checks; Internal Linking JS lint/build, PHPCS and
consent/link-persistence checks. The original dependent branches were fetched and
merged into the follow-ups, preserving their concurrent fixes.

GitHub CI passed for all five follow-ups before the final backend opt-out
integration assertion was added; check the current head's CI before merging.
Website preview d0d3534 is READY and authenticated GET /plugins/titles returned
200. This confirms HTTP availability, not a complete browser analytics journey.

An isolated WordPress staging setup was attempted with its own Compose project,
volumes and port 8899. Its containers started, but the local Docker runtime then
stopped responding to install/inspection commands. Plugin activation/telemetry
staging did not complete; a stop was requested for this project's containers
without touching unrelated services or deleting volumes. A direct PostHog query
for new v2 ingestion after 09:10 UTC returned no rows. This is **not** evidence of
zero customer actions and does not pass the staging/production delivery gate.
No changes have been merged or deployed to production.
