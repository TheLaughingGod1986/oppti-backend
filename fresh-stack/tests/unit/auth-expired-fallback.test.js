process.env.JWT_SECRET = 'regression-jwt-secret';
const jwt = require('jsonwebtoken');
jest.mock('../../lib/logger', () => ({ debug: jest.fn(), warn: jest.fn(), info: jest.fn() }));
const logger = require('../../lib/logger');
const { authMiddleware } = require('../../middleware/auth');

const active = { id: 'account-1', license_key: 'valid-key', status: 'active', plan: 'free' };
function database() {
  return { from: (table) => ({ select: () => ({ eq: (column, value) => ({
    single: async () => ({ data: table === 'licenses' && ['valid-key', 'account-1'].includes(value) ? active : null, error: null }),
    maybeSingle: async () => ({ data: table === 'sites' && ['secret-site-key', 'https://known-account.example'].includes(value) ? { status: 'active', license_key: 'valid-key' } : null, error: null })
  }) }) }) };
}
async function request(headers) {
  const req = { path: '/api/alt-text', method: 'POST', body: {}, header: name => headers[name] || null };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await authMiddleware({ supabase: database() })(req, res, next);
  return { req, res, next };
}
const expired = () => jwt.sign({ user_id: 'account-1' }, process.env.JWT_SECRET, { expiresIn: -60 });
beforeEach(() => { jest.clearAllMocks(); delete process.env.ALT_API_TOKEN; delete process.env.API_TOKEN; });

test.each([
  ['license', { 'X-License-Key': 'valid-key' }],
  ['site', { 'X-Site-Key': 'secret-site-key' }],
  ['api_token', { 'X-API-Key': 'secret-api-key' }]
])('expired JWT independently validates %s fallback', async (method, headers) => {
  process.env.ALT_API_TOKEN = 'secret-api-key';
  const { req, next } = await request({ Authorization: `Bearer ${expired()}`, ...headers });
  expect(next).toHaveBeenCalledTimes(1);
  expect(req.authMethod).toBe(method);
  expect(logger.debug).toHaveBeenCalledWith('[Auth] Expired JWT; trying independent credentials', expect.objectContaining({ reason: 'expired' }));
});

test.each([{}, { 'X-License-Key': 'invalid-key' }, { 'X-Site-Key': 'invalid-site-key' }, { 'X-API-Key': 'invalid-api-key' }])('expired JWT never authenticates without valid fallback: %j', async headers => {
  const { req, res, next } = await request({ Authorization: `Bearer ${expired()}`, 'X-Trial-Mode': 'true', ...headers });
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(401);
  expect(req.trialMode).toBeUndefined();
});

test('public URL alone does not suppress JWT validation warning', async () => {
  const { next } = await request({ Authorization: `Bearer ${expired()}`, 'X-Site-URL': 'https://public.example' });
  expect(next).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith('[Auth] JWT validation failed', expect.objectContaining({ fallback_present: false }));
});

test('invalid signature remains a warning even with independently valid credentials', async () => {
  const token = jwt.sign({ user_id: 'account-1' }, 'wrong-secret');
  const { req } = await request({ Authorization: `Bearer ${token}`, 'X-License-Key': 'valid-key' });
  expect(req.authMethod).toBe('license');
  expect(logger.warn).toHaveBeenCalledWith('[Auth] JWT validation failed', expect.objectContaining({ reason: 'invalid' }));
});

test('valid JWT authenticates active account', async () => {
  const { req, next } = await request({ Authorization: `Bearer ${jwt.sign({ user_id: 'account-1' }, process.env.JWT_SECRET)}` });
  expect(next).toHaveBeenCalledTimes(1);
  expect(req.authMethod).toBe('jwt');
});


test('expired bearer without fallback returns a terminal sign-in error, not invalid licence', async () => {
  const { res } = await request({ Authorization: `Bearer ${expired()}` });
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'JWT_EXPIRED', retryable: false }));
});


test.each([
  { 'X-Site-URL': 'https://known-account.example' },
  { 'X-Site-URL': 'https://known-account.example', 'X-Site-Key': 'guessed-site-key' }
])('public site URL never authenticates an account or rescues guessed credentials: %j', async headers => {
  const { next, res } = await request(headers);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(401);
});
