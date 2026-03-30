#!/usr/bin/env node

const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const PLAN_DEFAULTS = {
  free: { monthlyIncludedCredits: 50, billingInterval: 'month', isPaid: false },
  pro: { monthlyIncludedCredits: 1000, billingInterval: 'month', isPaid: true },
  agency: { monthlyIncludedCredits: 10000, billingInterval: 'month', isPaid: true },
  credits: { monthlyIncludedCredits: 0, billingInterval: 'one_time', isPaid: false }
};

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function createSupabase() {
  return createClient(
    getRequiredEnv('SUPABASE_URL'),
    getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function getArgValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

function normalizePlan(plan) {
  if (!plan) return 'free';
  const normalized = String(plan).trim().toLowerCase();
  if (!normalized) return 'free';
  if (normalized === 'growth') return 'pro';
  return normalized;
}

function getPlanDefaults(plan) {
  return PLAN_DEFAULTS[normalizePlan(plan)] || PLAN_DEFAULTS.free;
}

function inferLegacyBillingInterval(subscription = {}) {
  if (subscription.billing_interval) return subscription.billing_interval;
  const start = subscription.current_period_start ? new Date(subscription.current_period_start) : null;
  const end = subscription.current_period_end ? new Date(subscription.current_period_end) : null;
  if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
    const diffDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays >= 330) return 'year';
    if (diffDays >= 25) return 'month';
  }
  return getPlanDefaults(subscription.plan).billingInterval;
}

function currentMonthlyWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function summarizeGroups(groups) {
  return Object.entries(groups)
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({
      key,
      count: rows.length,
      siteIds: rows.map((row) => row.id),
      licenseKeys: [...new Set(rows.map((row) => row.license_key).filter(Boolean))]
    }))
    .sort((left, right) => right.count - left.count);
}

module.exports = {
  createSupabase,
  currentMonthlyWindow,
  getArgValue,
  getPlanDefaults,
  hasFlag,
  inferLegacyBillingInterval,
  normalizePlan,
  summarizeGroups
};
