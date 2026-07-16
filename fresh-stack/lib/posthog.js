function getPostHogConfig() {
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST;

  return {
    apiKey,
    host: host ? host.replace(/\/+$/, '') : null
  };
}

function withWebsitePersonProperties(properties = {}) {
  const domain = typeof properties.domain === 'string' ? properties.domain.trim() : '';
  if (!domain) return properties;

  return {
    ...properties,
    $set: {
      name: domain,
      website: properties.site_url || domain,
      ...(properties.$set || {})
    }
  };
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
      properties: withWebsitePersonProperties(properties)
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
      properties
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
  withWebsitePersonProperties
};
