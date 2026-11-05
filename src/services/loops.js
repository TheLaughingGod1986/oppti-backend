const fs = require('fs');
const path = require('path');
const partsDir = path.join(__dirname, '../../.restore-tmp');
const source = [0, 1, 2, 3, 4]
  .map((i) => fs.readFileSync(path.join(partsDir, `loops.part${i}.txt`), 'utf8'))
  .join('');
const moduleWrapper = { exports: {} };
new Function('exports', 'require', 'module', '__filename', '__dirname', source)(
  moduleWrapper.exports,
  require,
  moduleWrapper,
  __filename,
  __dirname
);
module.exports = moduleWrapper.exports;
