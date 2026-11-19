const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { calculateEscrowFee } = require("../escrow-fee");

function setup(fetchMock) {
  const documents = new Map();
  const bindings = new WeakMap();
  class HttpsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const db = {
    collection(name) {
      return { where: (field, operator, values) => {
        assert.equal(operator, "in");
        let after = null;
        const query = {
          orderBy() { return this; },
          limit() { return this; },
          startAfter(doc) { after = doc.id; return this; },
          async get() {
            const docs = [...documents.entries()]
              .filter(([key, value]) => key.startsWith(`${name}/`) && values.includes(value[field]))
              .map(([key, value]) => ({ id: key.slice(name.length + 1), data: () => value }))
              .sort((a, b) => a.id.localeCompare(b.id))
              .filter(doc => !after || doc.id > after).slice(0, 100);
            return { empty: docs.length === 0, docs };
          }
        };
        return query;
      }, doc: id => ({
        key: `${name}/${id}`,
        async get() {
          const value = documents.get(this.key);
          return { exists: value !== undefined, data: () => value };
        },
        async create(value) {
          assert.equal(documents.has(this.key), false);
          documents.set(this.key, value);
        }
      }) };
    },
    runTransaction(callback) {
      const run = queue.then(async () => {
        const writes = [];
        const transaction = {
          async get(ref) {
            const value = documents.get(ref.key);
            return { exists: value !== undefined, data: () => value };
          },
          update(ref, data) {
            writes.push(() => {
              assert.ok(documents.has(ref.key));
              documents.set(ref.key, { ...documents.get(ref.key), ...data });
            });
          },
          set(ref, data, options) {
            writes.push(() => documents.set(ref.key,
              options?.merge ? { ...documents.get(ref.key), ...data } : data));
          },
          create(ref, data) {
            writes.push(() => {
              assert.equal(documents.has(ref.key), false);
              documents.set(ref.key, data);
            });
          }
        };
        const result = await callback(transaction);
        writes.forEach(write => write());
        return result;
      });
      queue = run.catch(() => {});
      return run;
    }
  };
  let queue = Promise.resolve();
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  function extract(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first);
    return source.slice(first, last);
  }
  const context = {
    db,
    HttpsError,
    exports: {},
    FieldValue: { serverTimestamp: () => "time" },
    FieldPath: { documentId: () => "__name__" },
    FLW_SECRET_KEY: { value: () => "FLWSECK_TEST-test" },
    FLW_SECRET_HASH: { value: () => "test-webhook-hash" },
    FLUTTERWAVE_SECRET_KEY: { value: () => "FLWSECK_TEST-wallet" },
    FLUTTERWAVE_WEBHOOK_HASH: { value: () => "wallet-webhook-hash" },
    PAYMENT_REDIRECT_URL: "https://goldenphoneshop.github.io/Markertplace.html",
    onCall: (...args) => {
      const handler = args.at(-1);
      bindings.set(handler, args.length > 1 ? args[0] : {});
      return handler;
    },
    onRequest: (...args) => args.at(-1),
    onSchedule: (...args) => {
      const handler = args.at(-1);
      bindings.set(handler, args[0]);
      return handler;
    },
    URLSearchParams,
    URL,
    AbortSignal,
    Buffer,
    crypto,
    calculateEscrowFee,
    escrowFulfillment: require("../escrow-fulfillment"),
    process: { env: {
      GCLOUD_PROJECT: "escrow-test", ESCROW_TEST_PROJECT_ID: "escrow-test",
      ESCROW_TEST_REDIRECT_URL: "https://escrow-test.example.test/"
    } },
    fetch: fetchMock,
    logger: { error() {} }
  };
  context.walletCalls = [];
  context.ensurePurchaseIsVerified = async (...args) => { context.walletCalls.push(args); };
  vm.runInNewContext(
    extract("function requireVerifiedUser", "function requireQuizAdmin") +
    extract("exports.flutterwaveWalletWebhook", "function escrowAmountKobo") +
    extract("function escrowAmountKobo", "exports.getOrCreateGoldenChat"),
    context
  );
  return { documents, functions: context.exports, findVendorPayoutQuote: context.findVendorPayoutQuote, context, bindings };
}

function request(uid, data = {}, admin = false) {
  return {
    auth: { uid, token: { email_verified: true, firebase: {}, admin } },
    data: { orderId: "order1", ...(data.productId ? { fulfillment: { method: "pickup", stationId: "oshodi" } } : {}), ...data }
  };
}

function heldOrder() {
  return {
    buyerUid: "buyer",
    vendorUid: "vendor",
    status: "HELD_IN_ESCROW",
    productPrice: 7500,
    platformFee: 1375,
    totalPaid: 8875
  };
}

test("only the vendor can ship and only the buyer can release after shipment", async () => {
  const { documents, functions } = setup();
  documents.set("escrowOrders/order1", heldOrder());
  await assert.rejects(functions.markOrderShipped(request("other")),
    error => error.code === "permission-denied");
  await assert.rejects(functions.confirmDeliveryAndRelease(request("buyer")),
    error => error.code === "failed-precondition");
  await functions.markOrderShipped(request("vendor"));
  await assert.rejects(functions.confirmDeliveryAndRelease(request("other")),
    error => error.code === "permission-denied");
  const results = await Promise.all([
    functions.confirmDeliveryAndRelease(request("buyer")),
    functions.confirmDeliveryAndRelease(request("buyer"))
  ]);
  assert.equal(results.filter(result => !result.alreadyUpdated).length, 1);
  assert.equal(documents.get("vendorPayoutBalances/vendor").availableKobo, 750000);
  assert.equal(documents.get("escrowPlatformAccounting/revenue").retainedKobo, 137500);
  assert.equal(documents.get("escrowOrders/order1").status, "RELEASED");
  assert.equal(documents.get("escrowReleases/order1").productKobo, 750000);
});

test("disputes block buyer release and only an administrator can release a disputed order", async () => {
  const { documents, functions } = setup();
  documents.set("escrowOrders/order1", heldOrder());
  await functions.openEscrowDispute(request("buyer", { reason: "Item not received" }));
  await assert.rejects(functions.confirmDeliveryAndRelease(request("buyer")),
    error => error.code === "failed-precondition");
  await assert.rejects(functions.resolveEscrowDispute(request("vendor", { decision: "release" })),
    error => error.code === "permission-denied");
  await assert.rejects(functions.resolveEscrowDispute(request("admin", { decision: "refund" }, true)),
    error => error.code === "failed-precondition");
  assert.equal(documents.get("escrowOrders/order1").status, "DISPUTED");
  await functions.resolveEscrowDispute(request("admin", { decision: "release" }, true));
  assert.equal(documents.get("vendorPayoutBalances/vendor").availableKobo, 750000);
});

test("invalid amounts and duplicate ledger entries prevent any release", async () => {
  const { documents, functions } = setup();
  documents.set("escrowOrders/order1", { ...heldOrder(), status: "SHIPPED", totalPaid: 1 });
  await assert.rejects(functions.confirmDeliveryAndRelease(request("buyer")),
    error => error.code === "failed-precondition");
  assert.equal(documents.has("vendorPayoutBalances/vendor"), false);
  documents.set("escrowOrders/order1", { ...heldOrder(), status: "SHIPPED" });
  documents.set("escrowReleases/order1", { productKobo: 750000 });
  await assert.rejects(functions.confirmDeliveryAndRelease(request("buyer")),
    error => error.code === "failed-precondition");
  assert.equal(documents.get("escrowOrders/order1").status, "SHIPPED");
});

test("a dispute racing a release cannot credit a disputed order", async () => {
  const { documents, functions } = setup();
  documents.set("escrowOrders/order1", { ...heldOrder(), status: "SHIPPED" });
  const results = await Promise.allSettled([
    functions.openEscrowDispute(request("buyer", { reason: "Wrong item" })),
    functions.confirmDeliveryAndRelease(request("buyer"))
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(documents.get("escrowOrders/order1").status, "DISPUTED");
  assert.equal(documents.has("vendorPayoutBalances/vendor"), false);
});

test("unverified users cannot update orders", async () => {
  const { documents, functions } = setup();
  documents.set("escrowOrders/order1", heldOrder());
  const vendor = request("vendor");
  vendor.auth.token.email_verified = false;
  await assert.rejects(functions.markOrderShipped(vendor),
    error => error.code === "permission-denied");
  assert.equal(documents.get("escrowOrders/order1").status, "HELD_IN_ESCROW");
});

test("withdrawal quote calculates fees and retains whole-naira rounding", async () => {
  const { findVendorPayoutQuote } = setup();
  const providerFee = async amount => amount <= 5000 ? 1075 : amount <= 50000 ? 2688 : 5375;
  const quote = await findVendorPayoutQuote(200000, providerFee);
  assert.equal(quote.baseFeeKobo, 50000);
  assert.equal(quote.commissionKobo, 3000);
  assert.equal(quote.providerFeeKobo, 1075);
  assert.equal(quote.netKobo, 145900);
  assert.equal(quote.retainedBalanceKobo, 25);
  assert.equal(quote.debitedKobo + quote.retainedBalanceKobo, quote.grossKobo);
  await assert.rejects(findVendorPayoutQuote(199999, providerFee),
    error => error.code === "invalid-argument");
});

test("withdrawal quote handles a provider fee tier boundary without over-debiting", async () => {
  const { findVendorPayoutQuote } = setup();
  const providerFee = async amount => amount <= 5000 ? 1075 : 2688;
  const quote = await findVendorPayoutQuote(560406, providerFee);
  assert.equal(quote.netKobo, 500000);
  assert.equal(quote.providerFeeKobo, 1075);
  assert.equal(quote.retainedBalanceKobo, 925);
  assert.equal(quote.debitedKobo + quote.retainedBalanceKobo, 560406);
});

test("withdrawal commission changes at each configured threshold", async () => {
  const { findVendorPayoutQuote } = setup();
  const providerFee = async () => 0;
  for (const [amountKobo, expected] of [
    [999999, 15000], [1000000, 25000],
    [4999999, 125000], [5000000, 175000],
    [19999999, 700000], [20000000, 1000000]
  ]) {
    const quote = await findVendorPayoutQuote(amountKobo, providerFee);
    assert.equal(quote.commissionKobo, expected);
  }
});

test("the callable checks ownership and uses a Flutterwave quote for the net amount", async () => {
  const amounts = [];
  const { documents, functions } = setup(async url => {
    const parsed = new URL(url);
    amounts.push(Number(parsed.searchParams.get("amount")));
    return {
      ok: true,
      json: async () => ({
        status: "success",
        data: [{ currency: "NGN", fee_type: "value", fee: 26.875 }]
      })
    };
  });
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("vendorPayoutBalances/vendor", { availableKobo: 1000000 });
  const quote = await functions.getVendorPayoutQuote(request("vendor", { amount: 10000 }));
  assert.equal(quote.providerFeeKobo, 2688);
  assert.ok(amounts.includes(quote.netKobo / 100));
  assert.equal(quote.debitedKobo + quote.retainedBalanceKobo, 1000000);
  await assert.rejects(functions.getVendorPayoutQuote(request("other", { amount: 2000 })),
    error => error.code === "permission-denied");
  await assert.rejects(functions.getVendorPayoutQuote(request("vendor", { amount: 10001 })),
    error => error.code === "failed-precondition");
});

function payoutProvider() {
  let transfer;
  let transferCount = 0;
  let transferStatus = "NEW";
  let failTransfer = false;
  return {
    async fetch(url, options = {}) {
      if (url.includes("/transfers/fee?")) {
        return { ok: true, json: async () => ({
          status: "success", data: [{ currency: "NGN", fee_type: "value", fee: 10.75 }]
        }) };
      }
      if (url.endsWith("/accounts/resolve")) {
        const account = JSON.parse(options.body);
        return { ok: true, json: async () => ({
          status: "success", data: { account_number: account.account_number, account_name: "Test Vendor" }
        }) };
      }
      if (url.endsWith("/transfers")) {
        transferCount++;
        if (failTransfer) throw new Error("timeout");
        const input = JSON.parse(options.body);
        transfer = { id: 123, reference: input.reference, amount: input.amount,
          currency: "NGN", fee: 10.75, status: transferStatus };
        return { ok: true, json: async () => ({ status: "success", data: transfer }) };
      }
      assert.ok(url.endsWith("/transfers/123"));
      return { ok: true, json: async () => ({
        status: "success", data: { ...transfer, status: transferStatus }
      }) };
    },
    setStatus(status) { transferStatus = status; },
    fail() { failTransfer = true; },
    get transferCount() { return transferCount; }
  };
}

async function preparePayout(provider) {
  const { documents, functions } = setup(provider.fetch);
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("vendorPayoutBalances/vendor", { availableKobo: 200000 });
  const bank = await functions.saveVendorBankAccount(request("vendor", {
    bankCode: "044", accountNumber: "1234567890"
  }));
  const quote = await functions.getVendorPayoutQuote(request("vendor", { amount: 2000 }));
  return { documents, functions, bank, quote };
}

test("verified bank details are masked and only vendors can register them", async () => {
  const provider = payoutProvider();
  const { functions, bank } = await preparePayout(provider);
  assert.equal(bank.lastFour, "7890");
  assert.equal(Object.hasOwn(bank, "accountNumber"), false);
  const saved = await functions.getVendorBankAccount(request("vendor"));
  assert.equal(saved.lastFour, "7890");
  assert.equal(Object.hasOwn(saved, "accountNumber"), false);
  await assert.rejects(functions.saveVendorBankAccount(request("other", {
    bankCode: "044", accountNumber: "1234567890"
  })), error => error.code === "permission-denied");
});

test("payout functions reject the production project", async () => {
  const provider = payoutProvider();
  const { documents, functions, context } = setup(provider.fetch);
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("vendorPayoutBalances/vendor", { availableKobo: 200000 });
  context.process.env.GCLOUD_PROJECT = "golden-eagle-marketplace";
  context.process.env.ESCROW_TEST_PROJECT_ID = "golden-eagle-marketplace";
  for (const [name, data] of [
    ["getVendorPayoutQuote", { amount: 2000 }],
    ["saveVendorBankAccount", { bankCode: "044", accountNumber: "1234567890" }],
    ["getVendorBankAccount", {}],
    ["requestVendorWithdrawal", {}],
    ["checkVendorWithdrawal", {}]
  ]) {
    await assert.rejects(functions[name](request("vendor", data)),
      error => error.code === "failed-precondition");
  }
  assert.equal(provider.transferCount, 0);
});

test("payout reserves once and credits fees only after verified transfer success", async () => {
  const provider = payoutProvider();
  const { documents, functions, bank, quote } = await preparePayout(provider);
  const data = { amount: 2000, bankVersion: bank.version, quote, operationId: "unique_withdrawal_123456789" };
  const results = await Promise.all([
    functions.requestVendorWithdrawal(request("vendor", data)),
    functions.requestVendorWithdrawal(request("vendor", data))
  ]);
  assert.equal(provider.transferCount, 1);
  assert.equal(documents.get("vendorPayoutBalances/vendor").availableKobo, quote.retainedBalanceKobo);
  const withdrawalId = results[0].withdrawalId;
  await assert.rejects(functions.checkVendorWithdrawal(request("other", { withdrawalId })),
    error => error.code === "not-found");
  assert.equal((await functions.checkVendorWithdrawal(request("vendor", { withdrawalId }))).status, "PENDING");
  assert.equal(documents.has("escrowPlatformAccounting/withdrawalRevenue"), false);
  provider.setStatus("SUCCESSFUL");
  await Promise.all([
    functions.checkVendorWithdrawal(request("vendor", { withdrawalId })),
    functions.checkVendorWithdrawal(request("vendor", { withdrawalId }))
  ]);
  assert.equal(documents.get("escrowWithdrawals/" + withdrawalId).status, "PAID");
  assert.equal(documents.get("escrowPlatformAccounting/withdrawalRevenue").retainedKobo,
    quote.baseFeeKobo + quote.commissionKobo);
});

test("stale bank or changed quote cannot reserve or initiate a payout", async () => {
  const provider = payoutProvider();
  const { documents, functions, bank, quote } = await preparePayout(provider);
  const data = { amount: 2000, bankVersion: bank.version, quote, operationId: "unique_withdrawal_123456789" };
  await assert.rejects(functions.requestVendorWithdrawal(request("vendor", {
    ...data, quote: { ...quote, providerFeeKobo: quote.providerFeeKobo + 1 }
  })), error => error.code === "failed-precondition");
  await functions.saveVendorBankAccount(request("vendor", { bankCode: "044", accountNumber: "1234567890" }));
  await assert.rejects(functions.requestVendorWithdrawal(request("vendor", data)),
    error => error.code === "failed-precondition");
  assert.equal(provider.transferCount, 0);
  assert.equal(documents.get("vendorPayoutBalances/vendor").availableKobo, 200000);
});

test("an ambiguous transfer remains reserved and cannot be sent again", async () => {
  const provider = payoutProvider();
  const { documents, functions, bank, quote } = await preparePayout(provider);
  provider.fail();
  const data = { amount: 2000, bankVersion: bank.version, quote, operationId: "unique_withdrawal_123456789" };
  await assert.rejects(functions.requestVendorWithdrawal(request("vendor", data)),
    error => error.code === "unavailable");
  const retry = await functions.requestVendorWithdrawal(request("vendor", data));
  assert.equal(retry.status, "INITIATING");
  assert.equal(provider.transferCount, 1);
  assert.equal(documents.get("vendorPayoutBalances/vendor").availableKobo, quote.retainedBalanceKobo);
  await assert.rejects(functions.checkVendorWithdrawal(request("vendor", { withdrawalId: retry.withdrawalId })),
    error => error.code === "failed-precondition");
});

test("a failed provider transfer remains reserved for support review", async () => {
  const provider = payoutProvider();
  const { documents, functions, bank, quote } = await preparePayout(provider);
  const result = await functions.requestVendorWithdrawal(request("vendor", {
    amount: 2000, bankVersion: bank.version, quote, operationId: "unique_withdrawal_123456789"
  }));
  provider.setStatus("FAILED");
  await assert.rejects(functions.checkVendorWithdrawal(request("vendor", { withdrawalId: result.withdrawalId })),
    error => error.code === "failed-precondition");
  assert.equal(documents.get("vendorPayoutBalances/vendor").availableKobo, quote.retainedBalanceKobo);
  assert.equal(documents.has("escrowPlatformAccounting/withdrawalRevenue"), false);
});

test("concurrent payout requests cannot reserve the same balance twice", async () => {
  const provider = payoutProvider();
  const { documents, functions, bank, quote } = await preparePayout(provider);
  const data = { amount: 2000, bankVersion: bank.version, quote };
  const results = await Promise.allSettled([
    functions.requestVendorWithdrawal(request("vendor", { ...data, operationId: "unique_withdrawal_123456789" })),
    functions.requestVendorWithdrawal(request("vendor", { ...data, operationId: "unique_withdrawal_987654321" }))
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(provider.transferCount, 1);
  assert.equal(documents.get("vendorPayoutBalances/vendor").availableKobo, quote.retainedBalanceKobo);
});

test("sandbox checkout uses the server listing price and creates an order exactly once after verification", async () => {
  let payload;
  const { documents, functions } = setup(async (url, options) => {
    if (url.endsWith("/payments")) {
      payload = JSON.parse(options.body);
      return { ok: true, json: async () => ({
        status: "success", data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/test" }
      }) };
    }
    return { ok: true, json: async () => ({
      status: "success",
      data: { id: 123, status: "successful", tx_ref: payload.tx_ref,
        amount: 8062.5, currency: "NGN", customer: { email: "buyer@example.test" } }
    }) };
  });
  documents.set("users/buyer", { role: "Buyer" });
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("products/product1", {
    ownerUid: "vendor", title: "Phone", stock: 1, price: 7500
  });
  await assert.rejects(functions.initiateEscrowCheckout(request("buyer", {
    productId: "product1", expectedPrice: 1, checkoutEmail: "buyer@example.test"
  })), error => error.code === "failed-precondition");
  const checkout = await functions.initiateEscrowCheckout(request("buyer", {
    productId: "product1", expectedPrice: 7500, checkoutEmail: "buyer@example.test"
  }));
  assert.equal(payload.amount, 8062.5);
  assert.equal(checkout.platformFee, 562.5);
  assert.equal(checkout.totalPaid, 8062.5);
  assert.equal(payload.configurations.session_duration, 15);
  assert.equal(documents.get("products/product1").stock, 0);
  assert.equal(documents.get(`escrowPendingPayments/${checkout.txRef}`).reservationStatus, "HELD");
  assert.equal(Object.hasOwn(payload, "subaccounts"), false);
  await assert.rejects(functions.verifyEscrowPayment(request("other", {
    txRef: checkout.txRef, transactionId: "123"
  })), error => error.code === "not-found");
  const attempts = await Promise.all([
    functions.verifyEscrowPayment(request("buyer", { txRef: checkout.txRef, transactionId: "123" })),
    functions.verifyEscrowPayment(request("buyer", { txRef: checkout.txRef, transactionId: "123" }))
  ]);
  assert.equal(attempts.filter(result => !result.alreadyVerified).length, 1);
  assert.equal(documents.get(`escrowOrders/${checkout.txRef}`).status, "HELD_IN_ESCROW");
  assert.equal(documents.get(`escrowOrders/${checkout.txRef}`).totalPaid, 8062.5);
});

test("concurrent checkout requests cannot reserve the same final item", async () => {
  const { documents, functions } = setup(async () => ({
    ok: true, json: async () => ({ status: "success",
      data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/test" } })
  }));
  documents.set("users/buyer", { role: "Buyer" });
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("products/product1", { ownerUid: "vendor", title: "Phone", stock: 1, price: 7500 });
  const data = { productId: "product1", expectedPrice: 7500, checkoutEmail: "buyer@example.test" };
  const results = await Promise.allSettled([
    functions.initiateEscrowCheckout(request("buyer", data)),
    functions.initiateEscrowCheckout(request("buyer", data))
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(documents.get("products/product1").stock, 0);
});

test("checkout recalculates the fee when a vendor changes a listing price", async () => {
  const amounts = [];
  const { documents, functions } = setup(async (url, options) => {
    amounts.push(JSON.parse(options.body).amount);
    return { ok: true, json: async () => ({ status: "success",
      data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/test" } }) };
  });
  documents.set("users/buyer", { role: "Buyer" });
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("products/product1", { ownerUid: "vendor", title: "Phone", stock: 2, price: 1234.56 });
  const data = { productId: "product1", expectedPrice: 1234.56, checkoutEmail: "buyer@example.test" };
  const first = await functions.initiateEscrowCheckout(request("buyer", data));
  assert.equal(first.platformFee, 92.59);
  assert.equal(first.totalPaid, 1327.15);
  documents.get("products/product1").price = 2456.78;
  await assert.rejects(functions.initiateEscrowCheckout(request("buyer", data)),
    error => error.code === "failed-precondition");
  const second = await functions.initiateEscrowCheckout(request("buyer", { ...data, expectedPrice: 2456.78 }));
  assert.equal(second.platformFee, 184.26);
  assert.equal(second.totalPaid, 2641.04);
  assert.deepEqual(amounts, [1327.15, 2641.04]);
});

test("vendor vouchers discount checkout once per buyer and reduce vendor proceeds", async () => {
  let payload;
  const { documents, functions } = setup(async (url, options) => {
    if (url.endsWith("/payments")) {
      payload = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: "success",
        data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/test" } }) };
    }
    return { ok: true, json: async () => ({ status: "success", data: {
      id: 123, status: "successful", tx_ref: payload.tx_ref, amount: 7256.25,
      currency: "NGN", customer: { email: "buyer@example.test" }
    } }) };
  });
  documents.set("users/buyer", { role: "Buyer" });
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("products/product1", { ownerUid: "vendor", title: "Phone", stock: 2, price: 7500 });
  await functions.createStoreVoucher(request("vendor", { code: "SAVE10", scope: "store", type: "percent", value: 10 }));
  const quote = await functions.quoteStoreVoucher(request("buyer", { code: "save10", productId: "product1" }));
  assert.equal(quote.discount, 750);
  assert.equal(quote.productPrice, 6750);
  assert.equal(quote.platformFee, 506.25);
  const data = { productId: "product1", expectedPrice: 7500, checkoutEmail: "buyer@example.test",
    voucherCode: "SAVE10", expectedDiscount: 750 };
  const attempts = await Promise.allSettled([
    functions.initiateEscrowCheckout(request("buyer", data)),
    functions.initiateEscrowCheckout(request("buyer", data))
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const checkout = attempts.find(result => result.status === "fulfilled").value;
  assert.equal(payload.amount, 7256.25);
  await functions.verifyEscrowPayment(request("buyer", { txRef: checkout.txRef, transactionId: "123" }));
  const order = documents.get(`escrowOrders/${checkout.txRef}`);
  assert.equal(order.productPrice, 6750);
  assert.equal(order.originalProductPrice, 7500);
  assert.equal(order.discount, 750);
  await functions.markOrderShipped(request("vendor", { orderId: checkout.txRef }));
  await functions.confirmDeliveryAndRelease(request("buyer", { orderId: checkout.txRef }));
  assert.equal(documents.get("vendorPayoutBalances/vendor").availableKobo, 675000);
  await assert.rejects(functions.quoteStoreVoucher(request("buyer", { code: "SAVE10", productId: "product1" })),
    error => error.code === "failed-precondition");
});

test("platform vouchers require informed vendor participation and enforce expiry and price checks", async () => {
  const { documents, functions } = setup();
  documents.set("users/buyer", { role: "Buyer" });
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("products/product1", { ownerUid: "vendor", title: "Phone", stock: 1, price: 7500 });
  await assert.rejects(functions.createStoreVoucher(request("vendor", {
    code: "GLOBAL", scope: "platform", type: "fixed", value: 500
  })), error => error.code === "permission-denied");
  await functions.createStoreVoucher(request("admin", { code: "GLOBAL", scope: "platform", type: "fixed", value: 500 }, true));
  const terms = await functions.getPlatformVoucher(request("vendor", { code: "GLOBAL" }));
  assert.equal(terms.value, 500);
  assert.equal(terms.type, "fixed");
  await assert.rejects(functions.quoteStoreVoucher(request("buyer", { code: "GLOBAL", productId: "product1" })),
    error => error.code === "failed-precondition");
  await functions.setPlatformVoucherOptIn(request("vendor", { code: "GLOBAL", enabled: true }));
  const quote = await functions.quoteStoreVoucher(request("buyer", { code: "GLOBAL", productId: "product1" }));
  assert.equal(quote.productPrice, 7000);
  await assert.rejects(functions.initiateEscrowCheckout(request("buyer", {
    productId: "product1", expectedPrice: 7500, checkoutEmail: "buyer@example.test",
    voucherCode: "GLOBAL", expectedDiscount: 1
  })), error => error.code === "failed-precondition");
  await functions.setPlatformVoucherOptIn(request("vendor", { code: "GLOBAL", enabled: false }));
  await assert.rejects(functions.quoteStoreVoucher(request("buyer", { code: "GLOBAL", productId: "product1" })),
    error => error.code === "failed-precondition");
  documents.get("storeVouchers/GLOBAL").expiresAtMs = Date.now() - 1;
  await assert.rejects(functions.setPlatformVoucherOptIn(request("vendor", { code: "GLOBAL", enabled: true })),
    error => error.code === "failed-precondition");
});

test("a late voucher payment is refunded instead of reusing a voucher reserved by another checkout", async () => {
  const payments = [];
  const { documents, functions } = setup(async (url, options) => {
    if (url.endsWith("/payments")) {
      payments.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ status: "success",
        data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/test" } }) };
    }
    if (url.includes("verify_by_reference")) {
      return { ok: true, json: async () => ({ status: "success", data: { status: "failed" } }) };
    }
    if (url.endsWith("/refund")) {
      assert.equal(JSON.parse(options.body).amount, 7256.25);
      return { ok: true, json: async () => ({ status: "success",
        data: { id: 501, tx_id: 123, amount_refunded: 7256.25, status: "completed" } }) };
    }
    return { ok: true, json: async () => ({ status: "success", data: {
      id: 123, status: "successful", tx_ref: payments[0].tx_ref, amount: 7256.25,
      currency: "NGN", customer: { email: "buyer@example.test" }
    } }) };
  });
  documents.set("users/buyer", { role: "Buyer" });
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("products/product1", { ownerUid: "vendor", title: "Phone", stock: 2, price: 7500 });
  await functions.createStoreVoucher(request("vendor", { code: "SAVE10", scope: "store", type: "percent", value: 10 }));
  const data = { productId: "product1", expectedPrice: 7500, checkoutEmail: "buyer@example.test",
    voucherCode: "SAVE10", expectedDiscount: 750 };
  const first = await functions.initiateEscrowCheckout(request("buyer", data));
  documents.get(`escrowPendingPayments/${first.txRef}`).reservationExpiresAtMs = Date.now() - 1;
  await functions.reconcileExpiredEscrowPayments();
  const second = await functions.initiateEscrowCheckout(request("buyer", data));
  const verification = await functions.verifyEscrowPayment(request("buyer", { txRef: first.txRef, transactionId: "123" }));
  assert.equal(verification.status, "REFUND_PENDING");
  assert.equal(documents.get(`escrowOrders/${first.txRef}`).status, "REFUND_PENDING");
  const redemption = [...documents.entries()].find(([key]) => key.startsWith("voucherRedemptions/"))[1];
  assert.equal(redemption.txRef, second.txRef);
  assert.equal(redemption.status, "RESERVED");
});

test("delivery checkout validates details, charges the trusted fee and settles it to the marketplace", async () => {
  let payload;
  const { documents, functions } = setup(async (url, options) => {
    if (url.endsWith("/payments")) {
      payload = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: "success",
        data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/test" } }) };
    }
    return { ok: true, json: async () => ({ status: "success", data: {
      id: 123, status: "successful", tx_ref: payload.tx_ref, amount: 10812.5,
      currency: "NGN", customer: { email: "buyer@example.test" }
    } }) };
  });
  documents.set("users/buyer", { role: "Buyer" });
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("products/product1", { ownerUid: "vendor", title: "Phone", stock: 1, price: 7500 });
  const delivery = { method: "delivery", address: "12 Main Street", city: "Ikeja",
    state: "Lagos", phone: "08012345678", landmark: "Market" };
  const data = { productId: "product1", expectedPrice: 7500, checkoutEmail: "buyer@example.test" };
  for (const fulfillment of [null, { method: "pickup", stationId: "invalid" },
    { ...delivery, address: " " }, { ...delivery, phone: "abc" }]) {
    await assert.rejects(functions.initiateEscrowCheckout(request("buyer", { ...data, fulfillment })),
      error => error.code === "invalid-argument");
  }
  assert.equal(documents.get("products/product1").stock, 1);
  const checkout = await functions.initiateEscrowCheckout(request("buyer", {
    ...data, fulfillment: delivery, fulfillmentFee: 0
  }));
  assert.equal(checkout.fulfillmentFee, 2750);
  assert.equal(payload.amount, 10812.5);
  assert.equal(payload.meta.fulfillment.address, delivery.address);
  assert.equal(payload.meta.fulfillmentFee, 2750);
  await functions.verifyEscrowPayment(request("buyer", { txRef: checkout.txRef, transactionId: "123" }));
  const order = documents.get(`escrowOrders/${checkout.txRef}`);
  assert.equal(order.fulfillment.phone, delivery.phone);
  assert.equal(order.fulfillmentFee, 2750);
  await functions.markOrderShipped(request("vendor", { orderId: checkout.txRef }));
  await functions.confirmDeliveryAndRelease(request("buyer", { orderId: checkout.txRef }));
  assert.equal(documents.get("vendorPayoutBalances/vendor").availableKobo, 750000);
  assert.equal(documents.get("escrowPlatformAccounting/revenue").retainedKobo, 331250);
});

test("pickup details are persisted using the selected server-side station", async () => {
  let payload;
  const { documents, functions } = setup(async (url, options) => {
    if (url.endsWith("/payments")) {
      payload = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: "success",
        data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/test" } }) };
    }
    return { ok: true, json: async () => ({ status: "success", data: {
      id: 123, status: "successful", tx_ref: payload.tx_ref, amount: 8062.5,
      currency: "NGN", customer: { email: "buyer@example.test" }
    } }) };
  });
  documents.set("users/buyer", { role: "Buyer" });
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("products/product1", { ownerUid: "vendor", title: "Phone", stock: 1, price: 7500 });
  const checkout = await functions.initiateEscrowCheckout(request("buyer", {
    productId: "product1", expectedPrice: 7500, checkoutEmail: "buyer@example.test",
    fulfillment: { method: "pickup", stationId: "ikeja", stationName: "untrusted" }
  }));
  assert.equal(checkout.fulfillmentFee, 0);
  assert.match(payload.meta.fulfillment.stationName, /Computer Village/);
  await functions.verifyEscrowPayment(request("buyer", { txRef: checkout.txRef, transactionId: "123" }));
  assert.match(documents.get(`escrowOrders/${checkout.txRef}`).fulfillment.stationName, /Computer Village/);
});

test("expired stock is released once and missed successful payment is recovered", async () => {
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  let successful = false;
  const payment = { id: 123, status: "successful", tx_ref: txRef, amount: 8875,
    currency: "NGN", customer: { email: "buyer@example.test" } };
  const { documents, functions } = setup(async url => {
    if (url.includes("verify_by_reference")) {
      return { ok: true, json: async () => ({ status: "success",
        data: successful ? payment : { status: "failed" } }) };
    }
    return { ok: true, json: async () => ({ status: "success", data: payment }) };
  });
  documents.set("products/product1", { ownerUid: "vendor", stock: 0 });
  documents.set(`escrowPendingPayments/${txRef}`, {
    ...heldOrder(), productId: "product1", productTitle: "Phone", email: "buyer@example.test",
    status: "PENDING", reservationStatus: "HELD", reservationExpiresAtMs: Date.now() - 1, currency: "NGN"
  });
  await functions.reconcileExpiredEscrowPayments();
  await functions.reconcileExpiredEscrowPayments();
  assert.equal(documents.get("products/product1").stock, 1);
  successful = true;
  await functions.reconcileExpiredEscrowPayments();
  assert.equal(documents.get("products/product1").stock, 0);
  assert.equal(documents.get(`escrowOrders/${txRef}`).status, "HELD_IN_ESCROW");
});

test("verified failed payment releases the reservation exactly once, even before expiry", async () => {
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  let reference = "wrong-reference";
  const calls = [];
  const { documents, functions } = setup(async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    return { ok: true, json: async () => ({
      status: "success", data: { id: 123, tx_ref: reference, status: "failed" }
    }) };
  });
  documents.set("products/product1", { ownerUid: "vendor", stock: 0 });
  documents.set(`escrowPendingPayments/${txRef}`, {
    buyerUid: "buyer", vendorUid: "vendor", productId: "product1",
    email: "buyer@example.test", totalPaid: 8875, status: "PENDING",
    reservationStatus: "HELD", reservationExpiresAtMs: Date.now() + 900000
  });
  const event = { method: "POST", get: () => "test-webhook-hash",
    body: { event: "charge.failed", data: { id: 123, tx_ref: txRef, status: "failed" } } };
  function response() {
    return { status(code) { this.code = code; return this; }, send() {} };
  }
  const invalid = response();
  await functions.flutterwaveEscrowTestWebhook(event, invalid);
  assert.equal(invalid.code, 500);
  assert.equal(documents.get("products/product1").stock, 0);
  reference = txRef;
  const responses = [response(), response()];
  await Promise.all(responses.map(res => functions.flutterwaveEscrowTestWebhook(event, res)));
  assert.ok(responses.every(res => res.code === 200));
  assert.equal(documents.get("products/product1").stock, 1);
  assert.equal(documents.get(`escrowPendingPayments/${txRef}`).reservationStatus, "RELEASED");
  assert.ok(calls.every(call => call.url === "https://api.flutterwave.com/v3/transactions/123/verify" &&
    call.authorization === "Bearer FLWSECK_TEST-test"));
  await assert.rejects(functions.verifyEscrowPayment(request("buyer", { txRef, transactionId: "123" })),
    error => error.code === "failed-precondition");
  assert.equal(documents.get("products/product1").stock, 1);
});

test("late paid order with no stock initiates a full refund", async () => {
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  let refunds = 0;
  const { documents, functions } = setup(async (url, options) => {
    if (url.endsWith("/refund")) {
      refunds++;
      assert.equal(JSON.parse(options.body).amount, 8875);
      return { ok: true, json: async () => ({ status: "success",
        data: { id: 501, tx_id: 123, amount_refunded: 8875, status: "completed" } }) };
    }
    return { ok: true, json: async () => ({ status: "success", data: {
      id: 123, status: "successful", tx_ref: txRef, amount: 8875, currency: "NGN",
      customer: { email: "buyer@example.test" }
    } }) };
  });
  documents.set("products/product1", { ownerUid: "vendor", stock: 0 });
  documents.set(`escrowPendingPayments/${txRef}`, {
    ...heldOrder(), productId: "product1", productTitle: "Phone", email: "buyer@example.test",
    status: "PENDING", reservationStatus: "RELEASED", reservationExpiresAtMs: Date.now() - 1, currency: "NGN"
  });
  await functions.verifyEscrowPayment(request("buyer", { txRef, transactionId: "123" }));
  await functions.verifyEscrowPayment(request("buyer", { txRef, transactionId: "123" }));
  assert.equal(refunds, 1);
  assert.equal(documents.get(`escrowOrders/${txRef}`).status, "REFUND_PENDING");
});

test("scheduled recovery initiates a late refund if processing stopped before the request", async () => {
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  let refunds = 0;
  const { documents, functions } = setup(async (url, options) => {
    assert.ok(url.endsWith("/refund"));
    refunds++;
    assert.equal(JSON.parse(options.body).amount, 8875);
    return { ok: true, json: async () => ({ status: "success",
      data: { id: 501, tx_id: 123, amount_refunded: 8875, status: "completed" } }) };
  });
  documents.set(`escrowPendingPayments/${txRef}`, {
    status: "VERIFIED", reservationStatus: "REFUND_NEEDED"
  });
  documents.set(`escrowOrders/${txRef}`, {
    ...heldOrder(), status: "AUTO_REFUND_REQUIRED", transactionId: "123"
  });
  await functions.reconcileExpiredEscrowPayments();
  await functions.reconcileExpiredEscrowPayments();
  assert.equal(refunds, 1);
  assert.equal(documents.get(`escrowOrders/${txRef}`).status, "REFUND_PENDING");
});

test("sandbox checkout rejects totals below Flutterwave's minimum refund", async () => {
  let called = false;
  const { documents, functions } = setup(async () => { called = true; });
  documents.set("users/buyer", { role: "Buyer" });
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("products/product1", { ownerUid: "vendor", title: "Phone", stock: 1, price: 50 });
  await assert.rejects(functions.initiateEscrowCheckout(request("buyer", {
    productId: "product1", expectedPrice: 50, checkoutEmail: "buyer@example.test"
  })), error => error.code === "failed-precondition");
  await assert.rejects(functions.initiateEscrowCheckout(request("buyer", {
    productId: "product1", expectedPrice: 50, checkoutEmail: "buyer@example.test",
    fulfillment: { method: "delivery", address: "12 Main Street", city: "Ikeja",
      state: "Lagos", phone: "08012345678" }
  })), error => error.code === "failed-precondition");
  assert.equal(called, false);
});

test("a mismatched sandbox payment cannot create an order", async () => {
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  const { documents, functions } = setup(async () => ({
    ok: true,
    json: async () => ({
      status: "success", data: {
        id: 123, status: "successful", tx_ref: txRef, amount: 1, currency: "NGN",
        customer: { email: "buyer@example.test" }
      }
    })
  }));
  documents.set(`escrowPendingPayments/${txRef}`, {
    buyerUid: "buyer", email: "buyer@example.test", totalPaid: 8875, status: "PENDING"
  });
  await assert.rejects(functions.verifyEscrowPayment(request("buyer", {
    txRef, transactionId: "123"
  })), error => error.code === "failed-precondition");
  assert.equal(documents.has(`escrowOrders/${txRef}`), false);
});

test("production checkout, verification and webhook use the wallet merchant key", async () => {
  let payment;
  const { documents, functions, context } = setup(async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer FLWSECK-live");
    if (url.endsWith("/payments")) {
      payment = JSON.parse(options.body);
      return { ok: true, json: async () => ({
        status: "success", data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/live" }
      }) };
    }
    assert.match(url, /\/transactions\/123\/verify$/);
    return { ok: true, json: async () => ({
      status: "success", data: {
        id: 123, status: "successful", tx_ref: payment.tx_ref, amount: 91375, currency: "NGN",
        customer: { email: "buyer@example.test" }
      }
    }) };
  });
  context.process.env.GCLOUD_PROJECT = "golden-eagle-marketplace";
  context.FLW_SECRET_KEY.value = () => "FLWSECK-different-escrow-merchant";
  context.FLUTTERWAVE_SECRET_KEY.value = () => "FLWSECK-live";
  documents.set("users/buyer", { role: "Buyer" });
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("products/product1", { ownerUid: "vendor", title: "Phone", stock: 1, price: 85000 });
  const checkout = await functions.initiateEscrowCheckout(request("buyer", {
    productId: "product1", expectedPrice: 85000, checkoutEmail: "buyer@example.test"
  }));
  assert.equal(payment.amount, 91375);
  assert.equal(checkout.platformFee, 6375);
  assert.equal(payment.redirect_url, "https://goldenphoneshop.github.io/Markertplace.html");
  await functions.verifyEscrowPayment(request("buyer", { txRef: checkout.txRef, transactionId: "123" }));
  assert.equal(documents.get(`escrowOrders/${checkout.txRef}`).status, "HELD_IN_ESCROW");
  const response = { code: null, status(code) { this.code = code; return this; }, send() {} };
  await functions.flutterwaveWalletWebhook({
    get: () => "wallet-webhook-hash",
    body: { event: "charge.completed", data: { id: 123, tx_ref: checkout.txRef } }
  }, response);
  assert.equal(response.code, 200);
});

test("escrow payment functions bind both production and sandbox secrets", () => {
  const { functions, context, bindings } = setup();
  for (const name of ["initiateEscrowCheckout", "verifyEscrowPayment", "reconcileExpiredEscrowPayments"]) {
    const secrets = bindings.get(functions[name]).secrets;
    assert.ok(secrets.includes(context.FLW_SECRET_KEY));
    assert.ok(secrets.includes(context.FLUTTERWAVE_SECRET_KEY));
  }
});

test("checkout rejects keys from the wrong environment or an unconfigured project", async () => {
  const { functions, context } = setup();
  context.process.env.GCLOUD_PROJECT = "golden-eagle-marketplace";
  context.process.env.ESCROW_TEST_PROJECT_ID = "golden-eagle-marketplace";
  await assert.rejects(functions.initiateEscrowCheckout(request("buyer")),
    error => error.code === "failed-precondition");
  context.FLUTTERWAVE_SECRET_KEY.value = () => "FLWSECK-";
  await assert.rejects(functions.initiateEscrowCheckout(request("buyer")),
    error => error.code === "failed-precondition");
  context.process.env.GCLOUD_PROJECT = "escrow-test";
  context.process.env.ESCROW_TEST_PROJECT_ID = "escrow-test";
  context.FLW_SECRET_KEY.value = () => "FLWSECK-live";
  await assert.rejects(functions.initiateEscrowCheckout(request("buyer")),
    error => error.code === "failed-precondition");
  context.process.env.GCLOUD_PROJECT = "other-project";
  context.FLW_SECRET_KEY.value = () => "FLWSECK_TEST-test";
  await assert.rejects(functions.initiateEscrowCheckout(request("buyer")),
    error => error.code === "failed-precondition");
});

test("sandbox webhook validates its hash and verifies payment before creating an order", async () => {
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  const { documents, functions } = setup(async () => ({
    ok: true, json: async () => ({
      status: "success",
      data: { id: 123, status: "successful", tx_ref: txRef, amount: 8875, currency: "NGN",
        customer: { email: "buyer@example.test" } }
    })
  }));
  documents.set(`escrowPendingPayments/${txRef}`, {
    ...heldOrder(), productId: "product1", productTitle: "Phone",
    email: "buyer@example.test", status: "PENDING", reservationStatus: "HELD", currency: "NGN"
  });
  function response() {
    return {
      code: null,
      status(code) { this.code = code; return this; },
      send() {}
    };
  }
  const event = {
    method: "POST",
    body: { event: "charge.completed", data: { id: 123, tx_ref: txRef, status: "successful" } },
    get: () => "wrong-hash"
  };
  const denied = response();
  await functions.flutterwaveEscrowTestWebhook(event, denied);
  assert.equal(denied.code, 401);
  assert.equal(documents.has(`escrowOrders/${txRef}`), false);
  event.get = () => "test-webhook-hash";
  const accepted = response();
  await functions.flutterwaveEscrowTestWebhook(event, accepted);
  assert.equal(accepted.code, 200);
  assert.equal(documents.get(`escrowOrders/${txRef}`).status, "HELD_IN_ESCROW");
  const duplicate = response();
  await functions.flutterwaveEscrowTestWebhook(event, duplicate);
  assert.equal(duplicate.code, 200);
});

test("shared webhook keeps wallet routing and only routes escrow when enabled", async () => {
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  const { documents, functions, context } = setup(async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer FLWSECK_TEST-wallet");
    return { ok: true, json: async () => ({
      status: "success",
      data: { id: 123, status: "successful", tx_ref: txRef, amount: 8875, currency: "NGN",
        customer: { email: "buyer@example.test" } }
    }) };
  });
  documents.set(`escrowPendingPayments/${txRef}`, {
    ...heldOrder(), productId: "product1", productTitle: "Phone",
    email: "buyer@example.test", status: "PENDING", reservationStatus: "HELD", currency: "NGN"
  });
  function response() {
    return { code: null, status(code) { this.code = code; return this; }, send() {} };
  }
  const wallet = { get: () => "wallet-webhook-hash",
    body: { event: "charge.completed", data: { id: 99, tx_ref: "wallet-reference", status: "successful" } } };
  await functions.flutterwaveWalletWebhook(wallet, response());
  assert.equal(context.walletCalls.length, 1);
  context.process.env.ESCROW_LIVE_WEBHOOK_ENABLED = "true";
  const escrow = { get: () => "incorrect", body: { event: "charge.completed",
    data: { id: 123, tx_ref: txRef, status: "successful" } } };
  const denied = response();
  await functions.flutterwaveWalletWebhook(escrow, denied);
  assert.equal(denied.code, 401);
  assert.equal(documents.has(`escrowOrders/${txRef}`), false);
  escrow.get = () => "wallet-webhook-hash";
  const accepted = response();
  await functions.flutterwaveWalletWebhook(escrow, accepted);
  assert.equal(accepted.code, 200);
  assert.equal(documents.get(`escrowOrders/${txRef}`).status, "HELD_IN_ESCROW");
  await functions.flutterwaveWalletWebhook(wallet, response());
  assert.equal(context.walletCalls.length, 2);
});

test("production shared webhook routes verified escrow payments without a flag", async () => {
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  const { documents, functions, context } = setup(async (url, options) => {
    assert.match(url, /\/transactions\/123\/verify$/);
    assert.equal(options.headers.Authorization, "Bearer FLWSECK-live-wallet");
    return { ok: true, json: async () => ({
      status: "success",
      data: { id: 123, status: "successful", tx_ref: txRef, amount: 8875, currency: "NGN",
        customer: { email: "buyer@example.test" } }
    }) };
  });
  context.process.env.GCLOUD_PROJECT = "golden-eagle-marketplace";
  context.FLUTTERWAVE_SECRET_KEY.value = () => "FLWSECK-live-wallet";
  documents.set(`escrowPendingPayments/${txRef}`, {
    ...heldOrder(), productId: "product1", productTitle: "Phone",
    email: "buyer@example.test", status: "PENDING", reservationStatus: "HELD", currency: "NGN"
  });
  const response = () => ({ code: null, status(code) { this.code = code; return this; }, send() {} });
  const event = { get: () => "wrong-hash",
    body: { event: "charge.completed", data: { id: 123, tx_ref: txRef } } };
  const denied = response();
  await functions.flutterwaveWalletWebhook(event, denied);
  assert.equal(denied.code, 401);
  assert.equal(documents.has(`escrowOrders/${txRef}`), false);
  event.get = () => "wallet-webhook-hash";
  const accepted = response();
  await functions.flutterwaveWalletWebhook(event, accepted);
  assert.equal(accepted.code, 200);
  assert.equal(documents.get(`escrowOrders/${txRef}`).status, "HELD_IN_ESCROW");
  assert.equal(context.walletCalls.length, 0);
  await functions.flutterwaveWalletWebhook(event, response());
  assert.equal(documents.get(`escrowOrders/${txRef}`).status, "HELD_IN_ESCROW");
  await functions.flutterwaveWalletWebhook({
    get: () => "wallet-webhook-hash",
    body: { event: "charge.completed", data: { id: 99, tx_ref: "wallet-reference" } }
  }, response());
  assert.equal(context.walletCalls.length, 1);
});

test("production escrow webhook reports provider verification failures for retry", async () => {
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  const { documents, functions, context } = setup(async () => ({ ok: false }));
  context.process.env.GCLOUD_PROJECT = "golden-eagle-marketplace";
  documents.set(`escrowPendingPayments/${txRef}`, {
    ...heldOrder(), email: "buyer@example.test", status: "PENDING", reservationStatus: "HELD"
  });
  const response = { code: null, status(code) { this.code = code; return this; }, send() {} };
  await functions.flutterwaveWalletWebhook({
    get: () => "wallet-webhook-hash",
    body: { event: "charge.completed", data: { id: 123, tx_ref: txRef } }
  }, response);
  assert.equal(response.code, 500);
  assert.equal(documents.has(`escrowOrders/${txRef}`), false);
  assert.equal(context.walletCalls.length, 0);
});

test("sandbox webhook verifies transfer and refund events before finalizing once", async () => {
  const withdrawalId = "a".repeat(64);
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  let transferAmount = 1;
  const { documents, functions } = setup(async url => {
    if (url.endsWith("/transfers/123")) return { ok: true, json: async () => ({
      status: "success", data: {
        id: 123, reference: `escrow-payout-${withdrawalId}`, amount: transferAmount,
        currency: "NGN", fee: 10.75, status: "SUCCESSFUL"
      }
    }) };
    assert.ok(url.endsWith("/refunds/501"));
    return { ok: true, json: async () => ({
      id: 501, transaction_id: 321, amount_refunded: 8875, status: "completed-bank-transfer"
    }) };
  });
  documents.set(`escrowWithdrawals/${withdrawalId}`, {
    vendorUid: "vendor", reference: `escrow-payout-${withdrawalId}`, netKobo: 145900,
    providerFeeKobo: 1075, baseFeeKobo: 50000, commissionKobo: 3000,
    status: "PENDING", providerTransferId: "123"
  });
  documents.set(`escrowPaymentTransactions/321`, { txRef });
  documents.set(`escrowOrders/${txRef}`, { status: "REFUND_PENDING" });
  documents.set(`escrowRefunds/${txRef}`, {
    status: "PENDING", providerRefundId: "501", transactionId: "321", amountKobo: 887500
  });
  function response() {
    return { code: null, status(code) { this.code = code; return this; }, send() {} };
  }
  const transferEvent = {
    method: "POST", get: () => "test-webhook-hash",
    body: { event: "transfer.completed", data: { id: 123, reference: `escrow-payout-${withdrawalId}` } }
  };
  const bad = response();
  await functions.flutterwaveEscrowTestWebhook(transferEvent, bad);
  assert.equal(bad.code, 500);
  assert.equal(documents.get(`escrowWithdrawals/${withdrawalId}`).status, "PENDING");
  transferAmount = 1459;
  const accepted = response();
  await functions.flutterwaveEscrowTestWebhook(transferEvent, accepted);
  assert.equal(accepted.code, 200);
  await functions.flutterwaveEscrowTestWebhook(transferEvent, response());
  assert.equal(documents.get("escrowPlatformAccounting/withdrawalRevenue").retainedKobo, 53000);
  const refundEvent = {
    method: "POST", get: () => "test-webhook-hash",
    body: { id: 501, TransactionId: 321, AmountRefunded: 8875, status: "completed" }
  };
  const refundResponse = response();
  await functions.flutterwaveEscrowTestWebhook(refundEvent, refundResponse);
  assert.equal(refundResponse.code, 200);
  assert.equal(documents.get(`escrowOrders/${txRef}`).status, "REFUNDED");
  await functions.flutterwaveEscrowTestWebhook(refundEvent, response());
  assert.equal(documents.get(`escrowRefunds/${txRef}`).status, "REFUNDED");
});

test("an early transfer webhook reconciles the reservation without double-settling", async () => {
  let functions;
  let transfer;
  const provider = payoutProvider();
  const fetchMock = async (url, options = {}) => {
    if (url.endsWith("/transfers")) {
      const input = JSON.parse(options.body);
      transfer = { id: 123, reference: input.reference, amount: input.amount,
        currency: "NGN", fee: 10.75, status: "SUCCESSFUL" };
      const response = { status(code) { this.code = code; return this; }, send() {} };
      await functions.flutterwaveEscrowTestWebhook({
        method: "POST", get: () => "test-webhook-hash",
        body: { event: "transfer.completed", data: { id: 123, reference: input.reference } }
      }, response);
      assert.equal(response.code, 200);
      return { ok: true, json: async () => ({ status: "success", data: transfer }) };
    }
    if (url.endsWith("/transfers/123")) {
      return { ok: true, json: async () => ({ status: "success", data: transfer }) };
    }
    return provider.fetch(url, options);
  };
  const setupResult = setup(fetchMock);
  functions = setupResult.functions;
  const documents = setupResult.documents;
  documents.set("users/vendor", { role: "Vendor" });
  documents.set("vendorPayoutBalances/vendor", { availableKobo: 200000 });
  const bank = await functions.saveVendorBankAccount(request("vendor", {
    bankCode: "044", accountNumber: "1234567890"
  }));
  const quote = await functions.getVendorPayoutQuote(request("vendor", { amount: 2000 }));
  const result = await functions.requestVendorWithdrawal(request("vendor", {
    amount: 2000, bankVersion: bank.version, quote, operationId: "unique_withdrawal_123456789"
  }));
  assert.equal(result.status, "PAID");
  assert.equal(documents.get(`escrowWithdrawals/${result.withdrawalId}`).providerTransferId, "123");
  assert.equal(documents.get("escrowPlatformAccounting/withdrawalRevenue").retainedKobo, 53000);
});

test("admin refund remains pending until Flutterwave confirms final disbursement", async () => {
  let providerStatus = "completed";
  let refundRequests = 0;
  const { documents, functions } = setup(async (url, options) => {
    if (options.method === "POST") {
      refundRequests += 1;
      assert.equal(JSON.parse(options.body).amount, 8875);
      return { ok: true, json: async () => ({ status: "success",
        data: { id: 501, tx_id: 123, amount_refunded: 8875, status: "completed" } }) };
    }
    return { ok: true, json: async () => ({
      id: 501, transaction_id: 123, amount_refunded: 8875, status: providerStatus
    }) };
  });
  documents.set("escrowOrders/order1", { ...heldOrder(), status: "DISPUTED", transactionId: "123" });
  await assert.rejects(functions.resolveEscrowDispute(request("buyer", { decision: "refund" })),
    error => error.code === "permission-denied");
  await functions.resolveEscrowDispute(request("admin", { decision: "refund" }, true));
  assert.equal(documents.get("escrowOrders/order1").status, "REFUND_PENDING");
  await assert.rejects(functions.resolveEscrowDispute(request("admin", { decision: "refund" }, true)),
    error => error.code === "failed-precondition");
  assert.equal(refundRequests, 1);
  assert.equal((await functions.checkEscrowRefund(request("admin", {}, true))).status, "REFUND_PENDING");
  providerStatus = "completed-bank-transfer";
  assert.equal((await functions.checkEscrowRefund(request("admin", {}, true))).status, "REFUNDED");
  assert.equal(documents.get("escrowOrders/order1").status, "REFUNDED");
  assert.equal(documents.has("vendorPayoutBalances/vendor"), false);
});

test("fulfillment refunds are full before dispatch and product-only afterward", async () => {
  for (const dispatched of [false, true]) {
    const expected = dispatched ? 7500 : 10812.5;
    const { documents, functions } = setup(async (url, options) => {
      if (options.method === "POST") {
        assert.equal(JSON.parse(options.body).amount, expected);
        return { ok: true, json: async () => ({ status: "success",
          data: { id: 501, tx_id: 123, amount_refunded: expected, status: "completed" } }) };
      }
      return { ok: true, json: async () => ({
        id: 501, transaction_id: 123, amount_refunded: expected, status: "completed-bank-transfer"
      }) };
    });
    documents.set("escrowOrders/order1", {
      ...heldOrder(), platformFee: 562.5, fulfillment: { method: "delivery" },
      fulfillmentFee: 2750, totalPaid: 10812.5, transactionId: "123",
      ...(dispatched ? { shippedAt: "time" } : {})
    });
    await functions.openEscrowDispute(request("buyer", { reason: "Issue" }));
    await functions.resolveEscrowDispute(request("admin", { decision: "refund" }, true));
    await functions.checkEscrowRefund(request("admin", {}, true));
    await functions.checkEscrowRefund(request("admin", {}, true));
    assert.equal(documents.get("escrowOrders/order1").status, "REFUNDED");
    assert.equal(documents.get("escrowPlatformAccounting/revenue")?.retainedKobo || 0,
      dispatched ? 331250 : 0);
  }
});

test("an uncertain refund cannot be retried or released", async () => {
  let refundRequests = 0;
  const { documents, functions } = setup(async () => {
    refundRequests += 1;
    throw new Error("network timeout");
  });
  documents.set("escrowOrders/order1", { ...heldOrder(), status: "DISPUTED", transactionId: "123" });
  await assert.rejects(functions.resolveEscrowDispute(request("admin", { decision: "refund" }, true)),
    error => error.code === "unavailable");
  await assert.rejects(functions.resolveEscrowDispute(request("admin", { decision: "refund" }, true)),
    error => error.code === "failed-precondition");
  await assert.rejects(functions.resolveEscrowDispute(request("admin", { decision: "release" }, true)),
    error => error.code === "failed-precondition");
  assert.equal(refundRequests, 1);
  assert.equal(documents.get("escrowOrders/order1").status, "REFUND_INITIATING");
});

test("an early refund webhook verifies and finalizes without downgrading the order", async () => {
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  let functions;
  const { documents, functions: exports } = setup(async (url, options) => {
    if (options.method === "POST") {
      const response = { status(code) { this.code = code; return this; }, send() {} };
      await functions.flutterwaveEscrowTestWebhook({
        method: "POST", get: () => "test-webhook-hash",
        body: { id: 501, TransactionId: 123, AmountRefunded: 8875, status: "completed" }
      }, response);
      assert.equal(response.code, 200);
      return { ok: true, json: async () => ({ status: "success",
        data: { id: 501, tx_id: 123, amount_refunded: 8875, status: "completed" }
      }) };
    }
    return { ok: true, json: async () => ({
      id: 501, transaction_id: 123, amount_refunded: 8875, status: "completed-bank-transfer"
    }) };
  });
  functions = exports;
  documents.set(`escrowOrders/${txRef}`, { ...heldOrder(), status: "DISPUTED", transactionId: "123" });
  documents.set("escrowPaymentTransactions/123", { txRef });
  const result = await functions.resolveEscrowDispute(request("admin", { orderId: txRef, decision: "refund" }, true));
  assert.equal(result.status, "REFUNDED");
  assert.equal(documents.get(`escrowOrders/${txRef}`).status, "REFUNDED");
  assert.equal(documents.get(`escrowRefunds/${txRef}`).providerRefundId, "501");
});

test("an early refund webhook cannot attach a mismatched provider refund", async () => {
  const txRef = "escrow-12345678-1234-1234-1234-123456789abc";
  const { documents, functions } = setup(async () => ({
    ok: true, json: async () => ({
      id: 501, transaction_id: 999, amount_refunded: 8875, status: "completed-bank-transfer"
    })
  }));
  documents.set(`escrowOrders/${txRef}`, { status: "REFUND_INITIATING" });
  documents.set(`escrowRefunds/${txRef}`, { status: "INITIATING", transactionId: "123", amountKobo: 887500 });
  documents.set("escrowPaymentTransactions/123", { txRef });
  const response = { status(code) { this.code = code; return this; }, send() {} };
  await functions.flutterwaveEscrowTestWebhook({
    method: "POST", get: () => "test-webhook-hash",
    body: { event: "refund.completed", data: { id: 501, transaction_id: 123 } }
  }, response);
  assert.equal(response.code, 500);
  assert.equal(documents.get(`escrowOrders/${txRef}`).status, "REFUND_INITIATING");
});

test("admin can reconnect an uncertain refund only to the matching provider refund", async () => {
  let transactionId = 999;
  const { documents, functions } = setup(async () => ({
    ok: true, json: async () => ({
      id: 501, transaction_id: transactionId, amount_refunded: 8875, status: "completed-bank-transfer"
    })
  }));
  documents.set("escrowOrders/order1", { ...heldOrder(), status: "REFUND_INITIATING", transactionId: "123" });
  documents.set("escrowRefunds/order1", { transactionId: "123", amountKobo: 887500, status: "INITIATING" });
  await assert.rejects(functions.reconcileEscrowRefund(request("buyer", { refundId: "501" })),
    error => error.code === "permission-denied");
  await assert.rejects(functions.reconcileEscrowRefund(request("admin", { refundId: "501" }, true)),
    error => error.code === "failed-precondition");
  assert.equal(documents.get("escrowOrders/order1").status, "REFUND_INITIATING");
  transactionId = 123;
  await functions.reconcileEscrowRefund(request("admin", { refundId: "501" }, true));
  assert.equal(documents.get("escrowOrders/order1").status, "REFUND_PENDING");
  await functions.checkEscrowRefund(request("admin", {}, true));
  assert.equal(documents.get("escrowOrders/order1").status, "REFUNDED");
});

test("admin can reconnect an uncertain withdrawal only to the matching transfer", async () => {
  let reference = "wrong";
  const withdrawalId = "a".repeat(64);
  const { documents, functions } = setup(async () => ({
    ok: true, json: async () => ({ status: "success",
      data: { id: 123, reference, amount: 1459, currency: "NGN", fee: 10.75, status: "SUCCESSFUL" }
    })
  }));
  documents.set(`escrowWithdrawals/${withdrawalId}`, {
    vendorUid: "vendor", reference: "expected", netKobo: 145900, providerFeeKobo: 1075,
    baseFeeKobo: 50000, commissionKobo: 3000, status: "INITIATING"
  });
  await assert.rejects(functions.reconcileEscrowWithdrawal(request("vendor", { withdrawalId, transferId: "123" })),
    error => error.code === "permission-denied");
  await assert.rejects(functions.reconcileEscrowWithdrawal(request("admin", { withdrawalId, transferId: "123" }, true)),
    error => error.code === "failed-precondition");
  assert.equal(documents.get(`escrowWithdrawals/${withdrawalId}`).status, "INITIATING");
  reference = "expected";
  await functions.reconcileEscrowWithdrawal(request("admin", { withdrawalId, transferId: "123" }, true));
  await functions.checkVendorWithdrawal(request("vendor", { withdrawalId }));
  assert.equal(documents.get(`escrowWithdrawals/${withdrawalId}`).status, "PAID");
  assert.equal(documents.get("escrowPlatformAccounting/withdrawalRevenue").retainedKobo, 53000);
});
