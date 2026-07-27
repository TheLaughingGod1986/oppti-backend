/**
 * Kit → Google Sheets sync for Looker Studio.
 * Deploy: Extensions → Apps Script, paste this file, set KIT_API_KEY in Script Properties.
 * Schedule: Triggers → Add trigger → syncKitBroadcasts → Day timer → 6am–7am.
 */
const KIT_API_BASE = 'https://api.kit.com/v4';
const SHEET_NAME = 'kit_broadcasts';
const DAILY_SHEET_NAME = 'kit_daily';
const STORY_SHEET_NAME = 'kit_story_clicks';
const PAGE_DAILY_SHEET_NAME = 'kit_page_daily';

const SERVICE95_HOSTS = {
  'service95.com': true,
  'www.service95.com': true,
};

const NON_STORY_PATH_PREFIXES = [
  '/privacy-policy',
  '/terms',
  '/thank-you',
  '/unsubscribe',
  '/preferences',
  '/login',
  '/signup',
];

function syncKitBroadcasts() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('KIT_API_KEY');
  if (!apiKey) {
    throw new Error('Set KIT_API_KEY in Project Settings → Script Properties');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const detailSheet = getOrCreateSheet_(ss, SHEET_NAME, [
    'broadcast_id',
    'date',
    'subject',
    'status',
    'recipients',
    'emails_opened',
    'total_clicks',
    'open_rate',
    'click_rate',
    'synced_at',
  ]);
  const dailySheet = getOrCreateSheet_(ss, DAILY_SHEET_NAME, [
    'date',
    'kit_total_clicks',
    'kit_recipients',
    'kit_emails_opened',
    'broadcast_count',
    'synced_at',
  ]);
  const storySheet = getOrCreateSheet_(ss, STORY_SHEET_NAME, [
    'date',
    'broadcast_id',
    'subject',
    'url',
    'page_path',
    'unique_clicks',
    'synced_at',
  ]);
  const pageDailySheet = getOrCreateSheet_(ss, PAGE_DAILY_SHEET_NAME, [
    'date',
    'page_path',
    'kit_unique_clicks',
    'link_count',
    'synced_at',
  ]);

  const broadcasts = fetchAllBroadcastStats_(apiKey);
  const now = new Date().toISOString();
  const detailRows = [];
  const dailyMap = {};
  const storyRows = [];
  const pageDailyMap = {};

  broadcasts.forEach((item) => {
    const stats = item.stats || {};
    if (stats.status !== 'completed') return;

    const sendAt = item.send_at ? new Date(item.send_at) : null;
    if (!sendAt || isNaN(sendAt.getTime())) return;

    const dateKey = Utilities.formatDate(sendAt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    detailRows.push([
      item.id,
      dateKey,
      item.subject || '',
      stats.status,
      stats.recipients || 0,
      stats.emails_opened || 0,
      stats.total_clicks || 0,
      stats.open_rate || 0,
      stats.click_rate || 0,
      now,
    ]);

    if (!dailyMap[dateKey]) {
      dailyMap[dateKey] = {
        total_clicks: 0,
        recipients: 0,
        emails_opened: 0,
        broadcast_count: 0,
      };
    }
    dailyMap[dateKey].total_clicks += stats.total_clicks || 0;
    dailyMap[dateKey].recipients += stats.recipients || 0;
    dailyMap[dateKey].emails_opened += stats.emails_opened || 0;
    dailyMap[dateKey].broadcast_count += 1;

    const clicks = fetchBroadcastLinkClicks_(apiKey, item.id);
    clicks.forEach((click) => {
      if (!isStoryUrl_(click.url)) return;

      const pagePath = normalizePagePath_(click.url);
      const uniqueClicks = click.unique_clicks || 0;
      storyRows.push([
        dateKey,
        item.id,
        item.subject || '',
        click.url,
        pagePath,
        uniqueClicks,
        now,
      ]);

      const pageKey = dateKey + '|' + pagePath;
      if (!pageDailyMap[pageKey]) {
        pageDailyMap[pageKey] = {
          date: dateKey,
          page_path: pagePath,
          kit_unique_clicks: 0,
          link_count: 0,
        };
      }
      pageDailyMap[pageKey].kit_unique_clicks += uniqueClicks;
      pageDailyMap[pageKey].link_count += 1;
    });
  });

  writeRows_(detailSheet, detailRows);
  writeRows_(
    dailySheet,
    Object.keys(dailyMap).sort().map((dateKey) => {
      const day = dailyMap[dateKey];
      return [
        dateKey,
        day.total_clicks,
        day.recipients,
        day.emails_opened,
        day.broadcast_count,
        now,
      ];
    }),
  );
  writeRows_(storySheet, storyRows);
  writeRows_(
    pageDailySheet,
    Object.keys(pageDailyMap).sort().map((pageKey) => {
      const row = pageDailyMap[pageKey];
      return [
        row.date,
        row.page_path,
        row.kit_unique_clicks,
        row.link_count,
        now,
      ];
    }),
  );
}

function fetchAllBroadcastStats_(apiKey) {
  const all = [];
  let after = null;

  do {
    const query = ['status=completed', 'per_page=500'];
    if (after) query.push('after=' + encodeURIComponent(after));
    const url = KIT_API_BASE + '/broadcasts/stats?' + query.join('&');
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: {
        'X-Kit-Api-Key': apiKey,
        Accept: 'application/json',
      },
    });

    if (response.getResponseCode() !== 200) {
      throw new Error('Kit API error ' + response.getResponseCode() + ': ' + response.getContentText());
    }

    const payload = JSON.parse(response.getContentText());
    const page = payload.broadcasts || [];
    all.push.apply(all, page);

    const pagination = payload.pagination || {};
    after = pagination.has_next_page ? pagination.end_cursor : null;
  } while (after);

  return all;
}

function fetchBroadcastLinkClicks_(apiKey, broadcastId) {
  const url = KIT_API_BASE + '/broadcasts/' + broadcastId + '/clicks';
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      'X-Kit-Api-Key': apiKey,
      Accept: 'application/json',
    },
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Kit link clicks error ' + response.getResponseCode() + ': ' + response.getContentText());
  }

  const payload = JSON.parse(response.getContentText());
  return payload.broadcast && payload.broadcast.clicks ? payload.broadcast.clicks : [];
}

function normalizePagePath_(url) {
  if (!url) return '';

  const trimmed = String(url).trim();
  if (!trimmed || /^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed)) return '';

  try {
    const parsed = new URL(trimmed);
    if (!SERVICE95_HOSTS[parsed.hostname.toLowerCase()]) return '';

    var pathname = parsed.pathname || '/';
    if (pathname.length > 1 && pathname.charAt(pathname.length - 1) === '/') {
      pathname = pathname.slice(0, -1);
    }
    return pathname.toLowerCase();
  } catch (error) {
    return '';
  }
}

function isStoryUrl_(url) {
  const pagePath = normalizePagePath_(url);
  if (!pagePath || pagePath === '/') return false;

  for (var i = 0; i < NON_STORY_PATH_PREFIXES.length; i += 1) {
    if (pagePath.indexOf(NON_STORY_PATH_PREFIXES[i]) === 0) return false;
  }
  return true;
}

function writeRows_(sheet, rows) {
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), sheet.getLastColumn()).clearContent();
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
}

function getOrCreateSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}
