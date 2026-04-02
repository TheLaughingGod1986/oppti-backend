function ts() {
  return new Date().toISOString();
}

const RECENT_ENTRY_LIMIT = Math.max(10, Number(process.env.RECENT_LOG_BUFFER_SIZE || 100));
const recentEntries = [];

function truncateString(value, maxLength = 500) {
  if (typeof value !== 'string') return value;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function safeSerialize(value, depth = 0) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message),
      code: value.code || null
    };
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateString(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (depth >= 3) {
    return '[Truncated]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => safeSerialize(entry, depth + 1));
  }

  const serialized = {};
  for (const [key, entry] of Object.entries(value).slice(0, 25)) {
    serialized[key] = safeSerialize(entry, depth + 1);
  }
  return serialized;
}

function remember(level, args) {
  if (!['warn', 'error'].includes(level)) {
    return;
  }

  const message = args
    .filter((arg) => typeof arg === 'string')
    .join(' ')
    .trim() || '[no-message]';
  const context = args
    .filter((arg) => typeof arg !== 'string')
    .map((arg) => safeSerialize(arg));

  recentEntries.push({
    timestamp: ts(),
    level,
    message: truncateString(message),
    context
  });

  if (recentEntries.length > RECENT_ENTRY_LIMIT) {
    recentEntries.splice(0, recentEntries.length - RECENT_ENTRY_LIMIT);
  }
}

const logger = {
  info: (...args) => console.info(ts(), '[info]', ...args),
  warn: (...args) => {
    remember('warn', args);
    console.warn(ts(), '[warn]', ...args);
  },
  error: (...args) => {
    remember('error', args);
    console.error(ts(), '[error]', ...args);
  },
  debug: (...args) => {
    if (process.env.DEBUG) console.debug(ts(), '[debug]', ...args);
  },
  getRecentEntries: ({ levels = ['warn', 'error'], limit = 10 } = {}) => recentEntries
    .filter((entry) => levels.includes(entry.level))
    .slice(-limit)
    .reverse(),
  clearRecentEntries: () => {
    recentEntries.length = 0;
  }
};

module.exports = logger;
