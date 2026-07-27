#!/usr/bin/env node
/**
 * Pull Kit broadcast stats and per-link clicks for Looker Studio (via Google Sheets).
 *
 * Usage:
 *   KIT_API_KEY=kit_... node scripts/sync-kit-looker-data.js
 *   KIT_API_KEY=kit_... node scripts/sync-kit-looker-data.js --pretty
 *   KIT_API_KEY=kit_... node scripts/sync-kit-looker-data.js --skip-links
 */
const fs = require('fs');
const path = require('path');
const { isStoryUrl, normalizePagePath } = require('./kit-looker-utils');

const KIT_API_BASE = 'https://api.kit.com/v4';
const OUT_DIR = path.join(__dirname, 'output');

function parseArgs(argv) {
  return {
    pretty: argv.includes('--pretty'),
    skipLinks: argv.includes('--skip-links'),
  };
}

async function fetchBroadcastStatsPage(apiKey, after) {
  const params = new URLSearchParams({ status: 'completed', per_page: '500' });
  if (after) params.set('after', after);

  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`${KIT_API_BASE}/broadcasts/stats?${params}`, {
      headers: {
        'X-Kit-Api-Key': apiKey,
        Accept: 'application/json',
      },
    });

    const body = await response.text();
    if (response.ok) {
      return JSON.parse(body);
    }

    if (response.status === 429 && attempt < maxAttempts) {
      const retryAfterSec = Number(response.headers.get('retry-after')) || 0;
      await sleep(Math.max(retryAfterSec * 1000, attempt * 3000));
      continue;
    }

    throw new Error(`Kit API ${response.status}: ${body}`);
  }

  throw new Error('Kit API broadcasts/stats: exceeded retry attempts');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBroadcastLinkClicks(apiKey, broadcastId) {
  const maxAttempts = 6;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    const response = await fetch(`${KIT_API_BASE}/broadcasts/${broadcastId}/clicks`, {
      headers: {
        'X-Kit-Api-Key': apiKey,
        Accept: 'application/json',
      },
    });

    const body = await response.text();
    if (response.ok) {
      return JSON.parse(body);
    }

    if (response.status === 429 && attempt < maxAttempts) {
      const retryAfterSec = Number(response.headers.get('retry-after')) || 0;
      const backoffMs = Math.max(retryAfterSec * 1000, attempt * 2000);
      await sleep(backoffMs);
      continue;
    }

    throw new Error(`Kit link clicks ${broadcastId} ${response.status}: ${body}`);
  }

  throw new Error(`Kit link clicks ${broadcastId}: exceeded retry attempts`);
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(filePath, header, rows) {
  const lines = [header.join(',')];
  rows.forEach((row) => {
    lines.push(row.map((value) => csvEscape(value)).join(','));
  });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

async function fetchAllBroadcasts(apiKey) {
  const broadcasts = [];
  let after = null;

  do {
    const payload = await fetchBroadcastStatsPage(apiKey, after);
    for (const item of payload.broadcasts || []) {
      const stats = item.stats || {};
      if (!item.send_at) continue;
      broadcasts.push({
        broadcast_id: item.id,
        date: item.send_at.slice(0, 10),
        subject: item.subject || '',
        recipients: stats.recipients || 0,
        emails_opened: stats.emails_opened || 0,
        total_clicks: stats.total_clicks || 0,
      });
    }
    after = payload.pagination?.has_next_page ? payload.pagination.end_cursor : null;
  } while (after);

  return broadcasts;
}

async function fetchStoryClicks(apiKey, broadcasts) {
  const storyRows = [];
  const pageDaily = new Map();

  for (let index = 0; index < broadcasts.length; index += 1) {
    const broadcast = broadcasts[index];
    if (index > 0) {
      await sleep(250);
    }
    const payload = await fetchBroadcastLinkClicks(apiKey, broadcast.broadcast_id);
    for (const click of payload.broadcast?.clicks || []) {
      if (!isStoryUrl(click.url)) continue;

      const pagePath = normalizePagePath(click.url);
      const uniqueClicks = click.unique_clicks || 0;
      storyRows.push({
        date: broadcast.date,
        broadcast_id: broadcast.broadcast_id,
        subject: broadcast.subject,
        url: click.url,
        page_path: pagePath,
        unique_clicks: uniqueClicks,
      });

      const pageKey = `${broadcast.date}|${pagePath}`;
      const prev = pageDaily.get(pageKey) || {
        date: broadcast.date,
        page_path: pagePath,
        kit_unique_clicks: 0,
        link_count: 0,
      };
      prev.kit_unique_clicks += uniqueClicks;
      prev.link_count += 1;
      pageDaily.set(pageKey, prev);
    }
  }

  return { storyRows, pageDaily };
}

async function main() {
  const { pretty, skipLinks } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.KIT_API_KEY;
  if (!apiKey) {
    console.error('Set KIT_API_KEY');
    process.exit(1);
  }

  const broadcasts = await fetchAllBroadcasts(apiKey);

  const daily = new Map();
  broadcasts.forEach((row) => {
    const prev = daily.get(row.date) || {
      kit_total_clicks: 0,
      kit_recipients: 0,
      kit_emails_opened: 0,
      broadcast_count: 0,
    };
    prev.kit_total_clicks += row.total_clicks;
    prev.kit_recipients += row.recipients;
    prev.kit_emails_opened += row.emails_opened;
    prev.broadcast_count += 1;
    daily.set(row.date, prev);
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });

  writeCsv(
    path.join(OUT_DIR, 'kit_daily.csv'),
    ['date', 'kit_total_clicks', 'kit_recipients', 'kit_emails_opened', 'broadcast_count'],
    [...daily.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, row]) => [
        date,
        row.kit_total_clicks,
        row.kit_recipients,
        row.kit_emails_opened,
        row.broadcast_count,
      ]),
  );

  writeCsv(
    path.join(OUT_DIR, 'kit_broadcasts.csv'),
    ['broadcast_id', 'date', 'subject', 'recipients', 'emails_opened', 'total_clicks'],
    broadcasts.map((row) => [
      row.broadcast_id,
      row.date,
      row.subject,
      row.recipients,
      row.emails_opened,
      row.total_clicks,
    ]),
  );

  let storyRows = [];
  let pageDailyRows = [];
  if (!skipLinks) {
    const linkData = await fetchStoryClicks(apiKey, broadcasts);
    storyRows = linkData.storyRows;
    pageDailyRows = [...linkData.pageDaily.values()].sort((a, b) => {
      const dateCmp = a.date.localeCompare(b.date);
      if (dateCmp !== 0) return dateCmp;
      return a.page_path.localeCompare(b.page_path);
    });

    writeCsv(
      path.join(OUT_DIR, 'kit_story_clicks.csv'),
      ['date', 'broadcast_id', 'subject', 'url', 'page_path', 'unique_clicks'],
      storyRows.map((row) => [
        row.date,
        row.broadcast_id,
        row.subject,
        row.url,
        row.page_path,
        row.unique_clicks,
      ]),
    );

    writeCsv(
      path.join(OUT_DIR, 'kit_page_daily.csv'),
      ['date', 'page_path', 'kit_unique_clicks', 'link_count'],
      pageDailyRows.map((row) => [
        row.date,
        row.page_path,
        row.kit_unique_clicks,
        row.link_count,
      ]),
    );
  }

  const summary = {
    ok: true,
    daily_rows: daily.size,
    broadcast_rows: broadcasts.length,
    story_click_rows: storyRows.length,
    page_daily_rows: pageDailyRows.length,
    output_dir: OUT_DIR,
    files: {
      kit_daily: path.join(OUT_DIR, 'kit_daily.csv'),
      kit_broadcasts: path.join(OUT_DIR, 'kit_broadcasts.csv'),
      ...(skipLinks
        ? {}
        : {
            kit_story_clicks: path.join(OUT_DIR, 'kit_story_clicks.csv'),
            kit_page_daily: path.join(OUT_DIR, 'kit_page_daily.csv'),
          }),
    },
  };
  console.log(JSON.stringify(summary, null, pretty ? 2 : 0));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
