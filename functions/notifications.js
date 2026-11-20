"use strict";

const crypto = require("node:crypto");

function createNotifications({ db, FieldPath, Timestamp }) {
  const timestamp = event => Timestamp.fromDate(new Date(event.time));
  const idFor = value => crypto.createHash("sha256").update(value).digest("hex");

  async function createOnce(ref, data) {
    try {
      await ref.create(data);
    } catch (error) {
      if (error.code !== 6 && error.code !== "already-exists") throw error;
    }
  }

  async function notify(uid, event, data) {
    if (typeof uid !== "string" || !uid || uid.includes("/")) {
      throw new Error("Notification recipient is invalid.");
    }
    const ref = db.collection("users").doc(uid).collection("notifications")
      .doc(idFor(`${event.id}:${uid}`));
    await createOnce(ref, { ...data, createdAt: timestamp(event) });
  }

  async function follower(event) {
    const data = event.data?.data();
    if (!data || data.followerUid !== event.params.followerId ||
        event.params.followerId === event.params.userId) return;
    await notify(event.params.userId, event, {
      type: "follow", title: "New follower",
      message: "A marketplace member started following you."
    });
  }

  async function message(event) {
    const data = event.data?.data();
    if (!data) return;
    const chat = await db.collection("goldenChats").doc(event.params.chatId).get();
    const participants = chat.data()?.participantIds;
    if (!chat.exists || !Array.isArray(participants) || participants.length !== 2 ||
        !participants.includes(data.senderUid)) {
      throw new Error("Notification message has invalid chat participants.");
    }
    const recipient = participants.find(uid => uid !== data.senderUid);
    await notify(recipient, event, {
      type: "chat", title: "New Golden Chat message",
      message: "You received a new message.", chatId: event.params.chatId
    });
  }

  async function call(event) {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!before?.exists || !after?.exists) return;
    const previous = before.data();
    const current = after.data();
    if (previous.status !== "ringing" || current.status !== "ended") return;
    await notify(current.calleeUid, event, {
      type: "missed_call", title: "Missed call",
      message: `You missed a ${current.type === "video" ? "video" : "voice"} call.`,
      chatId: current.chatId
    });
  }

  async function order(event) {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!after?.exists) return;
    const data = after.data();
    if (before?.exists && before.data().status === data.status) return;
    if (typeof data.status !== "string") throw new Error("Order notification status is invalid.");
    const labels = {
      HELD_IN_ESCROW: "Payment is held in escrow.",
      SHIPPED: "The order was marked as shipped.",
      DISPUTED: "A dispute was opened for the order.",
      RELEASED: "The escrow payment was released.",
      AUTO_REFUND_REQUIRED: "The order requires a refund.",
      REFUND_INITIATING: "A refund is being initiated.",
      REFUND_PENDING: "The refund is pending.",
      REFUNDED: "The order was refunded."
    };
    const description = labels[data.status] || "The order status changed. Open your escrow orders for details.";
    await Promise.all([...new Set([data.buyerUid, data.vendorUid])].map(uid =>
      notify(uid, event, { type: "order", title: "Escrow order update", message: description })
    ));
  }

  async function withdrawal(event) {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!after?.exists) return;
    const data = after.data();
    if (before?.exists && before.data().status === data.status) return;
    const labels = {
      INITIATING: "Your payout request is being initiated.",
      PENDING: "Your payout is pending.",
      PAID: "Your payout was completed.",
      FAILED: "Your payout failed. Check your cash balance and payout history."
    };
    await notify(data.vendorUid, event, {
      type: "payout", title: "Payout update",
      message: labels[data.status] || "Your payout status changed. Check your payout history."
    });
  }

  async function walletPurchase(event) {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!after?.exists) return;
    const data = after.data();
    if (!["paid", "failed"].includes(data.status) ||
        (before?.exists && before.data().status === data.status)) return;
    await notify(data.uid, event, {
      type: "wallet", title: "Wallet purchase update",
      message: data.status === "paid"
        ? "Your wallet purchase was verified."
        : "Your wallet purchase failed. Check your payment before trying again."
    });
  }

  async function wallet(event) {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!after?.exists) return;
    const old = before?.exists ? before.data() : {};
    const data = after.data();
    const changed = ["coins", "likes", "loves", "hates", "dailyCheckInDay"]
      .some(key => old[key] !== data[key]);
    if (!changed) return;
    await notify(event.params.userId, event, {
      type: "wallet", title: "Wallet update",
      message: old.dailyCheckInDay !== data.dailyCheckInDay && data.dailyCheckInDay
        ? "Your daily check-in reward was added to your wallet."
        : "Your Golden Chat wallet or rewards balance changed."
    });
  }

  async function profile(event) {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!before?.exists || !after?.exists) return;
    const old = before.data();
    const data = after.data();
    if (!["name", "profilePhotoPath", "location", "gender", "ageRange", "description",
      "allowMediaDownloads", "followersPrivate", "followingPrivate", "verifiedDealerUntil",
      "verifiedDealerAutoRenew", "verifiedDealerAutoRenewPaused"]
      .some(key => {
        const left = old[key], right = data[key];
        if (typeof left?.isEqual === "function") return !left.isEqual(right);
        return left !== right;
      })) return;
    await notify(event.params.userId, event, {
      type: "account", title: "Account update",
      message: "Your profile or account settings were updated."
    });
  }

  async function product(event) {
    if (!event.data?.exists) return;
    const listing = event.data.data();
    const { ownerUid, title } = listing;
    if (typeof ownerUid !== "string" || !ownerUid || ownerUid.includes("/") ||
        typeof title !== "string" || !title.trim()) {
      throw new Error("New product notification data is invalid.");
    }
    const vendorRef = db.collection("users").doc(ownerUid);
    const vendor = await vendorRef.get();
    if (!vendor.exists || vendor.data().role !== "Vendor") return;
    const name = typeof vendor.data().name === "string" && vendor.data().name.trim()
      ? vendor.data().name.trim().slice(0, 120) : "A vendor you follow";
    let cursor = null;
    while (true) {
      let query = vendorRef.collection("followers").orderBy(FieldPath.documentId()).limit(400);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) return;
      const batch = db.batch();
      let recipients = 0;
      for (const follower of page.docs) {
        if (follower.id === ownerUid) continue;
        const ref = db.collection("users").doc(follower.id).collection("notifications")
          .doc(idFor(`${event.id}:${follower.id}`));
        batch.set(ref, {
          type: "new_product",
          title: "New product from a vendor you follow",
          message: `${name} added ${title.trim().slice(0, 160)}.`,
          vendorUid: ownerUid,
          productId: event.params.productId,
          createdAt: timestamp(event)
        }, { merge: true });
        recipients++;
      }
      if (recipients) await batch.commit();
      cursor = page.docs[page.docs.length - 1].id;
      if (page.size < 400) return;
    }
  }

  async function expireCalls() {
    const now = Date.now();
    const configRef = db.collection("notificationSettings").doc("callExpiration");
    await createOnce(configRef, { earliestCallAt: Timestamp.fromDate(new Date(now)) });
    const config = await configRef.get();
    const cutoff = Timestamp.fromDate(new Date(now - 60000));
    while (true) {
      const calls = await db.collection("calls").where("status", "==", "ringing")
        .where("createdAt", ">=", config.data().earliestCallAt)
        .where("createdAt", "<=", cutoff).limit(200).get();
      if (calls.empty) return;
      await Promise.all(calls.docs.map(doc => db.runTransaction(async tx => {
        const current = await tx.get(doc.ref);
        if (current.exists && current.data().status === "ringing" &&
            current.data().createdAt?.toMillis() <= cutoff.toMillis()) {
          tx.update(doc.ref, { status: "ended" });
        }
      })));
    }
  }

  return { follower, message, call, order, withdrawal, walletPurchase, wallet, profile, product, expireCalls };
}

module.exports = { createNotifications };
