(function (root, factory) {
  const config = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = config;
  } else {
    root.escrowFulfillment = config;
  }
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  return {
    homeDeliveryFee: 2750,
    stations: [
      { id: "oshodi", label: "Lagos State Oshodi Road, Pick up Centre - 11 Akinosho Street, Off Afariogun Street" },
      { id: "ikeja", label: "Computer Village Plaza, Pickup Station - 00 Obafemi Awolowo Way, Ikeja, Lagos" },
      { id: "arena", label: "Arena Market Plaza Pickup Center - Block 00 Phone Accessories Plaza, Bolade Oshodi, Lagos" }
    ]
  };
});
