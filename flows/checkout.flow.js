const { readStore } = require('../utils/store');
const { classifyCheckout } = require('../utils/policy');
async function readCheckoutDiagnostics(page) {
  const state = await readStore(page);
  return { validation: state.validationError, merchant: state.merchant, tenantAcceptOrders: state.tenantAcceptOrders };
}
function isMerchantUnorderable(state) { return classifyCheckout(state) !== 'unknown'; }
module.exports = { readCheckoutDiagnostics, isMerchantUnorderable };
