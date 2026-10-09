const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const summary = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'test-results', 'summary.json')));
const chosen = summary.outcomes?.find((result) => result.project === process.argv[2]) || summary.outcomes?.at(-1);
if (!chosen) throw new Error('No device report is available; inspect test-results/summary.json');
spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'show-report', path.join(path.dirname(chosen.report), 'html')], { stdio: 'inherit' });
