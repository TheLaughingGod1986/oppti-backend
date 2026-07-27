#!/usr/bin/env node
/**
 * Import scripts/output/kit_page_daily.csv into a Google Sheet tab.
 *
 * One-time setup (service account — preferred):
 *   1. Google Cloud Console → APIs & Services → Enable "Google Sheets API"
 *   2. IAM → Service Accounts → Create → Keys → Add JSON key
 *   3. Share the target sheet with the service account email (Editor)
 *   4. export GOOGLE_SHEETS_CREDENTIALS_PATH=/path/to/service-account.json
 *   5. npm run import:kit-page-daily
 *
 * Env:
 *   GOOGLE_SHEETS_CREDENTIALS_PATH  (required) path to service account JSON
 *   GOOGLE_SHEET_ID                 (optional) default: kit Looker sheet
 *   KIT_PAGE_DAILY_CSV              (optional) default: scripts/output/kit_page_daily.csv
 *   KIT_PAGE_DAILY_TAB              (optional) default: kit_page_daily
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DEFAULT_SHEET_ID = '1knshEn3tVVes5Gf2uqibCCALaIuOtUdT_lxJEqomTsI';
const DEFAULT_TAB = 'kit_page_daily';
const DEFAULT_CSV = path.join(__dirname, 'output', 'kit_page_daily.csv');
const CHUNK_SIZE = 1000;
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    pretty: argv.includes('--pretty'),
  };
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) {
    throw new Error('CSV is empty');
  }

  return lines.map((line) => {
    const parts = line.split(',');
    if (parts.length !== 4) {
      throw new Error(`Expected 4 columns, got ${parts.length}: ${line}`);
    }
    return parts;
  });
}

function chunkRows(rows, size) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

async function getSheetsClient(credentialsPath) {
  if (!credentialsPath) {
    throw new Error(
      'Missing GOOGLE_SHEETS_CREDENTIALS_PATH (path to service account JSON key)',
    );
  }
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Credentials file not found: ${credentialsPath}`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: SCOPES,
  });

  return google.sheets({ version: 'v4', auth });
}

async function ensureTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  });

  const existing = (meta.data.sheets || []).find(
    (sheet) => sheet.properties?.title === tabName,
  );
  if (existing) {
    return existing.properties.sheetId;
  }

  const response = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  });

  const added = response.data.replies?.[0]?.addSheet?.properties;
  if (!added?.sheetId) {
    throw new Error(`Failed to create tab "${tabName}"`);
  }
  return added.sheetId;
}

async function clearTab(sheets, spreadsheetId, tabName) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${tabName}!A:Z`,
  });
}

async function writeRows(sheets, spreadsheetId, tabName, rows) {
  const chunks = chunkRows(rows, CHUNK_SIZE);

  for (let index = 0; index < chunks.length; index += 1) {
    const startRow = index * CHUNK_SIZE + 1;
    const range = `${tabName}!A${startRow}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: chunks[index] },
    });
  }
}

async function countSheetRows(sheets, spreadsheetId, tabName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:D`,
  });
  return (response.data.values || []).length;
}

async function main() {
  const { dryRun, pretty } = parseArgs(process.argv);
  const credentialsPath = process.env.GOOGLE_SHEETS_CREDENTIALS_PATH;
  const spreadsheetId = process.env.GOOGLE_SHEET_ID || DEFAULT_SHEET_ID;
  const tabName = process.env.KIT_PAGE_DAILY_TAB || DEFAULT_TAB;
  const csvPath = process.env.KIT_PAGE_DAILY_CSV || DEFAULT_CSV;

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const summary = {
    csvPath,
    spreadsheetId,
    tabName,
    csvRows: rows.length,
    dataRows: Math.max(rows.length - 1, 0),
    dryRun,
  };

  if (dryRun) {
    console.log(pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary));
    return;
  }

  const sheets = await getSheetsClient(credentialsPath);
  await ensureTab(sheets, spreadsheetId, tabName);
  await clearTab(sheets, spreadsheetId, tabName);
  await writeRows(sheets, spreadsheetId, tabName, rows);

  const sheetRows = await countSheetRows(sheets, spreadsheetId, tabName);
  if (sheetRows !== rows.length) {
    throw new Error(`Row count mismatch: CSV ${rows.length}, sheet ${sheetRows}`);
  }

  summary.sheetRows = sheetRows;
  summary.imported = true;
  console.log(pretty ? JSON.stringify(summary, null, 2) : JSON.stringify(summary));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
