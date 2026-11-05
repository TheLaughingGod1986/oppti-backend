const logger = require('../lib/logger');
const { recordPluginConnection } = require('./pluginConnections');
const { trackPluginConnected } = require('../../src/services/loops');
const { isProductEmailsOptedOut } = require('../lib/productEmailOptOut');

const PLUGIN_ID = 'content_refresh';

/**
 * Content Refresh authenticates with an OpptiAI license key (often adopted from
 * a sibling plugin). The first successful licensed call is the moment this
 * account starts using Content Refresh.
 *
 * Records account_plugin_connections(plugin_id='content_refresh') and, on the
 * first connection, updates the Loops contact. Never throws.
 */
async function recordContentRefreshConnection(supabase, { account, pluginVersion, requestId } = {}) {
  const accountId = account?.id || null;
  if (!supabase || !accountId) return { recorded: false, isFirstConnection: false };

  try {
    const connection = await recordPluginConnection(supabase, {
      accountId,
      pluginId: PLUGIN_ID,
      pluginVersion: pluginVersion || null
    });
    if (connection.error) {
      logger.warn('[content-refresh] plugin_connection_state_failed', {
        account_id: accountId,
        request_id: requestId || null,
        error: connection.error.message || String(connection.error)
      });
      return { recorded: false, isFirstConnection: false };
    }

    const email = typeof account.email === 'string' ? account.email : '';
    if (connection.isFirstConnection && email && process.env.LOOPS_API_KEY) {
      try {
        await trackPluginConnected({
          email,
          userId: accountId,
          pluginId: PLUGIN_ID,
          pluginVersion,
          emitEvent: true,
          productEmailsOptOut: isProductEmailsOptedOut(account)
        });
      } catch (error) {
        logger.warn('[content-refresh] plugin_connected_loops_failed', {
          account_id: accountId,
          request_id: requestId || null,
          error: error.message
        });
      }
    }
    return { recorded: true, isFirstConnection: connection.isFirstConnection };
  } catch (error) {
    logger.warn('[content-refresh] plugin_connection_failed', {
      account_id: accountId,
      request_id: requestId || null,
      error: error.message
    });
    return { recorded: false, isFirstConnection: false };
  }
}

module.exports = { recordContentRefreshConnection, CONTENT_REFRESH_PLUGIN_ID: PLUGIN_ID };
