const logger = require('../lib/logger');
const { recordPluginConnection } = require('./pluginConnections');
const { trackPluginConnected } = require('../../src/services/loops');

const PLUGIN_ID = 'internal_linking';

/**
 * Internal Linking has no sign-up or login screen: it only ever authenticates
 * with an OpptiAI license key an administrator opted in to reuse from Titles
 * or Alt Text (and only after opting in to remote AI). So the first successful
 * licensed call is the moment this account starts using Internal Linking.
 *
 * Records account_plugin_connections(plugin_id='internal_linking') and, on the
 * first connection, updates the Loops contact (usesInternalLinking, version,
 * lastActivePlugin) and sends plugin_connected. Loops' skip list
 * (isLoopsSkippedEmail) is enforced inside src/services/loops.js.
 *
 * Never throws and never blocks the request outcome.
 */
async function recordInternalLinkingConnection(supabase, { account, pluginVersion, requestId } = {}) {
  const accountId = account?.id || null;
  if (!supabase || !accountId) return { recorded: false, isFirstConnection: false };

  try {
    const connection = await recordPluginConnection(supabase, {
      accountId,
      pluginId: PLUGIN_ID,
      pluginVersion: pluginVersion || null
    });
    if (connection.error) {
      logger.warn('[internal-linking] plugin_connection_state_failed', {
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
          emitEvent: true
        });
      } catch (error) {
        logger.warn('[internal-linking] plugin_connected_loops_failed', {
          account_id: accountId,
          request_id: requestId || null,
          error: error.message
        });
      }
    }
    return { recorded: true, isFirstConnection: connection.isFirstConnection };
  } catch (error) {
    logger.warn('[internal-linking] plugin_connection_failed', {
      account_id: accountId,
      request_id: requestId || null,
      error: error.message
    });
    return { recorded: false, isFirstConnection: false };
  }
}

module.exports = { recordInternalLinkingConnection, INTERNAL_LINKING_PLUGIN_ID: PLUGIN_ID };
