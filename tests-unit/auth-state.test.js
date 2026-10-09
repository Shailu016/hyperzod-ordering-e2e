const { test } = require('node:test');
const assert = require('node:assert/strict');
const { refreshAuthState, authenticatedState } = require('../utils/auth-state');
const origin = 'https://automations-store.hyperzod.me';
function state(token, cart) { return { cookies: [], origins: [{ origin, localStorage: [{ name: 'access_token', value: token }, { name: 'token_expires_in', value: '12345' }, { name: 'vuex', value: JSON.stringify({ User: { loggedInUser: { id: 7 }, token }, Cart: cart, Utils: { selectedLocation: 'fixture-location' } }) }] }] }; }
test('persisted renewal refreshes credentials but excludes the active checkout cart', () => {
  const result = refreshAuthState(state('old', { cartItems: [] }), state('fresh', { cartItems: [{ id: 42 }] }), origin);
  const values = Object.fromEntries(result.origins[0].localStorage.map((entry) => [entry.name, entry.value]));
  assert.equal(values.access_token, 'fresh');
  assert.equal(JSON.parse(values.vuex).User.token, 'fresh');
  assert.deepEqual(JSON.parse(values.vuex).Cart.cartItems, []);
  assert.equal(JSON.parse(values.vuex).Utils.selectedLocation, 'fixture-location');
});
test('unknown fixture origins and missing fresh credentials fail explicitly', () => {
  assert.throws(() => refreshAuthState({ origins: [] }, state('fresh', {}), origin), /fixture origin/);
  assert.throws(() => refreshAuthState(state('old', {}), state('', {}), origin), /missing a credential/);
});

test('a deferred stale auth flag is replaced only by the verified live user snapshot', () => {
  const snapshot = state('valid', { cartItems: [] });
  const entry = snapshot.origins[0].localStorage.find((value) => value.name === 'vuex');
  const persisted = JSON.parse(entry.value);
  persisted.User.isLoggedIn = false;
  entry.value = JSON.stringify(persisted);
  const liveUser = { isLoggedIn: true, loggedInUser: { id: 7, email: 'fixture@example.invalid' } };
  const result = authenticatedState(snapshot, liveUser, origin);
  const value = JSON.parse(result.origins[0].localStorage.find((value) => value.name === 'vuex').value);
  assert.equal(value.User.isLoggedIn, true);
  assert.deepEqual(value.User.loggedInUser, liveUser.loggedInUser);
  assert.deepEqual(value.Cart.cartItems, []);
  assert.equal(JSON.parse(entry.value).User.isLoggedIn, false);
  assert.throws(() => authenticatedState(snapshot, { ...liveUser, isLoggedIn: false }, origin), /unverified/);
});
