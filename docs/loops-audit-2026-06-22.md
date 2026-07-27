# Loops Email and Multi-Plugin Audit

Date: 22 June 2026  
Workspace: `beepbeepai`  
Products: BeepBeep AI - Alt Text Generator (`alt_text`) and BeepBeep Titles (`titles`)

## Executive summary

The sending domain `oppti.dev` is fully verified and all five active workflows pass Loops Guardian checks. The primary failure is upstream data: only `account_created` is arriving. In the last seven days Loops recorded three `account_created` events and zero `credits_exhausted`, `plan_upgraded`, `subscriber_added`, or `user_inactive_14_days` events. This explains why four active workflows have never sent.

The audience has 53 contacts, 45 currently subscribed. Existing records have no stable `userId` values or plugin attribution. Existing contacts are treated as Alt Text users, so the current copy is unsuitable for Titles-only users. Backend and plugin changes in this work add stable account identity, plugin membership, versions, activity timestamps, and retry-safe events without changing unsubscribe state.

## Findings

### Critical

1. **Lifecycle events are not reaching Loops.** Upgrade, credit exhaustion, and inactivity workflows are active but have zero sends. Backend event delivery was email-only, lacked idempotency, and provided no product context. Inactivity event production is not present in the active backend runtime.
2. **The onboarding workflow is product-specific but globally triggered.** `account_created` sends Alt Text instructions to every plugin user. A Titles registration would receive incorrect navigation and product guidance.

### High

1. **Contacts lack stable identity.** All sampled audience records have blank `userId`; email changes can fragment lifecycle history.
2. **No plugin membership data exists.** Loops has only `plan`, `generationsCount`, `imagesUnprocessed`, and `woocommerce` custom properties.
3. **Webhooks are disabled and have no endpoint or signing secret.** Delivery, bounce, suppression, and contact changes are not reconciled into backend state.
4. **Double opt-in is disabled.** This may be intentional for product-account email, but newsletter acquisition should use explicit consent and a separate public list or double opt-in path.

### Medium

1. **Four active workflows have zero sends**, so their triggers and audience list selection have not been production-proven.
2. **The third onboarding email has 0% clicks from 40 sends.** Its call to action or link instrumentation needs revision.
3. **Mailing-list configuration is embedded in source in the previous integration.** It is now environment-driven, but deployment must set `LOOPS_PLUGIN_USERS_LIST_ID=cmn7g83oddsuu0izg27ia6tgv`.
4. **A public `DELETE ME (test list)` remains in the account.** Remove it after confirming no test automation relies on it.

### Low

1. Company name is `beepbeepai` and the address is `305 marseden house`; review capitalization, spelling, and legal postal completeness.
2. Loops branding is included because the workspace is on the Free plan.
3. Campaign and payment transactional drafts are inactive and have never sent.

## Active email inventory

| Workflow | Trigger | Timing and subjects | Sends / performance | Audience |
| --- | --- | --- | --- | --- |
| Onboarding loop | `account_created` | Immediate: "You're in. Here's where to start."; +7d: "How many of your images are missing alt text?"; +7d: "How to clear your entire alt text backlog"; +16d: "A quick favour" | 53 at 26.4% / 7.5%; 41 at 24.4% / 4.9%; 40 at 20% / 0%; 36 at 25% / 2.8% | Plugin users |
| Upgrade loop | `credits_exhausted` | Immediate: "You've used your 50 free credits"; +3d: "What 50 more alt texts is actually worth" | 0 sends | List selection shown generically as `List`; verify before rollout |
| Re-engagement loop | `user_inactive_14_days` | Immediate: "Your media library still has untagged images" | 0 sends | List selection shown generically as `List`; verify before rollout |
| Subscriber welcome loop | `subscriber_added` | Immediate: "Welcome - here's what you'll get"; +4d: "The alt text mistake most sites still make"; +6d: "What we shipped recently" | 0 sends | Newsletter subscribers |
| Post-upgrade loop | `plan_upgraded` | Immediate: "Upgrade confirmed. Here's where to start."; +2d: "How to clear your alt text backlog this week"; +5d: "A quick check-in (+ one tip)" | 0 sends | List selection shown generically as `List`; verify before rollout |

Guardian reports two checks passed for every active workflow. The inspected onboarding preview includes a global unsubscribe link and identifies the `Plugin users` list. No fallback variables are currently visible in the active copy. The first onboarding email links users to WordPress instructions but is written only for Alt Text.

## Data dictionary

| Property | Type | Purpose |
| --- | --- | --- |
| `userId` | String | Stable backend `licenses.id` account identity |
| `acquisitionPluginId` | String | First known product: `alt_text` or `titles` |
| `acquisitionPluginTitle` | String | Human-readable acquisition product |
| `lastActivePluginId` | String | Most recently observed product |
| `lastActivePluginTitle` | String | Human-readable active product |
| `usesAltText` / `usesTitles` | Boolean | Independent product memberships; never clear the sibling flag |
| `altTextPluginVersion` / `titlesPluginVersion` | String | Latest observed client version per product |
| `altTextFirstSeenAt` / `titlesFirstSeenAt` | Date | First observed usage per product |
| `altTextLastActiveAt` / `titlesLastActiveAt` | Date | Latest observed usage per product |
| `firstPluginSeenAt` / `lastPluginSeenAt` | Date | Cross-product acquisition and activity timestamps |

Event properties add `pluginId`, `pluginTitle`, `pluginVersion`, and `userId`. Existing event names remain unchanged. `plugin_connected` is added for first authenticated use from each client.

## Event map

| Event | Previous behavior | New behavior |
| --- | --- | --- |
| `account_created` | Email-only, Alt Text assumptions | Stable account ID, acquisition plugin, product version, deterministic idempotency |
| `plugin_connected` | Not emitted | Records each account/product connection once using persistent `account_plugin_connections` state plus request idempotency |
| `generation_completed` | Shared count every five records | Per-product count, version, account ID, contact activity update |
| `credits_exhausted` | Could repeat on every zero-credit write | One event per account/product/billing period |
| `plan_upgraded` | Email and plan only | Stable account ID and retry-safe plan event |
| `user_inactive_14_days` | No active producer found | Requires a scheduled producer before the workflow can function |

## Unified lifecycle design

Draft workflow: `Unified multi-plugin onboarding (draft)` (`cmqp3asbj056a0jz3yesihlbu`). It remains inactive with zero sends, opens, and clicks; Guardian reports two checks passed.

- Keep one `Plugin users` list and one contact per backend account.
- Trigger onboarding from `account_created` or `plugin_connected`, then branch content by `usesAltText` and `usesTitles`.
- Alt Text-only contacts receive media-library and WooCommerce guidance.
- Titles-only contacts receive page scanning, title tag, and meta-description guidance.
- Dual-product contacts receive combined copy and enter each lifecycle stage once.
- Keep global unsubscribe and suppression behavior. Never send `subscribed: true` from backend synchronization.
- Apply a global frequency cap before enabling the currently dormant upgrade, re-engagement, and post-upgrade sequences together.

## Rollout checklist

1. Create the custom contact properties in Loops with the exact names and types above.
2. Set `LOOPS_PLUGIN_USERS_LIST_ID=cmn7g83oddsuu0izg27ia6tgv` in each deployed backend environment.
3. Deploy backend and both plugin clients, then verify `plugin_connected` and plugin-aware events in the Loops event log.
4. Run `npm run backfill:loops-contacts`, review output, then run a single test account with `--email=... --write` before the full write.
5. Review the draft `Unified multi-plugin onboarding (draft)` workflow. It triggers on `plugin_connected`, routes Titles by `lastActivePluginId`, and uses the Alt Text welcome as the fallback. Do not activate it until staging sends pass.
6. Apply migration `021_loops_webhook_reconciliation.sql`, configure `LOOPS_SIGNING_SECRET`, then point Loops at `/webhooks/loops` and send its test event before enabling webhooks.
7. Implement the missing inactivity producer or pause the re-engagement workflow.
8. Test registration, login, fifth generation, credit exhaustion, and plan upgrade using production-like test contacts only.
9. Confirm unsubscribed contacts remain unsubscribed and repeated events do not create duplicate sends.

## Current platform assessment

The integration now uses current Loops capabilities relevant to this system: contact upserts, stable `userId`, mailing-list membership, custom properties, event-triggered workflows, and `Idempotency-Key` for event sends. Recommended next capabilities are signed webhooks, suppression reconciliation, and conditional workflow content. Campaign and transactional creation APIs are available but are unnecessary for this lifecycle implementation and should not replace reviewed dashboard-managed templates.
