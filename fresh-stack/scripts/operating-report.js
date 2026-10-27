#!/usr/bin/env node
const fs = require('node:fs');
const { calculate } = require('../lib/operatingReport');
const { deliveryQuery, cohortExportQuery } = require('../lib/operatingReport/queries');
const [mode, input] = process.argv.slice(2);
if (mode === 'delivery-query') console.log(deliveryQuery(input));
else if (mode === 'cohort-query') console.log(cohortExportQuery(JSON.parse(fs.readFileSync(input, 'utf8'))));
else if (mode === 'calculate') {
  const data = JSON.parse(fs.readFileSync(input, 'utf8'));
  // A truncated/failed export can never confirm a count or denominator.
  if (data.querySucceeded !== true || data.truncated !== false) {
    data.options.coverage = {};
  }
  console.log(JSON.stringify(calculate(data.rows || [], data.options), null, 2));
} else {
  console.error('Usage: operating-report.js delivery-query <UTC-end> | cohort-query <bounds.json> | calculate <export.json>');
  process.exitCode = 1;
}
