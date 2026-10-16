const fs = require('node:fs');
const { executionSuite } = require('../utils/schedule');
const suite = executionSuite({ kind: process.env.E2E_SCHEDULE_KIND, event: process.env.GITHUB_EVENT_NAME,
  requestedSlot: process.env.E2E_SCHEDULE_SLOT, requestedSuite: process.env.E2E_REQUESTED_SUITE });
if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
fs.appendFileSync(process.env.GITHUB_OUTPUT, 'name=' + suite + '\n');
