const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");

function extract(start, end) {
  const first = html.indexOf(`        ${start}`);
  const last = html.indexOf(`        ${end}`, first);
  assert.ok(first >= 0 && last > first, `Cannot find ${start}`);
  return html.slice(first, last);
}

function doc(id, authorName, parentCommentId) {
  return { id, data: () => ({ authorName, ...(parentCommentId ? { parentCommentId } : {}) }) };
}

test("threads group replies under their parents and retain replies to missing parents", () => {
  const context = {};
  vm.runInNewContext(extract("function orderCommentThreads", "function syncCommunityReplyComposer"), context);
  const comments = [
    doc("root", "A"),
    doc("other", "B"),
    doc("reply", "C", "root"),
    doc("nested", "D", "reply"),
    doc("orphan", "E", "missing")
  ];
  const result = context.orderCommentThreads(comments);
  assert.deepEqual(Array.from(result.ordered, item => item.id),
    ["root", "reply", "nested", "other", "orphan"]);
  assert.equal(result.byId.get("reply").data().authorName, "C");
});

function submitContext() {
  const writes = [];
  const uploads = [];
  const input = {
    value: "Hello",
    setAttribute() {},
    placeholder: ""
  };
  const button = { disabled: false, textContent: "", innerHTML: "" };
  const form = {
    querySelector(selector) {
      return selector === "textarea" ? input : button;
    },
    dataset: { postId: "post1" }
  };
  const status = { classList: { add() {} } };
  const nodes = {
    productCommentInput: input,
    postProductCommentButton: button,
    voiceRecordStatus: status
  };
  const context = {
    currentUser: { uid: "user1", name: "Member" },
    discussionProductId: "product1",
    productCommentReplyTarget: null,
    pendingProductVoiceBlob: null,
    MAX_PRODUCT_VOICE_BYTES: 25 * 1024 * 1024,
    MAX_COMMUNITY_COMMENT_VOICE_BYTES: 25 * 1024 * 1024,
    communityCommentReplyTargets: new Map(),
    communityCommentVoiceStates: new Map(),
    communityCommentDrafts: new Map([["post1", "Hello"]]),
    firebase: { firestore: { FieldValue: { serverTimestamp: () => "timestamp" } } },
    firebaseStorage: {
      ref(storagePath) {
        return {
          async put(blob, metadata) { uploads.push({ storagePath, blob, metadata }); },
          async delete() {}
        };
      }
    },
    firebaseFirestore: {
      collection(collection) {
        return {
          doc(id) {
            return {
              collection() {
                return {
                  doc() {
                    return { id: "newComment", async set(data) { writes.push({ collection, id, data }); } };
                  }
                };
              }
            };
          }
        };
      }
    },
    document: {
      getElementById: id => nodes[id],
      querySelectorAll: () => [form]
    },
    clearPendingProductVoice() {},
    clearCommunityCommentVoice() {},
    syncCommunityReplyComposer() {},
    syncProductReplyComposer() {},
    cancelCommunityCommentReply(id) { context.communityCommentReplyTargets.delete(id); },
    cancelProductCommentReply() { context.productCommentReplyTarget = null; },
    showToast(message) { throw new Error(message); },
    openAuthModal() { throw new Error("unexpected sign-in"); },
    console
  };
  vm.runInNewContext(extract("async function postCommunityComment", "function syncCommunityCommentVoiceComposer"), context);
  vm.runInNewContext(extract("async function postProductComment", "function renderProductImageGallery"), context);
  return { context, writes, uploads, input, form };
}

test("community replies target the selected comment; ordinary comments stay unchanged", async () => {
  const { context, writes, input, form } = submitContext();
  context.communityCommentReplyTargets.set("post1", { id: "parent1", authorName: "A" });
  await context.postCommunityComment({ preventDefault() {}, currentTarget: form }, "post1");
  assert.equal(writes[0].collection, "communityPosts");
  assert.equal(writes[0].id, "post1");
  assert.equal(writes[0].data.parentCommentId, "parent1");
  assert.equal(context.communityCommentReplyTargets.has("post1"), false);
  input.value = "Another";
  await context.postCommunityComment({ preventDefault() {}, currentTarget: form }, "post1");
  assert.equal(Object.hasOwn(writes[1].data, "parentCommentId"), false);
});

test("product replies target the selected comment in the current discussion", async () => {
  const { context, writes } = submitContext();
  context.productCommentReplyTarget = { id: "parent2", authorName: "B" };
  await context.postProductComment({ preventDefault() {} });
  assert.equal(writes[0].collection, "productDiscussions");
  assert.equal(writes[0].id, "product1");
  assert.equal(writes[0].data.parentCommentId, "parent2");
  assert.equal(writes[0].data.voicePath, "");
  assert.equal(context.productCommentReplyTarget, null);
});

test("community voice-only replies upload and save without text", async () => {
  const { context, writes, uploads, input, form } = submitContext();
  input.value = "";
  context.communityCommentReplyTargets.set("post1", { id: "parent1", authorName: "A" });
  context.communityCommentVoiceStates.set("post1", { blob: { size: 12, type: "audio/webm" } });
  await context.postCommunityComment({ preventDefault() {}, currentTarget: form }, "post1");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].storagePath, "community-comment-voice/post1/newComment/user1/voice");
  assert.equal(writes[0].data.text, "");
  assert.equal(writes[0].data.voicePath, uploads[0].storagePath);
  assert.equal(writes[0].data.parentCommentId, "parent1");
});

test("product voice-only replies upload and save without text", async () => {
  const { context, writes, uploads, input } = submitContext();
  input.value = "";
  context.productCommentReplyTarget = { id: "parent2", authorName: "B" };
  context.pendingProductVoiceBlob = { size: 12, type: "audio/webm" };
  await context.postProductComment({ preventDefault() {} });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].storagePath, "product-discussions/product1/voice/user1/newComment");
  assert.equal(writes[0].data.text, "");
  assert.equal(writes[0].data.voicePath, uploads[0].storagePath);
  assert.equal(writes[0].data.parentCommentId, "parent2");
});

test("an empty community comment is rejected before upload or saving", async () => {
  const { context, writes, uploads, input, form } = submitContext();
  input.value = "  ";
  await assert.rejects(
    context.postCommunityComment({ preventDefault() {}, currentTarget: form }, "post1"),
    /Write a comment or record a voice note/
  );
  assert.equal(writes.length, 0);
  assert.equal(uploads.length, 0);
});

test("a community comment cannot be submitted while recording", async () => {
  const { context, writes, uploads, form } = submitContext();
  context.communityCommentVoiceStates.set("post1", { recorder: { state: "recording" } });
  await assert.rejects(
    context.postCommunityComment({ preventDefault() {}, currentTarget: form }, "post1"),
    /Stop recording before posting/
  );
  assert.equal(writes.length, 0);
  assert.equal(uploads.length, 0);
});
