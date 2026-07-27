const SERVICE95_HOSTS = new Set(['service95.com', 'www.service95.com']);

const NON_STORY_PATH_PREFIXES = [
  '/privacy-policy',
  '/terms',
  '/thank-you',
  '/unsubscribe',
  '/preferences',
  '/login',
  '/signup',
];

function normalizePagePath(url) {
  if (!url || typeof url !== 'string') return '';

  const trimmed = url.trim();
  if (!trimmed || /^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed)) return '';

  try {
    const parsed = new URL(trimmed);
    if (!SERVICE95_HOSTS.has(parsed.hostname.toLowerCase())) return '';

    let pathname = parsed.pathname || '/';
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    return pathname.toLowerCase();
  } catch {
    return '';
  }
}

function isStoryUrl(url) {
  const pagePath = normalizePagePath(url);
  if (!pagePath || pagePath === '/') return false;
  return !NON_STORY_PATH_PREFIXES.some((prefix) => pagePath.startsWith(prefix));
}

module.exports = {
  normalizePagePath,
  isStoryUrl,
  NON_STORY_PATH_PREFIXES,
  SERVICE95_HOSTS,
};
