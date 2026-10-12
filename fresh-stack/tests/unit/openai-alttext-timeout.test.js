jest.mock('axios', () => ({ post: jest.fn() }));
const axios = require('axios');
const { generateAltText, altTextCallTimeout, ALT_TEXT_TOTAL_BUDGET_MS } = require('../../lib/openai');
const { DEFAULT_CLAIM_TTL_MS } = require('../../services/idempotencyClaims');

const okResp = { data: { choices: [{ message: { content: 'A red bicycle leaning on a brick wall' } }], usage: { total_tokens: 3 } } };

beforeEach(() => { jest.clearAllMocks(); process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key'; });

test('total provider budget is ~90s, under the claim TTL', () => {
  expect(ALT_TEXT_TOTAL_BUDGET_MS).toBe(90000);
  expect(ALT_TEXT_TOTAL_BUDGET_MS).toBeLessThan(DEFAULT_CLAIM_TTL_MS);
});

test('per-call timeout shrinks so primary + fallback never exceed the budget', () => {
  const t0 = 1_000_000;
  expect(altTextCallTimeout(t0, t0)).toBe(60000);
  expect(altTextCallTimeout(t0, t0 + 60000)).toBe(30000);
  expect(altTextCallTimeout(t0, t0 + 89900)).toBe(1000);
});

test('primary call passes a timeout <= 60s', async () => {
  axios.post.mockResolvedValue(okResp);
  await generateAltText({ image: { base64: 'aGVsbG8=', mime_type: 'image/png' }, context: {} });
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(axios.post.mock.calls[0][2].timeout).toBeLessThanOrEqual(60000);
});

test('model-missing fallback gets only the remaining budget', async () => {
  const realNow = Date.now;
  let t = 5_000_000;
  Date.now = () => t;
  try {
    axios.post
      .mockImplementationOnce(async () => { t += 59000; const e = new Error('x'); e.response = { status: 404, data: { error: { message: 'The model `gpt-4o` does not exist' } } }; throw e; })
      .mockResolvedValueOnce(okResp);
    await generateAltText({ image: { base64: 'aGVsbG8=', mime_type: 'image/png' }, context: {} });
    const [first, second] = axios.post.mock.calls.map((c) => c[2].timeout);
    expect(first + second).toBeLessThanOrEqual(ALT_TEXT_TOTAL_BUDGET_MS + 1000);
    expect(second).toBeLessThanOrEqual(31000);
  } finally { Date.now = realNow; }
});
