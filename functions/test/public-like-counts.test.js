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

function firestore() {
  const listeners = new Map();
  const stopped = [];
  function reference(parts) {
    return {
      collection: name => reference([...parts, name]),
      doc: id => reference([...parts, id]),
      onSnapshot(next, error) {
        const key = parts.join("/");
        listeners.set(key, { next, error });
        return () => { stopped.push(key); listeners.delete(key); };
      }
    };
  }
  return { db: reference([]), listeners, stopped };
}

function likeButton(postId) {
  const count = { textContent: "" };
  const label = { textContent: "" };
  return {
    dataset: { postId },
    count,
    label,
    setAttribute() {},
    classList: { toggle() {} },
    querySelector(selector) {
      return selector === "[data-community-post-like-count]" ? count : label;
    }
  };
}

test("post Like counts update all copies and survive rerenders and account changes", () => {
  const { db, listeners, stopped } = firestore();
  let buttons = [likeButton("post1"), likeButton("post1"), likeButton("post2")];
  const context = {
    firebaseFirestore: db,
    currentUser: null,
    communityPostLikeUnsubscribers: new Map(),
    document: { querySelectorAll: () => buttons },
    console: { error() {} }
  };
  vm.runInNewContext(
    extract("function subscribeToCommunityPostLikes", "function cleanupCommunityPostLikeSubscriptions") +
    extract("function setCommunityPostLikeButton", "async function toggleCommunityPostLike"),
    context
  );
  context.subscribeToCommunityPostLikes("post1");
  assert.equal(buttons[0].count.textContent, "—");
  listeners.get("communityPostStats/post1").next({ data: () => ({ likes: 1234 }) });
  assert.equal(buttons[0].count.textContent, (1234).toLocaleString());
  assert.equal(buttons[1].count.textContent, (1234).toLocaleString());
  assert.equal(buttons[2].count.textContent, "");

  buttons = [likeButton("post1")];
  context.currentUser = { uid: "user1" };
  context.subscribeToCommunityPostLikes("post1");
  assert.equal(buttons[0].count.textContent, (1234).toLocaleString());
  listeners.get("communityPosts/post1/likes/user1").next({ exists: true });
  assert.equal(buttons[0].label.textContent, "Liked");
  context.currentUser = null;
  context.subscribeToCommunityPostLikes("post1");
  assert.equal(buttons[0].label.textContent, "Like");
  assert.ok(stopped.includes("communityPosts/post1/likes/user1"));
  listeners.get("communityPostStats/post1").error(new Error("offline"));
  assert.equal(buttons[0].count.textContent, "Unavailable");
});

test("product card counts update live, survive rerenders, and unsubscribe when filtered out", () => {
  const { db, listeners, stopped } = firestore();
  let labels = [
    { dataset: { feedProductLikes: "product1" }, textContent: "" },
    { dataset: { feedProductLikes: "product2" }, textContent: "" }
  ];
  const context = {
    firebaseFirestore: db,
    feedProductStatsSubscriptions: new Map(),
    document: { querySelectorAll: () => labels },
    console: { error() {} }
  };
  vm.runInNewContext(extract("function syncFeedProductStats", "async function boostProductListing"), context);
  context.syncFeedProductStats(["product1", "product2"]);
  assert.equal(labels[0].textContent, "—");
  listeners.get("productDiscussionStats/product1").next({ data: () => ({ likes: 7 }) });
  listeners.get("productDiscussionStats/product2").next({ data: () => undefined });
  assert.equal(labels[0].textContent, "7");
  assert.equal(labels[1].textContent, "0");
  labels = [{ dataset: { feedProductLikes: "product1" }, textContent: "" }];
  context.syncFeedProductStats(["product1"]);
  assert.equal(labels[0].textContent, "7");
  assert.ok(stopped.includes("productDiscussionStats/product2"));
  listeners.get("productDiscussionStats/product1").next({ data: () => ({ likes: 8 }) });
  assert.equal(labels[0].textContent, "8");
  listeners.get("productDiscussionStats/product1").error(new Error("offline"));
  assert.equal(labels[0].textContent, "Unavailable");
});

test("a visitor can render a post without a media owner", () => {
  const context = {
    currentUser: null,
    escapeHtml: String,
    renderVerifiedDealerBadge: () => "",
    communityDownloadPermissionCache: new Map(),
    openCommunityCommentPostIds: new Set(),
    communityCommentVoiceStates: new Map(),
    formatCommunityPostDate: () => ""
  };
  vm.runInNewContext(extract("function renderCommunityPostCard(post)", "function subscribeToCommunityPostLikes"), context);
  assert.match(context.renderCommunityPostCard({ id: "post1" }), /data-community-post-like-count/);
});
