(function (root, factory) {
  const calculateEscrowFee = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = { calculateEscrowFee };
  } else {
    root.calculateEscrowFee = calculateEscrowFee;
  }
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  return function calculateEscrowFee(productPrice) {
    if (typeof productPrice !== "number" || !Number.isFinite(productPrice) ||
        productPrice <= 0) {
      throw new RangeError("Product price must be a positive number.");
    }
    const priceKobo = Math.round(productPrice * 100);
    if (!Number.isSafeInteger(priceKobo) || priceKobo <= 0 ||
        Math.abs(productPrice * 100 - priceKobo) > 0.00001) {
      throw new RangeError("Product price must be a safe amount with at most two decimal places.");
    }

    // 7.5% is 3/40; splitting the division avoids unsafe integer multiplication.
    const feeKobo = Math.floor(priceKobo / 40) * 3 +
      Math.floor(((priceKobo % 40) * 3 + 20) / 40);
    return feeKobo / 100;
  };
});
