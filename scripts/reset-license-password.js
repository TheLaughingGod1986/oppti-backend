#!/usr/bin/env node
/**
 * Set bcrypt password_hash on public.licenses for dashboard/API login.
 *
 * Loads env from repo root: .env then .env.local (same as other scripts).
 *
 * Either:
 *   - DATABASE_URL — direct Postgres (e.g. Supabase local :54322, OrbStack)
 *   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — Supabase REST API
 *
 * Usage:
 *   node scripts/reset-license-password.js <email> <newPassword>
 *   LICENSE_EMAIL=a@b.com NEW_PASSWORD='secret' node scripts/reset-license-password.js
 */

const path = require('path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });
require('dotenv').config({ path: path.join(root, '.env.local') });

async function resetViaPg(email, passwordHash) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query(
      `UPDATE public.licenses
       SET password_hash = $1,
           updated_at = NOW()
       WHERE lower(email) = lower($2)`,
      [passwordHash, email]
    );
    if (res.rowCount === 0) {
      const { rows } = await client.query(
        `SELECT email FROM public.licenses ORDER BY created_at NULLS LAST LIMIT 20`
      );
      const sample = rows.map((r) => r.email).join(', ') || '(no rows)';
      throw new Error(
        `No license row for email "${email}". Sample emails in DB: ${sample}`
      );
    }
  } finally {
    await client.end();
  }
}

async function resetViaSupabase(email, passwordHash) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Set DATABASE_URL, or both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }
  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: row, error: fetchErr } = await supabase
    .from('licenses')
    .select('email')
    .eq('email', email)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!row) {
    throw new Error(`No license found for email: ${email} (must match stored casing)`);
  }
  const patch = {
    password_hash: passwordHash,
    updated_at: new Date().toISOString(),
  };
  const { error: updErr } = await supabase
    .from('licenses')
    .update(patch)
    .eq('email', email);
  if (updErr) throw updErr;
}

async function main() {
  const email = process.argv[2] || process.env.LICENSE_EMAIL;
  const newPassword = process.argv[3] || process.env.NEW_PASSWORD;
  if (!email || !newPassword) {
    console.error(
      'Usage: node scripts/reset-license-password.js <email> <newPassword>'
    );
    console.error(
      '   or: LICENSE_EMAIL=... NEW_PASSWORD=... node scripts/reset-license-password.js'
    );
    process.exit(1);
  }
  if (newPassword.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  if (process.env.DATABASE_URL) {
    await resetViaPg(email, passwordHash);
    console.log('Updated password_hash via DATABASE_URL for:', email);
  } else {
    await resetViaSupabase(email, passwordHash);
    console.log('Updated password_hash via Supabase API for:', email);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
