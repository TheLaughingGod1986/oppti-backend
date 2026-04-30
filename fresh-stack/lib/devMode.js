/**
 * Dev-mode detection and mock data helpers.
 * ALL code in this file is a no-op in production.
 * Activated only when NODE_ENV === 'development' or ALLOW_DEV_SITE_QUOTA === 'true'.
 */

function isDevMode() {
  return (
    process.env.NODE_ENV === 'development'
    || process.env.ALLOW_DEV_SITE_QUOTA === 'true'
  );
}

// TASK 3: single-source mock usage for dev
const DEV_USAGE_MOCK = {
  used: 12,
  limit: 50,
  remaining: 38,
  plan: 'free_dev'
};

// TASK 4: filter hook — replace this function to tweak dev usage without editing core
function applyDevUsageOverride(usage) {
  return usage;
}

module.exports = { isDevMode, DEV_USAGE_MOCK, applyDevUsageOverride };
