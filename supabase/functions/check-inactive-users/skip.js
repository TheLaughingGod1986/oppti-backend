// QA/test account email domains that must never reach Loops.
// Copy of DEFAULT_LOOPS_SKIP_DOMAINS in src/services/loops.js (edge functions
// cannot import it). fresh-stack/tests/unit/loops-skip-drift.test.js fails if
// the two lists differ. LOOPS_SKIP_DOMAINS replaces it when set, even to ''.
export const DEFAULT_LOOPS_SKIP_DOMAINS = 'example.invalid,maxxspace.com,uberip.com,qa.oppti.dev';

export function getSkipDomains(envValue) {
  const raw = envValue === undefined || envValue === null ? DEFAULT_LOOPS_SKIP_DOMAINS : String(envValue);
  return raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

export function isLoopsSkippedEmail(email, envValue) {
  if (!email || typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return !!domain && getSkipDomains(envValue).includes(domain);
}
