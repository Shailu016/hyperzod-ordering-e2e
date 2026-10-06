const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const YAML = require('yaml');
const root = path.resolve(__dirname, '..');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
const files = ['fixtures','flows','pages','tests','utils','scripts','tests-unit'].flatMap((dir) => walk(path.join(root,dir)));
try {
  for (const file of [...files, path.join(root,'playwright.config.js')].filter((file) => /\.(js|cjs)$/.test(file))) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    if (file.startsWith(path.join(root,'tests') + path.sep) && /\btest(?:\.describe)?\.only\s*\(/.test(fs.readFileSync(file,'utf8'))) throw new Error(`Focused test forbidden: ${file}`);
  }
  for (const file of [...walk(path.join(root,'.github/workflows')), path.join(root,'bitbucket-pipelines.yml')]) {
    const document = YAML.parseDocument(fs.readFileSync(file,'utf8'), { uniqueKeys: true });
    if (document.errors.length) throw new Error(`${file}: ${document.errors.map((error) => error.message).join('; ')}`);
  }
  const installed = require('@playwright/test/package.json').version;
  for (const file of [path.join(root,'bitbucket-pipelines.yml'), ...walk(path.join(root,'.github/workflows'))]) {
    const image = fs.readFileSync(file,'utf8').match(/mcr\.microsoft\.com\/playwright:v([\d.]+)-/);
    if (image && image[1] !== installed) throw new Error(`Playwright image/package mismatch: ${file}`);
  }
  execFileSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--list'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'), '--noEmit'], { cwd: root, stdio: 'pipe' });
  console.log('LINT: OK (JS syntax, focused-test guard, YAML, version alignment, imports and critical module types)');
} catch (error) {
  console.error(error.stdout?.toString() || error.message);
  process.exitCode = 1;
}
