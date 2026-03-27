/**
 * One-time backfill: add existing users to Loops and fire account_created.
 * Run from the oppti-backend root: node scripts/backfill-loops-contacts.js
 * Requires LOOPS_API_KEY and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const LOOPS_API_KEY = process.env.LOOPS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!LOOPS_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required env vars: LOOPS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function loopsPost(path, body) {
  const res = await fetch(`https://app.loops.so/api/v1${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LOOPS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

async function main() {
  console.log('Fetching real users from Supabase...');

  const { data: users, error } = await supabase
    .from('licenses')
    .select('email, plan, created_at')
    .not('email', 'is', null)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to fetch users:', error);
    process.exit(1);
  }

  // Filter out localhost/test entries
  const realUsers = users.filter(u => u.email && !u.email.includes('localhost'));
  console.log(`Found ${realUsers.length} real users to backfill:\n`);

  for (const user of realUsers) {
    process.stdout.write(`  ${user.email} ... `);

    // 1. Create contact in Loops
    const contactRes = await loopsPost('/contacts/create', {
      email: user.email,
      userGroup: 'plugin_user',
      source: 'plugin_signup',
    });

    if (!contactRes.ok && !contactRes.body.includes('already exists')) {
      console.log(`❌ contact create failed (${contactRes.status}): ${contactRes.body}`);
      continue;
    }

    // 2. Fire account_created event
    const eventRes = await loopsPost('/events/send', {
      email: user.email,
      eventName: 'account_created',
      plan: user.plan || 'free',
    });

    if (eventRes.ok) {
      console.log('✅');
    } else {
      console.log(`⚠️  event failed (${eventRes.status}): ${eventRes.body}`);
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\nBackfill complete.');
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
