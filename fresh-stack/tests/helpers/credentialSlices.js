// Every 8-character slice of a credential, for "no part of the key is
// logged" assertions.
function eightCharSlices(value) {
  const text = String(value || '');
  const slices = [];
  for (let i = 0; i + 8 <= text.length; i += 1) slices.push(text.slice(i, i + 8));
  return slices;
}

function expectNoCredentialSlices(loggedCalls, credentials) {
  const logged = JSON.stringify(loggedCalls);
  for (const credential of credentials) {
    expect(logged).not.toContain(credential);
    for (const slice of eightCharSlices(credential)) {
      expect(logged).not.toContain(slice);
    }
  }
}

module.exports = { eightCharSlices, expectNoCredentialSlices };
