async function readStore(page) {
  return page.evaluate(() => {
    const app = document.querySelector('#app')?.__vue_app__;
    const store = app?.config.globalProperties.$store;
    if (!store) throw new Error('Mounted Vuex store is unavailable');
    const g = store.getters;
    const snapshot = {
      user: g.getLoggedInUser, authenticated: g.isLoggedIn, location: g.getSelectedLocation, cart: g.getCart,
      items: g.getCartItems, merchant: g.getCartMerchant, validation: g.getValidateCartData,
      validationError: g.getValidateError, validationLoading: g.getValidateCartLoading,
      paymentModes: g.paymentModes, paymentModeId: g.getPaymentModeId,
      paymentModesLoading: g.paymentModesLoading, currentMerchant: g.getMerchant,
      tokenExpiresAt: Number(localStorage.getItem('token_expires_in')),
      hasToken: !!localStorage.getItem('access_token'),
      address: g.getDeliveryAddress, orderType: g.getOrderType,
      tenantAcceptOrders: g.getBootSettings?.accept_orders?.enable_accept_orders,
      customOrderForms: g.getCustomForm,
	  checkoutJourneyEnabled: g.isCheckoutJourneyEnabled,
    };
    return JSON.parse(JSON.stringify(snapshot));
  });
}
module.exports = { readStore };
async function readUserState(page) {
  return page.evaluate(() => {
    const state = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$store?.state.User;
    if (!state) throw new Error('Live user state is unavailable');
    return JSON.parse(JSON.stringify(state));
  });
}
module.exports.readUserState = readUserState;
