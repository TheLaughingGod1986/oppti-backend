function getPostHogConfig() {
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST;

  return {
    apiKey,
    host: host ? host.replace(/\/+$/, '') : null
  };
}

// Site URLs and hostnames are not sent to PostHog. Analytics identity is the
// pseudonymous install id only (rule 7 of docs/analytics/operating-report.md).
const SITE_IDENTIFIER_KEYS = [
  'site_url',
  'siteUrl',
  'site_host',
  'siteHost',
  'host',
  'domain',
  'canonical_domain',
  'website',
  'home_url',
  'page_url',
  'image_url'
];

// Personal data and full URLs are never sent either, whichever caller sets them.
const PERSONAL_KEYS = [
  'email',
  'license_key',
  'licenseKey',
  'referrer',
  'landing_page',
  'source_page',
  'signup_source_other'
];
// Person profiles additionally never get a name or address.
const PERSON_ONLY_KEYS = ['name', 'first_name', 'last_name', 'full_name', 'address', 'phone'];
const PERSON_KEYS = ['$set', '$set_once'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Values must be flat: scalars, null or arrays of scalars. Nested objects
// (where unchecked keys such as meta.site_url could hide) are dropped.
function isFlatValue(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  return Array.isArray(value) && value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
}

function cleanFlat(object, blockedKeys) {
  const cleaned = {};
  for (const [key, value] of Object.entries(object)) {
    if (blockedKeys.includes(key) || value === undefined || !isFlatValue(value)) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function stripSiteIdentifiers(properties = {}) {
  if (!isPlainObject(properties)) {
    return properties;
  }

  const blocked = [...SITE_IDENTIFIER_KEYS, ...PERSONAL_KEYS];
  const cleaned = cleanFlat(
    Object.fromEntries(Object.entries(properties).filter(([key]) => !PERSON_KEYS.includes(key))),
    blocked
  );

  for (const personKey of PERSON_KEYS) {
    if (isPlainObject(properties[personKey])) {
      const person = cleanFlat(properties[personKey], [...blocked, ...PERSON_ONLY_KEYS]);
      if (Object.keys(person).length) {
        cleaned[personKey] = person;
      }
    }
  }

  return cleaned;
}

async function sendPostHogRequest({ path, payload }) {
  const { apiKey, host } = getPostHogConfig();

  if (!apiKey || !host || !path || !payload) {
    return { ok: false, skipped: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`${host}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: apiKey,
        ...payload
      }),
      signal: controller.signal
    });

    return {
      ok: response.ok,
      status: response.status
    };
  } catch (error) {
    return {
      ok: false,
      error
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function captureServerEvent({ event, distinctId, properties = {} }) {
  if (!event || !distinctId) {
    return { ok: false, skipped: true };
  }

  return sendPostHogRequest({
    path: '/capture/',
    payload: {
      event,
      distinct_id: distinctId,
      properties: stripSiteIdentifiers(properties)
    }
  });
}

async function identifyServerUser({ distinctId, properties = {} }) {
  if (!distinctId) {
    return { ok: false, skipped: true };
  }

  return sendPostHogRequest({
    path: '/identify/',
    payload: {
      distinct_id: distinctId,
      properties: stripSiteIdentifiers(properties)
    }
  });
}

async function aliasServerUser({ distinctId, alias }) {
  if (!distinctId || !alias || distinctId === alias) {
    return { ok: false, skipped: true };
  }

  return sendPostHogRequest({
    path: '/capture/',
    payload: {
      event: '$create_alias',
      distinct_id: distinctId,
      properties: {
        alias
      }
    }
  });
}

module.exports = {
  captureServerEvent,
  identifyServerUser,
  aliasServerUser,
  getPostHogConfig,
  stripSiteIdentifiers,
  SITE_IDENTIFIER_KEYS
};
