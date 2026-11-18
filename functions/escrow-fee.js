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

    if (priceKobo < 500000) {
      return Math.round(priceKobo * 0.15 / 5000) * 50;
    }

    let feeKobo = 75000;
    feeKobo += Math.min(priceKobo - 500000, 500000) * 0.25;
    if (priceKobo > 1000000) {
      feeKobo += Math.min(priceKobo - 1000000, 1000000) * 0.30;
    }
    if (priceKobo > 2000000) {
      feeKobo += Math.min(priceKobo - 2000000, 3000000) / 6;
    }
    if (priceKobo > 5000000) {
      feeKobo += (priceKobo - 5000000) * 0.20;
    }
    return Math.round(feeKobo) / 100;
  };
});
