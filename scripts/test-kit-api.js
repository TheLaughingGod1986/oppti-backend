#!/usr/bin/env node
/**
 * Dry-run Kit broadcast stats fetch for Looker Studio sync validation.
 * Usage: KIT_API_KEY=... node scripts/test-kit-api.js
 */
const KIT_API_BASE = 'https://api.kit.com/v4';

async function fetchPage(apiKey, after) {
  const params = new URLSearchParams({ status: 'completed', per_page: '500' });
  if (after) params.set('after', after);

  const response = await fetch(`${KIT_API_BASE}/broadcasts/stats?${params}`, {
    headers: {
      'X-Kit-Api-Key': apiKey,
      Accept: 'application/json',
    },
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Kit API ${response.status}: ${body}`);
  }
  return JSON.parse(body);
}

async function main() {
  const apiKey = process.env.KIT_API_KEY;
  if (!apiKey) {
    console.error('Set KIT_API_KEY');
    process.exit(1);
  }

  let after = null;
  let totalBroadcasts = 0;
  let totalClicks = 0;
  const daily = new Map();

  do {
    const payload = await fetchPage(apiKey, after);
    for (const item of payload.broadcasts || []) {
      if (item.stats?.status !== 'completed' || !item.send_at) continue;
      totalBroadcasts += 1;
      totalClicks += item.stats.total_clicks || 0;
      const date = item.send_at.slice(0, 10);
      daily.set(date, (daily.get(date) || 0) + (item.stats.total_clicks || 0));
    }
    after = payload.pagination?.has_next_page ? payload.pagination.end_cursor : null;
  } while (after);

  const topDays = [...daily.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(JSON.stringify({
    ok: true,
    completed_broadcasts: totalBroadcasts,
    total_clicks: totalClicks,
    top_click_days: Object.fromEntries(topDays),
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
