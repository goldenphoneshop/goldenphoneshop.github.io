const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

function setup() {
  const documents = new Map();
  const users = new Map();
  const photos = new Map();
  class Ref {
    constructor(key) { this.key = key; }
    collection(name) { return new Collection(`${this.key}/${name}`); }
    async get() {
      const value = documents.get(this.key);
      return { exists: value !== undefined, data: () => value };
    }
  }
  class Collection {
    constructor(key) { this.key = key; }
    doc(id) { return new Ref(`${this.key}/${id}`); }
  }
  let queue = Promise.resolve();
  const db = {
    collection: name => new Collection(name),
    runTransaction: callback => {
      const run = queue.then(async () => {
        const writes = [];
        const tx = {
          get: ref => ref.get(),
          create: (ref, value) => writes.push(() => {
            assert.equal(documents.has(ref.key), false);
            documents.set(ref.key, value);
          }),
          set: (ref, value, options) => writes.push(() => {
            documents.set(ref.key, options?.merge
              ? { ...documents.get(ref.key), ...value }
              : value);
          }),
          update: (ref, value) => writes.push(() => {
            assert.equal(documents.has(ref.key), true);
            documents.set(ref.key, { ...documents.get(ref.key), ...value });
          })
        };
        const result = await callback(tx);
        writes.forEach(write => write());
        return result;
      });
      queue = run.catch(() => {});
      return run;
    }
  };
  class HttpsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const handler = (...args) => args.at(-1);
  const modules = {
    "./escrow-fee": require("../escrow-fee"),
    "./escrow-fulfillment": require("../escrow-fulfillment"),
    "firebase-admin/app": { initializeApp() {} },
    "firebase-admin/auth": {
      getAuth: () => ({
        async getUser(uid) {
          if (!users.has(uid)) throw Object.assign(new Error("not found"), { code: "auth/user-not-found" });
          return users.get(uid);
        }
      })
    },
    "firebase-admin/firestore": {
      getFirestore: () => db,
      FieldPath: {},
      FieldValue: { serverTimestamp: () => "server-time" }
    },
    "firebase-admin/storage": {
      getStorage: () => ({
        bucket: () => ({
          file: filePath => ({
            async getMetadata() {
              if (!photos.has(filePath)) throw Object.assign(new Error("not found"), { code: 404 });
              return [photos.get(filePath)];
            }
          })
        })
      })
    },
    "node:crypto": crypto,
    "firebase-functions/v2/scheduler": { onSchedule: handler },
    "firebase-functions/v2/firestore": {
      onDocumentCreated: handler,
      onDocumentDeleted: handler,
      onDocumentWritten: handler
    },
    "firebase-functions/v2/https": { onCall: handler, onRequest: handler, HttpsError },
    "firebase-functions/params": { defineSecret: () => ({}) },
    "firebase-functions": { logger: { error() {}, warn() {}, info() {} } }
  };
  const context = {
    exports: {},
    require: name => {
      if (!modules[name]) throw new Error(`Unexpected module: ${name}`);
      return modules[name];
    },
    URL,
    Date,
    Buffer,
    console
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8"), context);
  return { functions: context.exports, documents, users, photos };
}

function auth(uid, verified = true) {
  return { uid, token: { email_verified: verified, firebase: { sign_in_provider: "password" } } };
}

function completeProfile(uid, role = "Buyer") {
  return {
    uid,
    role,
    name: "Member",
    location: "Lagos",
    gender: "Prefer not to say",
    ageRange: "18-24",
    description: role === "Vendor" ? "Phone shop" : "",
    profilePhotoPath: `profile-photos/${uid}/photo`
  };
}

function seedAccount(state, uid, verified = true) {
  state.documents.set(`users/${uid}`, completeProfile(uid));
  state.users.set(uid, {
    email: `${uid}@example.test`,
    emailVerified: verified,
    metadata: { creationTime: new Date().toISOString() }
  });
  state.photos.set(`profile-photos/${uid}/photo`, { size: "20", contentType: "image/png" });
}

test("referral codes are stable, unique, and cannot be attached to old or same accounts", async () => {
  const state = setup();
  seedAccount(state, "referrer");
  seedAccount(state, "other");
  const first = await state.functions.getReferralInfo({ auth: auth("referrer") });
  const again = await state.functions.getReferralInfo({ auth: auth("referrer") });
  const other = await state.functions.getReferralInfo({ auth: auth("other") });
  assert.equal(first.referralCode, again.referralCode);
  assert.notEqual(first.referralCode, other.referralCode);
  assert.equal(new URL(first.referralLink).searchParams.get("ref"), first.referralCode);
  await assert.rejects(
    state.functions.recordReferralSignup({ auth: auth("referrer"), data: { referralCode: first.referralCode } }),
    error => error.code === "permission-denied"
  );
  state.users.get("other").metadata.creationTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await assert.rejects(
    state.functions.recordReferralSignup({ auth: auth("other"), data: { referralCode: first.referralCode } }),
    error => error.code === "failed-precondition"
  );
});

test("verified and complete profiles receive the two bonuses once, including concurrent retries", async () => {
  const state = setup();
  seedAccount(state, "referrer");
  seedAccount(state, "new", false);
  state.documents.set("quizWallets/referrer", { coins: 3.5, likes: 4 });
  state.documents.set("quizWallets/new", { coins: 0.5, likes: 2 });
  const info = await state.functions.getReferralInfo({ auth: auth("referrer") });
  const request = { auth: auth("new", false), data: { referralCode: info.referralCode } };
  assert.equal((await state.functions.recordReferralSignup(request)).attributed, true);
  assert.equal((await state.functions.recordReferralSignup(request)).duplicate, true);
  await assert.rejects(state.functions.completeReferralQualification({ auth: auth("new", false) }),
    error => error.code === "permission-denied");
  state.photos.delete("profile-photos/new/photo");
  assert.equal((await state.functions.completeReferralQualification({ auth: auth("new") })).profileComplete, false);
  assert.equal(state.documents.get("quizWallets/referrer").coins, 3.5);
  state.photos.set("profile-photos/new/photo", { size: "20", contentType: "image/png" });
  state.users.get("new").emailVerified = true;
  const results = await Promise.all([
    state.functions.completeReferralQualification({ auth: auth("new") }),
    state.functions.processReferralProfileCompletion({ params: { userId: "new" }, data: { after: { exists: true } } }),
    state.functions.completeReferralQualification({ auth: auth("new") })
  ]);
  assert.equal(results.filter(result => result?.awarded).length, 1);
  assert.equal(state.documents.get("quizWallets/referrer").coins, 13.5);
  assert.equal(state.documents.get("quizWallets/new").coins, 5.5);
  assert.equal(state.documents.get("quizWallets/referrer").likes, 4);
  assert.equal(state.documents.get("referralAttributions/new").status, "qualified");
  assert.equal(state.documents.get("referralAwards/new").referredUserBonusCoins, 5);
});

test("profile trigger waits for verification and required vendor description", async () => {
  const state = setup();
  seedAccount(state, "referrer");
  seedAccount(state, "new", false);
  state.documents.set("users/new", { ...completeProfile("new", "Vendor"), description: "" });
  const info = await state.functions.getReferralInfo({ auth: auth("referrer") });
  await state.functions.recordReferralSignup({ auth: auth("new", false), data: { referralCode: info.referralCode } });
  const event = { params: { userId: "new" }, data: { after: { exists: true } } };
  await state.functions.processReferralProfileCompletion(event);
  state.users.get("new").emailVerified = true;
  await state.functions.processReferralProfileCompletion(event);
  assert.equal(state.documents.has("referralAwards/new"), false);
  state.documents.set("users/new", completeProfile("new", "Vendor"));
  await state.functions.processReferralProfileCompletion(event);
  assert.equal(state.documents.get("quizWallets/new").coins, 5);
  assert.equal(state.documents.get("quizWallets/referrer").coins, 10);
});

test("referral attribution cannot be changed after registration", async () => {
  const state = setup();
  seedAccount(state, "first");
  seedAccount(state, "second");
  seedAccount(state, "new");
  const first = await state.functions.getReferralInfo({ auth: auth("first") });
  const second = await state.functions.getReferralInfo({ auth: auth("second") });
  await state.functions.recordReferralSignup({ auth: auth("new"), data: { referralCode: first.referralCode } });
  await assert.rejects(
    state.functions.recordReferralSignup({ auth: auth("new"), data: { referralCode: second.referralCode } }),
    error => error.code === "already-exists"
  );
  assert.equal(state.documents.get("referralAttributions/new").referrerUid, "first");
});

test("a failed signup attribution is retained and retried only for the same signed-in account", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "Markertplace.html"), "utf8");
  const start = html.indexOf("        function rememberSignupReferral(uid)");
  const end = html.indexOf("        function verifiedDealerErrorNotice", start);
  assert.ok(start >= 0 && end > start);
  const storage = new Map();
  const calls = [];
  let fails = true;
  const context = {
    pendingSignupReferralCode: "ABCDEF123456",
    currentUser: { uid: "new" },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    firebaseAuth: { currentUser: { uid: "new" } },
    firebaseFunctions: {
      httpsCallable: () => async data => {
        calls.push(data);
        if (fails) throw new Error("offline");
        return { data: { attributed: true } };
      }
    },
    console: { error() {} },
    showToast() {}
  };
  vm.runInNewContext(html.slice(start, end), context);
  assert.equal(context.rememberSignupReferral("new"), true);
  assert.equal(await context.syncSignupReferral("new"), false);
  assert.equal(storage.get("goldenEagle_pendingReferral:new"), "ABCDEF123456");
  context.firebaseAuth.currentUser = { uid: "another" };
  assert.equal(await context.syncSignupReferral("new"), false);
  assert.equal(calls.length, 1);
  context.firebaseAuth.currentUser = { uid: "new" };
  fails = false;
  assert.equal(await context.syncSignupReferral("new"), true);
  assert.equal(storage.has("goldenEagle_pendingReferral:new"), false);
  assert.equal(calls[1].referralCode, "ABCDEF123456");
});
