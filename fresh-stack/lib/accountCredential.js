// Data and billing routes need an account credential: a signed-in account
// (JWT) or the account's own licence key. Site headers alone (authMethod
// 'site') are not enough, because a site key can leak with the plugin.
// Generation, credit-spend and image-state sync routes stay on the site key.
const { sendSignInRequired } = require('./signInRequired');

const ACCOUNT_AUTH_METHODS = new Set(['jwt', 'license']);

function hasAccountCredential(req) {
  const account = req?.user || req?.license || null;
  return Boolean(account && (account.id || account.license_key) && ACCOUNT_AUTH_METHODS.has(req.authMethod));
}

function requireAccountCredential(req, res, next) {
  if (!hasAccountCredential(req)) return sendSignInRequired(req, res);
  return next();
}

module.exports = { ACCOUNT_AUTH_METHODS, hasAccountCredential, requireAccountCredential };
