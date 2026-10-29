const express = require('express');
const request = require('supertest');

jest.mock('../../services/quota', () => ({
  getQuotaStatus: jest.fn()
}));

jest.mock('../../services/imageAltState', () => ({
  resolveImageAltStateSiteContext: jest.fn().mockResolvedValue({
    site: {
      id: 'site_1',
      site_hash: 'site-hash-1'
    },
    siteIdentity: {
      siteHash: 'site-hash-1',
      siteUrl: 'https://example.com'
    },
    error: null
  }),
  syncImageAltStates: jest.fn().mockResolvedValue({
    count: 3,
    inserted: 3,
    updated: 0,
    unchanged: 0,
    missing_rows_created: 1,
    duplicate_input_rows: 0,
    orphaned_existing_rows: 0,
    dashboard_counts: {
      missing: 1,
      to_review: 1,
      optimized: 1,
      total_attention: 2
    },
    coverage: {
      status: 'AUTHORITATIVE_LEDGER',
      snapshot_fallback_active: false,
      state_counts: {
        missing: 1,
        generated: 0,
        needs_review: 1,
        approved: 1
      }
    },
    errors: []
  })
}));

const imageAltStateService = require('../../services/imageAltState');
const { createDashboardRouter } = require('../../routes/dashboard');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.license = {
      id: 'license_1',
      license_key: 'key-123',
      status: 'active',
      plan: 'pro'
    };
    req.user = req.license;
    req.authMethod = 'license';
    req.id = 'req-dashboard-sync';
    next();
  });
  app.use('/dashboard', createDashboardRouter({ supabase: { from: jest.fn() } }));
  return app;
}

describe('POST /dashboard/image-states/sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('syncs authoritative image states for a linked site', async () => {
    const app = createApp();
    const images = [
      { attachment_id: 101, current_state: 'MISSING', image_url: 'https://example.com/1.jpg' },
      { attachment_id: 102, current_state: 'NEEDS_REVIEW', image_url: 'https://example.com/2.jpg' },
      { attachment_id: 103, current_state: 'APPROVED', image_url: 'https://example.com/3.jpg' }
    ];

    const res = await request(app)
      .post('/dashboard/image-states/sync')
      .set('X-License-Key', 'key-123')
      .set('X-Site-Key', 'site-hash-1')
      .send({ images });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        site_id: 'site_1',
        site_hash: 'site-hash-1',
        updated: 0,
        inserted: 3,
        changed: 3,
        unchanged: 0,
        missing_rows_created: 1,
        duplicate_input_rows: 0,
        orphaned_existing_rows: 0,
        counts_by_state: {
          missing: 1,
          generated: 0,
          needs_review: 1,
          approved: 1
        },
        dashboard_counts: {
          missing: 1,
          to_review: 1,
          optimized: 1,
          total_attention: 2
        },
        coverage: {
          status: 'AUTHORITATIVE_LEDGER',
          snapshot_fallback_active: false,
          state_counts: {
            missing: 1,
            generated: 0,
            needs_review: 1,
            approved: 1
          }
        },
        errors: []
      }
    });
    expect(imageAltStateService.resolveImageAltStateSiteContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'req-dashboard-sync'
      }),
      { createIfMissing: true }
    );
    expect(imageAltStateService.syncImageAltStates).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        siteId: 'site_1',
        siteHash: 'site-hash-1',
        images,
        requestId: 'req-dashboard-sync',
        scope: 'full_site',
        allowDowngrade: false
      })
    );
  });

  test('accepts legacy items payloads from bootstrap sync clients', async () => {
    const app = createApp();
    const items = [
      { attachment_id: 201, current_state: 'MISSING', image_url: 'https://example.com/a.jpg' },
      { attachment_id: 202, current_state: 'APPROVED', image_url: 'https://example.com/b.jpg' }
    ];

    await request(app)
      .post('/dashboard/image-states/sync')
      .set('X-License-Key', 'key-123')
      .set('X-Site-Key', 'site-hash-1')
      .send({ items });

    expect(imageAltStateService.syncImageAltStates).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        siteId: 'site_1',
        siteHash: 'site-hash-1',
        images: items,
        requestId: 'req-dashboard-sync',
        scope: 'full_site',
        allowDowngrade: false
      })
    );
  });
});

describe('image state sync lines: no raw site key', () => {
  const logger = require('../../lib/logger');
  const { expectNoCredentialSlices } = require('../helpers/credentialSlices');
  const RAW_SITE_KEY = 'qa-raw-site-key-secret-0001';
  let spies;
  beforeEach(() => {
    spies = ['warn', 'info', 'debug', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));
  const calls = () => spies.flatMap((spy) => spy.mock.calls);

  test('received and site-resolution-failed lines log has_site_key, never the sent key', async () => {
    imageAltStateService.resolveImageAltStateSiteContext.mockResolvedValueOnce({ site: null, siteIdentity: null, error: 'SITE_NOT_FOUND' });
    await request(createApp())
      .post('/dashboard/image-states/sync')
      .set('X-License-Key', 'key-123')
      .set('X-Site-Key', RAW_SITE_KEY)
      .send({ images: [{ attachment_id: 101, current_state: 'MISSING', image_url: 'https://example.com/1.jpg' }] });
    for (const message of ['[dashboard] image_state_sync_received', '[dashboard] image_state_sync_site_resolution_failed']) {
      const found = calls().filter(([m]) => m === message);
      expect(found.length).toBe(1);
      expect(found[0][1]).toEqual(expect.objectContaining({ has_site_key: true }));
      expect(found[0][1]).not.toHaveProperty('request_site_hash');
    }
    expectNoCredentialSlices(calls(), [RAW_SITE_KEY]);
  });
});
