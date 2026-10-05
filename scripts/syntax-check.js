// @ts-check
/**
 * Poor-man's lint for this suite (no eslint dependency by design):
 *  1. `node --check` every JS file under fixtures/flows/pages/tests/utils.
 *  2. `playwright test --list` to prove every module loads (import errors).
 * Exit non-zero on any failure. Run via `npm run lint`, also wired into CI.
 */
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.join(__dirname, "..");
const dirs = ["fixtures", "flows", "pages", "tests", "utils"];
const extraFiles = ["playwright.config.js", "scripts/syntax-check.js"];
let failed = false;

function jsFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...jsFiles(full));
		else if (entry.name.endsWith(".js")) out.push(full);
	}
	return out;
}

function checkFile(file) {
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
	} catch {
		console.error(`SYNTAX FAIL: ${path.relative(root, file)}`);
		failed = true;
	}
}

for (const dir of dirs) {
	for (const file of jsFiles(path.join(root, dir))) checkFile(file);
}
for (const rel of extraFiles) checkFile(path.join(root, rel));

try {
	execFileSync("npx", ["playwright", "test", "--list"], {
		cwd: root,
		stdio: "pipe",
		shell: true,
	});
} catch (err) {
	console.error("PLAYWRIGHT --list FAILED (import error in suite)");
	console.error(String((err && err.message) || err).slice(0, 500));
	failed = true;
}

console.log(failed ? "LINT: FAIL" : "LINT: OK");
process.exit(failed ? 1 : 0);
