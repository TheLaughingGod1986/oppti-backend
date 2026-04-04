const Redis = require('ioredis');
const logger = require('./logger');

let client = null;

function getRedis() {
  if (client) return client;
  const url = process.env.REDIS_URL || process.env.REDIS_CONNECTION;
  if (!url) return null;
  client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
    connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5000),
    commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 4000)
  });
  client.on('error', (err) => {
    logger.error('[redis] error', err.message);
  });
  client.connect().catch(err => {
    logger.error('[redis] failed to connect', err.message);
  });
  return client;
}

module.exports = { getRedis };
