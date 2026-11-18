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

test("the test checkout confirms server totals before opening Flutterwave", async () => {
  let destination = "";
  let result = { checkoutUrl: "https://checkout.flutterwave.com/v3/hosted/pay/test",
    productPrice: 7500, platformFee: 1375, totalPaid: 8875 };
  const toasts = [];
  const context = {
    firebaseConfig: { projectId: "escrow-test" },
    currentUser: { email: "buyer@example.test" },
    products: [{ id: "p1", price: 7500 }],
    calculateEscrowFee,
    formatNaira: String,
    firebaseFunctions: { httpsCallable: () => async () => ({ data: result }) },
    window: { confirm: () => true, location: { assign: url => { destination = url; } } },
    showToast: message => toasts.push(message),
    console: { error() {} },
    URL
  };
  vm.runInNewContext(extract("async function startEscrowTestCheckout", "function updateDiscussionComposer"), context);
  const button = { disabled: false };
  await context.startEscrowTestCheckout("p1", button);
  assert.match(destination, /^https:\/\/checkout\.flutterwave\.com\//);
  assert.equal(button.disabled, false);
  destination = "";
  result = { ...result, totalPaid: 1 };
  await context.startEscrowTestCheckout("p1", button);
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
    firebaseFunctions: { httpsCallable: name => async () => { called.push(name); } },
    showToast() {},
    console,
    URL
  };
  vm.runInNewContext(extract("async function confirmFlutterwaveReturn", "async function startTimedQuiz"), context);
  await context.confirmFlutterwaveReturn();
  assert.deepEqual(called, ["verifyEscrowPayment"]);
  assert.equal(new URL(replaced).search, "");
});

test("the cart previews the single-product fee without presenting it as active checkout", () => {
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
  assert.match(nodes.cartEscrowPreview.innerHTML, /NGN 1375/);
  assert.match(nodes.cartEscrowPreview.innerHTML, /NGN 8875/);
  assert.match(nodes.cartEscrowPreview.innerHTML, /live escrow checkout is unavailable/i);
  assert.match(nodes.cartCheckout.textContent, /live escrow checkout is unavailable/i);
  context.firebaseConfig.projectId = "escrow-test";
  context.renderCart();
  assert.match(nodes.cartCheckout.innerHTML, /startEscrowTestCheckout/);
  assert.match(nodes.cartCheckout.innerHTML, /test payments only/i);
  context.cartItems[0].quantity = 2;
  context.renderCart();
  assert.match(nodes.cartEscrowPreview.textContent, /one listed product at a time/i);
  assert.match(nodes.cartCheckout.textContent, /unavailable/i);
  context.cartItems.length = 0;
  context.renderCart();
  assert.equal(nodes.cartEscrowPreview.innerHTML, "");
});

test("vendor payout controls stay unavailable when the backend rejects access", async () => {
  const nodes = {};
  const document = { getElementById(id) {
    if (!nodes[id]) nodes[id] = { value: "", textContent: "", classList: {
      hidden: false,
      add() { this.hidden = true; },
      remove() { this.hidden = false; },
      toggle(name, hidden) { this.hidden = hidden; }
    } };
    return nodes[id];
  } };
  const context = {
    currentUser: { uid: "vendor", role: "Vendor" }, document,
    firebaseFunctions: { httpsCallable: () => async () => { throw new Error("unavailable"); } },
    console: { error() {} }
  };
  vm.runInNewContext(extract("let escrowBankAccount", "function renderVerifiedDealerBadgeSettings"), context);
  await context.loadVendorEscrowPayoutSettings();
  assert.equal(nodes.vendorEscrowPayoutControls.classList.hidden, true);
  assert.match(nodes.vendorEscrowPayoutStatus.textContent, /unavailable/i);
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
    firebaseConfig: { projectId: "escrow-test" },
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
});

test("production guard blocks escrow order reads and actions", async () => {
  let called = false;
  const context = {
    currentUser: { uid: "buyer", role: "Buyer" },
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
    if (!nodes[id]) nodes[id] = { value: "", textContent: "", disabled: false, classList: {
      add() {}, remove() {}, toggle() {}
    } };
    return nodes[id];
  } };
  const quote = { grossKobo: 200000, baseFeeKobo: 50000, commissionKobo: 3000,
    providerFeeKobo: 1075, netKobo: 145900, retainedBalanceKobo: 25, debitedKobo: 199975 };
  const context = {
    currentUser: { uid: "vendor", role: "Vendor" }, document,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    firebaseFunctions: { httpsCallable: name => async data => {
      if (name === "getVendorBankAccount") return { data: {
        configured: true, accountName: "Vendor", bankCode: "044", lastFour: "7890", version: "version1"
      } };
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
  assert.match(nodes.escrowWithdrawalQuote.textContent, /1459/);
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
