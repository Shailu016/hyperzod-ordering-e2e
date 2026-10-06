const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../utils/policy');
test('destructive scope rejects wrong tenant, credentials and URL paths', () => {
  assert.equal(p.assertAllowedTarget('https://automations-store.hyperzod.me/'), 'https://automations-store.hyperzod.me');
  for (const value of ['https://customer.hyperzod.me', 'https://user:pass@automations-store.hyperzod.me', 'https://automations-store.hyperzod.me/other', 'file:///tmp', '-']) assert.throws(() => p.assertAllowedTarget(value));
});
test('identity cannot be unknown or a different account', () => {
  for (const user of [null, {}, { id: 1, email: 'other@example.invalid' }]) assert.throws(() => p.assertIdentity(user, 'test@example.invalid'));
  assert.throws(() => p.assertIdentity({ id: 2, email: 'test@example.invalid' }, 'test@example.invalid', 1));
});
test('absence requires explicit successful proof', () => {
  for (const body of [{ success: false }, { success: true }, { success: true, data: { user_exists: null } }]) assert.throws(() => p.intentState(body));
  assert.equal(p.intentState({ success: true, data: { user_exists: false } }), 'absent');
});
test('Cash/COD selection cannot admit a label-only or online method', () => {
  assert.equal(p.isCashMode({ payment_mode: { name: 'cash', is_offline_mode: true } }), true);
  assert.equal(p.isCashMode({ alias: 'Card on delivery', payment_mode: { name: 'stripe', is_offline_mode: false } }), false);
  assert.equal(p.isCashMode({ payment_mode: { name: 'cash', is_offline_mode: false } }), false);
});
test('successful order without identity fails instead of becoming skipped', () => {
  assert.throws(() => p.orderIdFrom({ success: true, data: {} }));
  assert.throws(() => p.orderIdFrom({ success: false, data: { id: 1 } }));
  assert.equal(p.orderIdFrom({ success: true, data: { order_id: 123 } }), 123);
});
test('cart snapshot detects quantity and option changes', () => {
  const line = { product_id: 1, merchant_id: 2, quantity: 1, product_price: 10, sub_total_amount: 10, options: [3] };
  assert.notDeepEqual(p.cartLines([line]), p.cartLines([{ ...line, quantity: 2 }]));
  assert.notDeepEqual(p.cartLines([line]), p.cartLines([{ ...line, options: [4] }]));
});
test('bill rejects subtotal drift and missing currency', () => {
  const cart = { cart_items: [{ sub_total_amount: 10 }], sub_total_amount: 10, total_amount: 10, currency_setting: { code: 'INR' }, total_amount_formatted: '10', sub_total_amount_formatted: '10' };
  assert.equal(p.validateBill(cart).total, 10);
  assert.throws(() => p.validateBill({ ...cart, sub_total_amount: 9 }));
  assert.throws(() => p.validateBill({ ...cart, currency_setting: null }));
  assert.throws(() => p.validateBill({ ...cart, total_amount: 9 }));
  assert.equal(p.validateBill({ ...cart, delivery_fee: 2, tax: 1, total_amount: 13 }).total, 13);
  assert.equal(p.validateBill({ ...cart, tax_method: 'inclusive', tax: 1 }).total, 10);
});
test('unrelated toast strings cannot classify a merchant as closed', () => {
  assert.equal(p.classifyCheckout('Session closed'), 'unknown');
  assert.equal(p.classifyCheckout({ merchant: { is_accepting_orders: false } }), 'fixture-unavailable');
});
test('diagnostics redact tokens and personal data', () => {
  const value = p.redact('Bearer abc.def https://x/?token=secret {"password":"secret","email":"a@example.invalid"}');
  assert.ok(!value.includes('secret')); assert.ok(!value.includes('a@example.invalid')); assert.ok(!value.includes('abc.def'));
});
