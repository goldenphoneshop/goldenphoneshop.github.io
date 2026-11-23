const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "..");
const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const firestoreRules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");

function extract(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Cannot find ${start}`);
  return source.slice(first, last);
}

function setupHelpers() {
  class HttpsError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const context = { HttpsError, QUIZ_LIKE_REWARD: 10 };
  vm.runInNewContext(
    extract("const OWNER_ADMIN_UID", "function requireVerifiedUser") +
    extract("function quizLikeRewardAmount", "exports.claimDailyCheckIn"),
    context
  );
  return context;
}

test("administrator access is bound to the owner UID, not another account's claim", () => {
  const { isOwnerAdmin } = setupHelpers();
  assert.equal(isOwnerAdmin({ uid: "LROHsLUXfEPnC6bDmSvy3vcRnNE3" }), true);
  assert.equal(isOwnerAdmin({ uid: "other-user", token: { admin: true } }), false);
});

test("product text detects formatted and obfuscated phone numbers", () => {
  const context = { HttpsError: Error };
  vm.runInNewContext(
    extract("function containsPhoneNumber", "async function recordPostingViolation"),
    context
  );
  assert.equal(context.containsPhoneNumber("+234 803 123 4567"), true);
  assert.equal(context.containsPhoneNumber("WhatsApp: 0803-123-4567"), true);
  assert.equal(context.containsPhoneNumber("o8o3 123 4567"), true);
  assert.equal(context.containsPhoneNumber("Original screen assembly"), false);
});

test("quiz Likes are awarded only for a perfect eligible reward quiz", () => {
  const { quizLikeRewardAmount } = setupHelpers();
  assert.equal(quizLikeRewardAmount(true, true, true, true), 10);
  assert.equal(quizLikeRewardAmount(true, false, true, true), 0);
  assert.equal(quizLikeRewardAmount(true, true, false, true), 0);
  assert.equal(quizLikeRewardAmount(false, true, true, true), 0);
});

test("product reactions require an existing listing owned by someone else", () => {
  const { requireProductReactionTarget } = setupHelpers();
  assert.equal(
    requireProductReactionTarget(
      { exists: true, data: () => ({ ownerUid: "vendor" }) },
      "buyer"
    ).ownerUid,
    "vendor"
  );
  assert.throws(
    () => requireProductReactionTarget({ exists: false }, "buyer"),
    error => error.code === "not-found"
  );
  assert.throws(
    () => requireProductReactionTarget(
      { exists: true, data: () => ({ ownerUid: "buyer" }) },
      "buyer"
    ),
    error => error.code === "permission-denied"
  );
});

test("marketplace cards do not claim every listing is verified", () => {
  assert.doesNotMatch(html, /<span>🦅 Verified<\/span>/);
  assert.doesNotMatch(html, /aria-label="Verified Dealer"/);
  assert.doesNotMatch(html, /Purchase Verified Dealer Badge/);
  assert.doesNotMatch(html, /Purchase Marketplace Dealer Badge/);
  assert.match(html, /Vendor application will require owner approval/);
});

test("new accounts cannot self-assign Vendor and badges require owner administration", () => {
  assert.match(firestoreRules, /request\.resource\.data\.role == 'Buyer'/);
  assert.match(source, /exports\.adminSetVendorApproval = onCall/);
  assert.match(source, /exports\.adminSetVerifiedDealerBadge = onCall/);
  assert.match(source, /Dealer verification badges are granted only after owner review/);
  assert.match(source, /PERMANENT_VERIFIED_DEALER_UID = "71ZtsYMKKtMsOSdHhBHAbjHzcqc2"/);
  assert.match(source, /exports\.deleteOwnedMarketplaceContent = onCall/);
  assert.match(firestoreRules, /allow create, update, delete: if false/);
});
