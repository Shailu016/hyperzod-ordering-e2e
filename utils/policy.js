const crypto = require('node:crypto');

function targetOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Target must be an HTTP(S) origin without credentials, query, or fragment');
  }
  if (url.pathname !== '/') throw new Error('Store target must be an origin, not a path');
  return url.origin;
}
function assertAllowedTarget(value, allowed = 'https://automations-store.hyperzod.me') {
  const origin = targetOrigin(value);
  const permitted = (allowed || 'https://automations-store.hyperzod.me').split(',').map((v) => targetOrigin(v.trim()));
  if (!permitted.includes(origin)) throw new Error('Target is not in E2E_ALLOWED_ORIGINS; destructive tests are blocked');
  return origin;
}
function identityKey(origin, email) {
  return crypto.createHash('sha256').update(`${origin}\n${email.trim().toLowerCase()}`).digest('hex').slice(0, 24);
}
function assertIdentity(user, expectedEmail, expectedId) {
  if (!user || !user.id || String(user.email || '').toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new Error('Authenticated identity is unavailable or does not match the test identity');
  }
  if (expectedId != null && String(user.id) !== String(expectedId)) throw new Error('Authenticated user ID changed');
  return user;
}
function intentState(body) {
  if (body?.success !== true || typeof body.data?.user_exists !== 'boolean') {
    throw new Error('User intent probe did not establish existence or absence');
  }
  return body.data.user_exists ? 'present' : 'absent';
}
function isCashMode(mode) {
  return !!mode && ['cash', 'cod', 'cash_on_delivery'].includes(mode.payment_mode?.name) &&
    mode.payment_mode.is_offline_mode === true && mode.is_supported !== false && mode.is_amount_eligible !== false;
}
function orderIdFrom(body) {
  if (body?.success !== true) throw new Error('Order API did not report success');
  const id = body.data?.order_id ?? body.data?.id;
  if (!['string', 'number'].includes(typeof id) || !String(id).trim()) throw new Error('Successful order response is missing its order ID');
  return id;
}
function cartLines(items) {
  if (!Array.isArray(items)) throw new Error('Cart items must be an array');
  return items.map((item) => {
    if (!item?.product_id || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) throw new Error('Invalid cart line');
    return {
      product: String(item.product_id), merchant: String(item.merchant_id), quantity: Number(item.quantity),
      price: Number(item.product_price), subtotal: Number(item.sub_total_amount),
      options: Object.fromEntries(Object.entries(item).filter(([key]) => /option|addon|instruction/i.test(key)).sort(([a], [b]) => a.localeCompare(b))),
    };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function validateBill(cart) {
  if (!cart || !Array.isArray(cart.cart_items) || !cart.cart_items.length) throw new Error('Checkout requires a nonempty cart');
  const values = ['sub_total_amount', 'total_amount'];
  for (const key of values) if (!Number.isFinite(Number(cart[key])) || Number(cart[key]) < 0) throw new Error(`Invalid ${key}`);
  const sum = cart.cart_items.reduce((n, line) => n + Number(line.sub_total_amount), 0);
  if (!Number.isFinite(sum) || Math.abs(sum - Number(cart.sub_total_amount)) > 0.02) throw new Error('Line subtotals do not equal the cart subtotal');
  if (!cart.currency_setting?.code && !cart.currency?.code) throw new Error('Cart currency is missing');
  if (!cart.total_amount_formatted || !cart.sub_total_amount_formatted) throw new Error('Formatted bill amounts are missing');
  const amount = (key) => {
    if (cart[key] == null || cart[key] === '') return 0;
    const value = Number(cart[key]);
    if (!Number.isFinite(value)) throw new Error(`Invalid bill component ${key}`);
    return value;
  };
  const taxes = cart.tax_method === 'inclusive' ? 0 : amount('tax') + amount('delivery_tax');
  const custom = (cart.custom_charges || []).reduce((n, charge) => n + Number(charge.charge_amount), 0);
  const adjustments = (cart.payment_adjustments || []).reduce((n, adjustment) => n + Number(adjustment.amount), 0);
  const expected = Number(cart.sub_total_amount) + amount('delivery_fee') + amount('packaging_charge') + taxes + amount('tip_amount') + amount('merchant_tip_amount') + custom - amount('discount_amount') - adjustments;
  if (!Number.isFinite(expected) || Math.abs(expected - Number(cart.total_amount)) > 0.02) throw new Error('Bill total does not equal its explicit components');
  return { total: Number(cart.total_amount), subtotal: Number(cart.sub_total_amount), currency: cart.currency_setting?.code || cart.currency.code };
}
function classifyCheckout(state) {
  if (!state || typeof state !== 'object') return 'unknown';
  if (state.tenantAcceptOrders === false) return 'tenant-disabled';
  if (state.merchant?.is_accepting_orders === false || state.validation?.is_delivering === false) return 'fixture-unavailable';
  return 'unknown';
}
function redact(value) {
  return String(value).replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|key|password|otp|email|phone)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/("(?:access_token|refresh_token|password|code|email|mobile|phone)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
}
module.exports = { targetOrigin, assertAllowedTarget, identityKey, assertIdentity, intentState, isCashMode, orderIdFrom, cartLines, validateBill, classifyCheckout, redact };
