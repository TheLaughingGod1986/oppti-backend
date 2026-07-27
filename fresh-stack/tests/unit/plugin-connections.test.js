const { recordPluginConnection } = require('../../services/pluginConnections');

function createSupabase(existing = null) {
  const inserted = [];
  const updated = [];
  return {
    inserted,
    updated,
    from() {
      return {
        select() {
          const chain = {
            eq() { return chain; },
            maybeSingle: async () => ({ data: existing, error: null })
          };
          return chain;
        },
        insert: async (payload) => {
          inserted.push(payload);
          return { error: null };
        },
        update(payload) {
          updated.push(payload);
          return { eq: async () => ({ error: null }) };
        }
      };
    }
  };
}

describe('plugin connection state', () => {
  test('marks a new account/plugin pair as the first connection', async () => {
    const supabase = createSupabase();
    const result = await recordPluginConnection(supabase, {
      accountId: 'account-1',
      pluginId: 'titles',
      pluginVersion: '1.0.0'
    });
    expect(result).toEqual({ isFirstConnection: true, error: null });
    expect(supabase.inserted).toHaveLength(1);
  });

  test('updates an existing connection without treating it as new', async () => {
    const supabase = createSupabase({ id: 'connection-1' });
    const result = await recordPluginConnection(supabase, {
      accountId: 'account-1',
      pluginId: 'titles',
      pluginVersion: '1.1.0'
    });
    expect(result).toEqual({ isFirstConnection: false, error: null });
    expect(supabase.updated).toHaveLength(1);
    expect(supabase.inserted).toHaveLength(0);
  });
});
