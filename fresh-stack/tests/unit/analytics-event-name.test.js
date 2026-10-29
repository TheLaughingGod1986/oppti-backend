const express = require('express');
const request = require('supertest');
const logger = require('../../lib/logger');
const { createAnalyticsRouter, isValidEventName } = require('../../routes/analytics');

const EMAIL = 'qa-person@example.invalid';

function makeApp(capture) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'acct-1' }; next(); });
  app.use('/analytics', createAnalyticsRouter({ capture }));
  return app;
}

describe('/analytics/event name check', () => {
  let spies;
  beforeEach(() => {
    spies = ['warn', 'info', 'debug', 'error'].map((level) => jest.spyOn(logger, level).mockImplementation(() => {}));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));
  const allCalls = () => spies.flatMap((spy) => spy.mock.calls);

  const longName = `a${'b'.repeat(64)}`; // 65 characters
  test.each([
    [`signup ${EMAIL}`],
    ['$identify'],
    ['$set'],
    ['$pageview'],
    ['Signup'],
    [longName],
    ['signup-clicked'],
    ['1signup'],
    ['_signup'],
    ['signup.clicked'],
    [`signup_${'x'.repeat(10)}@example.invalid`]
  ])('rejects %s with 400, forwards nothing and never logs the name', async (name) => {
    const capture = jest.fn().mockResolvedValue({ ok: true });
    const res = await request(makeApp(capture)).post('/analytics/event').send({ event: name, properties: {} });
    expect(res.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
    const rejected = allCalls().filter(([m]) => m === '[analytics] rejected_event_name');
    expect(rejected).toHaveLength(1);
    expect(rejected[0][1]).toEqual({ route: 'analytics.event', reason: 'invalid_event_name', request_id: null });
    const logged = JSON.stringify(allCalls());
    expect(logged).not.toContain(name);
    expect(logged).not.toMatch(/example\.invalid|identify|\$set|\$pageview|Signup|bbbbbbbb/);
  });

  test.each([['dashboard_viewed'], ['cta_clicked'], ['a'], [`a${'b'.repeat(63)}`], ['step_2_done']])(
    'accepts %s and forwards it unchanged', async (name) => {
      const capture = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      const res = await request(makeApp(capture)).post('/analytics/event').send({ event: name });
      expect(res.status).toBe(200);
      expect(capture).toHaveBeenCalledWith(expect.objectContaining({ event: name, distinctId: 'acct-1' }));
      expect(allCalls().some(([m]) => m === '[analytics] rejected_event_name')).toBe(false);
    }
  );

  test('isValidEventName rejects non-strings', () => {
    expect(isValidEventName(null)).toBe(false);
    expect(isValidEventName(42)).toBe(false);
    expect(isValidEventName('')).toBe(false);
  });
});
