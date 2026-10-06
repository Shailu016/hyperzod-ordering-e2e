#!/usr/bin/env node
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { acquireLease } = require('../utils/lease');
const { exportManifest } = require('../utils/manifest');
const { assertAllowedTarget } = require('../utils/policy');
const { summarizeReports } = require('./summarize');
const ROOT = path.resolve(__dirname, '..');
const SUITES = { signup: ['setup'], smoke: ['web'], web: ['web'], android: ['android'], ios: ['ios'], mobile: ['android', 'ios'], all: ['web', 'android', 'ios'] };
async function run(suite = process.argv[2]) {
  if (!SUITES[suite]) throw new Error('Choose smoke, web, android, ios, mobile, or all');
  const origin = assertAllowedTarget(process.env.BASE_URL, process.env.E2E_ALLOWED_ORIGINS);
  const missing = require('../utils/env').validateEnv();
  if (missing.length) throw new Error(`Invalid E2E settings: ${missing.join(', ')}`);
  const runId = `${process.env.GITHUB_RUN_ID || Date.now()}-${crypto.randomUUID()}`;
  const directory = path.join(ROOT, 'test-results', runId);
  fs.mkdirSync(directory, { recursive: true });
  const summaryFile = path.join(ROOT, 'test-results', 'summary.json');
  const outcomes = [];
  const initial = { runId, suite, origin, expectedProjects: SUITES[suite], startedAt: new Date().toISOString(), outcomes, status: 'running' };
  const writeSummary = (value) => {
    const json = JSON.stringify(value, null, 2);
    fs.writeFileSync(path.join(directory, 'summary.json'), json);
    fs.writeFileSync(summaryFile, json);
  };
  writeSummary(initial);
  let release;
  let child;
  let stopped = false;
  const stop = () => { stopped = true; child?.kill('SIGTERM'); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    release = await acquireLease({ origin, email: process.env.TEST_USER_EMAIL, owner: runId });
    for (const project of SUITES[suite]) {
      if (stopped) break;
      const projectDir = path.join(directory, project);
      fs.mkdirSync(projectDir, { recursive: true });
      const args = [require.resolve('@playwright/test/cli'), 'test', `--project=${project}`];
      if (suite === 'smoke') args.push('--grep', '@smoke');
      for (const flag of process.argv.slice(3)) {
        if (!['--headed', '--ui', '--debug'].includes(flag)) throw new Error('Unsupported interactive runner option');
        args.push(flag);
      }
      const result = await new Promise((resolve) => {
        child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, E2E_RUN_ID: `${runId}-${project}`, E2E_LEASE_OWNER: runId, E2E_RUN_DIR: projectDir } });
        child.on('error', (error) => resolve({ exitCode: 1, error: error.message }));
        child.on('exit', (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal }));
      });
      try { exportManifest(`${runId}-${project}`, projectDir); }
      catch (error) { result.exitCode = 1; result.error = `Lifecycle evidence export failed: ${error.message}`; }
      outcomes.push({ project, ...result, report: path.join(projectDir, 'report.json') });
      writeSummary({ ...initial, outcomes });
    }
    const summary = summarizeReports(initial, outcomes, fs.readFileSync);
    writeSummary({ ...summary, finishedAt: new Date().toISOString() });
    process.exitCode = summary.status === 'passed' ? 0 : 1;
  } catch (error) {
    writeSummary({ ...initial, outcomes, status: 'infrastructure-failed', error: error.message, finishedAt: new Date().toISOString() });
    throw error;
  } finally {
    try { if (release) await release(); }
    catch (error) { writeSummary({ ...JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8')), status: 'infrastructure-failed', leaseReleaseError: error.message }); process.exitCode = 1; }
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, SUITES };
