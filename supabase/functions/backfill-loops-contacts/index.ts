import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * One-time backfill: add existing users to Loops and fire account_created.
 * Trigger via the Supabase dashboard Test button (or DELETE this function after use).
 */
Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const LOOPS_API_KEY = Deno.env.get('LOOPS_API_KEY')!;

  // Fetch all real active users
  const { data: users, error } = await supabase
    .from('licenses')
    .select('email, plan, created_at')
    .not('email', 'is', null)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Filter out localhost/test entries
  const realUsers = (users || []).filter(
    (u: { email: string }) => u.email && !u.email.includes('localhost'),
  );

  const results: { email: string; contact: string; event: string }[] = [];

  for (const user of realUsers) {
    // 1. Create contact in Loops
    const contactRes = await fetch('https://app.loops.so/api/v1/contacts/create', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: user.email,
        userGroup: 'plugin_user',
        source: 'plugin_signup',
      }),
    });
    const contactBody = await contactRes.text();
    const contactStatus = contactRes.ok || contactBody.includes('already exists')
      ? 'ok'
      : `failed(${contactRes.status})`;

    // 2. Fire account_created event
    const eventRes = await fetch('https://app.loops.so/api/v1/events/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: user.email,
        eventName: 'account_created',
        plan: user.plan || 'free',
      }),
    });
    const eventStatus = eventRes.ok ? 'ok' : `failed(${eventRes.status})`;

    results.push({ email: user.email, contact: contactStatus, event: eventStatus });

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 300));
  }

  return new Response(
    JSON.stringify({ processed: realUsers.length, results }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
