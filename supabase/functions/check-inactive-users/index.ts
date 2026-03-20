import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (_req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data: inactiveUsers } = await supabase
    .from('licenses')
    .select('email, last_generation_at')
    .lt('last_generation_at', fourteenDaysAgo)
    .eq('reengagement_sent', false)
    .eq('plan', 'free');

  for (const user of inactiveUsers || []) {
    await fetch('https://app.loops.so/api/v1/events/send', {
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

    await supabase
      .from('licenses')
      .update({ reengagement_sent: true })
      .eq('email', user.email);
  }

  return new Response(
    JSON.stringify({ processed: (inactiveUsers || []).length }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
