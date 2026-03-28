const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'POSTHOG_API_KEY',
  'POSTHOG_HOST',
  'ALTTEXT_AI_STRIPE_PRICE_PRO',
  'ALTTEXT_AI_STRIPE_PRICE_AGENCY',
  'ALTTEXT_AI_STRIPE_PRICE_CREDITS',
  'ALLOWED_ORIGINS',
  'PORT',
  'JWT_SECRET'
];

const REQUIRED_ENV_GROUPS = [
  ['OPENAI_API_KEY', 'ALTTEXT_OPENAI_API_KEY']
];

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function isDevelopment() {
  return process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
}

function isTest() {
  return process.env.NODE_ENV === 'test';
}

function getEnv(key, defaultValue = null) {
  const value = process.env[key];
  return value === undefined || value === '' ? defaultValue : value;
}

function requireEnv(key) {
  const value = getEnv(key);
  if (value === null) {
    throw new Error(`[config] Missing env var: ${key}`);
  }
  return value;
}

function getMissingEnv({
  required = REQUIRED_ENV_VARS,
  requiredGroups = REQUIRED_ENV_GROUPS
} = {}) {
  const missing = required.filter((key) => !getEnv(key));

  for (const group of requiredGroups) {
    const hasAny = group.some((key) => Boolean(getEnv(key)));
    if (!hasAny) {
      missing.push(group.join(' or '));
    }
  }

  return missing;
}

function validateEnv(options = {}) {
  if (isTest() || process.env.SKIP_ENV_VALIDATION === 'true') {
    return process.env;
  }

  const missing = getMissingEnv(options);
  if (missing.length) {
    throw new Error(`[config] Missing env vars: ${missing.join(', ')}`);
  }

  return process.env;
}

if (!isTest() && process.env.SKIP_ENV_VALIDATION !== 'true') {
  const missing = getMissingEnv();
  if (missing.length) {
    console.error('[config] Missing env vars:', missing.join(', '));
    process.exit(1);
  }
}

module.exports = {
  env: process.env,
  REQUIRED_ENV_VARS,
  REQUIRED_ENV_GROUPS,
  getEnv,
  requireEnv,
  getMissingEnv,
  validateEnv,
  isProduction,
  isDevelopment,
  isTest
};
