const logger = require('../lib/logger');
const { getRecentFullAudits } = require('./optimizerAudit');

/**
 * Optimizer progress — the Progress screen's real data (Phase 1).
 *
 * Weekly report and Achievements are computed on read from the two sources
 * that already exist: optimizer_audits history (score + per-category scores in
 * result_json) and usage_events (real plugin activity per site). No new schema.
 *
 * Wins and Milestones (history facts needing accurate timestamps) are Phase 2
 * via an optimizer_events table and are not produced here.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function gradeFor(score) {
  if (score >= 97) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 83) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 65) return 'C+';
  if (score >= 55) return 'C';
  return 'D';
}

function clampPct(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/* Human labels for the category keys stored in result_json. */
const CATEGORY_LABELS = {
  images: 'Images',
  internalLinking: 'Internal linking',
  seo: 'SEO',
  schema: 'Schema',
  aiReadiness: 'AI readiness',
  technical: 'Technical',
  performance: 'Performance',
  accessibility: 'Accessibility'
};

/* ---- Site identity + plugin activity (usage_events) ---- */

async function getSiteId(supabase, siteHash) {
  if (!supabase || !siteHash) return null;
  const { data, error } = await supabase
    .from('sites')
    .select('id')
    .eq('site_hash', siteHash)
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

/**
 * Real plugin activity for a site: lifetime and last-7-days image counts by
 * feature. Bounded per-site (one site's slice of usage_events), summed in JS.
 * Returns zeros when there is no connected account (trial/anonymous).
 */
async function getUsageTotals(supabase, siteHash) {
  const empty = { altImagesLifetime: 0, altImagesWeek: 0, titlesWeek: 0 };
  const siteId = await getSiteId(supabase, siteHash);
  if (!siteId) return empty;

  const { data, error } = await supabase
    .from('usage_events')
    .select('image_count, feature_type, created_at, status')
    .eq('site_id', siteId);
  if (error || !data) {
    logger.warn('[optimizer-progress] usage_events query failed', { site_hash: siteHash, error: error && error.message });
    return empty;
  }

  const weekAgo = Date.now() - WEEK_MS;
  const totals = { ...empty };
  for (const row of data) {
    if (row.status && row.status !== 'finalized' && row.status !== 'completed' && row.status !== 'succeeded') continue;
    const count = Number(row.image_count) || 0;
    const inWeek = row.created_at && new Date(row.created_at).getTime() >= weekAgo;
    if (row.feature_type === 'alt_text') {
      totals.altImagesLifetime += count;
      if (inWeek) totals.altImagesWeek += count;
    } else if (row.feature_type === 'title_meta') {
      if (inWeek) totals.titlesWeek += Math.max(1, count);
    }
  }
  return totals;
}

/* ---- Weekly report ---- */

function computeWeekly(audits, usage) {
  if (!audits.length) return null;
  const latest = audits[0];
  const grade = gradeFor(latest.overallScore);

  // Baseline = most recent audit older than 7 days; else the previous audit.
  const cutoff = Date.now() - WEEK_MS;
  const baseline = audits.slice(1).find((a) => new Date(a.completedAt).getTime() <= cutoff)
    || audits[1]
    || null;

  const items = [];
  if (usage.altImagesWeek > 0) items.push(`${usage.altImagesWeek} images fixed`);
  if (usage.titlesWeek > 0) items.push(`${usage.titlesWeek} titles improved`);

  let delta = 0;
  if (baseline) {
    delta = latest.overallScore - baseline.overallScore;
    const lc = (latest.result && latest.result.categories) || {};
    const bc = (baseline.result && baseline.result.categories) || {};
    const improvements = [];
    for (const key of Object.keys(CATEGORY_LABELS)) {
      const now = lc[key] && lc[key].score;
      const then = bc[key] && bc[key].score;
      if (typeof now === 'number' && typeof then === 'number' && now - then >= 2) {
        improvements.push({ label: CATEGORY_LABELS[key], gain: now - then });
      }
    }
    improvements.sort((a, b) => b.gain - a.gain);
    for (const imp of improvements.slice(0, 3)) {
      items.push(`${imp.label} up ${imp.gain} points`);
    }
  }

  if (!items.length) {
    items.push(baseline ? 'No score changes this week' : `Baseline audit complete — score ${latest.overallScore}`);
  }

  return {
    label: 'This week',
    grade,
    delta,
    hasBaseline: Boolean(baseline),
    items: items.slice(0, 4)
  };
}

/* ---- Achievements ---- */

/* Static definitions; progress reads real values from the latest audit and
 * lifetime usage. `noun` drives the "remaining" copy. Add a badge by adding an
 * entry. `get` returns { current, target }. */
const ACHIEVEMENT_DEFS = [
  { icon: 'access', title: 'Accessibility Champion', desc: 'Every image described', noun: '%',
    get: (a) => ({ current: cat(a, 'images', 'coverageScore'), target: 100 }) },
  { icon: 'brain', title: 'AI Ready', desc: '90+ AI readiness', noun: 'points',
    get: (a) => ({ current: cat(a, 'aiReadiness', 'score'), target: 90 }) },
  { icon: 'bolt', title: 'Fast Website', desc: 'Core Web Vitals passed', noun: 'points',
    get: (a) => ({ current: cat(a, 'performance', 'score'), target: 90 }) },
  { icon: 'search', title: 'Search Expert', desc: '95+ SEO score', noun: 'points',
    get: (a) => ({ current: cat(a, 'seo', 'score'), target: 95 }) },
  { icon: 'link', title: 'Authority Builder', desc: 'No orphan pages', noun: 'points',
    get: (a) => ({ current: cat(a, 'internalLinking', 'score'), target: 100,
      earned: cat(a, 'internalLinking', 'orphanedCount') === 0 }) },
  { icon: 'code', title: 'Schema Master', desc: 'Structured data in place', noun: 'points',
    get: (a) => ({ current: cat(a, 'schema', 'score'), target: 90 }) },
  { icon: 'star', title: '100 Score Club', desc: 'Reach a perfect score', noun: 'points',
    get: (a) => ({ current: a.overallScore || 0, target: 100 }) },
  { icon: 'image', title: '1000 Images Improved', desc: 'Lifetime image fixes', noun: 'images',
    get: (a, usage) => ({ current: usage.altImagesLifetime, target: 1000 }) }
];

function cat(audit, key, field) {
  const c = audit.result && audit.result.categories && audit.result.categories[key];
  return (c && typeof c[field] === 'number') ? c[field] : 0;
}

function computeAchievements(latest, usage) {
  if (!latest || !latest.result) return [];
  return ACHIEVEMENT_DEFS.map((def) => {
    const { current, target, earned } = def.get(latest, usage);
    const isEarned = earned != null ? earned : current >= target;
    const progress = clampPct((current / target) * 100);
    const remainingVal = Math.max(0, target - current);
    const noun = def.noun;
    return {
      icon: def.icon,
      title: def.title,
      desc: def.desc,
      earned: isEarned,
      progress,
      progressText: noun === '%' ? `${clampPct(current)}% covered` : `${Math.round(current)} / ${target}`,
      remaining: isEarned ? 'Complete' : (noun === '%'
        ? `${clampPct(remainingVal)}% to go`
        : `${Math.round(remainingVal)} ${noun} remaining`)
    };
  });
}

/**
 * Progress payload for a site: { weekly, achievements }. Empty-safe — returns
 * nulls/[] before enough history exists, so the frontend can keep honest
 * empty states rather than demo data.
 */
async function getOptimizerProgress({ siteHash, supabase = null }) {
  // Lazy require avoids a circular dependency (events → progress).
  const { getEvents } = require('./optimizerEvents');
  const [audits, usage, wins, milestones] = await Promise.all([
    getRecentFullAudits({ siteHash, supabase, limit: 12 }),
    getUsageTotals(supabase, siteHash),
    getEvents({ supabase, siteHash, type: 'win', limit: 8 }),
    getEvents({ supabase, siteHash, type: 'milestone', limit: 8 })
  ]);
  return {
    weekly: computeWeekly(audits, usage),
    achievements: computeAchievements(audits[0], usage),
    wins,
    milestones,
    auditCount: audits.length,
    // Full result of the most recent audit, so the dashboard can show real
    // scores on load without forcing a re-scan.
    latestResult: audits[0] ? audits[0].result : null
  };
}

module.exports = {
  gradeFor,
  computeWeekly,
  computeAchievements,
  ACHIEVEMENT_DEFS,
  getSiteId,
  getOptimizerProgress
};
