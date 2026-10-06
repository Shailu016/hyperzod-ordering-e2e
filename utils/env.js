const path = require("path");
const fs = require("fs");

const AUTH_DIR = path.join(__dirname, "..", ".auth");
// Legacy single-user state (kept so old specs/config keep working).
const STORAGE_STATE = path.join(AUTH_DIR, "user.json");
const USER_META = path.join(AUTH_DIR, "user-meta.json");

// Per-project states for the multi-device matrix (web / android / ios).
// The setup project writes user.json once, then fans it out to all three so
// every device project starts from the same authenticated session.
const PROJECTS = ["web", "android", "ios"];
function storageStateFor(project) {
	if (!project || project === "setup" || project === "cleanup" || project === "web") {
		return path.join(AUTH_DIR, "user-web.json");
	}
	if (PROJECTS.includes(project)) {
		return path.join(AUTH_DIR, `user-${project}.json`);
	}
	return path.join(AUTH_DIR, "user-web.json");
}

const testUser = {
	firstName: process.env.TEST_USER_FIRST_NAME || "Playwright Tester",
	email: (process.env.TEST_USER_EMAIL || "").trim().toLowerCase(),
	phone: (process.env.TEST_USER_PHONE || "").replace(/\D/g, ""),
	country: process.env.TEST_USER_COUNTRY || "India",
	password: process.env.TEST_USER_PASSWORD || "Test@123456",
};

const config = {
	locationQuery: process.env.TEST_LOCATION_QUERY || "Indore",
	fallbackOtp: process.env.TEST_FALLBACK_OTP || "1234",
	// No fallback: an empty target must fail loudly in setup's preflight,
	// never silently test the wrong deployment.
	baseURL: process.env.BASE_URL || "",
};

function ensureAuthDir() {
	if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function saveUserMeta(meta) {
	ensureAuthDir();
	fs.writeFileSync(USER_META, JSON.stringify(meta, null, 2));
}

function readUserMeta() {
	if (!fs.existsSync(USER_META)) return null;
	try {
		return JSON.parse(fs.readFileSync(USER_META, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Fail fast with a plain-language message when required env is missing.
 * Called by the setup project before it touches the UI.
 * @returns {string[]} list of missing variable names (empty = ok)
 */
function validateEnv() {
	const missing = [];
	if (!config.baseURL) missing.push("BASE_URL");
	if (!testUser.email) missing.push("TEST_USER_EMAIL");
	if (!testUser.phone) missing.push("TEST_USER_PHONE");
	if (!testUser.password) missing.push("TEST_USER_PASSWORD");
	if (!config.locationQuery) missing.push("TEST_LOCATION_QUERY");
	return missing;
}

/**
 * Copy the canonical setup session to every device project state.
 * Keeps web/android/ios in sync without running signup three times.
 */
function fanOutStorageStates() {
	ensureAuthDir();
	const canonical =
		fs.existsSync(STORAGE_STATE) &&
		fs.statSync(STORAGE_STATE).size > 50
			? STORAGE_STATE
			: path.join(AUTH_DIR, "user-web.json");
	if (!fs.existsSync(canonical)) return;
	const raw = fs.readFileSync(canonical);
	for (const p of PROJECTS) {
		fs.writeFileSync(path.join(AUTH_DIR, `user-${p}.json`), raw);
	}
	// Legacy path always mirrors web so old tooling keeps working.
	fs.writeFileSync(STORAGE_STATE, raw);
}

module.exports = {
	AUTH_DIR,
	STORAGE_STATE,
	USER_META,
	PROJECTS,
	storageStateFor,
	testUser,
	config,
	ensureAuthDir,
	saveUserMeta,
	readUserMeta,
	validateEnv,
	fanOutStorageStates,
};
