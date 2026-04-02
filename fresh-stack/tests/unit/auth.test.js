const { authMiddleware } = require('../../middleware/auth');

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function createSupabaseMock(licenseRow = null) {
  return {
    from: (table) => {
      if (table !== 'licenses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: null, error: null })
            })
          })
        };
      }

      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: licenseRow,
              error: licenseRow ? null : new Error('not found')
            })
          })
        })
      };
    }
  };
}

describe('auth middleware', () => {
  test('rejects missing license and api token', async () => {
    const supabase = {};
    const mw = authMiddleware({ supabase });
    const req = { header: () => null };
    const res = createRes();
    await mw(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  test('prefers real auth over trial headers', async () => {
    const supabase = createSupabaseMock({
      id: 'lic-1',
      license_key: 'key-123',
      plan: 'pro',
      status: 'active'
    });
    const mw = authMiddleware({ supabase });
    const req = {
      header: (name) => {
        if (name === 'X-License-Key') return 'key-123';
        if (name === 'X-Trial-Mode') return 'true';
        if (name === 'X-Trial-Site-Hash') return 'trial-site';
        if (name === 'Authorization') return null;
        if (name === 'X-API-Key') return null;
        return null;
      }
    };
    const res = createRes();
    let nextCalled = false;

    await mw(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(req.trialMode).toBeUndefined();
    expect(req.authMethod).toBe('license');
    expect(req.license.license_key).toBe('key-123');
  });

  test('still allows anonymous trial requests', async () => {
    const supabase = createSupabaseMock(null);
    const mw = authMiddleware({ supabase });
    const req = {
      path: '/api/alt-text',
      header: (name) => {
        if (name === 'X-Trial-Mode') return 'true';
        if (name === 'X-Trial-Site-Hash') return 'trial-site';
        return null;
      }
    };
    const res = createRes();
    let nextCalled = false;

    await mw(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(req.trialMode).toBe(true);
    expect(req.trialSiteHash).toBe('trial-site');
    expect(req.authMethod).toBe('trial');
  });

  test('allows anonymous dashboard trial requests with persistent anon id', async () => {
    const supabase = createSupabaseMock(null);
    const mw = authMiddleware({ supabase });
    const req = {
      path: '/api/alt-text',
      body: { anon_id: 'Anon-ABC-123' },
      header: (name) => {
        if (name === 'X-Site-Key') return 'trial-site';
        return null;
      }
    };
    const res = createRes();
    let nextCalled = false;

    await mw(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.trialMode).toBe(true);
    expect(req.trialSiteHash).toBe('trial-site');
    expect(req.anonId).toBe('anon-abc-123');
    expect(req.anonymous).toEqual(expect.objectContaining({
      anonId: 'anon-abc-123'
    }));
  });
});
