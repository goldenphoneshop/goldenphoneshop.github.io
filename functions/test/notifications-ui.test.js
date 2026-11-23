const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "index.html"), "utf8");
const start = html.indexOf("function openNotificationsModal()");
const end = html.indexOf("function closeChatCoinStore()", start);
assert.ok(start >= 0 && end > start);

function setup() {
  const nodes = new Map();
  const callbacks = [];
  const actions = [];
  let latestLimit;
  const element = id => {
    if (!nodes.has(id)) {
      const classes = new Set(id === "chatWalletDetails" ? ["hidden"] : []);
      nodes.set(id, {
        innerHTML: "", textContent: "",
        setAttribute() {},
        classList: {
          add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle: (name, value) => value ? classes.add(name) : classes.delete(name)
        }
      });
    }
    return nodes.get(id);
  };
  const query = {
    collection: () => query, doc: () => query, orderBy: () => query,
    limit(value) { latestLimit = value; return this; },
    onSnapshot(success, error) { callbacks.push({ success, error }); return () => {}; },
    async update() { actions.push("read"); },
    async get() { return { exists: true, id: `chat_${"a".repeat(40)}`,
      data: () => ({ participantIds: ["alice", "bob"] }) }; }
  };
  const context = {
    currentUser: { uid: "alice" }, notificationsUnsubscribe: null,
    inAppNotifications: [], notificationLoadState: "idle", notificationLimit: 50,
    notificationSubscriptionRevision: 0, products: [],
    document: { getElementById: element }, firebaseFirestore: query,
    firebase: { firestore: { FieldValue: { serverTimestamp: () => "time" } } },
    escapeHtml: text => String(text).replace(/</g, "&lt;"),
    toggleSideMenu: () => {}, showToast: text => actions.push(text),
    openAccountPage: section => actions.push(section),
    openChatPage: () => actions.push("chat"),
    selectGoldenChat: () => actions.push("select"),
    showMarketplacePage: () => actions.push("marketplace"),
    toggleChatWalletDetails: () => actions.push("wallet"),
    openDetailModal: () => actions.push("product"),
    console: { error() {} }
  };
  vm.runInNewContext(html.slice(start, end), context);
  return { context, nodes, callbacks, actions, element, getLimit: () => latestLimit };
}

test("notification loading, error, retry and older-page controls are visible", () => {
  const { context, callbacks, element, getLimit } = setup();
  context.subscribeToNotifications();
  assert.match(element("inAppNotificationList").innerHTML, /Loading/);
  callbacks[0].error(new Error("offline"));
  assert.match(element("inAppNotificationList").innerHTML, /Retry/);
  assert.equal(element("notificationMenuUnreadCount").textContent, "!");
  context.subscribeToNotifications();
  const docs = Array.from({ length: 50 }, (_, i) => ({
    id: `notice${i}`, data: () => ({ title: "<unsafe>", message: "Update" })
  }));
  callbacks[1].success({ docs });
  assert.match(element("inAppNotificationList").innerHTML, /&lt;unsafe>/);
  assert.match(element("inAppNotificationList").innerHTML, /Load older/);
  context.loadOlderNotifications();
  assert.equal(getLimit(), 100);
  callbacks[1].success({ docs: [] });
  assert.match(element("inAppNotificationList").innerHTML, /Loading/);
});

test("account, chat and listing notifications route to their relevant views", async () => {
  const { context, callbacks, actions } = setup();
  context.subscribeToNotifications();
  const chatId = `chat_${"a".repeat(40)}`;
  callbacks[0].success({ docs: [
    { id: "order", data: () => ({ type: "order" }) },
    { id: "chat", data: () => ({ type: "missed_call", chatId }) },
    { id: "listing", data: () => ({ type: "new_product", productId: "phone" }) }
  ] });
  await context.openInAppNotification("order");
  await context.openInAppNotification("chat");
  context.firebaseFirestore.get = async () => ({ exists: true, id: "phone",
    data: () => ({ title: "Phone" }) });
  await context.openInAppNotification("listing");
  assert.deepEqual(actions, ["read", "escrow", "read", "chat", "select", "read", "marketplace", "product"]);
});

test("follow button renders the actual member role and the following state", () => {
  const first = html.indexOf("function renderMemberFollowButton(member)");
  const last = html.indexOf("function subscribeToFollowedVendors()", first);
  assert.ok(first >= 0 && last > first);
  const context = {
    currentUser: { uid: "viewer" }, followedMemberIds: new Set(),
    escapeHtml: text => String(text).replace(/</g, "&lt;")
  };
  vm.runInNewContext(html.slice(first, last), context);
  assert.match(context.renderMemberFollowButton({ uid: "vendor", role: "Vendor" }), />Follow vendor<\/span>/);
  assert.match(context.renderMemberFollowButton({ uid: "buyer", role: "Buyer" }), />Follow buyer<\/span>/);
  context.followedMemberIds.add("vendor");
  assert.match(context.renderMemberFollowButton({ uid: "vendor", role: "Vendor" }), />Following<\/span>/);
});
