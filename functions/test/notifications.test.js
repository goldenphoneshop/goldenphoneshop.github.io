const test = require("node:test");
const assert = require("node:assert/strict");
const { createNotifications } = require("../notifications");

function setup() {
  const docs = new Map();
  let batchCount = 0;
  let failBatchNumber = null;
  class Stamp {
    constructor(ms) { this.ms = ms; }
    toMillis() { return this.ms; }
    isEqual(other) { return other instanceof Stamp && this.ms === other.ms; }
    static fromDate(date) { return new Stamp(date.getTime()); }
  }
  class Ref {
    constructor(path) { this.path = path; this.id = path.split("/").pop(); }
    collection(name) { return new Query(`${this.path}/${name}`); }
    async get() {
      const data = docs.get(this.path);
      return { id: this.id, ref: this, exists: data !== undefined, data: () => data };
    }
    async create(data) {
      if (docs.has(this.path)) throw Object.assign(new Error("exists"), { code: 6 });
      docs.set(this.path, data);
    }
  }
  class Query {
    constructor(path, filters = [], cursor = "", max = Infinity) {
      Object.assign(this, { path, filters, cursor, max });
    }
    doc(id) { return new Ref(`${this.path}/${id}`); }
    where(field, op, value) { return new Query(this.path, [...this.filters, [field, op, value]], this.cursor, this.max); }
    orderBy() { return this; }
    startAfter(cursor) { return new Query(this.path, this.filters, cursor, this.max); }
    limit(max) { return new Query(this.path, this.filters, this.cursor, max); }
    async get() {
      const prefix = `${this.path}/`;
      const rows = [...docs.entries()].filter(([key, data]) => {
        if (!key.startsWith(prefix) || key.slice(prefix.length).includes("/")) return false;
        if (key.slice(prefix.length) <= this.cursor) return false;
        return this.filters.every(([field, op, value]) => {
          const item = data[field];
          if (op === "==") return item === value;
          if (op === "in") return value.includes(item);
          if (op === ">=") return item && item.toMillis() >= value.toMillis();
          if (op === "<=") return item && item.toMillis() <= value.toMillis();
          throw new Error(`Unsupported operator ${op}`);
        });
      }).sort(([a], [b]) => a.localeCompare(b)).slice(0, this.max)
        .map(([key, data]) => ({ id: key.slice(prefix.length), ref: new Ref(key), exists: true, data: () => data }));
      return { docs: rows, empty: rows.length === 0, size: rows.length };
    }
  }
  const update = (ref, data) => {
    assert.ok(docs.has(ref.path));
    docs.set(ref.path, { ...docs.get(ref.path), ...data });
  };
  const db = {
    collection: name => new Query(name),
    async runTransaction(fn) {
      const writes = [];
      const result = await fn({
        get: ref => ref.get(),
        update: (ref, data) => writes.push(() => update(ref, data))
      });
      writes.forEach(write => write());
      return result;
    },
    batch() {
      const writes = [];
      return {
        set: (ref, data, options) => writes.push(() =>
          docs.set(ref.path, options?.merge ? { ...docs.get(ref.path), ...data } : data)),
        update: (ref, data) => writes.push(() => update(ref, data)),
        async commit() {
          batchCount++;
          if (batchCount === failBatchNumber) throw new Error("temporary failure");
          writes.forEach(write => write());
        }
      };
    }
  };
  const handlers = createNotifications({
    db, FieldPath: { documentId: () => "__name__" }, Timestamp: Stamp
  });
  return { docs, handlers, Stamp, failBatchAt: number => { failBatchNumber = number; } };
}

function snapshot(data) {
  return { exists: data !== undefined, data: () => data };
}
function event(id, params, before, after) {
  return { id, time: "2025-01-01T00:00:00Z", params,
    data: { before: snapshot(before), after: snapshot(after) } };
}
function notifications(docs, uid) {
  return [...docs.entries()].filter(([path]) => path.startsWith(`users/${uid}/notifications/`)).map(([, data]) => data);
}

test("chat and follow notifications go only to their intended recipient and retries preserve read status", async () => {
  const { docs, handlers } = setup();
  docs.set("goldenChats/chat", { participantIds: ["alice", "bob"] });
  const message = { id: "message-event", time: "2025-01-01T00:00:00Z",
    params: { chatId: "chat" }, data: snapshot({ senderUid: "alice", text: "private" }) };
  await handlers.message(message);
  const notice = notifications(docs, "bob")[0];
  assert.equal(notice.chatId, "chat");
  assert.equal(notice.message.includes("private"), false);
  notice.readAt = "read";
  await handlers.message(message);
  assert.equal(notifications(docs, "bob").length, 1);
  assert.equal(notifications(docs, "bob")[0].readAt, "read");
  assert.equal(notifications(docs, "alice").length, 0);
  await assert.rejects(handlers.message({ ...message, data: snapshot({ senderUid: "outsider" }) }), /participants/);
  await handlers.follower({ id: "follow", time: message.time,
    params: { userId: "bob", followerId: "alice" }, data: snapshot({ followerUid: "alice" }) });
  assert.equal(notifications(docs, "bob")[1].type, "follow");
});

test("order and payout updates notify participants only when status changes", async () => {
  const { docs, handlers } = setup();
  const order = { buyerUid: "buyer", vendorUid: "vendor", status: "SHIPPED" };
  await handlers.order(event("order", {}, { ...order, status: "HELD_IN_ESCROW" }, order));
  assert.equal(notifications(docs, "buyer")[0].message, "The order was marked as shipped.");
  assert.equal(notifications(docs, "vendor").length, 1);
  await handlers.order(event("same", {}, order, { ...order, productTitle: "new" }));
  assert.equal(notifications(docs, "buyer").length, 1);
  await handlers.withdrawal(event("payout", {}, { vendorUid: "vendor", status: "PENDING" },
    { vendorUid: "vendor", status: "FAILED" }));
  assert.match(notifications(docs, "vendor")[1].message, /failed/i);
  assert.equal(notifications(docs, "buyer").length, 1);
});

test("wallet, profile and missed-call events do not include sensitive details", async () => {
  const { docs, handlers } = setup();
  await handlers.wallet(event("wallet", { userId: "alice" }, { coins: 3 }, { coins: 8, dailyCheckInDay: "2025-01-01" }));
  await handlers.profile(event("profile", { userId: "alice" }, { name: "Old" }, { name: "New", location: "secret" }));
  await handlers.call(event("call", {}, { status: "ringing" },
    { status: "ended", calleeUid: "alice", callerUid: "bob", chatId: "chat", type: "video" }));
  await handlers.call(event("answered", {}, { status: "accepted" },
    { status: "ended", calleeUid: "alice", callerUid: "bob" }));
  const results = notifications(docs, "alice");
  assert.equal(results.length, 3);
  assert.match(results[0].message, /check-in/);
  assert.equal(results[1].message.includes("secret"), false);
  assert.match(results[2].message, /video/);
  assert.equal(notifications(docs, "bob").length, 0);
});

test("new vendor products reach only followers across pages and retries preserve read status", async () => {
  const { docs, handlers, failBatchAt } = setup();
  docs.set("users/vendor", { role: "Vendor", name: "Golden Store" });
  docs.set("users/outsider", {});
  for (let i = 0; i < 405; i++) {
    docs.set(`users/vendor/followers/user${String(i).padStart(3, "0")}`, {});
  }
  docs.set("users/vendor/followers/vendor", {});
  const product = { id: "product-event", time: "2025-01-01T00:00:00Z",
    params: { productId: "phone" }, data: snapshot({ ownerUid: "vendor", title: "Phone" }) };
  failBatchAt(2);
  await assert.rejects(handlers.product(product), /temporary failure/);
  notifications(docs, "user000")[0].readAt = "read";
  await handlers.product(product);
  for (let i = 0; i < 405; i++) {
    const notices = notifications(docs, `user${String(i).padStart(3, "0")}`);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, "new_product");
    assert.equal(notices[0].productId, "phone");
    assert.match(notices[0].message, /Golden Store added Phone/);
  }
  assert.equal(notifications(docs, "user000")[0].readAt, "read");
  assert.equal(notifications(docs, "outsider").length, 0);
  assert.equal(notifications(docs, "vendor").length, 0);
});

test("products owned by a non-vendor or without followers send no alerts", async () => {
  const { docs, handlers } = setup();
  const product = { id: "event", time: "2025-01-01T00:00:00Z",
    params: { productId: "phone" }, data: snapshot({ ownerUid: "seller", title: "Phone" }) };
  docs.set("users/seller", { role: "Buyer" });
  docs.set("users/seller/followers/alice", {});
  await handlers.product(product);
  assert.equal(notifications(docs, "alice").length, 0);
  docs.set("users/seller", { role: "Vendor" });
  docs.delete("users/seller/followers/alice");
  await handlers.product(product);
  assert.equal(notifications(docs, "alice").length, 0);
});

test("expired ringing calls are ended while accepted and recent calls remain unchanged", async () => {
  const { docs, handlers, Stamp } = setup();
  docs.set("notificationSettings/callExpiration", { earliestCallAt: new Stamp(Date.now() - 100000) });
  docs.set("calls/old", { status: "ringing", createdAt: new Stamp(Date.now() - 70000) });
  docs.set("calls/historical", { status: "ringing", createdAt: new Stamp(Date.now() - 200000) });
  docs.set("calls/recent", { status: "ringing", createdAt: new Stamp(Date.now()) });
  docs.set("calls/answered", { status: "accepted", createdAt: new Stamp(Date.now() - 70000) });
  await handlers.expireCalls();
  assert.equal(docs.get("calls/old").status, "ended");
  assert.equal(docs.get("calls/historical").status, "ringing");
  assert.equal(docs.get("calls/recent").status, "ringing");
  assert.equal(docs.get("calls/answered").status, "accepted");
});
