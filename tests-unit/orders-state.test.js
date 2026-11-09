const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hasEmptyOrdersState } = require("../utils/orders-state");

test("orders readiness recognizes the storefront empty message but not the section heading", () => {
	assert.equal(hasEmptyOrdersState("Past Orders\nYou don't have any past orders"), true);
	assert.equal(hasEmptyOrdersState("Past Orders\nNo orders yet."), true);
	assert.equal(hasEmptyOrdersState("Past Orders\nLoading..."), false);
	assert.equal(hasEmptyOrdersState("Past Orders"), false);
});
