const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { calculateEscrowFee } = require("../escrow-fee");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "Markertplace.html"), "utf8");
function extract(start, end) {
  const first = html.indexOf(`        ${start}`);
  const last = html.indexOf(`        ${end}`, first);
  assert.ok(first >= 0 && last > first);
  return html.slice(first, last);
}

test("checkout confirms server totals before opening Flutterwave", async () => {
  let destination = "";
  let result = { checkoutUrl: "https://checkout.flutterwave.com/v3/hosted/pay/test",
    productPrice: 7500, platformFee: 562.5, fulfillmentFee: 0, totalPaid: 8062.5 };
  const toasts = [];
  const nodes = {
    escrowFulfillmentMethod: { value: "pickup" },
    escrowStation: { value: "oshodi" },
    escrowVoucherCode: { value: "" },
    escrowCheckoutSubmit: { disabled: false }
  };
  const requests = [];
  const context = {
    firebaseConfig: { projectId: "golden-eagle-marketplace" },
    currentUser: { email: "buyer@example.test" },
    products: [{ id: "p1", price: 7500 }],
    calculateEscrowFee,
    formatNaira: String,
    escrowFulfillment: require("../escrow-fulfillment"),
    document: { getElementById: id => nodes[id] },
    firebaseFunctions: { httpsCallable: () => async data => { requests.push(data); return { data: result }; } },
    window: { confirm: () => true, location: { assign: url => { destination = url; } } },
    showToast: message => toasts.push(message),
    console: { error() {} },
    URL
  };
  vm.runInNewContext(extract("let escrowVoucherQuote", "function updateDiscussionComposer"), context);
  const event = { preventDefault() {}, currentTarget: { dataset: { productId: "p1" } } };
  await context.submitEscrowCheckout(event);
  assert.match(destination, /^https:\/\/checkout\.flutterwave\.com\//);
  assert.equal(requests[0].fulfillment.stationId, "oshodi");
  assert.equal(nodes.escrowCheckoutSubmit.disabled, false);
  destination = "";
  result = { ...result, totalPaid: 1 };
  await context.submitEscrowCheckout(event);
  assert.equal(destination, "");
  assert.match(toasts.at(-1), /checkout total changed/i);
});

test("an escrow return is verified without invoking the wallet purchase handler", async () => {
  const called = [];
  let replaced = "";
  const context = {
    walletPaymentReturnPromise: null,
    currentUser: { uid: "buyer" },
    window: {
      location: { href: "https://escrow-test.example.test/?tx_ref=escrow-test&transaction_id=123&status=successful" },
      history: { replaceState: (state, title, url) => { replaced = url; } }
    },
    document: { title: "Test" },
    firebaseFunctions: { httpsCallable: name => async () => { called.push(name); return { data: { status: "HELD_IN_ESCROW" } }; } },
    showToast() {},
    console,
    URL
  };
  vm.runInNewContext(extract("async function confirmFlutterwaveReturn", "async function startTimedQuiz"), context);
  await context.confirmFlutterwaveReturn();
  assert.deepEqual(called, ["verifyEscrowPayment"]);
  assert.equal(new URL(replaced).search, "");
});

test("an escrow return reports a pending refund instead of completed checkout", async () => {
  const toasts = [];
  const context = {
    walletPaymentReturnPromise: null,
    currentUser: { uid: "buyer" },
    window: {
      location: { href: "https://escrow-test.example.test/?tx_ref=escrow-test&transaction_id=123&status=successful" },
      history: { replaceState() {} }
    },
    document: { title: "Test" },
    firebaseFunctions: { httpsCallable: () => async () => ({ data: { status: "REFUND_PENDING" } }) },
    showToast: message => toasts.push(message), console, URL
  };
  vm.runInNewContext(extract("async function confirmFlutterwaveReturn", "async function startTimedQuiz"), context);
  await context.confirmFlutterwaveReturn();
  assert.match(toasts[0], /refund status/i);
});

test("fulfillment form lists stations and requires the selected delivery details", () => {
  const nodes = {};
  for (const id of ["escrowCheckoutForm", "escrowFulfillmentMethod", "escrowStation", "escrowStationField",
    "escrowDeliveryFields", "escrowDeliveryAddress", "escrowDeliveryCity", "escrowDeliveryState",
    "escrowDeliveryPhone", "escrowCheckoutTotal", "escrowCheckoutModal", "escrowVoucherStatus"]) {
    nodes[id] = { value: "", dataset: {}, classList: {
      hidden: true, add() {}, remove() {}, toggle(name, hidden) { this.hidden = hidden; }
    } };
  }
  nodes.escrowCheckoutForm.reset = () => {};
  const option = {};
  const context = {
    currentUser: { uid: "buyer" }, products: [{ id: "p1", price: 7500 }],
    escrowFulfillment: require("../escrow-fulfillment"), calculateEscrowFee,
    document: { getElementById: id => nodes[id], querySelector: () => option },
    escapeHtml: String, formatNaira: String, console
  };
  vm.runInNewContext(extract("let escrowVoucherQuote", "function updateDiscussionComposer"), context);
  context.startEscrowCheckout("p1");
  assert.match(nodes.escrowStation.innerHTML, /Computer Village/);
  assert.match(option.textContent, /2750/);
  nodes.escrowFulfillmentMethod.value = "delivery";
  context.updateEscrowFulfillmentForm();
  assert.equal(nodes.escrowDeliveryAddress.required, true);
  assert.equal(nodes.escrowStation.required, false);
  assert.match(nodes.escrowCheckoutTotal.textContent, /10812\.5/);
  nodes.escrowFulfillmentMethod.value = "pickup";
  context.updateEscrowFulfillmentForm();
  assert.equal(nodes.escrowDeliveryAddress.required, false);
  assert.equal(nodes.escrowStation.required, true);
  assert.match(nodes.escrowCheckoutTotal.textContent, /8062\.5/);
});

test("delivery checkout sends the entered details and verifies the fulfillment fee", async () => {
  let destination = "";
  const calls = [];
  const nodes = {
    escrowFulfillmentMethod: { value: "delivery" },
    escrowDeliveryAddress: { value: " 12 Main Street " },
    escrowDeliveryCity: { value: "Ikeja" },
    escrowDeliveryState: { value: "Lagos" },
    escrowDeliveryPhone: { value: "08012345678" },
    escrowDeliveryLandmark: { value: "Market" },
    escrowVoucherCode: { value: "" },
    escrowCheckoutSubmit: { disabled: false }
  };
  let fulfillmentFee = 2750;
  const context = {
    currentUser: { email: "buyer@example.test" },
    products: [{ id: "p1", price: 7500 }],
    calculateEscrowFee,
    escrowFulfillment: require("../escrow-fulfillment"),
    formatNaira: String,
    document: { getElementById: id => nodes[id] },
    firebaseFunctions: { httpsCallable: name => async data => {
      calls.push({ name, data });
      return { data: { checkoutUrl: "https://checkout.flutterwave.com/v3/hosted/pay/test",
        productPrice: 7500, platformFee: 562.5, fulfillmentFee, totalPaid: 10812.5 } };
    } },
    window: { confirm: () => true, location: { assign: url => { destination = url; } } },
    showToast() {}, console: { error() {} }, URL
  };
  vm.runInNewContext(extract("let escrowVoucherQuote", "function updateDiscussionComposer"), context);
  const event = { preventDefault() {}, currentTarget: { dataset: { productId: "p1" } } };
  await context.submitEscrowCheckout(event);
  assert.equal(calls[0].name, "initiateEscrowCheckout");
  assert.equal(calls[0].data.fulfillment.address, "12 Main Street");
  assert.equal(calls[0].data.fulfillment.phone, "08012345678");
  assert.match(destination, /^https:\/\/checkout\.flutterwave\.com\//);
  destination = "";
  fulfillmentFee = 0;
  await context.submitEscrowCheckout(event);
  assert.equal(destination, "");
});

test("voucher quote is displayed and sent with checkout, and edits invalidate it", async () => {
  const calls = [];
  let destination = "";
  const nodes = {
    escrowCheckoutForm: { dataset: { productId: "p1" } },
    escrowFulfillmentMethod: { value: "pickup" },
    escrowStation: { value: "oshodi" },
    escrowStationField: { classList: { toggle() {} } },
    escrowDeliveryFields: { classList: { toggle() {} } },
    escrowDeliveryAddress: {}, escrowDeliveryCity: {}, escrowDeliveryState: {}, escrowDeliveryPhone: {},
    escrowVoucherCode: { value: "save10" }, escrowVoucherStatus: {}, escrowCheckoutTotal: {},
    escrowCheckoutSubmit: { disabled: false }
  };
  const context = {
    currentUser: { uid: "buyer", email: "buyer@example.test" },
    products: [{ id: "p1", price: 7500 }], calculateEscrowFee,
    escrowFulfillment: require("../escrow-fulfillment"), formatNaira: String,
    document: { getElementById: id => nodes[id] },
    firebaseFunctions: { httpsCallable: name => async data => {
      calls.push({ name, data });
      if (name === "quoteStoreVoucher") return { data: {
        code: "SAVE10", originalPrice: 7500, discount: 750, productPrice: 6750, platformFee: 506.25
      } };
      return { data: { checkoutUrl: "https://checkout.flutterwave.com/v3/hosted/pay/test",
        productPrice: 6750, platformFee: 506.25, fulfillmentFee: 0, totalPaid: 7256.25 } };
    } },
    window: { confirm: () => true, location: { assign: url => { destination = url; } } },
    showToast() {}, console: { error() {} }, URL
  };
  vm.runInNewContext(extract("let escrowVoucherQuote", "function updateDiscussionComposer"), context);
  await context.applyEscrowVoucher();
  assert.match(nodes.escrowVoucherStatus.textContent, /750 discount/);
  assert.match(nodes.escrowCheckoutTotal.textContent, /7256\.25/);
  const event = { preventDefault() {}, currentTarget: nodes.escrowCheckoutForm };
  await context.submitEscrowCheckout(event);
  assert.equal(calls[1].data.voucherCode, "SAVE10");
  assert.equal(calls[1].data.expectedDiscount, 750);
  assert.match(destination, /^https:\/\/checkout\.flutterwave\.com\//);
  destination = "";
  context.clearEscrowVoucher();
  await context.submitEscrowCheckout(event);
  assert.equal(calls.length, 2);
  assert.equal(destination, "");
});

test("the cart offers checkout only for a single vendor product", () => {
  const nodes = {};
  for (const id of ["cartItemCount", "cartItems", "cartSummary", "cartSubtotal", "cartEscrowPreview", "cartCheckout"]) {
    nodes[id] = {
      textContent: "",
      innerHTML: "",
      classList: { add() {}, remove() {} },
      replaceChildren() { this.innerHTML = ""; this.textContent = ""; }
    };
  }
  const context = {
    document: { getElementById: id => nodes[id] },
    cartItems: [{ productId: "p1", quantity: 1 }],
    products: [{ id: "p1", ownerUid: "vendor", price: 7500, stock: 2, title: "Phone" }],
    firebaseConfig: { projectId: "golden-eagle-marketplace" },
    getProductImages: () => [],
    escapeHtml: String,
    formatNaira: value => `NGN ${value}`,
    calculateEscrowFee,
    console
  };
  vm.runInNewContext(
    extract("function renderEscrowFeePreview", "function renderProducts()") +
    extract("function renderCart()", "function askAiAboutItem"),
    context
  );
  context.renderCart();
  assert.match(nodes.cartEscrowPreview.innerHTML, /Fee \(7\.5%\): NGN 562\.5/);
  assert.match(nodes.cartEscrowPreview.innerHTML, /NGN 8062\.5/);
  assert.match(nodes.cartEscrowPreview.innerHTML, /estimate excludes delivery or pickup fees/i);
  assert.match(nodes.cartCheckout.innerHTML, /startEscrowCheckout/);
  assert.match(nodes.cartCheckout.innerHTML, /Pay with Escrow Protection/i);
  context.products[0].price = 85000;
  context.renderCart();
  assert.match(nodes.cartEscrowPreview.innerHTML, /Fee \(7\.5%\): NGN 6375/);
  assert.match(nodes.cartEscrowPreview.innerHTML, /NGN 91375/);
  context.cartItems[0].quantity = 2;
  context.renderCart();
  assert.match(nodes.cartEscrowPreview.textContent, /one listed product at a time/i);
  assert.match(nodes.cartCheckout.textContent, /choose one listed product/i);
  context.cartItems.length = 0;
  context.renderCart();
  assert.equal(nodes.cartEscrowPreview.innerHTML, "");
});

test("vendor payout controls stay unavailable when the backend rejects access", async () => {
  const nodes = {};
  const document = { getElementById(id) {
    if (!nodes[id]) nodes[id] = { value: "", textContent: "", replaceChildren() {}, classList: {
      hidden: false,
      add() { this.hidden = true; },
      remove() { this.hidden = false; },
      toggle(name, hidden) { this.hidden = hidden; }
    } };
    return nodes[id];
  } };
  const context = {
    currentUser: { uid: "vendor", role: "Vendor" }, document,
    Option: function(text, value) { this.text = text; this.value = value; },
    localStorage: { getItem: () => null },
    firebaseFirestore: { collection: () => ({
      doc: () => ({ get: async () => ({ exists: false }) }),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true }) }) })
    }) },
    formatNaira: String,
    firebaseFunctions: { httpsCallable: () => async () => { throw new Error("unavailable"); } },
    console: { error() {} }
  };
  vm.runInNewContext(extract("let escrowBankAccount", "function renderVerifiedDealerBadgeSettings"), context);
  await context.loadVendorEscrowPayoutSettings();
  assert.equal(nodes.vendorEscrowPayoutLaunchFields.classList.hidden, true);
  assert.match(nodes.vendorEscrowPayoutStatus.textContent, /unavailable/i);
});

test("vendor cash and chat balances load independently of the payout launch gate", async () => {
  const nodes = {};
  const document = { getElementById(id) {
    if (!nodes[id]) nodes[id] = { value: "", textContent: "", replaceChildren() {}, classList: {
      hidden: false, add() { this.hidden = true; }, remove() { this.hidden = false; },
      toggle(name, hidden) { this.hidden = hidden; }
    } };
    return nodes[id];
  } };
  const context = {
    currentUser: { uid: "vendor", role: "Vendor" }, document,
    Option: function(text, value) { this.text = text; this.value = value; },
    localStorage: { getItem: () => null },
    firebaseFirestore: { collection: name => ({
      doc: () => ({ get: async () => ({ exists: true, data: () =>
        name === "vendorPayoutBalances" ? { availableKobo: 750000 } : { coins: 7.5 } }) }),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true }) }) })
    }) },
    firebaseFunctions: { httpsCallable: () => async () => ({ data: { payoutsEnabled: false } }) },
    formatNaira: value => `NGN ${value}`, console: { error() {} }
  };
  vm.runInNewContext(extract("let escrowBankAccount", "function renderVerifiedDealerBadgeSettings"), context);
  await context.loadVendorEscrowPayoutSettings();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.vendorAvailableCash.textContent, "NGN 7500");
  assert.equal(nodes.vendorSpendableCoins.textContent, "7.5");
  assert.equal(nodes.vendorEscrowPayoutLaunchFields.classList.hidden, true);
  assert.match(nodes.vendorEscrowPayoutStatus.textContent, /awaiting launch/i);
});

test("order controls match the participant and status and call the protected functions", async () => {
  const list = { textContent: "", innerHTML: "" };
  const queries = [];
  const calls = [];
  let order = { productTitle: "Phone", status: "SHIPPED", productPrice: 7500,
    platformFee: 1375, totalPaid: 8875 };
  const context = {
    currentUser: { uid: "buyer", role: "Buyer" },
    activeAccountSection: "escrow",
    firebaseConfig: { projectId: "golden-eagle-marketplace" },
    firebaseFirestore: { collection: () => ({ where: (field, op, uid) => {
      queries.push({ field, uid });
      return { get: async () => ({ empty: false, docs: [{ id: "order1", data: () => order }] }) };
    } }) },
    firebaseFunctions: { httpsCallable: name => async data => {
      calls.push({ name, data });
      return { data: { status: "RELEASED" } };
    } },
    document: { getElementById: () => list },
    escapeHtml: String, formatNaira: String,
    window: { confirm: () => true, prompt: () => "Wrong item" },
    showToast() {}, console: { error() {} }
  };
  vm.runInNewContext(extract("async function loadEscrowOrders", "function populateProfileSettings"), context);
  await context.loadEscrowOrders();
  assert.equal(queries[0].field, "buyerUid");
  assert.match(list.innerHTML, /Confirm delivery/);
  assert.match(list.innerHTML, /Open dispute/);
  const button = { dataset: { orderId: "order1", action: "confirm" }, disabled: false };
  await context.updateEscrowOrderFromProfile(button);
  assert.equal(calls[0].name, "confirmDeliveryAndRelease");
  assert.equal(calls[0].data.orderId, "order1");
  assert.equal(button.disabled, false);
  context.currentUser = { uid: "vendor", role: "Vendor" };
  order = { ...order, status: "HELD_IN_ESCROW" };
  await context.loadEscrowOrders();
  assert.equal(queries.at(-1).field, "vendorUid");
  assert.match(list.innerHTML, /Mark shipped/);
  assert.doesNotMatch(list.innerHTML, /Confirm delivery|Open dispute/);
  order = { ...order, fulfillment: { method: "pickup", stationName: "Computer Village" }, fulfillmentFee: 0 };
  await context.loadEscrowOrders();
  assert.match(list.innerHTML, /Pickup Station/);
  assert.match(list.innerHTML, /Computer Village/);
  assert.match(list.innerHTML, /Mark ready for pickup/);
  context.currentUser = { uid: "buyer", role: "Buyer" };
  order.status = "SHIPPED";
  await context.loadEscrowOrders();
  assert.match(list.innerHTML, /Ready for pickup/);
  assert.match(list.innerHTML, /Confirm pickup/);
});

test("production account navigation opens the escrow orders section", () => {
  const nodes = {};
  const context = {
    currentUser: { uid: "buyer", role: "Buyer" },
    firebaseConfig: { projectId: "golden-eagle-marketplace" },
    activeAccountSection: "profile",
    accountConnectionsUnsubscribe: null,
    document: {
      querySelectorAll: () => [],
      getElementById(id) {
        if (!nodes[id]) nodes[id] = { classList: {
          hidden: true,
          remove() { this.hidden = false; },
          toggle(name, hidden) { this.hidden = hidden; }
        } };
        return nodes[id];
      }
    },
    unsubscribeFromProfilePresence() {},
    clearProfileProductStatsSubscriptions() {},
    loadEscrowOrders() { context.loaded = true; }
  };
  vm.runInNewContext(extract("function showAccountSection", "async function loadEscrowOrders"), context);
  context.showAccountSection("escrow");
  assert.equal(context.activeAccountSection, "escrow");
  assert.equal(nodes.escrowOrdersNav.classList.hidden, false);
  assert.equal(nodes.escrowOrdersSection.classList.hidden, false);
  assert.equal(context.loaded, true);
});

test("signed-out users cannot load or change escrow orders", async () => {
  let called = false;
  const context = {
    currentUser: null,
    firebaseConfig: { projectId: "golden-eagle-marketplace" },
    firebaseFirestore: { collection() { called = true; } },
    firebaseFunctions: { httpsCallable() { called = true; } }
  };
  vm.runInNewContext(extract("async function loadEscrowOrders", "function populateProfileSettings"), context);
  await context.loadEscrowOrders();
  await context.updateEscrowOrderFromProfile({ dataset: { action: "confirm" } });
  assert.equal(called, false);
});

test("payout UI retains a request ID after a timeout and reuses it on retry", async () => {
  const nodes = {};
  const storage = new Map();
  const calls = [];
  let shouldFail = true;
  const document = { getElementById(id) {
    if (!nodes[id]) nodes[id] = { value: "", textContent: "", disabled: false,
      replaceChildren() {}, add() {}, classList: {
      add() {}, remove() {}, toggle() {}
    } };
    return nodes[id];
  } };
  const quote = { grossKobo: 254075, baseFeeKobo: 50000, commissionKobo: 3000,
    providerFeeKobo: 1075, netKobo: 200000, retainedBalanceKobo: 0, debitedKobo: 254075 };
  const context = {
    currentUser: { uid: "vendor", role: "Vendor" }, document,
    Option: function(text, value) { this.text = text; this.value = value; },
    firebaseFirestore: { collection: () => ({
      doc: () => ({ get: async () => ({ exists: false }) }),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true }) }) })
    }) },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    firebaseFunctions: { httpsCallable: name => async data => {
      if (name === "getVendorBankAccount") return { data: {
        configured: true, payoutsEnabled: true, accountName: "Vendor", bankCode: "044", lastFour: "7890", version: "version1"
      } };
      if (name === "getVendorPayoutBanks") return { data: { banks: [{ code: "044", name: "Test Bank" }] } };
      if (name === "getVendorPayoutQuote") return { data: quote };
      if (name === "requestVendorWithdrawal") {
        calls.push(data);
        if (shouldFail) throw new Error("timeout");
        return { data: { status: "PENDING", withdrawalId: "a".repeat(64) } };
      }
      if (name === "checkVendorWithdrawal") return { data: { status: "PAID" } };
      throw new Error("Unexpected callable");
    } },
    crypto: { randomUUID: () => "12345678-1234-1234-1234-123456789abc" },
    window: { confirm: () => true }, formatNaira: String,
    showToast() {}, console: { error() {} }
  };
  vm.runInNewContext(extract("let escrowBankAccount", "function renderVerifiedDealerBadgeSettings"), context);
  await context.loadVendorEscrowPayoutSettings();
  nodes.escrowWithdrawalAmount.value = "2000";
  await context.quoteEscrowWithdrawal({ preventDefault() {} });
  assert.match(nodes.escrowWithdrawalQuote.textContent, /2540.75/);
  await context.submitEscrowWithdrawal();
  assert.ok(storage.has("escrowWithdrawalRequest:vendor"));
  shouldFail = false;
  await context.retryEscrowWithdrawal();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].operationId, calls[1].operationId);
  assert.equal(storage.has("escrowWithdrawalRequest:vendor"), false);
  assert.equal(storage.get("escrowWithdrawalCheck:vendor"), "a".repeat(64));
  await context.checkEscrowWithdrawal();
  assert.equal(storage.has("escrowWithdrawalCheck:vendor"), false);
});
