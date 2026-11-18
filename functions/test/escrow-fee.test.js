const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { calculateEscrowFee } = require("../escrow-fee");

test("the agreed marginal schedule and boundary amounts are calculated in kobo", () => {
  const examples = [
    [1000, 150],
    [4999, 750],
    [5000, 750],
    [7500, 1375],
    [10000, 2000],
    [10001, 2000.30],
    [19999, 4999.70],
    [20000, 5000],
    [20001, 5000.17],
    [50000, 10000],
    [50001, 10000.20]
  ];
  for (const [price, expected] of examples) {
    assert.equal(calculateEscrowFee(price), expected, `price ${price}`);
  }
});

test("fees below NGN 5000 round to the nearest NGN 50", () => {
  assert.equal(calculateEscrowFee(100), 0);
  assert.equal(calculateEscrowFee(500), 100);
  assert.equal(calculateEscrowFee(833.34), 150);
});

test("invalid or unrepresentable prices are rejected", () => {
  for (const price of [0, -1, NaN, Infinity, "1000", 1.001, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => calculateEscrowFee(price), RangeError);
  }
});

test("the browser and Node load the same calculator", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "escrow-fee.js"), "utf8");
  const browser = {};
  vm.runInNewContext(source, browser);
  for (const price of [100, 5000, 7500, 10001, 20001, 50001]) {
    assert.equal(browser.calculateEscrowFee(price), calculateEscrowFee(price));
  }
});
