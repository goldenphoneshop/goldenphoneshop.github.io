const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "Markertplace.html"), "utf8");
const start = html.indexOf("        function safeProfilePhotoPath");
const end = html.indexOf("        function clearProfilePhotoCache", start);
assert.ok(start >= 0 && end > start);

function setup() {
  const requests = [];
  const errors = [];
  const viewer = { uid: "viewer", getIdToken: async () => "id-token" };
  const context = {
    currentUser: { uid: "viewer" },
    firebaseAuth: { currentUser: viewer },
    firebaseStorage: { ref: () => ({ bucket: "example.firebasestorage.app",
      getMetadata: async () => ({ size: 10 }) }) },
    MAX_PROFILE_PHOTO_BYTES: 5 * 1024 * 1024,
    profilePhotoObjectUrls: new Map(),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, blob: async () => ({ size: 10, type: "image/jpeg" }) };
    },
    URL: { createObjectURL: () => "blob:photo", revokeObjectURL() {} },
    showToast: text => errors.push(text),
    console: { error() {} }
  };
  vm.runInNewContext(html.slice(start, end), context);
  const classes = new Set();
  const image = { dataset: {}, classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    removeAttribute: name => { delete image[name]; } };
  return { context, requests, errors, image, classes };
}

test("profile photos load with an authenticated request for the viewer or another member", async () => {
  const { context, requests, image, classes } = setup();
  await context.loadProfilePhotoInto(image, "profile-photos/viewer/own", "viewer", true);
  assert.equal(image.src, "blob:photo");
  assert.equal(requests[0].options.headers.Authorization, "Firebase id-token");
  assert.match(requests[0].url, /profile-photos%2Fviewer%2Fown\?alt=media$/);
  await context.loadProfilePhotoInto(image, "profile-photos/other/photo", "other", true);
  assert.equal(image.src, "blob:photo");
  assert.equal(classes.has("hidden"), false);
  assert.equal(requests.length, 2);
});

test("profile photo requests discard results after an account change", async () => {
  const { context, image } = setup();
  context.fetch = async () => {
    context.currentUser = { uid: "other-viewer" };
    context.firebaseAuth.currentUser = { uid: "other-viewer" };
    return { ok: true, blob: async () => ({ size: 10, type: "image/jpeg" }) };
  };
  await context.loadProfilePhotoInto(image, "profile-photos/viewer/own", "viewer");
  assert.equal(image.src, undefined);
  assert.equal(context.profilePhotoObjectUrls.size, 0);
});

test("failed or oversized photo downloads are reported without displaying them", async () => {
  const { context, errors, image, requests } = setup();
  context.firebaseStorage.ref = () => ({ getMetadata: async () => ({ size: 6 * 1024 * 1024 }) });
  await context.loadProfilePhotoInto(image, "profile-photos/viewer/own", "viewer", true);
  assert.equal(requests.length, 0);
  assert.equal(image.src, undefined);
  assert.equal(errors.length, 1);
});
