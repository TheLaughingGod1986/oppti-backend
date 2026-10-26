// One reply for billing calls that need a signed-in account or a licence key:
// a fixed code and message, the same bytes on every route.
const SIGN_IN_REQUIRED_BODY = Object.freeze({
  code: 'SIGN_IN_REQUIRED',
  message: 'Sign in to manage billing.'
});

function sendSignInRequired(res) {
  return res.status(401).json(SIGN_IN_REQUIRED_BODY);
}

module.exports = { SIGN_IN_REQUIRED_BODY, sendSignInRequired };
