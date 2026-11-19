const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { calculateEscrowFee } = require("../escrow-fee");

test("the 7.5% fee is calculated in kobo across prices", () => {
  const examples = [
    [1000, 75],
    [4999, 374.93],
    [5000, 375],
    [7500, 562.50],
    [10000, 750],
    [20000, 1500],
    [50000, 3750],
    [85000, 6375]
  ];
  for (const [price, expected] of examples) {
    assert.equal(calculateEscrowFee(price), expected, `price ${price}`);
  }
});

test("fees round to the nearest kobo, with half a kobo rounded up", () => {
  assert.equal(calculateEscrowFee(0.06), 0);
  assert.equal(calculateEscrowFee(0.07), 0.01);
  assert.equal(calculateEscrowFee(0.20), 0.02);
  assert.equal(calculateEscrowFee(0.21), 0.02);
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
