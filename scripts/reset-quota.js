#!/usr/bin/env node
/**
 * Reset quota for testing - deletes quota_summaries for current period
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function resetQuota(licenseKey) {
  if (!licenseKey) {
    console.error('Usage: node reset-quota.js <license-key>');
    console.log('\nOr to reset for ALL licenses (use carefully):');
    console.log('  node reset-quota.js --all');
    process.exit(1);
  }

  try {
    if (licenseKey === '--all') {
      // Delete all quota summaries for current period
      const { data, error } = await supabase
        .from('quota_summaries')
        .delete()
        .gte('period_start', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());

      if (error) throw error;
      console.log('✅ All quota summaries for current period have been reset');
    } else {
      // Delete quota summary for specific license
      const { data, error } = await supabase
        .from('quota_summaries')
        .delete()
        .eq('license_key', licenseKey);

      if (error) throw error;
      console.log(`✅ Quota reset for license: ${licenseKey.substring(0, 8)}...`);
    }

    // Also optionally clear usage logs for testing
    const clearLogs = process.argv.includes('--clear-logs');
    if (clearLogs) {
      const { error: logsError } = await supabase
        .from('usage_logs')
        .delete()
        .eq('license_key', licenseKey === '--all' ? undefined : licenseKey)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()); // Last 24 hours

      if (logsError) throw logsError;
      console.log('✅ Usage logs for last 24 hours cleared');
    }

    console.log('\n✨ You can now test generation with a fresh quota!');
  } catch (err) {
    console.error('❌ Error resetting quota:', err.message);
    process.exit(1);
  }
}

const licenseKey = process.argv[2];
resetQuota(licenseKey);
