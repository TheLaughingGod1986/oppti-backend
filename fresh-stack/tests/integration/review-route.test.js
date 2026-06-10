const express = require('express');
const request = require('supertest');
const { authMiddleware } = require('../../middleware/auth');

jest.mock('../../lib/openai', () => ({
  reviewAltText: jest.fn()
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
  markImageAltStateApproved: jest.fn().mockResolvedValue({
    data: {
      id: 'image_state_1',
      image_ref: 'attachment:123',
      current_state: 'APPROVED'
    },
    error: null
  })
}));

const { reviewAltText } = require('../../lib/openai');
const imageAltStateService = require('../../services/imageAltState');
const { createReviewRouter } = require('../../routes/review');

function createChainableMock(resolveData = null, resolveError = null) {
  const chainable = {
    select: () => chainable,
    eq: () => chainable,
    single: () => Promise.resolve({ data: resolveData, error: resolveError }),
    maybeSingle: () => Promise.resolve({ data: resolveData, error: resolveError }),
    then: (resolve, reject) => Promise.resolve({ data: resolveData ? [resolveData] : [], error: resolveError }).then(resolve, reject)
  };

  return chainable;
}

function createSupabaseMock(licenseRow = null) {
  return {
    from(table) {
      if (table === 'licenses') {
        return createChainableMock(licenseRow);
      }

      return createChainableMock(null);
    }
  };
}

function createApp(supabase) {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware({ supabase }));
  app.use('/api/review', createReviewRouter({ supabase }));
  return app;
}

describe('POST /api/review', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reviewAltText.mockResolvedValue({
      score: 94,
      status: 'great',
      grade: 'Excellent',
      summary: 'Alt text accurately matches the image.',
      issues: [],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
    });
  });

  test('requires authenticated access', async () => {
    const app = createApp(createSupabaseMock());

    const res = await request(app)
      .post('/api/review')
      .send({
        alt_text: 'A person at a desk',
        image_data: { url: 'https://example.com/image.jpg', width: 100, height: 100 }
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_LICENSE');
    expect(reviewAltText).not.toHaveBeenCalled();
  });

  test('supports the legacy review request body', async () => {
    const app = createApp(createSupabaseMock({
      id: 'license_123',
      license_key: 'key-123',
      plan: 'pro',
      status: 'active'
    }));

    const res = await request(app)
      .post('/api/review')
      .set('X-License-Key', 'key-123')
      .send({
        alt_text: 'Golden retriever running through a park',
        image_data: {
          url: 'https://example.com/dog.jpg',
          width: 1200,
          height: 800,
          filename: 'dog.jpg'
        },
        context: {
          post_title: 'Dog gallery'
        }
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.review).toEqual(expect.objectContaining({
      score: 94,
      status: 'great'
    }));
    expect(res.body.tokens).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20
    });
    expect(reviewAltText).toHaveBeenCalledWith(expect.objectContaining({
      altText: 'Golden retriever running through a park',
      context: { post_title: 'Dog gallery' },
      service: 'alttext-ai'
    }));
  });

  test('returns a null review when the caller omits image payload', async () => {
    const app = createApp(createSupabaseMock({
      id: 'license_123',
      license_key: 'key-123',
      plan: 'pro',
      status: 'active'
    }));

    const res = await request(app)
      .post('/api/review')
      .set('X-License-Key', 'key-123')
      .send({
        alt_text: 'Golden retriever running through a park'
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      review: null,
      tokens: null
    });
    expect(reviewAltText).not.toHaveBeenCalled();
  });

  test('POST /api/review/approve marks an image state approved', async () => {
    const app = createApp(createSupabaseMock({
      id: 'license_123',
      license_key: 'key-123',
      plan: 'pro',
      status: 'active'
    }));

    const res = await request(app)
      .post('/api/review/approve')
      .set('X-License-Key', 'key-123')
      .set('X-Site-Key', 'site-hash-1')
      .send({
        attachment_id: 123,
        alt_text: 'Approved alt text'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.state).toEqual(expect.objectContaining({
      current_state: 'APPROVED',
      image_ref: 'attachment:123'
    }));
    expect(imageAltStateService.resolveImageAltStateSiteContext).toHaveBeenCalled();
    expect(imageAltStateService.markImageAltStateApproved).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      siteId: 'site_1',
      altText: 'Approved alt text',
      body: expect.objectContaining({
        attachment_id: 123
      })
    }));
  });
});
