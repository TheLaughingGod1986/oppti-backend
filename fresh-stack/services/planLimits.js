const PLAN_LIMITS = {
  free: { credits: 50, dailyCredits: 5, maxSites: 1 },
  starter: { credits: 100, maxSites: 1 },
  pro: { credits: 1000, maxSites: 1 },
  agency: { credits: 10000, maxSites: null } // null = unlimited
};

function getLimits(plan = 'free') {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

module.exports = {
  getLimits,
  PLAN_LIMITS
};
