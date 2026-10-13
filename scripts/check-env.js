// Validate configuration before installing browsers or starting user lifecycle tests.
require("dotenv").config();
const { config, validateEnv, validateBaseURL } = require("../utils/env");
try {
	validateBaseURL(config.baseURL);
	const missing = validateEnv();
	if (missing.length) {
		const names = missing.map((name) => name.replace(/_FORMAT$/, "").replace(/^TEST_/, "E2E_"));
		throw new Error("Missing or invalid variables: " + missing.join(", ") + ". Check .env or GitHub Actions secrets: " + names.join(", "));
	}
	console.log("E2E configuration: OK");
} catch (error) {
	console.error("E2E configuration: " + error.message);
	process.exitCode = 1;
}
