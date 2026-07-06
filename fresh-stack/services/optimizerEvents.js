const logger = require('../lib/logger');
const { gradeFor, getSiteId } = require('./optimizerProgress');

/**
 * Optimizer events — milestones and wins recorded at audit completion.
 *
 * These are history facts with meaningful timestamps (unlike the computed
 * weekly/achievements), so they're written once, when they happen, into the
 * optimizer_events table (idempotent on site_hash + key). Reads are cheap.
 * A per-instance memory store backs the local dev path (no Supabase).
 */

// site_hash -> [event, ...] fallback when Supabase is unavailable (dev).
const memoryEvents = new Map();

function cat(audit, key, field) {
  const c = audit && audit.result && audit.result.categories && audit.result.categories[key];
  return (c && typeof c[field] === 'number') ? c[field] : null;
}

/* Milestone definitions — a milestone fires when its condition flips from
 * false (previous audit) to true (current audit): a genuine crossing. */
const MILESTONE_DEFS = [
  { key: 'grade_b', icon: 'star', label: 'Reached Grade B', cond: (a) => a.overallScore >= 75 },
  { key: 'score_80', icon: 'trend-up', label: 'Passed 80', cond: (a) => a.overallScore >= 80 },
  { key: 'grade_a', icon: 'star', label: 'Reached Grade A', cond: (a) => a.overallScore >= 90 },
  { key: 'images_all', icon: 'image', label: 'All images described', cond: (a) => cat(a, 'images', 'coverageScore') >= 100 },
  { key: 'no_orphans', icon: 'link', label: 'No orphan pages', cond: (a) => cat(a, 'internalLinking', 'orphanedCount') === 0 && (cat(a, 'internalLinking', 'pagesScanned') || 0) > 0 },
  { key: 'schema_added', icon: 'code', label: 'Structured data added', cond: (a) => (cat(a, 'schema', 'pagesWithSchema') || 0) > 0 }
];

/* Which improved category maps to which visitor-facing benefit (for wins). */
const CATEGORY_GAIN = {
  images: 'Accessibility improved',
  accessibility: 'Accessibility improved',
  seo: 'Search visibility improved',
  schema: 'AI understanding increased',
  internalLinking: 'Site authority improved',
  aiReadiness: 'AI visibility improved',
  performance: 'Faster pages',
  technical: 'Stronger foundations'
};

function categoryGains(current, previous) {
  const lc = (current.result && current.result.categories) || {};
  const bc = (previous.result && previous.result.categories) || {};
  const gains = [];
  for (const key of Object.keys(CATEGORY_GAIN)) {
    const now = lc[key] && lc[key].score;
    const then = bc[key] && bc[key].score;
    if (typeof now === 'number' && typeof then === 'number' && now - then >= 2) {
      if (!gains.includes(CATEGORY_GAIN[key])) gains.push(CATEGORY_GAIN[key]);
    }
  }
  return gains.slice(0, 3);
}

/* Real plugin activity (images generated) between two timestamps, used to
 * attribute a win to the plugin that earned it. Zero without a connected
 * account. */
async function imagesGeneratedBetween(supabase, siteHash, sinceISO) {
  if (!supabase || !sinceISO) return 0;
  const siteId = await getSiteId(supabase, siteHash);
  if (!siteId) return 0;
  const { data, error } = await supabase
    .from('usage_events')
    .select('image_count, status')
    .eq('site_id', siteId)
    .eq('feature_type', 'alt_text')
    .gte('created_at', sinceISO);
  if (error || !data) return 0;
  return data
    .filter((r) => !r.status || ['finalized', 'completed', 'succeeded'].includes(r.status))
    .reduce((sum, r) => sum + (Number(r.image_count) || 0), 0);
}

async function recordEvent(supabase, event) {
  if (supabase) {
    const { error } = await supabase
      .from('optimizer_events')
      .upsert(event, { onConflict: 'site_hash,key', ignoreDuplicates: true });
    if (error) logger.warn('[optimizer-events] record failed', { key: event.key, error: error.message });
    return;
  }
  const list = memoryEvents.get(event.site_hash) || [];
  if (!list.some((e) => e.key === event.key)) {
    list.push({ ...event, created_at: new Date().toISOString() });
    memoryEvents.set(event.site_hash, list);
  }
}

/**
 * Detect and record milestones + wins for a completed audit. Non-fatal:
 * a failure here never breaks the audit. `previous` is the prior completed
 * audit for the site (null on the first).
 */
async function detectEvents({ supabase, siteHash, current, previous }) {
  try {
    if (!previous) {
      await recordEvent(supabase, {
        site_hash: siteHash, type: 'milestone', key: 'first_audit',
        label: 'First AI audit completed', detail: `Baseline score ${current.overallScore}`,
        points_delta: null, metadata: { icon: 'scan' }
      });
      return;
    }

    // Milestones — crossings only.
    for (const def of MILESTONE_DEFS) {
      if (def.cond(current) && !def.cond(previous)) {
        await recordEvent(supabase, {
          site_hash: siteHash, type: 'milestone', key: def.key,
          label: def.label, detail: `Score ${current.overallScore} · grade ${gradeFor(current.overallScore)}`,
          points_delta: null, metadata: { icon: def.icon }
        });
      }
    }

    // Win — a meaningful score jump, attributed to the work that caused it.
    const delta = current.overallScore - previous.overallScore;
    if (delta >= 2) {
      const gains = categoryGains(current, previous);
      const images = await imagesGeneratedBetween(supabase, siteHash, previous.completedAt);
      let title;
      let plugin = null;
      if (images > 0) { title = `${images} image descriptions generated`; plugin = 'Alt Text AI'; }
      else if (gains.length) { title = `${gains[0]}`; }
      else { title = `Website health improved`; }
      await recordEvent(supabase, {
        site_hash: siteHash, type: 'win', key: `win_${current.auditId}`,
        label: title, detail: gains.join(' · ') || null,
        points_delta: delta, metadata: { plugin, gains, icon: plugin ? 'image' : 'trend-up' }
      });
    }
  } catch (error) {
    logger.warn('[optimizer-events] detection failed', { site_hash: siteHash, error: error.message });
  }
}

function shortDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
  catch (e) { return ''; }
}

/** Read events of a type for a site, newest first, mapped to frontend shapes. */
async function getEvents({ supabase, siteHash, type, limit = 12 }) {
  let rows = [];
  if (supabase) {
    const { data, error } = await supabase
      .from('optimizer_events')
      .select('label, detail, points_delta, metadata, created_at')
      .eq('site_hash', siteHash)
      .eq('type', type)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (!error && data) rows = data;
    else if (error) logger.warn('[optimizer-events] read failed', { site_hash: siteHash, type, error: error.message });
  } else {
    rows = (memoryEvents.get(siteHash) || [])
      .filter((e) => e.type === type)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }

  if (type === 'milestone') {
    return rows.map((r) => ({
      icon: (r.metadata && r.metadata.icon) || 'star',
      label: r.label,
      when: shortDate(r.created_at)
    }));
  }
  // wins
  return rows.map((r) => ({
    title: r.label,
    ago: shortDate(r.created_at),
    delta: r.points_delta != null ? `+${r.points_delta}` : '',
    plugin: (r.metadata && r.metadata.plugin) || null,
    gains: (r.metadata && r.metadata.gains) || (r.detail ? [r.detail] : [])
  }));
}

module.exports = {
  MILESTONE_DEFS,
  categoryGains,
  detectEvents,
  getEvents,
  _memoryEvents: memoryEvents
};
