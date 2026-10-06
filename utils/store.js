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
      address: g.getDeliveryAddress, orderType: g.getOrderType,
      tenantAcceptOrders: g.getBootSettings?.accept_orders?.enable_accept_orders,
    };
    return JSON.parse(JSON.stringify(snapshot));
  });
}
module.exports = { readStore };
