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

function stripSiteIdentifiers(properties = {}) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return properties;
  }

  const cleaned = { ...properties };
  for (const key of SITE_IDENTIFIER_KEYS) {
    delete cleaned[key];
  }

  for (const personKey of ['$set', '$set_once']) {
    if (cleaned[personKey] && typeof cleaned[personKey] === 'object') {
      const person = { ...cleaned[personKey] };
      for (const key of SITE_IDENTIFIER_KEYS) {
        delete person[key];
      }
      if (Object.keys(person).length) {
        cleaned[personKey] = person;
      } else {
        delete cleaned[personKey];
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
