const { pluginTelemetryContext } = require('../../lib/pluginTelemetryContext');
const args = { pluginSlug: 'beepbeep-ai-alt-text-generator', product: 'alt_text', operationId: 'operation-a' };
const headers = { 'X-Telemetry-Consent': 'yes', 'X-Telemetry-Install-ID': 'random_install_123456', 'X-Environment': 'production' };
const request = extra => ({ user: { id: 'account-uuid' }, header: key => ({ ...headers, ...extra })[key] });
test.each([undefined, 'no', 'true', ''])('no explicit opt-in %s means no capture context', consent => expect(pluginTelemetryContext(request({ 'X-Telemetry-Consent': consent }), args)).toBeNull());
test.each(['https://private.example/page', 'person@example.com', 'short', undefined])('rejects non-install identity %s', install => expect(pluginTelemetryContext(request({ 'X-Telemetry-Install-ID': install }), args)).toBeNull());
test('standardizes attribution without exposing account identifiers or credentials', () => {
  const context = pluginTelemetryContext(request({}), args);
  expect(context).toMatchObject({ product: 'alt_text', telemetry_consent: true, site_install_id: headers['X-Telemetry-Install-ID'], operation_id: 'operation-a', environment: 'production', is_test: false });
  expect(context.account_id).toMatch(/^acct_[a-f0-9]{32}$/);
  expect(JSON.stringify(context)).not.toContain('account-uuid');
});
test('missing environment cannot silently become production', () => expect(pluginTelemetryContext(request({ 'X-Environment': undefined }), args)).toMatchObject({ environment: 'unknown', is_test: true }));
test('QA production request remains marked QA', () => expect(pluginTelemetryContext(request({ 'X-Telemetry-Test': 'yes' }), args).is_test).toBe(true));
