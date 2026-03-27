import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch users who are inactive — either:
  // 1. last_generation_at exists but is older than 14 days, OR
  // 2. last_generation_at is NULL (never generated) but account is older than 14 days
  const { data: inactiveUsers } = await supabase
    .from('licenses')
    .select('email, last_generation_at, created_at')
    .eq('reengagement_sent', false)
    .eq('plan', 'free')
    .not('email', 'is', null)
    .or(`last_generation_at.lt.${fourteenDaysAgo},and(last_generation_at.is.null,created_at.lt.${fourteenDaysAgo})`);

  let processed = 0;

  for (const user of inactiveUsers || []) {
    const res = await fetch('https://app.loops.so/api/v1/events/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('LOOPS_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: user.email,
        eventName: 'user_inactive_14_days',
      }),
    });

    if (res.ok) {
      await supabase
        .from('licenses')
        .update({ reengagement_sent: true })
        .eq('email', user.email);
      processed++;
    }
  }

  return new Response(
    JSON.stringify({ processed, total: (inactiveUsers || []).length }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
