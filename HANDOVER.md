# HANDOVER — oppti-backend

Written 12 Oct 2026 ~15:00 London by Chief of Staff (Grok Bot) so any agent can pick up from git alone. Master index of all repos: `TheLaughingGod1986/orbit-with-ben` → `HANDOVER.md`. The Website Auditor plan lives in the private repo `oppti-website-auditor` (HANDOVER.md + docs/). This repo is **public**: no customer data or secrets here.

## OpptiAI standing rules (Ben, in force 12 Oct 2026)
- **Who decides:** only real money and irreversible actions go to Ben. The AI team (Chief of Staff = Grok Bot, plus Oppti Growth, Marketing, Analysis, QA, Plugin Dev) decides everything else. Updates to Ben are results only, and say plainly when nothing is needed from him.
- **Releases:** a plugin release ships only after QA passes, and only from a checked clean zip (built with the repo's build script, contents listed and diffed against the last release; no dev files).
- **Git:** never force-push; open a new PR instead. Merge when checks are green (or none required). Each new plugin gets its own repo. Commit identity: `TheLaughingGod1986` (use the GitHub noreply address; never a personal address).
- **Macs:** nothing on either Mac (mini or MacBook) is ever deleted, reset or stashed.
- **Customer email** (from support@oppti.dev, no review needed): chase/reply at most one chase a week and two in total per person; never chase paying customers; refunds, discounts and complaints go to Ben. The chase log is kept off public repos (it has customer emails) — see "Gaps" below.
- **Marketing:** the daily social pass is "Always go". Buffer is the only social route. No price cut, no WP.org listing rewrite, no Reddit dump. UTM convention: lowercase, hyphens; `utm_source`=where (x, facebook, linkedin, wporg, oppti-blog, email, youtube), `utm_medium`=social|reply|listing|cta|email, `utm_campaign`=<plugin>-<purpose>. Tag only oppti.dev links; WP.org links stay clean.
- **October 2026 target (Oppti Growth):** 10 new regular users by 31 Oct. A regular = an account with at least one signed-in successful Alt Text or Titles generation on a real (non-test) site; free counts. Test sites (Playground, TasteWP, InstaWP, localhost, trycloudflare) never count.
- **Data:** Supabase project `femyykcbrleehnyapxbu`. Accounts live in `public.licenses` keyed by email (`auth.users` is empty); `usage_logs.user_email` links usage. PostHog has `signup_succeeded` with `signup_source` / `auditor_source` / `auditor_finding`.
- **Pending with Ben:** whether to make the public repos private (do not change visibility unasked); API key rotation (pending).

## Auditor → plugin handoff params (agreed 12 Oct 2026)
New Auditor cards send **both** `source=auditor&finding=<check_id>&auditor_source=<check_id>` (same check ids as `finding=`, e.g. `missing_alt`).
- Alt Text 4.6.140 reads `source=auditor&finding=missing_alt` (opens Library filtered to Missing; PostHog attribution). Keep sending it.
- Alt Text 4.6.141 and Titles 1.0.29 accept either form. Drop the old param only once most sites are past 4.6.141.
- QA tests new card → 4.6.140 and new card → 4.6.141 (Auditor v1 #7).

## Release state (12 Oct 2026, 14:50 London)
- **Alt Text:** live 4.6.140. Merged since: #56 (`aec9194d`, attempts floor, IF-instead-of-GREATEST) and #59 (`9a994859`, tests only). **Next: 4.6.141** — carries #56 plus the Auditor reporting/handoff hooks (accept `auditor_source`).
- **Titles:** live 1.0.28 on WP.org (readme on main still says 1.0.26; releases are cut from `release/1.0.x`). #34 merged into `release/1.0.27` as `0b5da69e`, ships in **1.0.29** with the Auditor handoff (#32 open: `source=auditor` attribution).
- **Backend:** #31 open (Loops contact structure).
- **Internal Linking 0.1.3:** uploaded to WP.org 6 Oct, reply to the Plugins Team already sent 6 Oct; awaiting approval. Do not send a duplicate reply.
- **Website Auditor (oppti-optimizer):** 0.8.3 → v1 in progress (repo `oppti-website-auditor`, private). See its HANDOVER.md.

## What does NOT live in any repo (gaps a new agent must know)
- **Logins and sessions on the Mac mini:** Chrome/CDP browsers (Orbit Studio on port 9223; HOS/Flow on 9222, signed into Ben's personal channel), YouTube Studio, Google Flow (AI Ultra), Buffer, ElevenLabs, Vertex/Google Cloud console, WordPress.org (beepbeepv2), PostHog, Stripe, Supabase, Vercel, Render. CLI auths on the mini: `gh`, Cursor `agent`, `codex`, Antigravity `agy`, Claude Code. A new agent needs Ben to sign in or hand these over; they cannot be recreated from git.
- **Secrets (names only, never values):** `07_Content-Ops/.env` on the mini (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`, `YT_ANALYTICS_REFRESH_TOKEN_OWB`/`_HOS`, `BUFFER_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `ELEVENLABS_API_KEY`, `PUBLISHING_DRY_RUN=true`); Vercel project env (`orbit-content-ops`, Channel Scout incl. Google Ads refresh token); Render env for `oppti-backend` (Supabase service key, Stripe keys, Loops key, PostHog key); WordPress.org SVN password; Ben's Gmail account (address kept out of repos). Key rotation is still pending with Ben.
- **Mini launchd jobs** (defined in-repo under `launchd/`, but only running on the mini): `com.owb.chief-relay` (every 10 min, 24/7), analytics snapshot 06:40, Buffer mirror check 07:05, `studio.py stale` every 15 min, refill/escalate in the relay. J0053 (point launchd at the repo's `chief_relay.py`) may still be open — check `launchctl list | grep owb` on the mini.
- **Routines that run on Grok Bot's server (Chief of Staff), not in git:** Oppti Desk group room (Growth, Marketing, Analysis, QA, Plugin Dev agents and their prompts); Marketing daily social pass (weekdays, "Always go"); OpptiAI new-signup watch + chase/reply emails (Supabase `licenses` watermark, chase log); Mac mini health check; studio review pass on PR #99 / HOS #180. A replacement agent has to recreate these as its own scheduled tasks (cron/launchd or its platform's scheduler) from the descriptions here.
- **Grok Bot box files** (`/workspace` on the Grok Bot box, not reachable by others): `/workspace/oppti-briefs/` (patches, release zips, briefs — the Auditor ones are copied into `oppti-website-auditor/docs/`), `/workspace/oppti-signups/chase-log.md` + `watermark.json` (customer emails; deliberately not committed to public repos), `/workspace/oppti-growth-plan/GROWTH_PLAN_2026-10.md`.
- **Chief memory:** Ben's preferences are now written into these HANDOVER files; anything not here was not decided.

## How to resume
1. Read this file and `AGENTS.md` (if present).
2. `gh pr list` here and in the sibling repos.
3. Ship only through PRs; QA pass + clean zip before any WP.org release.
