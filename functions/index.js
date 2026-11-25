const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { AggregateField, FieldPath, FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const crypto = require("node:crypto");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const {
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentWritten
} = require("firebase-functions/v2/firestore");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { logger } = require("firebase-functions");
const { calculateEscrowFee } = require("./escrow-fee");
const escrowFulfillment = require("./escrow-fulfillment");
const { answerGoldenAi } = require("./golden-ai");
const { createNotifications } = require("./notifications");

initializeApp();

const db = getFirestore();
const notifications = createNotifications({ db, FieldPath, Timestamp });
const notificationTrigger = document => ({ document, retry: true });
exports.notifyNewFollower = onDocumentCreated(notificationTrigger("users/{userId}/followers/{followerId}"), notifications.follower);
exports.notifyGoldenChatMessage = onDocumentCreated(notificationTrigger("goldenChats/{chatId}/messages/{messageId}"), notifications.message);
exports.notifyMissedCall = onDocumentWritten(notificationTrigger("calls/{callId}"), notifications.call);
exports.notifyEscrowOrder = onDocumentWritten(notificationTrigger("escrowOrders/{orderId}"), notifications.order);
exports.notifyVendorWithdrawal = onDocumentWritten(notificationTrigger("escrowWithdrawals/{withdrawalId}"), notifications.withdrawal);
exports.notifyWalletPurchase = onDocumentWritten(notificationTrigger("walletPurchases/{purchaseId}"), notifications.walletPurchase);
exports.notifyWalletUpdate = onDocumentWritten(notificationTrigger("quizWallets/{userId}"), notifications.wallet);
exports.notifyAccountUpdate = onDocumentWritten(notificationTrigger("users/{userId}"), notifications.profile);
exports.notifyNewVendorProduct = onDocumentCreated(
  { document: "products/{productId}", retry: true, memory: "1GiB", timeoutSeconds: 540 },
  notifications.product
);
exports.expireUnansweredCalls = onSchedule(
  { schedule: "* * * * *", timeZone: "Etc/UTC", timeoutSeconds: 540, retryCount: 3 },
  notifications.expireCalls
);
const FLUTTERWAVE_SECRET_KEY = defineSecret("FLUTTERWAVE_SECRET_KEY");
const FLUTTERWAVE_WEBHOOK_HASH = defineSecret("FLUTTERWAVE_WEBHOOK_HASH");
const FLW_SECRET_KEY = defineSecret("FLW_SECRET_KEY");
const FLW_SECRET_HASH = defineSecret("FLW_SECRET_HASH");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GOLDEN_AI_SERVICE_ACCOUNT = defineString("GOLDEN_AI_SERVICE_ACCOUNT");
const PAYMENT_REDIRECT_URL = "https://goldeneaglegsm.com/";
const QUIZ_QUESTION_COUNT = 5;
const QUIZ_SECONDS_PER_QUESTION = 30;
const QUIZ_LIKE_REWARD = 10;
const FREE_DAILY_REWARD_PLAYS = 2;
const PAID_DAILY_REWARD_PLAYS = 5;
const PURCHASES = {
  lovePack: { amount: 500, currency: "NGN", loves: 10 },
  hatePack: { amount: 500, currency: "NGN", hates: 5 },
  quizPlayPack: { amount: 1000, currency: "NGN", plays: PAID_DAILY_REWARD_PLAYS },
  chatCoins12: { amount: 350, currency: "NGN", coins: 12 },
  chatCoins50: { amount: 1500, currency: "NGN", coins: 50 },
  chatCoins350: { amount: 7500, currency: "NGN", coins: 350 }
};
const CHAT_ACTION_COSTS = { text: 1, image: 2, video: 4, voice: 3 };
const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CHAT_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_CHAT_VOICE_BYTES = 25 * 1024 * 1024;
const CHAT_MEDIA_RESERVATION_MS = 10 * 60 * 1000;
const PRODUCT_BOOST_COST = 5;
const PRODUCT_BOOST_DURATION_MS = 24 * 60 * 60 * 1000;
const STOCK_ALERT_COST = 10;
const STOCK_ALERT_PAGE_SIZE = 400;
const REFERRER_REFERRAL_BONUS = 10;
const REFERRED_USER_REFERRAL_BONUS = 5;
const REFERRAL_ATTRIBUTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const VERIFIED_DEALER_BADGE_COST = 24;
const REACTION_UNDO_WINDOW_MS = 10 * 1000;
const OWNER_ADMIN_UID = "LROHsLUXfEPnC6bDmSvy3vcRnNE3";
const PERMANENT_VERIFIED_DEALER_UID = "71ZtsYMKKtMsOSdHhBHAbjHzcqc2";
const PERMANENT_VERIFIED_DEALER_EMAIL = "employmentteamr303@gmail.com";
const FIRST_SANCTION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function isOwnerAdmin(auth) {
  return auth?.uid === OWNER_ADMIN_UID;
}

function containsPhoneNumber(value) {
  if (typeof value !== "string") return false;
  const normalized = value
    .normalize("NFKC")
    .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/(?:zero|oh|o)/gi, match => match.toLowerCase().startsWith("o") ? "0" : "0")
    .toLowerCase()
    .replace(/[^0-9+]/g, "");
  return /(?:\+?234[0-9]{10}|0[789][01][0-9]{8}|[0-9]{10,15})/.test(normalized);
}

function assertNoPhoneNumbers(data, fields) {
  const field = fields.find(name => containsPhoneNumber(data[name]));
  if (field) {
    throw new HttpsError(
      "invalid-argument",
      "Phone numbers and off-platform contact details cannot appear in product listings."
    );
  }
}

async function recordPostingViolation(auth, source, productId = null) {
  const sanctionRef = db.collection("accountSanctions").doc(auth.uid);
  const nowMs = Date.now();
  const violationRef = db.collection("moderationViolations").doc();
  const result = await db.runTransaction(async transaction => {
    const sanctionSnapshot = await transaction.get(sanctionRef);
    const current = sanctionSnapshot.data() || {};
    const warningCount = Number.isSafeInteger(current.warningCount) ? current.warningCount + 1 : 1;
    const existingUntilMs = timestampMillis(current.restrictedUntil);
    const restrictedUntil = new Date(Math.max(existingUntilMs, nowMs) + FIRST_SANCTION_DURATION_MS);
    transaction.set(sanctionRef, {
      warningCount,
      restrictedUntil,
      ownerReviewRequired: warningCount >= 3,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.create(violationRef, {
      uid: auth.uid,
      source,
      productId,
      warningNumber: warningCount,
      createdAt: FieldValue.serverTimestamp()
    });
    transaction.create(db.collection("adminSecurityAudit").doc(), {
      action: "phone-number-posting-violation",
      actorUid: auth.uid,
      targetUid: auth.uid,
      warningNumber: warningCount,
      source,
      productId,
      createdAt: FieldValue.serverTimestamp()
    });
    return { warningCount, restrictedUntilMs: restrictedUntil.getTime() };
  });
  return result;
}

async function assertCanPublish(auth) {
  const snapshot = await db.collection("accountSanctions").doc(auth.uid).get();
  if (!snapshot.exists) return;
  const sanction = snapshot.data();
  const restrictedUntilMs = timestampMillis(sanction.restrictedUntil);
  if (sanction.ownerReviewRequired === true) {
    throw new HttpsError(
      "permission-denied",
      "Your account is awaiting owner review after repeated contact-sharing violations."
    );
  }
  if (restrictedUntilMs > Date.now()) {
    throw new HttpsError(
      "permission-denied",
      `Product posting is restricted until ${new Date(restrictedUntilMs).toISOString()}.`
    );
  }
}

function requireVerifiedUser(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in to use this marketplace feature.");
  }
  const token = request.auth.token;
  const provider = token.firebase?.sign_in_provider;
  if (provider !== "phone" && token.email_verified !== true) {
    throw new HttpsError("permission-denied", "Verify your account before using the reaction store.");
  }
  return request.auth;
}

const goldenAiLimits = new Map();
exports.askGoldenAi = onCall(
  { secrets: [GEMINI_API_KEY], serviceAccount: GOLDEN_AI_SERVICE_ACCOUNT,
    maxInstances: 2, concurrency: 20, timeoutSeconds: 40 },
  async request => {
    const auth = requireVerifiedUser(request);
    if (!request.data || Object.keys(request.data).some(key => key !== "prompt")) {
      throw new HttpsError("invalid-argument", "Send only a question.");
    }
    const now = Date.now();
    for (const [key, value] of goldenAiLimits) {
      if (value.expiresAt <= now) goldenAiLimits.delete(key);
    }
    const key = crypto.createHash("sha256").update(auth.uid).digest("hex");
    const current = goldenAiLimits.get(key);
    if (current && current.count >= 8) {
      throw new HttpsError("resource-exhausted", "Too many questions. Please wait a minute and try again.");
    }
    if (!current && goldenAiLimits.size >= 2000) {
      throw new HttpsError("resource-exhausted", "The assistant is busy. Please try again shortly.");
    }
    goldenAiLimits.set(key, current
      ? { ...current, count: current.count + 1 }
      : { count: 1, expiresAt: now + 60000 });
    try {
      const result = await answerGoldenAi({ prompt: request.data.prompt,
        projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
        apiKey: GEMINI_API_KEY.value(),
        payoutsEnabled: process.env.GCLOUD_PROJECT === "golden-eagle-marketplace" &&
          process.env.ESCROW_LIVE_PAYOUTS_ENABLED === "true" });
      if (result.error) throw new HttpsError(result.error, result.message);
      return result;
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.error("Golden AI assistant request failed.");
      throw new HttpsError("unavailable", "The assistant is temporarily unavailable. Please try again.");
    }
  }
);

function requireQuizAdmin(request) {
  const auth = requireVerifiedUser(request);
  if (!isOwnerAdmin(auth)) {
    throw new HttpsError("permission-denied", "Quiz administrator access is required.");
  }
  return auth;
}

function accountWalletRef(uid) {
  return db.collection("quizWallets").doc(uid);
}

function dailyQuizUsageRef(uid, dayKey) {
  return db.collection("quizDailyUsage").doc(`${uid}_${dayKey}`);
}

function normalizeDirectoryValue(value) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 1000) : "";
}

function memberSearchTokens(values) {
  const tokens = new Set();
  values.forEach(value => {
    normalizeDirectoryValue(value)
      .split(/[^a-z0-9@.+_-]+/)
      .filter(word => word.length >= 2)
      .forEach(word => {
        const maxLength = Math.min(word.length, 32);
        for (let length = 2; length <= maxLength; length += 1) {
          tokens.add(word.slice(0, length));
        }
      });
  });
  return [...tokens];
}

function redactEmailAddresses(value) {
  return value.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "email hidden");
}

function searchableMember(uid, profile) {
  if (!profile || !["Buyer", "Vendor"].includes(profile.role)) return null;
  const rawName = typeof profile.name === "string" ? profile.name.slice(0, 120) : "";
  const name = rawName && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawName)
    ? redactEmailAddresses(rawName)
    : "Marketplace member";
  return {
    uid,
    name,
    role: profile.role,
    location: typeof profile.location === "string"
      ? redactEmailAddresses(profile.location.slice(0, 160))
      : "",
    description: typeof profile.description === "string"
      ? redactEmailAddresses(profile.description.slice(0, 1000))
      : "",
    profilePhotoPath: typeof profile.profilePhotoPath === "string" ? profile.profilePhotoPath : ""
  };
}

async function writeMemberDirectory(uid, profile) {
  const member = searchableMember(uid, profile);
  const directoryRef = db.collection("memberDirectory").doc(uid);
  if (!member) {
    await directoryRef.delete();
    return;
  }
  const directoryData = {
    ...member,
    searchTokens: memberSearchTokens([
      member.name,
      member.role,
      member.location,
      member.description
    ]),
    updatedAt: FieldValue.serverTimestamp()
  };
  const existing = await directoryRef.get();
  const previous = existing.data() || {};
  const unchanged = existing.exists &&
    previous.name === directoryData.name &&
    previous.role === directoryData.role &&
    previous.location === directoryData.location &&
    previous.description === directoryData.description &&
    previous.profilePhotoPath === directoryData.profilePhotoPath &&
    JSON.stringify(previous.searchTokens) === JSON.stringify(directoryData.searchTokens);
  if (!unchanged) await directoryRef.set(directoryData);
}

exports.syncMemberDirectory = onDocumentWritten("users/{userId}", async event => {
  const snapshot = event.data?.after;
  if (!snapshot?.exists) {
    await db.collection("memberDirectory").doc(event.params.userId).delete();
    return;
  }
  await writeMemberDirectory(event.params.userId, snapshot.data());
});

exports.ensureMyMemberDirectoryEntry = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const profileSnapshot = await db.collection("users").doc(auth.uid).get();
  if (!profileSnapshot.exists) {
    throw new HttpsError("failed-precondition", "Complete your account profile before searching for members.");
  }
  await writeMemberDirectory(auth.uid, profileSnapshot.data());
  return { indexed: true };
});

exports.searchMarketplaceMembers = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const query = typeof request.data?.query === "string" ? request.data.query.trim() : "";
  if (query.length < 2 || query.length > 120) {
    throw new HttpsError("invalid-argument", "Enter at least 2 characters and no more than 120.");
  }

  const now = Date.now();
  const limitRef = db.collection("memberSearchLimits").doc(auth.uid);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(limitRef);
    const current = snapshot.data() || {};
    const withinWindow = Number.isInteger(current.windowStartMs) &&
      now >= current.windowStartMs && now - current.windowStartMs < 60_000;
    const requestCount = withinWindow && Number.isInteger(current.requestCount)
      ? current.requestCount
      : 0;
    if (requestCount >= 30) {
      throw new HttpsError("resource-exhausted", "Too many member searches. Please wait a minute and try again.");
    }
    transaction.set(limitRef, {
      windowStartMs: withinWindow ? current.windowStartMs : now,
      requestCount: requestCount + 1,
      updatedAt: FieldValue.serverTimestamp()
    });
  });

  const results = new Map();
  const emailQuery = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query);
  if (emailQuery) {
    try {
      const user = await getAuth().getUserByEmail(query.toLowerCase());
      if (user.uid !== auth.uid) {
        const profileSnapshot = await db.collection("users").doc(user.uid).get();
        if (profileSnapshot.exists) {
          const member = searchableMember(user.uid, profileSnapshot.data());
          if (member) results.set(user.uid, member);
        }
      }
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        logger.error("Marketplace member email lookup failed.", { error });
        throw new HttpsError("internal", "Member search could not be completed. Please try again.");
      }
    }
  } else {
    const terms = [...new Set(normalizeDirectoryValue(query)
      .split(/\s+/)
      .filter(term => term.length >= 2)
      .map(term => term.slice(0, 32))
      .slice(0, 5))];
    const matches = await Promise.all(terms.map(term =>
      db.collection("memberDirectory")
        .where("searchTokens", "array-contains", term)
        .limit(40)
        .get()
    ));
    const matchingIds = matches.length
      ? matches[0].docs
        .filter(document => matches.every(snapshot => snapshot.docs.some(match => match.id === document.id)))
        .map(document => document.id)
      : [];
    matchingIds.forEach(uid => {
      if (uid === auth.uid) return;
      const document = matches[0].docs.find(match => match.id === uid);
      if (!document) return;
      const member = searchableMember(uid, document.data());
      if (member) results.set(uid, member);
    });
  }

  return {
    members: [...results.values()].slice(0, 20)
  };
});

exports.recordProfileView = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const profileUid = request.data?.profileUid;
  if (typeof profileUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(profileUid) ||
      profileUid === auth.uid) {
    return { recorded: false };
  }
  const [viewer, target] = await Promise.all([
    db.collection("users").doc(auth.uid).get(),
    db.collection("users").doc(profileUid).get()
  ]);
  if (!viewer.exists || !target.exists) {
    throw new HttpsError("not-found", "This profile could not be found.");
  }
  await db.collection("users").doc(profileUid).collection("profileViews").doc(auth.uid).set({
    viewerUid: auth.uid,
    viewerName: typeof viewer.data().name === "string" ? viewer.data().name.slice(0, 120) : "Marketplace member",
    viewerRole: viewer.data().role === "Vendor" ? "Vendor" : "Buyer",
    viewedAt: FieldValue.serverTimestamp()
  });
  return { recorded: true };
});

exports.listProfileViewers = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const snapshot = await db.collection("users").doc(auth.uid).collection("profileViews")
    .orderBy("viewedAt", "desc")
    .limit(50)
    .get();
  return {
    viewers: snapshot.docs.map(document => ({
      uid: document.id,
      name: document.data().viewerName,
      role: document.data().viewerRole,
      viewedAtMs: timestampMillis(document.data().viewedAt)
    }))
  };
});

exports.quickFollowMember = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const memberUid = request.data?.memberUid;
  if (typeof memberUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(memberUid) ||
      memberUid === auth.uid) {
    throw new HttpsError("invalid-argument", "Choose a valid member to follow.");
  }
  const [viewerSnapshot, memberSnapshot] = await Promise.all([
    db.collection("users").doc(auth.uid).get(),
    db.collection("users").doc(memberUid).get()
  ]);
  if (!viewerSnapshot.exists || !memberSnapshot.exists ||
      !["Buyer", "Vendor"].includes(memberSnapshot.data().role)) {
    throw new HttpsError("not-found", "This member could not be found.");
  }
  const followRef = db.collection("users").doc(auth.uid)
    .collection("following").doc(memberUid);
  const followerRef = db.collection("users").doc(memberUid)
    .collection("followers").doc(auth.uid);
  const added = await db.runTransaction(async transaction => {
    const [followSnapshot, followerSnapshot] = await Promise.all([
      transaction.get(followRef),
      transaction.get(followerRef)
    ]);
    if (followSnapshot.exists && followerSnapshot.exists) return false;
    const timestamp = FieldValue.serverTimestamp();
    transaction.set(followRef, {
      memberUid,
      memberName: String(memberSnapshot.data().name || "Marketplace member").slice(0, 120),
      memberRole: memberSnapshot.data().role,
      createdAt: timestamp
    }, { merge: true });
    transaction.set(followerRef, {
      followerUid: auth.uid,
      followerName: String(viewerSnapshot.data().name || "Marketplace member").slice(0, 120),
      followerRole: viewerSnapshot.data().role === "Vendor" ? "Vendor" : "Buyer",
      createdAt: timestamp
    }, { merge: true });
    return true;
  });
  return { followed: true, alreadyFollowing: !added, memberUid };
});

async function sumOwnedItemLikes(itemsCollection, statsCollection, ownerUid) {
  const items = await db.collection(itemsCollection)
    .where("ownerUid", "==", ownerUid)
    .get();
  const statsRefs = items.docs.map(document =>
    db.collection(statsCollection).doc(document.id)
  );
  let likes = 0;
  for (let offset = 0; offset < statsRefs.length; offset += 300) {
    const statsSnapshots = await db.getAll(...statsRefs.slice(offset, offset + 300));
    statsSnapshots.forEach(snapshot => {
      const count = snapshot.data()?.likes;
      if (Number.isSafeInteger(count) && count > 0) likes += count;
    });
  }
  return likes;
}

exports.getPublicProfileStats = onCall(async request => {
  requireVerifiedUser(request);
  const profileUid = request.data?.profileUid;
  if (typeof profileUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(profileUid)) {
    throw new HttpsError("invalid-argument", "Choose a valid member profile.");
  }

  const profileSnapshot = await db.collection("users").doc(profileUid).get();
  if (!profileSnapshot.exists) {
    throw new HttpsError("not-found", "This member profile is no longer available.");
  }

  const [followersCountSnapshot, followingCountSnapshot, communityLikes, productLikes,
    quizAttemptsSnapshot, walletSnapshot] = await Promise.all([
    db.collection("users").doc(profileUid).collection("followers").count().get(),
    db.collection("users").doc(profileUid).collection("following").count().get(),
    sumOwnedItemLikes("communityPosts", "communityPostStats", profileUid),
    sumOwnedItemLikes("products", "productDiscussionStats", profileUid),
    db.collection("quizAttempts").where("uid", "==", profileUid)
      .select("status", "awardedLikes").get(),
    db.collection("quizWallets").doc(profileUid).get()
  ]);
  const quizLikesEarned = quizAttemptsSnapshot.docs.reduce((total, attempt) => {
    const data = attempt.data();
    return data.status === "submitted" && Number.isSafeInteger(data.awardedLikes) && data.awardedLikes > 0
      ? total + data.awardedLikes
      : total;
  }, 0);

  return {
    followersCount: followersCountSnapshot.data().count,
    followingCount: followingCountSnapshot.data().count,
    likesReceived: communityLikes + productLikes,
    quizLikesEarned,
    quizLikesAvailable: normalizedWallet(walletSnapshot.data()).likes,
    followersPrivate: profileSnapshot.data().followersPrivate === true,
    followingPrivate: profileSnapshot.data().followingPrivate === true
  };
});

function normalizedWallet(data = {}) {
  return {
    likes: Number.isInteger(data.likes) && data.likes >= 0 ? data.likes : 0,
    loves: Number.isInteger(data.loves) && data.loves >= 0 ? data.loves : 0,
    hates: Number.isInteger(data.hates) && data.hates >= 0 ? data.hates : 0,
    coins: typeof data.coins === "number" &&
      data.coins >= 0 &&
      Number.isSafeInteger(data.coins * 2)
      ? data.coins
      : 0
  };
}

function quizLikeRewardAmount(finalQuestion, perfect, rewardEligible, likeRewardEligible) {
  return finalQuestion && perfect && rewardEligible && likeRewardEligible
    ? QUIZ_LIKE_REWARD
    : 0;
}

function requireProductReactionTarget(productSnapshot, uid) {
  if (!productSnapshot.exists) {
    throw new HttpsError("not-found", "This product listing could not be found.");
  }
  const product = productSnapshot.data();
  if (typeof product.ownerUid !== "string" || !product.ownerUid) {
    throw new HttpsError("failed-precondition", "This product listing has no valid owner.");
  }
  if (product.ownerUid === uid) {
    throw new HttpsError("permission-denied", "You cannot react to your own product listing.");
  }
  return product;
}

exports.claimDailyCheckIn = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const day = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
  const walletRef = accountWalletRef(auth.uid);
  const profileRef = db.collection("users").doc(auth.uid);
  return db.runTransaction(async transaction => {
    const [profile, wallet] = await Promise.all([
      transaction.get(profileRef), transaction.get(walletRef)
    ]);
    if (!profile.exists || !["Buyer", "Vendor"].includes(profile.data().role)) {
      throw new HttpsError("failed-precondition", "Complete your marketplace profile before checking in.");
    }
    const data = wallet.data() || {};
    if (wallet.exists && data.coins !== undefined &&
        (typeof data.coins !== "number" || data.coins < 0 || !Number.isSafeInteger(data.coins * 2))) {
      throw new HttpsError("failed-precondition", "Your coin balance needs reconciliation.");
    }
    const coins = normalizedWallet(data).coins;
    if (typeof data.dailyCheckInDay === "string" && data.dailyCheckInDay >= day) {
      return { awarded: false, coinsRemaining: coins, day };
    }
    if (!Number.isSafeInteger((coins + 5) * 2)) {
      throw new HttpsError("failed-precondition", "Your coin balance needs reconciliation.");
    }
    transaction.set(walletRef, { coins: coins + 5, dailyCheckInDay: day,
      dailyCheckInAt: FieldValue.serverTimestamp() }, { merge: true });
    return { awarded: true, coinsRemaining: coins + 5, day };
  });
});

function profileIsChatReady(uid, profile) {
  const photoPrefix = `profile-photos/${uid}/`;
  const photoName = typeof profile?.profilePhotoPath === "string" &&
    profile.profilePhotoPath.startsWith(photoPrefix)
    ? profile.profilePhotoPath.slice(photoPrefix.length)
    : "";
  return typeof profile?.name === "string" && profile.name.trim().length > 0 &&
    /^[A-Za-z0-9_-]+$/.test(photoName) &&
    typeof profile.location === "string" && profile.location.trim().length > 0 &&
    ["Woman", "Man", "Non-binary", "Prefer not to say"].includes(profile.gender) &&
    ["Under 18", "18-24", "25-34", "35-44", "45-54", "55+"].includes(profile.ageRange) &&
    (profile.role !== "Vendor" ||
      (typeof profile.description === "string" && profile.description.trim().length > 0));
}

exports.getReferralInfo = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const userProfileSnapshot = await db.collection("users").doc(auth.uid).get();
  if (!userProfileSnapshot.exists ||
      !["Buyer", "Vendor"].includes(userProfileSnapshot.data().role)) {
    throw new HttpsError("failed-precondition", "Complete your marketplace profile before creating a referral link.");
  }

  const referralProfileRef = db.collection("referralProfiles").doc(auth.uid);
  let referralCode = null;
  for (let attempt = 0; attempt < 5 && !referralCode; attempt += 1) {
    const candidateCode = crypto.randomBytes(6).toString("hex").toUpperCase();
    let codeCollision = false;
    await db.runTransaction(async transaction => {
      referralCode = null;
      codeCollision = false;
      const profileSnapshot = await transaction.get(referralProfileRef);
      if (profileSnapshot.exists) {
        const existingCode = profileSnapshot.data().code;
        if (typeof existingCode !== "string" || !/^[A-F0-9]{12}$/.test(existingCode)) {
          throw new HttpsError("internal", "Your saved referral link could not be verified.");
        }
        const existingCodeSnapshot = await transaction.get(
          db.collection("referralCodes").doc(existingCode)
        );
        if (!existingCodeSnapshot.exists || existingCodeSnapshot.data().uid !== auth.uid) {
          throw new HttpsError("internal", "Your saved referral link could not be verified.");
        }
        referralCode = existingCode;
        return;
      }

      const candidateRef = db.collection("referralCodes").doc(candidateCode);
      const candidateSnapshot = await transaction.get(candidateRef);
      if (candidateSnapshot.exists) {
        codeCollision = true;
        return;
      }
      transaction.create(referralProfileRef, {
        uid: auth.uid,
        code: candidateCode,
        createdAt: FieldValue.serverTimestamp()
      });
      transaction.create(candidateRef, {
        uid: auth.uid,
        createdAt: FieldValue.serverTimestamp()
      });
      referralCode = candidateCode;
    });
    if (!referralCode && !codeCollision) {
      throw new HttpsError("internal", "A referral link could not be created.");
    }
  }

  if (!referralCode) {
    throw new HttpsError("unavailable", "A unique referral link could not be created. Try again.");
  }
  const referralUrl = new URL(PAYMENT_REDIRECT_URL);
  referralUrl.searchParams.set("ref", referralCode);
  return {
    referralCode,
    referralLink: referralUrl.toString(),
    referrerBonusCoins: REFERRER_REFERRAL_BONUS,
    referredUserBonusCoins: REFERRED_USER_REFERRAL_BONUS
  };
});

exports.recordReferralSignup = onCall(async request => {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "Create an account before attaching a referral link.");
  }
  const referralCode = typeof request.data?.referralCode === "string"
    ? request.data.referralCode.trim().toUpperCase()
    : "";
  if (!/^[A-F0-9]{12}$/.test(referralCode)) {
    throw new HttpsError("invalid-argument", "This referral link is invalid.");
  }

  const attributionRef = db.collection("referralAttributions").doc(auth.uid);
  const existingAttribution = await attributionRef.get();
  if (existingAttribution.exists) {
    if (existingAttribution.data().referralCode !== referralCode) {
      throw new HttpsError("already-exists", "A referral link is already attached to this account.");
    }
    return { attributed: true, duplicate: true };
  }

  const referralCodeRef = db.collection("referralCodes").doc(referralCode);
  const [referredAuthUser, referralCodeSnapshot] = await Promise.all([
    getAuth().getUser(auth.uid),
    referralCodeRef.get()
  ]);
  if (!referralCodeSnapshot.exists) {
    throw new HttpsError("not-found", "This referral link is no longer valid.");
  }
  const referrerUid = referralCodeSnapshot.data().uid;
  if (typeof referrerUid !== "string" || referrerUid === auth.uid) {
    throw new HttpsError("permission-denied", "You cannot refer your own account.");
  }

  const creationTimeMs = Date.parse(referredAuthUser.metadata.creationTime);
  if (!Number.isFinite(creationTimeMs) ||
      creationTimeMs > Date.now() ||
      Date.now() - creationTimeMs > REFERRAL_ATTRIBUTION_WINDOW_MS) {
    throw new HttpsError(
      "failed-precondition",
      "A referral link can only be attached to a newly created account."
    );
  }

  const [referrerProfileSnapshot, referrerAuthUser] = await Promise.all([
    db.collection("users").doc(referrerUid).get(),
    getAuth().getUser(referrerUid).catch(error => {
      if (error.code === "auth/user-not-found") {
        throw new HttpsError("failed-precondition", "This referral link is no longer active.");
      }
      throw error;
    })
  ]);
  if (!referrerProfileSnapshot.exists ||
      !["Buyer", "Vendor"].includes(referrerProfileSnapshot.data().role) ||
      referrerAuthUser.disabled) {
    throw new HttpsError("failed-precondition", "This referral link is no longer active.");
  }
  const referredEmail = referredAuthUser.email?.trim().toLowerCase();
  const referrerEmail = referrerAuthUser.email?.trim().toLowerCase();
  const sameEmail = Boolean(referredEmail && referrerEmail && referredEmail === referrerEmail);
  const samePhone = Boolean(
    referredAuthUser.phoneNumber &&
    referrerAuthUser.phoneNumber &&
    referredAuthUser.phoneNumber === referrerAuthUser.phoneNumber
  );
  if (sameEmail || samePhone) {
    throw new HttpsError("permission-denied", "You cannot refer your own account.");
  }

  let duplicate = false;
  await db.runTransaction(async transaction => {
    duplicate = false;
    const [attributionSnapshot, currentCodeSnapshot] = await Promise.all([
      transaction.get(attributionRef),
      transaction.get(referralCodeRef)
    ]);
    if (attributionSnapshot.exists) {
      if (attributionSnapshot.data().referralCode !== referralCode) {
        throw new HttpsError("already-exists", "A referral link is already attached to this account.");
      }
      duplicate = true;
      return;
    }
    if (!currentCodeSnapshot.exists || currentCodeSnapshot.data().uid !== referrerUid) {
      throw new HttpsError("not-found", "This referral link is no longer valid.");
    }
    transaction.create(attributionRef, {
      referredUid: auth.uid,
      referrerUid,
      referralCode,
      status: "pending",
      createdAt: FieldValue.serverTimestamp()
    });
  });
  return { attributed: true, duplicate };
});

async function qualifyReferral(uid) {
  const profileRef = db.collection("users").doc(uid);
  const attributionRef = db.collection("referralAttributions").doc(uid);
  const awardRef = db.collection("referralAwards").doc(uid);
  const [initialAttributionSnapshot, initialProfileSnapshot] = await Promise.all([
    attributionRef.get(),
    profileRef.get()
  ]);
  if (!initialAttributionSnapshot.exists) {
    return { eligible: false, awarded: false };
  }
  if (initialAttributionSnapshot.data().status === "qualified") {
    return { eligible: true, awarded: false, duplicate: true };
  }
  if (!initialProfileSnapshot.exists ||
      !["Buyer", "Vendor"].includes(initialProfileSnapshot.data().role) ||
      !profileIsChatReady(uid, initialProfileSnapshot.data())) {
    return { eligible: true, awarded: false, profileComplete: false };
  }
  const photoPath = initialProfileSnapshot.data().profilePhotoPath;
  try {
    const [metadata] = await getStorage().bucket().file(photoPath).getMetadata();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(metadata.contentType || "") ||
        !Number.isFinite(Number(metadata.size)) ||
        Number(metadata.size) <= 0 || Number(metadata.size) > 5 * 1024 * 1024) {
      return { eligible: true, awarded: false, profileComplete: false };
    }
  } catch (error) {
    if (error.code === 404) {
      return { eligible: true, awarded: false, profileComplete: false };
    }
    throw error;
  }

  let result = { eligible: true, awarded: false };
  await db.runTransaction(async transaction => {
    result = { eligible: true, awarded: false };
    const [profileSnapshot, attributionSnapshot, awardSnapshot] = await Promise.all([
      transaction.get(profileRef),
      transaction.get(attributionRef),
      transaction.get(awardRef)
    ]);
    if (!attributionSnapshot.exists) {
      result = { eligible: false, awarded: false };
      return;
    }
    const attribution = attributionSnapshot.data();
    const referrerUid = attribution.referrerUid;
    if (typeof referrerUid !== "string" || referrerUid === uid) {
      throw new HttpsError("failed-precondition", "The referral record could not be verified.");
    }
    if (awardSnapshot.exists || attribution.status === "qualified") {
      result = { eligible: true, awarded: false, duplicate: true };
      return;
    }
    if (attribution.status !== "pending") {
      throw new HttpsError("failed-precondition", "The referral is not awaiting qualification.");
    }
    if (!profileSnapshot.exists || !["Buyer", "Vendor"].includes(profileSnapshot.data().role) ||
        !profileIsChatReady(uid, profileSnapshot.data()) ||
        profileSnapshot.data().profilePhotoPath !== photoPath) {
      result = { eligible: true, awarded: false, profileComplete: false };
      return;
    }

    const referrerProfileRef = db.collection("users").doc(referrerUid);
    const referrerWalletRef = accountWalletRef(referrerUid);
    const referredWalletRef = accountWalletRef(uid);
    const [referrerProfileSnapshot, referrerWalletSnapshot, referredWalletSnapshot] =
      await Promise.all([
        transaction.get(referrerProfileRef),
        transaction.get(referrerWalletRef),
        transaction.get(referredWalletRef)
      ]);
    if (!referrerProfileSnapshot.exists ||
        !["Buyer", "Vendor"].includes(referrerProfileSnapshot.data().role)) {
      throw new HttpsError("failed-precondition", "The referring member's account could not be verified.");
    }

    const referrerWallet = normalizedWallet(referrerWalletSnapshot.data());
    const referredWallet = normalizedWallet(referredWalletSnapshot.data());
    const referredCoinsRemaining = referredWallet.coins + REFERRED_USER_REFERRAL_BONUS;
    if (!Number.isSafeInteger((referrerWallet.coins + REFERRER_REFERRAL_BONUS) * 2) ||
        !Number.isSafeInteger(referredCoinsRemaining * 2)) {
      throw new HttpsError("failed-precondition", "The referral wallet balances could not be updated.");
    }
    transaction.set(referrerWalletRef, {
      ...referrerWallet,
      coins: referrerWallet.coins + REFERRER_REFERRAL_BONUS,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(referredWalletRef, {
      ...referredWallet,
      coins: referredCoinsRemaining,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.create(awardRef, {
      referrerUid,
      referredUid: uid,
      referralCode: attribution.referralCode,
      referrerBonusCoins: REFERRER_REFERRAL_BONUS,
      referredUserBonusCoins: REFERRED_USER_REFERRAL_BONUS,
      awardedAt: FieldValue.serverTimestamp()
    });
    transaction.update(attributionRef, {
      status: "qualified",
      qualifiedAt: FieldValue.serverTimestamp()
    });
    result = {
      eligible: true,
      awarded: true,
      referrerBonusCoins: REFERRER_REFERRAL_BONUS,
      referredUserBonusCoins: REFERRED_USER_REFERRAL_BONUS,
      referredCoinsRemaining
    };
  });
  return result;
}

exports.completeReferralQualification = onCall(async request => {
  const auth = requireVerifiedUser(request);
  return qualifyReferral(auth.uid);
});

async function qualifyReferralForVerifiedAccount(uid) {
  const attribution = await db.collection("referralAttributions").doc(uid).get();
  if (!attribution.exists || attribution.data().status !== "pending") return;
  const user = await getAuth().getUser(uid);
  if (!user.disabled && (user.emailVerified || user.phoneNumber)) {
    await qualifyReferral(uid);
  }
}

exports.processReferralProfileCompletion = onDocumentWritten(
  { document: "users/{userId}", retry: true },
  async event => {
    if (!event.data?.after.exists) return;
    await qualifyReferralForVerifiedAccount(event.params.userId);
  }
);

exports.processReferralAttribution = onDocumentCreated(
  { document: "referralAttributions/{userId}", retry: true },
  async event => {
    if (!event.data) return;
    await qualifyReferralForVerifiedAccount(event.params.userId);
  }
);

function addOneUtcCalendarMonth(date) {
  const result = new Date(date);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDayOfMonth = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0
  )).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDayOfMonth));
  return result;
}

function timestampMillis(value) {
  if (typeof value?.toMillis === "function") return value.toMillis();
  return value instanceof Date ? value.getTime() : 0;
}

function isReactionUndoable(reaction, now) {
  const createdAtMs = timestampMillis(reaction?.createdAt);
  return createdAtMs > 0
    && createdAtMs <= now
    && now < createdAtMs + REACTION_UNDO_WINDOW_MS;
}

async function markPurchaseFailed(purchaseRef, purchase, txRef) {
  await db.runTransaction(async transaction => {
    const purchaseSnapshot = await transaction.get(purchaseRef);
    if (!purchaseSnapshot.exists || purchaseSnapshot.data().status !== "pending") return;
    let usageSnapshot = null;
    let usageRef = null;
    if (purchase.product === "quizPlayPack") {
      usageRef = dailyQuizUsageRef(purchase.uid, purchase.quizDayKey);
      usageSnapshot = await transaction.get(usageRef);
    }
    transaction.update(purchaseRef, { status: "failed" });
    if (usageSnapshot?.data()?.extraPackPurchaseRef === txRef) {
      transaction.set(usageRef, {
        extraPackPurchaseRef: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  });
}

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

async function ensureDefaultQuizQuestion() {
  const questionsRef = db.collection("quizQuestions");
  const defaultQuestionRef = questionsRef.doc("default-gsm-basics");
  await db.runTransaction(async transaction => {
    const existingQuestions = await transaction.get(questionsRef.limit(1));
    if (!existingQuestions.empty) return;

    transaction.create(defaultQuestionRef, {
      question: "Which component stores electrical energy to power a mobile phone when it is unplugged?",
      options: ["Battery", "SIM card", "Antenna", "Speaker"],
      correctOption: 0,
      enabled: true,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
}

async function ensurePurchaseIsVerified(txRef, transactionId, secretKey) {
  if (typeof txRef !== "string" || typeof transactionId !== "string") {
    throw new HttpsError("invalid-argument", "The payment reference is incomplete.");
  }
  const purchaseRef = db.collection("walletPurchases").doc(txRef);
  const purchaseSnapshot = await purchaseRef.get();
  if (!purchaseSnapshot.exists) {
    throw new HttpsError("not-found", "The payment reference was not found.");
  }
  const purchase = purchaseSnapshot.data();
  const response = await fetch(
    `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  const verification = await response.json();
  const payment = verification.data;
  if (!response.ok || verification.status !== "success" ||
      payment?.status !== "successful" ||
      payment.tx_ref !== txRef ||
      payment.currency !== purchase.currency ||
      Math.round(Number(payment.amount) * 100) !== Math.round(purchase.amount * 100) ||
      String(payment.customer?.email || "").toLowerCase() !== purchase.email.toLowerCase()) {
    logger.warn("Flutterwave payment did not match the pending purchase.", { txRef });
    throw new HttpsError("failed-precondition", "The payment could not be verified against this purchase.");
  }

  await db.runTransaction(async transaction => {
    const currentPurchaseSnapshot = await transaction.get(purchaseRef);
    if (!currentPurchaseSnapshot.exists) {
      throw new HttpsError("not-found", "The payment reference was not found.");
    }
    const currentPurchase = currentPurchaseSnapshot.data();
    if (currentPurchase.status === "paid") return;
    if (currentPurchase.status !== "pending") {
      throw new HttpsError("failed-precondition", "This purchase is no longer pending.");
    }

    const walletRef = accountWalletRef(currentPurchase.uid);
    const walletSnapshot = await transaction.get(walletRef);
    const wallet = normalizedWallet(walletSnapshot.data());
    const update = {
      ...wallet,
      updatedAt: FieldValue.serverTimestamp()
    };

    if (currentPurchase.product === "lovePack") update.loves += PURCHASES.lovePack.loves;
    if (currentPurchase.product === "hatePack") update.hates += PURCHASES.hatePack.hates;
    if (currentPurchase.product === "chatCoins12") update.coins += PURCHASES.chatCoins12.coins;
    if (currentPurchase.product === "chatCoins50") update.coins += PURCHASES.chatCoins50.coins;
    if (currentPurchase.product === "chatCoins350") update.coins += PURCHASES.chatCoins350.coins;

    if (currentPurchase.product === "quizPlayPack") {
      const usageRef = dailyQuizUsageRef(currentPurchase.uid, currentPurchase.quizDayKey);
      const usageSnapshot = await transaction.get(usageRef);
      if (!usageSnapshot.exists ||
          usageSnapshot.data().extraPackPurchaseRef !== txRef ||
          usageSnapshot.data().extraPackPurchased === true) {
        throw new HttpsError("failed-precondition", "This daily quiz-play purchase is no longer available.");
      }
      transaction.set(usageRef, {
        extraPackPurchased: true,
        extraPackPurchaseRef: FieldValue.delete(),
        extraPackGrantedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    transaction.set(walletRef, update, { merge: true });
    transaction.update(purchaseRef, {
      status: "paid",
      flutterwaveTransactionId: transactionId,
      verifiedAt: FieldValue.serverTimestamp()
    });
  });

  return { verified: true, product: purchase.product };
}

exports.beginWalletPurchase = onCall(
  { secrets: [FLUTTERWAVE_SECRET_KEY] },
  async request => {
    const auth = requireVerifiedUser(request);
    const product = request.data?.product;
    const purchaseDetails = typeof product === "string" &&
      Object.prototype.hasOwnProperty.call(PURCHASES, product)
      ? PURCHASES[product]
      : null;
    const verifiedEmail = auth.token.email_verified === true &&
      typeof auth.token.email === "string"
      ? auth.token.email.trim()
      : "";
    const checkoutEmail = typeof request.data?.checkoutEmail === "string"
      ? request.data.checkoutEmail.trim()
      : "";
    const email = verifiedEmail || checkoutEmail;
    if (!purchaseDetails) {
      throw new HttpsError("invalid-argument", "Choose a valid wallet package.");
    }
    if (product === "lovePack") {
      throw new HttpsError("failed-precondition", "Love credit purchases are no longer available.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new HttpsError("failed-precondition", "Enter an email address for your Flutterwave receipt.");
    }

    const txRef = `wallet-${crypto.randomUUID()}`;
    const purchaseRef = db.collection("walletPurchases").doc(txRef);
    const now = Date.now();
    const quizDayKey = new Date(now).toISOString().slice(0, 10);
    const purchaseData = {
      uid: auth.uid,
      email,
      product,
      amount: purchaseDetails.amount,
      currency: purchaseDetails.currency,
      status: "pending",
      createdAt: FieldValue.serverTimestamp()
    };
    if (product === "quizPlayPack") {
      purchaseData.quizDayKey = quizDayKey;
      const usageRef = dailyQuizUsageRef(auth.uid, quizDayKey);
      let existingCheckoutUrl = null;
      await db.runTransaction(async transaction => {
        const usageSnapshot = await transaction.get(usageRef);
        const usage = usageSnapshot.data() || {};
        if (usage.extraPackPurchased === true) {
          throw new HttpsError("failed-precondition", "You have already purchased today's extra quiz plays.");
        }
        if (typeof usage.extraPackPurchaseRef === "string") {
          const existingPurchaseRef = db.collection("walletPurchases").doc(usage.extraPackPurchaseRef);
          const existingPurchase = await transaction.get(existingPurchaseRef);
          if (existingPurchase.exists &&
              existingPurchase.data().status === "pending" &&
              typeof existingPurchase.data().checkoutUrl === "string") {
            existingCheckoutUrl = existingPurchase.data().checkoutUrl;
            return;
          }
          if (existingPurchase.exists && existingPurchase.data().status === "pending") {
            throw new HttpsError("failed-precondition", "Your daily quiz-play checkout is starting. Please try again shortly.");
          }
        }
        transaction.create(purchaseRef, purchaseData);
        transaction.set(usageRef, {
          extraPackPurchaseRef: txRef,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      });
      if (existingCheckoutUrl) return { checkoutUrl: existingCheckoutUrl };
    } else {
      await purchaseRef.create(purchaseData);
    }

    try {
      const response = await fetch("https://api.flutterwave.com/v3/payments", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${FLUTTERWAVE_SECRET_KEY.value()}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tx_ref: txRef,
          amount: purchaseDetails.amount,
          currency: purchaseDetails.currency,
          redirect_url: PAYMENT_REDIRECT_URL,
          customer: {
            email,
            name: typeof auth.token.name === "string" ? auth.token.name : "Marketplace member"
          },
          customizations: {
            title: product.startsWith("chatCoins") ? "Golden Chat coins" : "Golden Eagle wallet",
            description: product === "quizPlayPack"
              ? "Five extra reward-eligible GSM quiz plays for today"
              : product.startsWith("chatCoins")
                ? `${purchaseDetails.coins} Golden Chat coins`
                : "Marketplace reaction credits"
          }
        }),
        signal: AbortSignal.timeout(15000)
      });
      const checkout = await response.json();
      const checkoutUrl = checkout.data?.link;
      const parsedCheckoutUrl = typeof checkoutUrl === "string" ? new URL(checkoutUrl) : null;
      if (!response.ok || checkout.status !== "success" ||
          !parsedCheckoutUrl ||
          parsedCheckoutUrl.protocol !== "https:" ||
          parsedCheckoutUrl.hostname !== "checkout.flutterwave.com") {
        logger.error("Flutterwave checkout could not be initialized.", {
          txRef,
          status: response.status
        });
        await markPurchaseFailed(purchaseRef, purchaseData, txRef);
        throw new HttpsError("unavailable", "Flutterwave could not start checkout.");
      }
      await purchaseRef.update({ checkoutUrl });
      return { checkoutUrl, txRef };
    } catch (error) {
      if (!(error instanceof HttpsError)) {
        await markPurchaseFailed(purchaseRef, purchaseData, txRef);
        logger.error("Unable to initialize Flutterwave checkout.", { txRef, error });
      }
      throw error instanceof HttpsError
        ? error
        : new HttpsError("unavailable", "Payment checkout could not be started.");
    }
  }
);

exports.verifyWalletPayment = onCall(
  { secrets: [FLUTTERWAVE_SECRET_KEY] },
  async request => {
    const auth = requireVerifiedUser(request);
    const txRef = request.data?.txRef;
    const transactionId = request.data?.transactionId;
    const expectedProduct = request.data?.expectedProduct;
    if (typeof txRef !== "string" || !txRef.startsWith("wallet-")) {
      throw new HttpsError("invalid-argument", "The payment reference is invalid.");
    }
    if (expectedProduct !== undefined && expectedProduct !== "goldenChatCoins") {
      throw new HttpsError("invalid-argument", "The requested payment type is invalid.");
    }
    const purchaseSnapshot = await db.collection("walletPurchases").doc(txRef).get();
    if (!purchaseSnapshot.exists || purchaseSnapshot.data().uid !== auth.uid) {
      throw new HttpsError("not-found", "This payment does not belong to your account.");
    }
    if (expectedProduct === "goldenChatCoins" &&
        !["chatCoins12", "chatCoins50", "chatCoins350"].includes(purchaseSnapshot.data().product)) {
      throw new HttpsError("failed-precondition", "This receipt is not for a Golden Chat coin purchase.");
    }
    return ensurePurchaseIsVerified(txRef, transactionId, FLUTTERWAVE_SECRET_KEY.value());
  }
);

exports.flutterwaveWalletWebhook = onRequest(
  { secrets: [FLUTTERWAVE_SECRET_KEY, FLUTTERWAVE_WEBHOOK_HASH] },
  async (request, response) => {
    const suppliedHash = request.get("verif-hash") || "";
    const expectedHash = FLUTTERWAVE_WEBHOOK_HASH.value();
    const supplied = Buffer.from(suppliedHash);
    const expected = Buffer.from(expectedHash);
    if (!expectedHash || supplied.length !== expected.length ||
        !crypto.timingSafeEqual(supplied, expected)) {
      response.status(401).send("Invalid webhook signature.");
      return;
    }
    const txRef = request.body?.data?.tx_ref;
    const transactionId = request.body?.data?.id;
    if (process.env.GCLOUD_PROJECT === "golden-eagle-marketplace" ||
        process.env.ESCROW_LIVE_WEBHOOK_ENABLED === "true") {
      try {
        if (await routeEscrowWebhookEvent(request.body, FLUTTERWAVE_SECRET_KEY.value())) {
          response.status(200).send("Escrow event processed.");
          return;
        }
      } catch (error) {
        logger.error("Flutterwave escrow webhook requires reconciliation.", { txRef, error });
        response.status(500).send("Escrow event requires reconciliation.");
        return;
      }
    }
    try {
      await ensurePurchaseIsVerified(
        txRef,
        String(transactionId || ""),
        FLUTTERWAVE_SECRET_KEY.value()
      );
      response.status(200).send("Payment verified.");
    } catch (error) {
      logger.error("Flutterwave webhook payment verification failed.", { txRef, error });
      response.status(error instanceof HttpsError ? 400 : 500).send("Payment verification failed.");
    }
  }
);

function escrowAmountKobo(amount, allowZero = false) {
  if (typeof amount !== "number" || !Number.isFinite(amount) ||
      amount < 0 || (!allowZero && amount === 0)) {
    throw new HttpsError("failed-precondition", "The order has an invalid monetary amount.");
  }
  const kobo = Math.round(amount * 100);
  if (!Number.isSafeInteger(kobo) || Math.abs(amount * 100 - kobo) > 0.00001 ||
      (!allowZero && kobo === 0)) {
    throw new HttpsError("failed-precondition", "The order has an invalid monetary amount.");
  }
  return kobo;
}

function requireEscrowAdmin(request) {
  const auth = requireVerifiedUser(request);
  if (!isOwnerAdmin(auth)) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
  return auth;
}

exports.getEscrowAdminMetrics = onCall(async request => {
  requireEscrowAdmin(request);
  const day = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);
  const orders = db.collection("escrowOrders");
  const statuses = ["HELD_IN_ESCROW", "SHIPPED", "DISPUTED", "AUTO_REFUND_REQUIRED",
    "REFUND_INITIATING", "REFUND_PENDING", "REFUNDED", "RELEASED"];
  const methods = ["delivery", "pickup"];
  const activeOrders = orders.where("status", "in", ["HELD_IN_ESCROW", "SHIPPED", "DISPUTED",
    "AUTO_REFUND_REQUIRED", "REFUND_INITIATING", "REFUND_PENDING"]);
  const active = activeOrders.aggregate({ count: AggregateField.count(), total: AggregateField.sum("totalPaid") }).get();
  const activeCount = activeOrders.count().get();
  const checkIns = db.collection("quizWallets").where("dailyCheckInDay", "==", day).count().get();
  const breakdown = methods.flatMap(method => statuses.map(async status => {
    const result = await orders.where("fulfillment.method", "==", method)
      .where("status", "==", status).count().get();
    return { method, status, count: result.data().count };
  }));
  const [activeResult, activeCountResult, checkInResult, ...fulfillment] =
    await Promise.all([active, activeCount, checkIns, ...breakdown]);
  const count = checkInResult.data().count;
  const amount = activeResult.data().total;
  if (!Number.isSafeInteger(activeCountResult.data().count) || activeCountResult.data().count < 0 ||
      activeCountResult.data().count !== activeResult.data().count ||
      !Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(count * 5) ||
      typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new HttpsError("failed-precondition", "Dashboard metrics require reconciliation.");
  }
  return { day, activeOrders: activeCountResult.data().count, activeTotal: amount,
    dailyCheckIns: count, dailyCoins: count * 5, fulfillment };
});

exports.listEscrowAdminQueue = onCall(async request => {
  requireEscrowAdmin(request);
  const queues = {
    disputes: { collection: "escrowOrders", statuses: ["DISPUTED"] },
    refunds: { collection: "escrowRefunds", statuses: ["INITIATING", "PENDING"] },
    payouts: { collection: "escrowWithdrawals", statuses: ["INITIATING", "PENDING"] }
  };
  const kind = request.data?.kind;
  const cursor = request.data?.cursor;
  if (!Object.hasOwn(queues, kind) ||
      (cursor != null && (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(cursor)))) {
    throw new HttpsError("invalid-argument", "Choose a valid queue and cursor.");
  }
  const queue = queues[kind];
  let query = db.collection(queue.collection).where("status", "in", queue.statuses)
    .orderBy(FieldPath.documentId()).limit(51);
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.get();
  const page = snapshot.docs.slice(0, 50);
  const items = page.map(doc => {
    const data = doc.data();
    if (kind === "disputes") return { id: doc.id, status: data.status, productTitle: data.productTitle,
      buyerUid: data.buyerUid, vendorUid: data.vendorUid, disputeReason: data.disputeReason,
      productPrice: data.productPrice, totalPaid: data.totalPaid, transactionId: data.transactionId,
      dispatched: !!data.shippedAt, fulfillmentMethod: data.fulfillment?.method || "legacy" };
    if (kind === "refunds") return { id: doc.id, status: data.status, amountKobo: data.amountKobo,
      transactionId: data.transactionId, providerRefundId: data.providerRefundId || null,
      mode: data.mode || "automatic-or-test", initiatedBy: data.initiatedBy };
    return { id: doc.id, status: data.status, vendorUid: data.vendorUid, grossKobo: data.grossKobo,
      netKobo: data.netKobo, bankLastFour: data.bankLastFour, providerTransferId: data.providerTransferId || null };
  });
  return { items, nextCursor: snapshot.docs.length > 50 ? page[page.length - 1].id : null };
});

function escrowStoredBalance(snapshot, field) {
  if (!snapshot.exists) return 0;
  const value = snapshot.data()?.[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpsError("failed-precondition", "The escrow ledger needs reconciliation.");
  }
  return value;
}

function escrowSandboxKey() {
  const key = FLW_SECRET_KEY.value();
  const projectId = process.env.GCLOUD_PROJECT;
  if (typeof key !== "string" || !key.startsWith("FLWSECK_TEST-") ||
      !projectId || projectId === "golden-eagle-marketplace" ||
      projectId !== process.env.ESCROW_TEST_PROJECT_ID) {
    throw new HttpsError("failed-precondition", "Escrow checkout requires a separate configured test project and Flutterwave test key.");
  }
  return key;
}

function escrowPaymentKey() {
  if (process.env.GCLOUD_PROJECT !== "golden-eagle-marketplace") {
    return escrowSandboxKey();
  }
  const key = FLUTTERWAVE_SECRET_KEY.value();
  if (typeof key !== "string" || !/^FLWSECK-\S+$/.test(key)) {
    throw new HttpsError("failed-precondition", "Configure a live Flutterwave wallet secret key for escrow checkout.");
  }
  return key;
}

function vendorPayoutsEnabled() {
  return process.env.GCLOUD_PROJECT !== "golden-eagle-marketplace" ||
    process.env.ESCROW_LIVE_PAYOUTS_ENABLED === "true";
}

function vendorPayoutKey(requireEnabled = true) {
  if (requireEnabled && !vendorPayoutsEnabled()) {
    throw new HttpsError("failed-precondition", "Live vendor payouts are not enabled yet.");
  }
  return escrowPaymentKey();
}

function escrowCheckoutRedirectUrl() {
  if (process.env.GCLOUD_PROJECT === "golden-eagle-marketplace") {
    return PAYMENT_REDIRECT_URL;
  }
  let url;
  try {
    url = new URL(process.env.ESCROW_TEST_REDIRECT_URL);
  } catch (error) {
    throw new HttpsError("failed-precondition", "Configure an escrow test redirect URL.");
  }
  if (url.protocol !== "https:" || url.hostname === "goldenphoneshop.github.io" ||
      url.username || url.password) {
    throw new HttpsError("failed-precondition", "Escrow test checkout requires a separate HTTPS test site.");
  }
  return url.href;
}

function voucherCode(value) {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z0-9_-]{4,32}$/.test(code)) {
    throw new HttpsError("invalid-argument", "Enter a voucher code of 4 to 32 letters, numbers, underscores or hyphens.");
  }
  return code;
}

function voucherPairRef(collection, code, uid) {
  const id = crypto.createHash("sha256").update(`${code}\0${uid}`).digest("hex");
  return db.collection(collection).doc(id);
}

exports.createStoreVoucher = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const code = voucherCode(request.data?.code);
  const scope = request.data?.scope;
  const type = request.data?.type;
  const value = request.data?.value;
  if (!["platform", "store"].includes(scope) || !["fixed", "percent"].includes(type) ||
      typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new HttpsError("invalid-argument", "Choose a valid voucher scope, type and discount.");
  }
  const units = Math.round(value * 100);
  if (!Number.isSafeInteger(units) || units < 1 || Math.abs(value * 100 - units) > 0.00001 ||
      (type === "percent" && units > 10000)) {
    throw new HttpsError("invalid-argument", "Enter a valid discount with at most two decimal places.");
  }
  const profile = await db.collection("users").doc(auth.uid).get();
  const isAdmin = isOwnerAdmin(auth);
  if (!isAdmin && (!profile.exists || profile.data().role !== "Vendor")) {
    throw new HttpsError("permission-denied", "Only vendors and administrators can create vouchers.");
  }
  if (scope === "platform" && !isAdmin) {
    throw new HttpsError("permission-denied", "Only administrators can create platform vouchers.");
  }
  const vendorUid = scope === "store" ? (isAdmin ? request.data?.vendorUid : auth.uid) : null;
  if (scope === "store") {
    if (typeof vendorUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(vendorUid)) {
      throw new HttpsError("invalid-argument", "Choose a valid vendor.");
    }
    const vendor = await db.collection("users").doc(vendorUid).get();
    if (!vendor.exists || vendor.data().role !== "Vendor") {
      throw new HttpsError("failed-precondition", "Choose an existing vendor.");
    }
  }
  const ref = db.collection("storeVouchers").doc(code);
  const now = Date.now();
  await db.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists) throw new HttpsError("already-exists", "This voucher code is already in use.");
    transaction.create(ref, { code, scope, vendorUid, type, units, createdBy: auth.uid,
      expiresAtMs: now + 30 * 24 * 60 * 60 * 1000, createdAt: FieldValue.serverTimestamp() });
  });
  return { code, expiresAtMs: now + 30 * 24 * 60 * 60 * 1000 };
});

exports.setPlatformVoucherOptIn = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const code = voucherCode(request.data?.code);
  if (typeof request.data?.enabled !== "boolean") {
    throw new HttpsError("invalid-argument", "Choose whether to participate.");
  }
  const profileRef = db.collection("users").doc(auth.uid);
  const voucherRef = db.collection("storeVouchers").doc(code);
  const optInRef = voucherPairRef("voucherOptIns", code, auth.uid);
  await db.runTransaction(async transaction => {
    const [profile, voucher] = await Promise.all([transaction.get(profileRef), transaction.get(voucherRef)]);
    if (!profile.exists || profile.data().role !== "Vendor") {
      throw new HttpsError("permission-denied", "Only vendors can opt in.");
    }
    if (!voucher.exists || voucher.data().scope !== "platform" ||
        voucher.data().expiresAtMs <= Date.now()) {
      throw new HttpsError("failed-precondition", "This platform voucher is unavailable.");
    }
    transaction.set(optInRef, { code, vendorUid: auth.uid, enabled: request.data.enabled,
      updatedAt: FieldValue.serverTimestamp() });
  });
  return { enabled: request.data.enabled };
});

exports.getPlatformVoucher = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const code = voucherCode(request.data?.code);
  const [profile, voucher] = await Promise.all([
    db.collection("users").doc(auth.uid).get(),
    db.collection("storeVouchers").doc(code).get()
  ]);
  if (!profile.exists || profile.data().role !== "Vendor") {
    throw new HttpsError("permission-denied", "Only vendors can view platform voucher terms.");
  }
  if (!voucher.exists || voucher.data().scope !== "platform" || voucher.data().expiresAtMs <= Date.now()) {
    throw new HttpsError("failed-precondition", "This platform voucher is unavailable.");
  }
  const { type, units, expiresAtMs } = voucher.data();
  return { code, type, value: units / 100, expiresAtMs };
});

async function readVoucherPrice(transaction, code, buyerUid, listing, priceKobo) {
  const ref = db.collection("storeVouchers").doc(code);
  const redemptionRef = voucherPairRef("voucherRedemptions", code, buyerUid);
  const optInRef = voucherPairRef("voucherOptIns", code, listing.ownerUid);
  const [voucher, redemption, optIn] = await Promise.all([
    transaction.get(ref), transaction.get(redemptionRef), transaction.get(optInRef)
  ]);
  if (!voucher.exists || !Number.isSafeInteger(voucher.data().expiresAtMs) ||
      voucher.data().expiresAtMs <= Date.now() ||
      (voucher.data().scope === "store" && voucher.data().vendorUid !== listing.ownerUid) ||
      (voucher.data().scope === "platform" && (!optIn.exists || optIn.data().enabled !== true)) ||
      !["store", "platform"].includes(voucher.data().scope)) {
    throw new HttpsError("failed-precondition", "This voucher is not available for this product.");
  }
  if (redemption.exists && redemption.data().status !== "RELEASED") {
    throw new HttpsError("failed-precondition", "This voucher has already been used or is reserved for another checkout.");
  }
  const { type, units } = voucher.data();
  if (!Number.isSafeInteger(units) || units <= 0 ||
      !["fixed", "percent"].includes(type) || (type === "percent" && units > 10000)) {
    throw new HttpsError("failed-precondition", "This voucher needs reconciliation.");
  }
  const discountKobo = type === "fixed" ? units
    : Number((BigInt(priceKobo) * BigInt(units) + 5000n) / 10000n);
  if (discountKobo <= 0 || priceKobo - discountKobo < 10000) {
    throw new HttpsError("failed-precondition", "This discount cannot be applied to this product.");
  }
  return { discountKobo, redemptionRef };
}

exports.quoteStoreVoucher = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const code = voucherCode(request.data?.code);
  const productId = request.data?.productId;
  if (typeof productId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(productId)) {
    throw new HttpsError("invalid-argument", "Choose a valid product.");
  }
  return db.runTransaction(async transaction => {
    const [buyer, product] = await Promise.all([
      transaction.get(db.collection("users").doc(auth.uid)),
      transaction.get(db.collection("products").doc(productId))
    ]);
    if (!buyer.exists || buyer.data().role !== "Buyer") {
      throw new HttpsError("permission-denied", "Only buyers can use vouchers.");
    }
    if (!product.exists || !product.data().ownerUid || product.data().ownerUid === auth.uid ||
        !Number.isSafeInteger(product.data().stock) || product.data().stock < 1) {
      throw new HttpsError("failed-precondition", "This product is not available.");
    }
    const priceKobo = escrowAmountKobo(product.data().price);
    const { discountKobo } = await readVoucherPrice(transaction, code, auth.uid, product.data(), priceKobo);
    const discountedPrice = (priceKobo - discountKobo) / 100;
    return { code, originalPrice: priceKobo / 100, discount: discountKobo / 100,
      productPrice: discountedPrice, platformFee: calculateEscrowFee(discountedPrice) };
  });
});

async function initiateMultiItemEscrowCheckout(request, auth, secret, redirectUrl) {
  const requestedItems = request.data?.items;
  if (!Array.isArray(requestedItems) || requestedItems.length < 1 || requestedItems.length > 20) {
    throw new HttpsError("invalid-argument", "Select between 1 and 20 products.");
  }
  const normalizedItems = requestedItems.map(item => {
    if (!item || typeof item.productId !== "string" ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(item.productId) ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) {
      throw new HttpsError("invalid-argument", "Each cart item needs a valid product and quantity.");
    }
    return {
      productId: item.productId,
      quantity: item.quantity,
      expectedPriceKobo: escrowAmountKobo(item.expectedPrice)
    };
  });
  if (new Set(normalizedItems.map(item => item.productId)).size !== normalizedItems.length) {
    throw new HttpsError("invalid-argument", "Combine duplicate cart items before checkout.");
  }
  const buyer = await db.collection("users").doc(auth.uid).get();
  if (!buyer.exists || buyer.data().role !== "Buyer") {
    throw new HttpsError("permission-denied", "Only buyers can use escrow checkout.");
  }
  const productRefs = normalizedItems.map(item => db.collection("products").doc(item.productId));
  const productSnapshots = await db.getAll(...productRefs);
  const listingItems = normalizedItems.map((item, index) => {
    const snapshot = productSnapshots[index];
    const listing = snapshot.data();
    if (!snapshot.exists || typeof listing?.ownerUid !== "string" ||
        listing.ownerUid === auth.uid || !Number.isSafeInteger(listing.stock) ||
        listing.stock < item.quantity || typeof listing.title !== "string" ||
        !listing.title.trim()) {
      throw new HttpsError("failed-precondition", "A selected product is unavailable or its stock changed.");
    }
    const unitPriceKobo = escrowAmountKobo(listing.price);
    if (unitPriceKobo !== item.expectedPriceKobo) {
      throw new HttpsError("failed-precondition", "A selected product price changed. Review the cart.");
    }
    return {
      productId: item.productId,
      quantity: item.quantity,
      ownerUid: listing.ownerUid,
      title: listing.title,
      unitPriceKobo,
      linePriceKobo: unitPriceKobo * item.quantity
    };
  });
  const vendorUid = listingItems[0].ownerUid;
  if (listingItems.some(item => item.ownerUid !== vendorUid)) {
    throw new HttpsError(
      "failed-precondition",
      "Checkout products from one vendor at a time. Separate products from other vendors."
    );
  }
  const vendor = await db.collection("users").doc(vendorUid).get();
  if (!vendor.exists || vendor.data().role !== "Vendor") {
    throw new HttpsError("failed-precondition", "This cart does not have an eligible vendor.");
  }
  const selected = request.data?.fulfillment;
  let fulfillment;
  let fulfillmentFee;
  if (selected?.method === "pickup") {
    const station = escrowFulfillment.stations.find(item => item.id === selected.stationId);
    if (!station) throw new HttpsError("invalid-argument", "Choose a valid pickup station.");
    fulfillment = { method: "pickup", stationId: station.id, stationName: station.label };
    fulfillmentFee = 0;
  } else if (selected?.method === "delivery") {
    const field = (name, max, required = true) => {
      const value = typeof selected[name] === "string" ? selected[name].trim() : "";
      if ((required && !value) || value.length > max) {
        throw new HttpsError("invalid-argument", `Enter a valid ${name}.`);
      }
      return value;
    };
    const phone = field("phone", 25);
    if (!/^\+?[0-9][0-9 ()-]{6,23}[0-9]$/.test(phone) ||
        phone.replace(/\D/g, "").length < 8) {
      throw new HttpsError("invalid-argument", "Enter a valid phone number.");
    }
    fulfillment = { method: "delivery", address: field("address", 200), city: field("city", 100),
      state: field("state", 100), phone, landmark: field("landmark", 200, false) };
    fulfillmentFee = escrowFulfillment.homeDeliveryFee;
  } else {
    throw new HttpsError("invalid-argument", "Choose a fulfillment method.");
  }
  const email = auth.token.email_verified === true && typeof auth.token.email === "string"
    ? auth.token.email.trim()
    : typeof request.data?.checkoutEmail === "string" ? request.data.checkoutEmail.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new HttpsError("invalid-argument", "Enter an email address for your payment receipt.");
  }
  const txRef = `escrow-${crypto.randomUUID()}`;
  const pendingRef = db.collection("escrowPendingPayments").doc(txRef);
  const fulfillmentKobo = escrowAmountKobo(fulfillmentFee, true);
  const pricing = await db.runTransaction(async transaction => {
    const currentSnapshots = await Promise.all(productRefs.map(ref => transaction.get(ref)));
    const reservedItems = listingItems.map((item, index) => {
      const current = currentSnapshots[index];
      if (!current.exists || current.data().ownerUid !== item.ownerUid ||
          escrowAmountKobo(current.data().price) !== item.unitPriceKobo ||
          current.data().title !== item.title ||
          !Number.isSafeInteger(current.data().stock) || current.data().stock < item.quantity) {
        throw new HttpsError("failed-precondition", "A selected listing changed or is out of stock.");
      }
      transaction.update(productRefs[index], { stock: current.data().stock - item.quantity });
      return {
        productId: item.productId,
        productTitle: item.title,
        quantity: item.quantity,
        unitPrice: item.unitPriceKobo / 100,
        productPrice: item.linePriceKobo / 100
      };
    });
    const productKobo = reservedItems.reduce((total, item) =>
      total + escrowAmountKobo(item.productPrice), 0);
    const feeKobo = reservedItems.reduce((total, item) =>
      total + escrowAmountKobo(calculateEscrowFee(item.productPrice), true), 0);
    const totalKobo = productKobo + feeKobo + fulfillmentKobo;
    if (!Number.isSafeInteger(totalKobo)) {
      throw new HttpsError("failed-precondition", "The cart total is too large.");
    }
    transaction.create(pendingRef, {
      buyerUid: auth.uid,
      vendorUid,
      items: reservedItems,
      productId: reservedItems.length === 1 ? reservedItems[0].productId : null,
      productTitle: reservedItems.map(item => item.productTitle).join(", ").slice(0, 500),
      productPrice: productKobo / 100,
      platformFee: feeKobo / 100,
      fulfillment,
      fulfillmentFee,
      totalPaid: totalKobo / 100,
      currency: "NGN",
      email,
      status: "PENDING",
      reservationStatus: "HELD",
      reservationExpiresAtMs: Date.now() + 15 * 60 * 1000,
      createdAt: FieldValue.serverTimestamp()
    });
    return { productKobo, feeKobo, totalKobo };
  });
  const response = await fetch("https://api.flutterwave.com/v3/payments", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tx_ref: txRef,
      amount: pricing.totalKobo / 100,
      currency: "NGN",
      redirect_url: redirectUrl,
      customer: { email },
      meta: { fulfillment, fulfillmentFee, itemCount: listingItems.reduce((sum, item) => sum + item.quantity, 0) },
      configurations: { session_duration: 15 },
      customizations: { title: "Golden Eagle multi-item escrow checkout" }
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    logger.error("Escrow cart checkout initialization failed.", { txRef, status: response.status });
    throw new HttpsError("unavailable", "Flutterwave could not start checkout.");
  }
  const checkout = await response.json();
  const checkoutUrl = new URL(checkout.data?.link || "");
  if (checkout.status !== "success" || checkoutUrl.protocol !== "https:" ||
      checkoutUrl.hostname !== "checkout.flutterwave.com") {
    throw new HttpsError("unavailable", "Flutterwave returned an invalid checkout link.");
  }
  return {
    checkoutUrl: checkoutUrl.href,
    txRef,
    productPrice: pricing.productKobo / 100,
    platformFee: pricing.feeKobo / 100,
    fulfillmentFee,
    totalPaid: pricing.totalKobo / 100
  };
}

exports.initiateEscrowCheckout = onCall(
  { secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY] },
  async request => {
    const auth = requireVerifiedUser(request);
    const secret = escrowPaymentKey();
    const redirectUrl = escrowCheckoutRedirectUrl();
    if (Array.isArray(request.data?.items)) {
      return initiateMultiItemEscrowCheckout(request, auth, secret, redirectUrl);
    }
    const productId = request.data?.productId;
    if (typeof productId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(productId)) {
      throw new HttpsError("invalid-argument", "Choose a valid product.");
    }
    const [buyer, product] = await Promise.all([
      db.collection("users").doc(auth.uid).get(),
      db.collection("products").doc(productId).get()
    ]);
    if (!buyer.exists || buyer.data()?.role !== "Buyer") {
      throw new HttpsError("permission-denied", "Only buyers can use escrow checkout.");
    }
    if (!product.exists) throw new HttpsError("not-found", "This product is no longer available.");
    const listing = product.data();
    if (typeof listing.ownerUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(listing.ownerUid) ||
        typeof listing.title !== "string" || !listing.title.trim() ||
        listing.ownerUid === auth.uid ||
        !Number.isSafeInteger(listing.stock) || listing.stock < 1) {
      throw new HttpsError("failed-precondition", "This listing is not available for checkout.");
    }
    const vendor = await db.collection("users").doc(listing.ownerUid).get();
    if (!vendor.exists || vendor.data()?.role !== "Vendor") {
      throw new HttpsError("failed-precondition", "This listing does not have an eligible vendor.");
    }
    const priceKobo = escrowAmountKobo(listing.price);
    if (escrowAmountKobo(request.data?.expectedPrice) !== priceKobo) {
      throw new HttpsError("failed-precondition", "The product price changed. Review it before checkout.");
    }
    const code = request.data?.voucherCode ? voucherCode(request.data.voucherCode) : null;
    const expectedDiscountKobo = code ? escrowAmountKobo(request.data?.expectedDiscount, true) : 0;
    const selected = request.data?.fulfillment;
    let fulfillment;
    let fulfillmentFee;
    if (selected?.method === "pickup") {
      const station = escrowFulfillment.stations.find(item => item.id === selected.stationId);
      if (!station) throw new HttpsError("invalid-argument", "Choose a valid pickup station.");
      fulfillment = { method: "pickup", stationId: station.id, stationName: station.label };
      fulfillmentFee = 0;
    } else if (selected?.method === "delivery") {
      const field = (name, max, required = true) => {
        const value = typeof selected[name] === "string" ? selected[name].trim() : "";
        if ((required && !value) || value.length > max) {
          throw new HttpsError("invalid-argument", `Enter a valid ${name}.`);
        }
        return value;
      };
      const phone = field("phone", 25);
      if (!/^\+?[0-9][0-9 ()-]{6,23}[0-9]$/.test(phone) ||
          phone.replace(/\D/g, "").length < 8) {
        throw new HttpsError("invalid-argument", "Enter a valid phone number.");
      }
      fulfillment = { method: "delivery", address: field("address", 200), city: field("city", 100),
        state: field("state", 100), phone, landmark: field("landmark", 200, false) };
      fulfillmentFee = escrowFulfillment.homeDeliveryFee;
    } else {
      throw new HttpsError("invalid-argument", "Choose a fulfillment method.");
    }
    const fulfillmentKobo = escrowAmountKobo(fulfillmentFee, true);
    const email = auth.token.email_verified === true && typeof auth.token.email === "string"
      ? auth.token.email.trim()
      : typeof request.data?.checkoutEmail === "string" ? request.data.checkoutEmail.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new HttpsError("invalid-argument", "Enter an email address for your payment receipt.");
    }
    const txRef = `escrow-${crypto.randomUUID()}`;
    const pendingRef = db.collection("escrowPendingPayments").doc(txRef);
    const productRef = db.collection("products").doc(productId);
    const pricing = await db.runTransaction(async transaction => {
      const current = await transaction.get(productRef);
      if (!current.exists || current.data().ownerUid !== listing.ownerUid ||
          current.data().price !== listing.price || current.data().title !== listing.title ||
          !Number.isSafeInteger(current.data().stock) || current.data().stock < 1) {
        throw new HttpsError("failed-precondition", "This listing changed or is out of stock. Review it again.");
      }
      const voucher = code ? await readVoucherPrice(transaction, code, auth.uid, current.data(), priceKobo) : null;
      const discountKobo = voucher ? voucher.discountKobo : 0;
      if (discountKobo !== expectedDiscountKobo) {
        throw new HttpsError("failed-precondition", "The voucher discount changed. Review it again.");
      }
      const productKobo = priceKobo - discountKobo;
      if (productKobo < 10000) {
        throw new HttpsError("failed-precondition", "The product price must be at least NGN 100 so it can be refunded after dispatch.");
      }
      const feeKobo = escrowAmountKobo(calculateEscrowFee(productKobo / 100), true);
      const totalKobo = productKobo + feeKobo + fulfillmentKobo;
      if (!Number.isSafeInteger(totalKobo)) {
        throw new HttpsError("failed-precondition", "The product total is too large.");
      }
      transaction.update(productRef, { stock: current.data().stock - 1 });
      if (voucher) {
        transaction.set(voucher.redemptionRef, { code, buyerUid: auth.uid, txRef, status: "RESERVED" });
      }
      transaction.create(pendingRef, {
        buyerUid: auth.uid,
        vendorUid: listing.ownerUid,
        productId,
        productTitle: listing.title,
        productPrice: productKobo / 100,
        ...(code ? { voucherCode: code, originalProductPrice: priceKobo / 100,
          discount: discountKobo / 100 } : {}),
        platformFee: feeKobo / 100,
        fulfillment,
        fulfillmentFee,
        totalPaid: totalKobo / 100,
        currency: "NGN",
        email,
        status: "PENDING",
        reservationStatus: "HELD",
        reservationExpiresAtMs: Date.now() + 15 * 60 * 1000,
        createdAt: FieldValue.serverTimestamp()
      });
      return { productKobo, feeKobo, totalKobo, discountKobo };
    });
    const { productKobo, feeKobo, totalKobo, discountKobo } = pricing;
    const response = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tx_ref: txRef,
        amount: totalKobo / 100,
        currency: "NGN",
        redirect_url: redirectUrl,
        customer: { email },
        meta: { fulfillment, fulfillmentFee },
        configurations: { session_duration: 15 },
        customizations: { title: "Golden Eagle escrow checkout" }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      logger.error("Escrow checkout initialization failed.", { txRef, status: response.status });
      throw new HttpsError("unavailable", "Flutterwave could not start checkout.");
    }
    const checkout = await response.json();
    let checkoutUrl;
    try {
      checkoutUrl = new URL(checkout.data?.link);
    } catch (error) {
      logger.error("Flutterwave returned an invalid escrow checkout URL.", { txRef });
      throw new HttpsError("unavailable", "Flutterwave returned an invalid checkout link.");
    }
    if (checkout.status !== "success" || checkoutUrl.protocol !== "https:" ||
        checkoutUrl.hostname !== "checkout.flutterwave.com") {
      throw new HttpsError("unavailable", "Flutterwave returned an invalid checkout link.");
    }
    return { checkoutUrl: checkoutUrl.href, txRef, productPrice: productKobo / 100,
      originalProductPrice: priceKobo / 100, discount: discountKobo / 100,
      platformFee: feeKobo / 100, fulfillmentFee, totalPaid: totalKobo / 100 };
  }
);

async function verifyEscrowTransaction(txRef, transactionId, secret) {
  if (typeof txRef !== "string" || !/^escrow-[0-9a-f-]{36}$/i.test(txRef) ||
      typeof transactionId !== "string" || !/^\d{1,32}$/.test(transactionId)) {
    throw new HttpsError("invalid-argument", "The payment reference is invalid.");
  }
  const pendingRef = db.collection("escrowPendingPayments").doc(txRef);
  const pendingSnapshot = await pendingRef.get();
  if (!pendingSnapshot.exists) throw new HttpsError("not-found", "Escrow payment not found.");
  const pending = pendingSnapshot.data();
  const response = await fetch(
    `https://api.flutterwave.com/v3/transactions/${transactionId}/verify`,
    { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000) }
  );
  if (!response.ok) throw new HttpsError("unavailable", "Flutterwave could not verify the payment.");
  const verification = await response.json();
  const payment = verification.data;
  if (verification.status === "success" && payment?.status === "failed" &&
      String(payment.id) === transactionId && payment.tx_ref === txRef) {
    await releaseExpiredEscrowStock(txRef, Date.now(), true);
    return { orderId: txRef, status: "FAILED" };
  }
  const paidKobo = Number(payment?.amount) * 100;
  const expectedKobo = escrowAmountKobo(pending.totalPaid);
  if (verification.status !== "success" || payment?.status !== "successful" ||
      String(payment.id) !== transactionId || payment.tx_ref !== txRef || payment.currency !== "NGN" ||
      !Number.isFinite(paidKobo) || Math.abs(paidKobo - expectedKobo) > 0.00001 ||
      String(payment.customer?.email || "").toLowerCase() !== pending.email.toLowerCase()) {
    throw new HttpsError("failed-precondition", "The payment could not be verified against this order.");
  }
  const orderRef = db.collection("escrowOrders").doc(txRef);
  const transactionRef = db.collection("escrowPaymentTransactions").doc(transactionId);
  const result = await db.runTransaction(async transaction => {
    const [current, order, claim] = await Promise.all([
      transaction.get(pendingRef), transaction.get(orderRef), transaction.get(transactionRef)
    ]);
    if (!current.exists) throw new HttpsError("not-found", "Escrow payment not found.");
    const data = current.data();
    if (data.status === "VERIFIED" && data.transactionId === transactionId && order.exists &&
        claim.exists && claim.data().txRef === txRef) {
      return { orderId: txRef, alreadyVerified: true, status: order.data().status,
        needsRefund: order.data().status === "AUTO_REFUND_REQUIRED" };
    }
    if (data.status !== "PENDING" || order.exists || claim.exists ||
        data.totalPaid !== pending.totalPaid || data.buyerUid !== pending.buyerUid) {
      throw new HttpsError("failed-precondition", "The escrow payment needs reconciliation.");
    }
    const redemptionRef = data.voucherCode ? voucherPairRef("voucherRedemptions", data.voucherCode, data.buyerUid) : null;
    const redemption = redemptionRef ? await transaction.get(redemptionRef) : null;
    if (redemptionRef && !redemption.exists) {
      throw new HttpsError("failed-precondition", "The voucher payment needs reconciliation.");
    }
    const voucherAvailable = !redemptionRef || redemption.data().status === "RELEASED" ||
      (redemption.data().status === "RESERVED" && redemption.data().txRef === txRef);
    let needsRefund = false;
    if (data.reservationStatus === "RELEASED") {
      const reservationItems = Array.isArray(data.items) && data.items.length
        ? data.items
        : [{ productId: data.productId, quantity: 1 }];
      const productRefs = reservationItems.map(item => db.collection("products").doc(item.productId));
      const productSnapshots = await Promise.all(productRefs.map(ref => transaction.get(ref)));
      const stockAvailable = voucherAvailable && reservationItems.every((item, index) => {
        const product = productSnapshots[index];
        return product.exists && product.data().ownerUid === data.vendorUid &&
          Number.isSafeInteger(product.data().stock) && product.data().stock >= item.quantity;
      });
      if (stockAvailable) {
        reservationItems.forEach((item, index) => transaction.update(productRefs[index], {
          stock: productSnapshots[index].data().stock - item.quantity
        }));
      } else {
        needsRefund = true;
      }
    } else if (data.reservationStatus !== "HELD") {
      throw new HttpsError("failed-precondition", "The stock reservation needs reconciliation.");
    } else if (!voucherAvailable || (redemptionRef &&
        (redemption.data().status !== "RESERVED" || redemption.data().txRef !== txRef))) {
      throw new HttpsError("failed-precondition", "The voucher reservation needs reconciliation.");
    }
    if (redemptionRef && !needsRefund) {
      transaction.set(redemptionRef, { code: data.voucherCode, buyerUid: data.buyerUid,
        txRef, status: "USED", usedAt: FieldValue.serverTimestamp() });
    } else if (redemptionRef && redemption.data().status === "RESERVED" && redemption.data().txRef === txRef) {
      transaction.update(redemptionRef, { status: "RELEASED" });
    }
    transaction.create(orderRef, {
      buyerUid: data.buyerUid,
      vendorUid: data.vendorUid,
      ...(Array.isArray(data.items) ? { items: data.items } : {}),
      productId: data.productId,
      productTitle: data.productTitle,
      productPrice: data.productPrice,
      ...(data.voucherCode ? { voucherCode: data.voucherCode, originalProductPrice: data.originalProductPrice,
        discount: data.discount } : {}),
      platformFee: data.platformFee,
      ...(data.fulfillment ? { fulfillment: data.fulfillment, fulfillmentFee: data.fulfillmentFee } : {}),
      totalPaid: data.totalPaid,
      currency: data.currency,
      transactionId,
      status: needsRefund ? "AUTO_REFUND_REQUIRED" : "HELD_IN_ESCROW",
      createdAt: FieldValue.serverTimestamp()
    });
    transaction.create(transactionRef, { txRef, createdAt: FieldValue.serverTimestamp() });
    transaction.update(pendingRef, {
      status: "VERIFIED", reservationStatus: needsRefund ? "REFUND_NEEDED" : "CONSUMED",
      transactionId, verifiedAt: FieldValue.serverTimestamp()
    });
    return { orderId: txRef, alreadyVerified: false,
      status: needsRefund ? "AUTO_REFUND_REQUIRED" : "HELD_IN_ESCROW", needsRefund };
  });
  if (result.needsRefund) {
    const refund = await startEscrowRefund(txRef, secret, "automatic", "AUTO_REFUND_REQUIRED");
    result.status = refund.status;
  }
  return { orderId: result.orderId, alreadyVerified: result.alreadyVerified, status: result.status };
}

exports.verifyEscrowPayment = onCall(
  { secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY] },
  async request => {
    const auth = requireVerifiedUser(request);
    const secret = escrowPaymentKey();
    const txRef = request.data?.txRef;
    if (typeof txRef !== "string" || !/^escrow-[0-9a-f-]{36}$/i.test(txRef)) {
      throw new HttpsError("invalid-argument", "The payment reference is invalid.");
    }
    const pending = await db.collection("escrowPendingPayments").doc(txRef).get();
    if (!pending.exists || pending.data().buyerUid !== auth.uid) {
      throw new HttpsError("not-found", "This payment does not belong to your account.");
    }
    const result = await verifyEscrowTransaction(txRef, request.data?.transactionId, secret);
    if (result.status === "FAILED") {
      throw new HttpsError("failed-precondition", "Flutterwave reports that this payment attempt failed. Check your order before retrying.");
    }
    return result;
  }
);

async function releaseExpiredEscrowStock(txRef, now, paymentFailed = false) {
  const pendingRef = db.collection("escrowPendingPayments").doc(txRef);
  return db.runTransaction(async transaction => {
    const pending = await transaction.get(pendingRef);
    if (!pending.exists || pending.data().status !== "PENDING" ||
        pending.data().reservationStatus !== "HELD" ||
        (!paymentFailed && pending.data().reservationExpiresAtMs > now)) return false;
    const data = pending.data();
    const reservationItems = Array.isArray(data.items) && data.items.length
      ? data.items
      : [{ productId: data.productId, quantity: 1 }];
    const productRefs = reservationItems.map(item => db.collection("products").doc(item.productId));
    const products = await Promise.all(productRefs.map(ref => transaction.get(ref)));
    const redemptionRef = data.voucherCode ? voucherPairRef("voucherRedemptions", data.voucherCode, data.buyerUid) : null;
    const redemption = redemptionRef ? await transaction.get(redemptionRef) : null;
    if (redemptionRef && (!redemption.exists || redemption.data().status !== "RESERVED" ||
        redemption.data().txRef !== txRef)) {
      throw new HttpsError("failed-precondition", "The voucher reservation needs reconciliation.");
    }
    reservationItems.forEach((item, index) => {
      const product = products[index];
      if (product.exists && product.data().ownerUid === data.vendorUid) {
        const restored = product.data().stock + item.quantity;
        if (!Number.isSafeInteger(product.data().stock) || product.data().stock < 0 ||
            !Number.isSafeInteger(restored)) {
          throw new HttpsError("failed-precondition", "The product stock needs reconciliation.");
        }
        transaction.update(productRefs[index], { stock: restored });
      } else {
        logger.error("Escrow reservation product no longer exists.", { txRef, productId: item.productId });
      }
    });
    if (redemptionRef) transaction.update(redemptionRef, { status: "RELEASED" });
    transaction.update(pendingRef, {
      reservationStatus: "RELEASED", reservationReleasedAt: FieldValue.serverTimestamp()
    });
    return true;
  });
}

exports.reconcileExpiredEscrowPayments = onSchedule(
  { schedule: "every 5 minutes", secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY], timeoutSeconds: 540 },
  async () => {
    const secret = escrowPaymentKey();
    const now = Date.now();
    let cursor = null;
    while (true) {
      let query = db.collection("escrowPendingPayments")
        .where("reservationStatus", "in", ["HELD", "RELEASED", "REFUND_NEEDED"])
        .orderBy(FieldPath.documentId()).limit(100);
      if (cursor) query = query.startAfter(cursor);
      const batch = await query.get();
      if (batch.empty) break;
      for (const doc of batch.docs) {
        const data = doc.data();
        if (data.reservationStatus === "REFUND_NEEDED" && data.status === "VERIFIED") {
          try {
            await startEscrowRefund(doc.id, secret, "automatic", "AUTO_REFUND_REQUIRED");
          } catch (error) {
            logger.error("Escrow automatic refund recovery failed.", { txRef: doc.id, error: error.message });
          }
          continue;
        }
        if (data.status !== "PENDING" || !Number.isSafeInteger(data.reservationExpiresAtMs) ||
            data.reservationExpiresAtMs > now) continue;
        try {
          await releaseExpiredEscrowStock(doc.id, now);
          const queryString = new URLSearchParams({ tx_ref: doc.id });
          const response = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?${queryString}`, {
            headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000)
          });
          if (!response.ok) {
            logger.error("Escrow payment lookup failed.", { txRef: doc.id, status: response.status });
            continue;
          }
          const result = await response.json();
          if (result.status !== "success") {
            logger.error("Escrow payment lookup was not successful.", { txRef: doc.id });
            continue;
          }
          if (result.data?.status === "successful") {
            await verifyEscrowTransaction(doc.id, String(result.data.id || ""), secret);
          }
        } catch (error) {
          logger.error("Escrow payment recovery failed.", { txRef: doc.id, error: error.message });
        }
      }
      cursor = batch.docs[batch.docs.length - 1];
      if (batch.docs.length < 100) break;
    }
  }
);

exports.flutterwaveEscrowTestWebhook = onRequest(
  { secrets: [FLW_SECRET_KEY, FLW_SECRET_HASH] },
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).send("Method not allowed.");
      return;
    }
    const secretHash = FLW_SECRET_HASH.value();
    const received = request.get("verif-hash");
    if (typeof secretHash !== "string" || !secretHash ||
        typeof received !== "string") {
      response.status(401).send("Invalid webhook signature.");
      return;
    }
    const expectedBuffer = Buffer.from(secretHash);
    const receivedBuffer = Buffer.from(received);
    if (expectedBuffer.length !== receivedBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
      response.status(401).send("Invalid webhook signature.");
      return;
    }
    let secret;
    try {
      secret = escrowSandboxKey();
    } catch (error) {
      logger.error("Escrow test webhook is not configured for a test environment.");
      response.status(503).send("Escrow test environment unavailable.");
      return;
    }
    try {
      await routeEscrowWebhookEvent(request.body, secret);
      response.status(200).send("Event processed.");
    } catch (error) {
      logger.error("Escrow test webhook verification failed.", { code: error.code || "unknown" });
      response.status(500).send("Event requires reconciliation.");
    }
  }
);

async function routeEscrowWebhookEvent(body, secret) {
  const event = body?.event;
  const data = body?.data || body;
  if ((event === "charge.completed" || event === "charge.failed") &&
      typeof data?.tx_ref === "string" && data.tx_ref.startsWith("escrow-")) {
    await verifyEscrowTransaction(data.tx_ref, String(data.id || ""), secret);
    return true;
  }
  if (event === "transfer.completed" && typeof data?.reference === "string" &&
      /^escrow-payout-[a-f0-9]{64}$/.test(data.reference)) {
    const withdrawalId = data.reference.slice("escrow-payout-".length);
    const snapshot = await db.collection("escrowWithdrawals").doc(withdrawalId).get();
    const transferId = String(data.id || "");
    if (!snapshot.exists || !/^\d{1,32}$/.test(transferId) ||
        (snapshot.data().providerTransferId && snapshot.data().providerTransferId !== transferId)) {
      throw new HttpsError("failed-precondition", "The transfer needs reconciliation.");
    }
    await checkEscrowWithdrawalStatus(withdrawalId, snapshot.data().vendorUid, secret, transferId);
    return true;
  }
  const rawRefund = !event && data && Object.hasOwn(data, "TransactionId") &&
    Object.hasOwn(data, "AmountRefunded") && Object.hasOwn(data, "id");
  if (event === "refund.completed" || rawRefund) {
    const transactionId = String(data?.transaction_id || data?.tx_id || data?.TransactionId || "");
    if (!/^\d{1,32}$/.test(transactionId)) {
      throw new HttpsError("invalid-argument", "The refund transaction ID is invalid.");
    }
    const claim = await db.collection("escrowPaymentTransactions").doc(transactionId).get();
    if (!claim.exists) return false;
    const orderId = claim.data().txRef;
    const refund = await db.collection("escrowRefunds").doc(orderId).get();
    const refundId = String(data.id || "");
    if (!refund.exists || !/^\d{1,32}$/.test(refundId) ||
        (refund.data().providerRefundId && refund.data().providerRefundId !== refundId)) {
      throw new HttpsError("failed-precondition", "The refund needs reconciliation.");
    }
    await checkEscrowRefundStatus(orderId, secret, refundId);
    return true;
  }
  return false;
}

async function findVendorPayoutQuote(netKobo, quoteFeeKobo) {
  const maxNetKobo = 2147483647 * 100;
  if (!Number.isSafeInteger(netKobo) || netKobo < 200000 ||
      netKobo > maxNetKobo || netKobo % 100 !== 0) {
    throw new HttpsError("invalid-argument", "Withdraw a whole-naira amount between NGN 2,000 and NGN 2,147,483,647.");
  }
  const commissionRate = netKobo < 1000000 ? 15
    : netKobo < 5000000 ? 25
      : netKobo < 20000000 ? 35 : 50;
  const baseFeeKobo = 50000;
  const commissionKobo = Math.round(netKobo * commissionRate / 1000);
  const providerFeeKobo = await quoteFeeKobo(netKobo / 100);
  if (!Number.isSafeInteger(providerFeeKobo) || providerFeeKobo < 0) {
    throw new HttpsError("unavailable", "Flutterwave returned an invalid transfer fee.");
  }
  const debitedKobo = baseFeeKobo + commissionKobo + providerFeeKobo + netKobo;
  if (!Number.isSafeInteger(debitedKobo)) {
    throw new HttpsError("failed-precondition", "The payout amount needs reconciliation.");
  }
  return {
    grossKobo: debitedKobo,
    baseFeeKobo,
    commissionKobo,
    providerFeeKobo,
    netKobo,
    retainedBalanceKobo: 0,
    debitedKobo
  };
}

async function fetchVendorTransferFee(secret, netNaira) {
  const query = new URLSearchParams({ amount: String(netNaira), currency: "NGN", type: "account" });
  const response = await fetch(`https://api.flutterwave.com/v3/transfers/fee?${query}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    logger.error("Flutterwave transfer fee quote failed.", { status: response.status });
    throw new HttpsError("unavailable", "Flutterwave could not quote the transfer fee.");
  }
  const quote = await response.json();
  const fees = Array.isArray(quote.data) ? quote.data.filter(item =>
    item && item.currency === "NGN" && item.fee_type === "value") : [];
  const rawFee = fees.length === 1 ? fees[0].fee : null;
  const fee = typeof rawFee === "number" ||
    (typeof rawFee === "string" && /^\d+(\.\d+)?$/.test(rawFee))
    ? Number(rawFee) : NaN;
  if (quote.status !== "success" || !Number.isFinite(fee) || fee < 0 ||
      !Number.isSafeInteger(Math.ceil(fee * 100))) {
    throw new HttpsError("unavailable", "Flutterwave returned an invalid transfer fee.");
  }
  return Math.ceil(fee * 100 - 0.00000001);
}

function sanitizeProviderDiagnostic(value, fallback = "Flutterwave transfer request was rejected.") {
  const text = typeof value === "string" ? value : fallback;
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/FLWSECK(?:_TEST)?-[A-Za-z0-9._-]+/gi, "[REDACTED_KEY]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 500) || fallback;
}

async function readProviderTransferResponse(response) {
  if (typeof response.text === "function") {
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        body = null;
      }
    }
    return { body, rawTextLength: text.length };
  }
  return { body: await response.json(), rawTextLength: 0 };
}

function providerTransferDiagnostic(status, body, fallback) {
  const providerStatus = typeof body?.status === "string"
    ? sanitizeProviderDiagnostic(body.status, "unknown")
    : "unknown";
  const candidate = body?.message || body?.error?.message || body?.data?.message || fallback;
  return {
    providerHttpStatus: Number.isSafeInteger(status) ? status : 0,
    providerStatus,
    providerErrorMessage: sanitizeProviderDiagnostic(candidate, fallback)
  };
}

async function saveProviderTransferDiagnostic(ref, diagnostic) {
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists || snapshot.data().status !== "INITIATING") return;
    transaction.update(ref, {
      providerHttpStatus: diagnostic.providerHttpStatus,
      providerErrorStatus: diagnostic.providerStatus,
      providerErrorMessage: diagnostic.providerErrorMessage,
      providerErrorAt: FieldValue.serverTimestamp()
    });
  });
}

async function failRejectedProviderTransfer(ref, vendorUid, diagnostic) {
  const balanceRef = db.collection("vendorPayoutBalances").doc(vendorUid);
  await db.runTransaction(async transaction => {
    const [snapshot, balanceSnapshot] = await Promise.all([
      transaction.get(ref),
      transaction.get(balanceRef)
    ]);
    if (!snapshot.exists || snapshot.data().status !== "INITIATING" ||
        snapshot.data().providerTransferId) {
      return false;
    }
    const payout = snapshot.data();
    const debit = payout.debitedKobo;
    const restored = escrowStoredBalance(balanceSnapshot, "availableKobo") + debit;
    const parts = ["netKobo", "baseFeeKobo", "commissionKobo", "providerFeeKobo"]
      .map(field => payout[field]);
    if (!balanceSnapshot.exists || !Number.isSafeInteger(debit) || debit <= 0 ||
        parts.some(value => !Number.isSafeInteger(value) || value < 0) ||
        parts.reduce((sum, value) => sum + value, 0) !== debit ||
        !Number.isSafeInteger(restored)) {
      throw new HttpsError("failed-precondition", "The payout ledger needs reconciliation.");
    }
    transaction.set(balanceRef, {
      availableKobo: restored,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.update(ref, {
      status: "FAILED",
      providerHttpStatus: diagnostic.providerHttpStatus,
      providerErrorStatus: diagnostic.providerStatus,
      providerErrorMessage: diagnostic.providerErrorMessage,
      providerErrorAt: FieldValue.serverTimestamp(),
      refundedAt: FieldValue.serverTimestamp()
    });
    return true;
  });
}

exports.getVendorPayoutQuote = onCall(
  { secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY], timeoutSeconds: 120 },
  async request => {
    const auth = requireVerifiedUser(request);
    const secret = vendorPayoutKey();
    const netKobo = escrowAmountKobo(request.data?.amount);
    const [profile, balance] = await Promise.all([
      db.collection("users").doc(auth.uid).get(),
      db.collection("vendorPayoutBalances").doc(auth.uid).get()
    ]);
    if (!profile.exists || profile.data()?.role !== "Vendor") {
      throw new HttpsError("permission-denied", "Only vendors can request a payout quote.");
    }
    const quote = await findVendorPayoutQuote(netKobo, netNaira =>
      fetchVendorTransferFee(secret, netNaira));
    if (quote.debitedKobo > escrowStoredBalance(balance, "availableKobo")) {
      throw new HttpsError("failed-precondition", "Your releasable payout balance is too low.");
    }
    return quote;
  }
);

exports.getVendorPayoutBanks = onCall(
  { secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY] },
  async request => {
    const auth = requireVerifiedUser(request);
    const secret = vendorPayoutKey();
    const profile = await db.collection("users").doc(auth.uid).get();
    if (!profile.exists || profile.data()?.role !== "Vendor") {
      throw new HttpsError("permission-denied", "Only vendors can access payout banks.");
    }
    const response = await fetch("https://api.flutterwave.com/v3/banks/NG", {
      headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new HttpsError("unavailable", "Flutterwave could not load Nigerian banks.");
    const result = await response.json();
    if (result.status !== "success" || !Array.isArray(result.data)) {
      throw new HttpsError("unavailable", "Flutterwave returned an invalid bank list.");
    }
    const banks = result.data.filter(bank => typeof bank?.code === "string" &&
      /^\d{3,6}$/.test(bank.code) && typeof bank.name === "string" &&
      bank.name.trim() && bank.name.length <= 200)
      .map(bank => ({ code: bank.code, name: bank.name.trim() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!banks.length) throw new HttpsError("unavailable", "Flutterwave returned no supported banks.");
    return { banks };
  }
);

exports.saveVendorBankAccount = onCall(
  { secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY] },
  async request => {
    const auth = requireVerifiedUser(request);
    const secret = vendorPayoutKey();
    const bankCode = request.data?.bankCode;
    const accountNumber = request.data?.accountNumber;
    if (typeof bankCode !== "string" || !/^\d{3,6}$/.test(bankCode) ||
        typeof accountNumber !== "string" || !/^\d{10}$/.test(accountNumber)) {
      throw new HttpsError("invalid-argument", "Enter a valid Nigerian bank code and account number.");
    }
    const profileRef = db.collection("users").doc(auth.uid);
    const profile = await profileRef.get();
    if (!profile.exists || profile.data()?.role !== "Vendor") {
      throw new HttpsError("permission-denied", "Only vendors can register payout accounts.");
    }
    const response = await fetch("https://api.flutterwave.com/v3/accounts/resolve", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ account_bank: bankCode, account_number: accountNumber }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new HttpsError("unavailable", "Flutterwave could not verify the bank account.");
    const result = await response.json();
    const name = result.data?.account_name;
    if (result.status !== "success" || result.data?.account_number !== accountNumber ||
        typeof name !== "string" || !name.trim() || name.length > 200) {
      throw new HttpsError("failed-precondition", "Flutterwave could not verify the bank account.");
    }
    const version = crypto.randomUUID();
    const bankRef = db.collection("escrowVendorBankAccounts").doc(auth.uid);
    await db.runTransaction(async transaction => {
      const currentProfile = await transaction.get(profileRef);
      if (!currentProfile.exists || currentProfile.data()?.role !== "Vendor") {
        throw new HttpsError("permission-denied", "Only vendors can register payout accounts.");
      }
      transaction.set(bankRef, {
        bankCode, accountNumber, accountName: name.trim(), version,
        updatedAt: FieldValue.serverTimestamp()
      });
    });
    return { bankCode, lastFour: accountNumber.slice(-4), accountName: name.trim(), version };
  }
);

exports.getVendorBankAccount = onCall(
  { secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY] },
  async request => {
    const auth = requireVerifiedUser(request);
    const profile = await db.collection("users").doc(auth.uid).get();
    if (!profile.exists || profile.data()?.role !== "Vendor") {
      throw new HttpsError("permission-denied", "Only vendors can view payout accounts.");
    }
    if (!vendorPayoutsEnabled()) return { configured: false, payoutsEnabled: false };
    vendorPayoutKey();
    const snapshot = await db.collection("escrowVendorBankAccounts").doc(auth.uid).get();
    if (!snapshot.exists) return { configured: false, payoutsEnabled: true };
    const account = snapshot.data();
    if (typeof account.bankCode !== "string" || !/^\d{3,6}$/.test(account.bankCode) ||
        typeof account.accountNumber !== "string" || !/^\d{10}$/.test(account.accountNumber) ||
        typeof account.accountName !== "string" || typeof account.version !== "string") {
      throw new HttpsError("failed-precondition", "The payout account needs reconciliation.");
    }
    return { configured: true, payoutsEnabled: true, bankCode: account.bankCode, lastFour: account.accountNumber.slice(-4),
      accountName: account.accountName, version: account.version };
  }
);

exports.requestVendorWithdrawal = onCall(
  { secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY], timeoutSeconds: 120 },
  async request => {
    const auth = requireVerifiedUser(request);
    const operationId = request.data?.operationId;
    if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(operationId)) {
      throw new HttpsError("invalid-argument", "A valid withdrawal request ID is required.");
    }
    const netKobo = escrowAmountKobo(request.data?.amount);
    const withdrawalId = crypto.createHash("sha256").update(`${auth.uid}\0${operationId}`).digest("hex");
    const withdrawalRef = db.collection("escrowWithdrawals").doc(withdrawalId);
    const prior = await withdrawalRef.get();
    if (prior.exists) return { withdrawalId, status: prior.data().status, alreadyRequested: true };
    const secret = vendorPayoutKey();
    const bankRef = db.collection("escrowVendorBankAccounts").doc(auth.uid);
    const bankSnapshot = await bankRef.get();
    if (!bankSnapshot.exists || bankSnapshot.data().version !== request.data?.bankVersion) {
      throw new HttpsError("failed-precondition", "Confirm the current payout bank account before withdrawing.");
    }
    const bank = bankSnapshot.data();
    if (!/^\d{3,6}$/.test(bank.bankCode || "") || !/^\d{10}$/.test(bank.accountNumber || "")) {
      throw new HttpsError("failed-precondition", "The payout bank account needs reconciliation.");
    }
    const quote = await findVendorPayoutQuote(netKobo, netNaira => fetchVendorTransferFee(secret, netNaira));
    const expected = request.data?.quote;
    const fields = ["grossKobo", "baseFeeKobo", "commissionKobo", "providerFeeKobo",
      "netKobo", "retainedBalanceKobo", "debitedKobo"];
    if (!expected || fields.some(field => expected[field] !== quote[field])) {
      throw new HttpsError("failed-precondition", "The payout quote changed. Review the new fees before confirming.");
    }
    const profileRef = db.collection("users").doc(auth.uid);
    const balanceRef = db.collection("vendorPayoutBalances").doc(auth.uid);
    const reference = `escrow-payout-${withdrawalId}`;
    const reserved = await db.runTransaction(async transaction => {
      const [profile, balance, currentBank, existing] = await Promise.all([
        transaction.get(profileRef), transaction.get(balanceRef),
        transaction.get(bankRef), transaction.get(withdrawalRef)
      ]);
      if (existing.exists) return false;
      if (!profile.exists || profile.data()?.role !== "Vendor") {
        throw new HttpsError("permission-denied", "Only vendors can withdraw.");
      }
      if (!currentBank.exists || currentBank.data().version !== bank.version) {
        throw new HttpsError("failed-precondition", "The payout bank account changed. Review it again.");
      }
      const availableKobo = escrowStoredBalance(balance, "availableKobo");
      if (availableKobo < quote.debitedKobo) {
        throw new HttpsError("failed-precondition", "Your releasable payout balance is too low.");
      }
      transaction.set(balanceRef, {
        availableKobo: availableKobo - quote.debitedKobo,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.create(withdrawalRef, {
        vendorUid: auth.uid, reference, bankVersion: bank.version,
        bankLastFour: bank.accountNumber.slice(-4), ...quote,
        status: "INITIATING", createdAt: FieldValue.serverTimestamp()
      });
      return true;
    });
    if (!reserved) {
      const existing = await withdrawalRef.get();
      return { withdrawalId, status: existing.data().status, alreadyRequested: true };
    }
    let result;
    try {
      const response = await fetch("https://api.flutterwave.com/v3/transfers", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          account_bank: bank.bankCode, account_number: bank.accountNumber,
          amount: quote.netKobo / 100, currency: "NGN", debit_currency: "NGN",
          reference, narration: "Escrow vendor payout"
        }),
        signal: AbortSignal.timeout(15000)
      });
      const parsed = await readProviderTransferResponse(response);
      result = parsed.body;
      if (!response.ok) {
        const diagnostic = providerTransferDiagnostic(
          response.status,
          result,
          "Flutterwave did not return a transfer response body."
        );
        await saveProviderTransferDiagnostic(withdrawalRef, diagnostic);
        logger.error("Flutterwave transfer request rejected.", {
          withdrawalId,
          providerHttpStatus: diagnostic.providerHttpStatus,
          providerStatus: diagnostic.providerStatus,
          providerMessage: diagnostic.providerErrorMessage
        });
        if (response.status >= 400 && response.status < 500) {
          await failRejectedProviderTransfer(withdrawalRef, auth.uid, diagnostic);
        }
        throw new Error(`Transfer request returned HTTP ${response.status}.`);
      }
    } catch (error) {
      logger.error("Escrow payout requires reconciliation.", { withdrawalId, error: error.message });
      throw new HttpsError("unavailable", "Payout status is uncertain. Contact support; do not retry.");
    }
    const transfer = result.data;
    const transferId = String(transfer?.id || "");
    const transferFee = transfer?.fee;
    if (result.status !== "success" || !/^\d{1,32}$/.test(transferId) ||
        transfer.reference !== reference || transfer.currency !== "NGN" ||
        Number(transfer.amount) !== quote.netKobo / 100 ||
        (transfer.status !== "FAILED" && (typeof transferFee !== "number" ||
          !Number.isFinite(transferFee) ||
          Math.ceil(transferFee * 100 - 0.00000001) !== quote.providerFeeKobo)) ||
        !["NEW", "PENDING", "SUCCESSFUL", "FAILED"].includes(transfer.status)) {
      const diagnostic = providerTransferDiagnostic(
        200,
        result,
        "Flutterwave returned an invalid or incomplete transfer response."
      );
      await saveProviderTransferDiagnostic(withdrawalRef, diagnostic);
      logger.error("Flutterwave transfer response needs reconciliation.", {
        withdrawalId,
        providerHttpStatus: diagnostic.providerHttpStatus,
        providerStatus: diagnostic.providerStatus,
        providerMessage: diagnostic.providerErrorMessage
      });
      throw new HttpsError("unavailable", "Payout status is uncertain. Contact support; do not retry.");
    }
    await db.runTransaction(async transaction => {
      const current = await transaction.get(withdrawalRef);
      if (!current.exists) {
        throw new HttpsError("failed-precondition", "The payout needs reconciliation.");
      }
      if (["PENDING", "PAID", "FAILED"].includes(current.data().status) &&
          current.data().providerTransferId === transferId) return;
      if (current.data().status !== "INITIATING") {
        throw new HttpsError("failed-precondition", "The payout needs reconciliation.");
      }
      transaction.update(withdrawalRef, {
        status: "PENDING", providerTransferId: transferId,
        updatedAt: FieldValue.serverTimestamp()
      });
    });
    if (transfer.status === "FAILED") {
      await checkEscrowWithdrawalStatus(withdrawalId, auth.uid, secret, transferId);
    }
    const current = await withdrawalRef.get();
    return { withdrawalId, status: current.data().status, alreadyRequested: false };
  }
);

async function checkEscrowWithdrawalStatus(withdrawalId, vendorUid, secret, notifiedTransferId) {
    if (typeof withdrawalId !== "string" || !/^[a-f0-9]{64}$/.test(withdrawalId)) {
      throw new HttpsError("invalid-argument", "Choose a valid payout.");
    }
    const withdrawalRef = db.collection("escrowWithdrawals").doc(withdrawalId);
    const snapshot = await withdrawalRef.get();
    if (!snapshot.exists || snapshot.data().vendorUid !== vendorUid) {
      throw new HttpsError("not-found", "Payout not found.");
    }
    const withdrawal = snapshot.data();
    if (["PAID", "FAILED"].includes(withdrawal.status)) {
      if (notifiedTransferId && notifiedTransferId !== withdrawal.providerTransferId) {
        throw new HttpsError("failed-precondition", "The payout needs reconciliation.");
      }
      return { status: withdrawal.status };
    }
    const transferId = withdrawal.providerTransferId || notifiedTransferId;
    if (!["INITIATING", "PENDING"].includes(withdrawal.status) ||
        !/^\d{1,32}$/.test(transferId || "") ||
        (notifiedTransferId && withdrawal.providerTransferId &&
          notifiedTransferId !== withdrawal.providerTransferId)) {
      throw new HttpsError("failed-precondition", "The payout needs reconciliation.");
    }
    const response = await fetch(`https://api.flutterwave.com/v3/transfers/${transferId}`, {
      headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new HttpsError("unavailable", "Flutterwave could not check the payout.");
    const result = await response.json();
    const transfer = result.data;
    const fee = transfer?.fee;
    if (result.status !== "success" || String(transfer?.id) !== transferId ||
        transfer.reference !== withdrawal.reference || transfer.currency !== "NGN" ||
        Number(transfer.amount) !== withdrawal.netKobo / 100) {
      throw new HttpsError("failed-precondition", "The payout needs reconciliation.");
    }
    if (!["NEW", "PENDING", "SUCCESSFUL", "FAILED"].includes(transfer.status)) {
      throw new HttpsError("failed-precondition", "The payout did not complete and requires support review.");
    }
    if (transfer.status !== "FAILED" &&
        (typeof fee !== "number" || !Number.isFinite(fee) ||
        Math.ceil(fee * 100 - 0.00000001) !== withdrawal.providerFeeKobo)) {
      throw new HttpsError("failed-precondition", "The payout fee needs reconciliation.");
    }
    const revenueRef = db.collection("escrowPlatformAccounting").doc("withdrawalRevenue");
    const balanceRef = db.collection("vendorPayoutBalances").doc(vendorUid);
    await db.runTransaction(async transaction => {
      const [current, revenue, balance] = await Promise.all([
        transaction.get(withdrawalRef), transaction.get(revenueRef), transaction.get(balanceRef)
      ]);
      if (!current.exists || current.data().vendorUid !== vendorUid ||
          current.data().reference !== withdrawal.reference ||
          (current.data().providerTransferId && current.data().providerTransferId !== transferId)) {
        throw new HttpsError("failed-precondition", "The payout needs reconciliation.");
      }
      if (["PAID", "FAILED"].includes(current.data().status)) {
        if (["SUCCESSFUL", "FAILED"].includes(transfer.status) &&
            (current.data().status === "PAID") !== (transfer.status === "SUCCESSFUL")) {
          throw new HttpsError("failed-precondition", "The payout status changed and needs reconciliation.");
        }
        return;
      }
      if (!["INITIATING", "PENDING"].includes(current.data().status)) {
        throw new HttpsError("failed-precondition", "The payout needs reconciliation.");
      }
      if (transfer.status !== "SUCCESSFUL") {
        if (transfer.status === "FAILED") {
          const debit = current.data().debitedKobo;
          const parts = ["netKobo", "baseFeeKobo", "commissionKobo", "providerFeeKobo"]
            .map(field => current.data()[field]);
          const restored = escrowStoredBalance(balance, "availableKobo") + debit;
          if (!balance.exists || !Number.isSafeInteger(debit) || debit <= 0 ||
              parts.some(value => !Number.isSafeInteger(value) || value < 0) ||
              parts.reduce((sum, value) => sum + value, 0) !== debit ||
              !Number.isSafeInteger(restored)) {
            throw new HttpsError("failed-precondition", "The payout ledger needs reconciliation.");
          }
          transaction.set(balanceRef, { availableKobo: restored,
            updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          transaction.update(withdrawalRef, {
            status: "FAILED", providerTransferId: transferId,
            refundedAt: FieldValue.serverTimestamp()
          });
          return;
        }
        transaction.update(withdrawalRef, {
          status: "PENDING", providerTransferId: transferId, updatedAt: FieldValue.serverTimestamp()
        });
        return;
      }
      const retainedKobo = escrowStoredBalance(revenue, "retainedKobo") +
        withdrawal.baseFeeKobo + withdrawal.commissionKobo;
      if (!Number.isSafeInteger(retainedKobo)) {
        throw new HttpsError("failed-precondition", "The payout ledger needs reconciliation.");
      }
      transaction.set(revenueRef, { retainedKobo, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.update(withdrawalRef, {
        status: "PAID", providerTransferId: transferId, completedAt: FieldValue.serverTimestamp()
      });
    });
    const updated = await withdrawalRef.get();
    return { status: updated.data().status };
}

exports.checkVendorWithdrawal = onCall(
  { secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY] },
  async request => {
    const auth = requireVerifiedUser(request);
    const secret = vendorPayoutKey(false);
    return checkEscrowWithdrawalStatus(request.data?.withdrawalId, auth.uid, secret);
  }
);

exports.adminCheckVendorWithdrawal = onCall(
  { secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY] },
  async request => {
    requireEscrowAdmin(request);
    const secret = vendorPayoutKey(false);
    const withdrawalId = request.data?.withdrawalId;
    if (typeof withdrawalId !== "string" || !/^[a-f0-9]{64}$/.test(withdrawalId)) {
      throw new HttpsError("invalid-argument", "Choose a valid payout.");
    }
    const snapshot = await db.collection("escrowWithdrawals").doc(withdrawalId).get();
    if (!snapshot.exists) throw new HttpsError("not-found", "Payout not found.");
    const withdrawal = snapshot.data();
    if (!Number.isSafeInteger(withdrawal.grossKobo) || withdrawal.grossKobo < 200000) {
      throw new HttpsError("failed-precondition", "The payout is below the NGN 2,000 minimum or needs reconciliation.");
    }
    return checkEscrowWithdrawalStatus(withdrawalId, withdrawal.vendorUid, secret);
  }
);

exports.reconcileEscrowWithdrawal = onCall(
  { secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY] },
  async request => {
    const auth = requireVerifiedUser(request);
    if (!isOwnerAdmin(auth)) {
      throw new HttpsError("permission-denied", "Administrator access is required.");
    }
    const secret = vendorPayoutKey(false);
    const withdrawalId = request.data?.withdrawalId;
    const transferId = request.data?.transferId;
    if (typeof withdrawalId !== "string" || !/^[a-f0-9]{64}$/.test(withdrawalId) ||
        typeof transferId !== "string" || !/^\d{1,32}$/.test(transferId)) {
      throw new HttpsError("invalid-argument", "Provide a valid withdrawal and Flutterwave transfer ID.");
    }
    const ref = db.collection("escrowWithdrawals").doc(withdrawalId);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new HttpsError("not-found", "Withdrawal not found.");
    const withdrawal = snapshot.data();
    if (!Number.isSafeInteger(withdrawal.grossKobo) || withdrawal.grossKobo < 200000) {
      throw new HttpsError("failed-precondition", "The payout is below the NGN 2,000 minimum or needs reconciliation.");
    }
    if (withdrawal.status !== "INITIATING") {
      throw new HttpsError("failed-precondition", "Only an uncertain withdrawal can be reconciled here.");
    }
    const response = await fetch(`https://api.flutterwave.com/v3/transfers/${transferId}`, {
      headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new HttpsError("unavailable", "Flutterwave could not verify the transfer.");
    const result = await response.json();
    const transfer = result.data;
    if (result.status !== "success" || String(transfer?.id) !== transferId ||
        transfer.reference !== withdrawal.reference || transfer.currency !== "NGN" ||
        Number(transfer.amount) !== withdrawal.netKobo / 100 ||
        (transfer.status !== "FAILED" && (typeof transfer.fee !== "number" ||
          !Number.isFinite(transfer.fee) ||
          Math.ceil(transfer.fee * 100 - 0.00000001) !== withdrawal.providerFeeKobo)) ||
        !["NEW", "PENDING", "SUCCESSFUL", "FAILED"].includes(transfer.status)) {
      throw new HttpsError("failed-precondition", "The transfer does not match the reserved withdrawal.");
    }
    await db.runTransaction(async transaction => {
      const current = await transaction.get(ref);
      if (!current.exists || current.data().status !== "INITIATING" ||
          current.data().reference !== withdrawal.reference) {
        throw new HttpsError("failed-precondition", "The withdrawal changed. Review it again.");
      }
      transaction.update(ref, {
        status: "PENDING", providerTransferId: transferId,
        reconciledBy: auth.uid, updatedAt: FieldValue.serverTimestamp()
      });
    });
    return { status: "PENDING" };
  }
);

async function updateEscrowOrder(request, action) {
  const auth = requireVerifiedUser(request);
  const orderId = request.data?.orderId;
  if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) {
    throw new HttpsError("invalid-argument", "Choose a valid escrow order.");
  }
  if (action === "resolve" && !isOwnerAdmin(auth)) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
  const reason = typeof request.data?.reason === "string" ? request.data.reason.trim() : "";
  if (action === "dispute" && (!reason || reason.length > 2000)) {
    throw new HttpsError("invalid-argument", "Provide a dispute reason of up to 2,000 characters.");
  }
  if (action === "resolve" && request.data?.decision !== "release") {
    throw new HttpsError("failed-precondition", "Automated refunds are not available yet.");
  }

  const orderRef = db.collection("escrowOrders").doc(orderId);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists) throw new HttpsError("not-found", "Escrow order not found.");
    const order = snapshot.data();
    if ((action === "ship" && order.vendorUid !== auth.uid) ||
        (["confirm", "dispute"].includes(action) && order.buyerUid !== auth.uid)) {
      throw new HttpsError("permission-denied", "You cannot update this escrow order.");
    }

    if (action === "ship") {
      if (order.status === "SHIPPED") return { status: "SHIPPED", alreadyUpdated: true };
      if (order.status !== "HELD_IN_ESCROW") {
        throw new HttpsError("failed-precondition", "Only a held order can be marked shipped.");
      }
      transaction.update(orderRef, { status: "SHIPPED", shippedAt: FieldValue.serverTimestamp() });
      return { status: "SHIPPED", alreadyUpdated: false };
    }

    if (action === "dispute") {
      if (order.status === "DISPUTED") return { status: "DISPUTED", alreadyUpdated: true };
      if (!["HELD_IN_ESCROW", "SHIPPED"].includes(order.status)) {
        throw new HttpsError("failed-precondition", "This order cannot be disputed.");
      }
      transaction.update(orderRef, {
        status: "DISPUTED",
        disputeReason: reason,
        disputedAt: FieldValue.serverTimestamp()
      });
      return { status: "DISPUTED", alreadyUpdated: false };
    }

    if (order.status === "RELEASED") return { status: "RELEASED", alreadyUpdated: true };
    const requiredStatus = action === "confirm" ? "SHIPPED" : "DISPUTED";
    if (order.status !== requiredStatus) {
      throw new HttpsError("failed-precondition", "This order is not ready to release.");
    }
    if (typeof order.vendorUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(order.vendorUid) ||
        order.vendorUid === order.buyerUid) {
      throw new HttpsError("failed-precondition", "The order has an invalid vendor.");
    }
    const productKobo = escrowAmountKobo(order.productPrice);
    const feeKobo = escrowAmountKobo(order.platformFee, true);
    const fulfillmentKobo = order.fulfillment ? escrowAmountKobo(order.fulfillmentFee, true) : 0;
    const totalKobo = escrowAmountKobo(order.totalPaid);
    if (!Number.isSafeInteger(productKobo + feeKobo + fulfillmentKobo) ||
        productKobo + feeKobo + fulfillmentKobo !== totalKobo) {
      throw new HttpsError("failed-precondition", "The order amount needs reconciliation.");
    }
    const balanceRef = db.collection("vendorPayoutBalances").doc(order.vendorUid);
    const revenueRef = db.collection("escrowPlatformAccounting").doc("revenue");
    const releaseRef = db.collection("escrowReleases").doc(orderId);
    const [balanceSnapshot, revenueSnapshot, releaseSnapshot] = await Promise.all([
      transaction.get(balanceRef),
      transaction.get(revenueRef),
      transaction.get(releaseRef)
    ]);
    if (releaseSnapshot.exists) {
      throw new HttpsError("failed-precondition", "The order release needs reconciliation.");
    }
    const balanceKobo = escrowStoredBalance(balanceSnapshot, "availableKobo") + productKobo;
    const revenueKobo = escrowStoredBalance(revenueSnapshot, "retainedKobo") + feeKobo + fulfillmentKobo;
    if (!Number.isSafeInteger(balanceKobo) || !Number.isSafeInteger(revenueKobo)) {
      throw new HttpsError("failed-precondition", "The escrow ledger needs reconciliation.");
    }
    transaction.set(balanceRef, { availableKobo: balanceKobo, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(revenueRef, { retainedKobo: revenueKobo, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.create(releaseRef, {
      vendorUid: order.vendorUid,
      productKobo,
      feeKobo,
      fulfillmentKobo,
      releasedBy: auth.uid,
      releasedAt: FieldValue.serverTimestamp()
    });
    transaction.update(orderRef, {
      status: "RELEASED",
      releasedBy: auth.uid,
      releasedAt: FieldValue.serverTimestamp()
    });
    return { status: "RELEASED", alreadyUpdated: false };
  });
}

async function initiateEscrowRefund(request) {
  const auth = requireVerifiedUser(request);
  if (!isOwnerAdmin(auth)) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
  const secret = escrowSandboxKey();
  const orderId = request.data?.orderId;
  return startEscrowRefund(orderId, secret, auth.uid, "DISPUTED");
}

exports.prepareManualEscrowRefund = onCall(async request => {
  const auth = requireEscrowAdmin(request);
  const orderId = request.data?.orderId;
  if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) {
    throw new HttpsError("invalid-argument", "Choose a valid escrow order.");
  }
  const orderRef = db.collection("escrowOrders").doc(orderId);
  const refundRef = db.collection("escrowRefunds").doc(orderId);
  return db.runTransaction(async transaction => {
    const [orderSnapshot, refundSnapshot] = await Promise.all([
      transaction.get(orderRef), transaction.get(refundRef)
    ]);
    if (!orderSnapshot.exists) throw new HttpsError("not-found", "Escrow order not found.");
    const order = orderSnapshot.data();
    if (refundSnapshot.exists) {
      const refund = refundSnapshot.data();
      if (refund.mode === "MANUAL" && ["INITIATING", "PENDING"].includes(refund.status) &&
          ["REFUND_INITIATING", "REFUND_PENDING"].includes(order.status)) {
        return { orderId, transactionId: refund.transactionId, amountKobo: refund.amountKobo, alreadyPrepared: true };
      }
      throw new HttpsError("failed-precondition", "This refund already exists or needs reconciliation.");
    }
    if (order.status !== "DISPUTED" ||
        typeof order.transactionId !== "string" || !/^\d{1,32}$/.test(order.transactionId)) {
      throw new HttpsError("failed-precondition", "Only a disputed order with a verified payment can be prepared.");
    }
    const productKobo = escrowAmountKobo(order.productPrice);
    const feeKobo = escrowAmountKobo(order.platformFee, true);
    const fulfillmentKobo = order.fulfillment ? escrowAmountKobo(order.fulfillmentFee, true) : 0;
    const totalKobo = escrowAmountKobo(order.totalPaid);
    if (!Number.isSafeInteger(productKobo + feeKobo + fulfillmentKobo) ||
        productKobo + feeKobo + fulfillmentKobo !== totalKobo) {
      throw new HttpsError("failed-precondition", "The order amount needs reconciliation.");
    }
    const amountKobo = order.fulfillment && order.shippedAt ? productKobo : totalKobo;
    if (amountKobo < 10000) {
      throw new HttpsError("failed-precondition", "Flutterwave's minimum refund is NGN 100; contact support.");
    }
    transaction.create(refundRef, { orderId, transactionId: order.transactionId, amountKobo,
      retainedKobo: totalKobo - amountKobo, mode: "MANUAL", status: "INITIATING",
      initiatedBy: auth.uid, createdAt: FieldValue.serverTimestamp() });
    transaction.update(orderRef, { status: "REFUND_INITIATING",
      refundRequestedAt: FieldValue.serverTimestamp() });
    return { orderId, transactionId: order.transactionId, amountKobo, alreadyPrepared: false };
  });
});

exports.verifyManualEscrowRefund = onCall(
  { secrets: [FLW_SECRET_KEY, FLUTTERWAVE_SECRET_KEY] },
  async request => {
    const auth = requireEscrowAdmin(request);
    const orderId = request.data?.orderId;
    const refundId = request.data?.refundId;
    if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId) ||
        typeof refundId !== "string" || !/^\d{1,32}$/.test(refundId)) {
      throw new HttpsError("invalid-argument", "Provide a valid order and Flutterwave refund ID.");
    }
    const snapshot = await db.collection("escrowRefunds").doc(orderId).get();
    if (!snapshot.exists || snapshot.data().mode !== "MANUAL") {
      throw new HttpsError("failed-precondition", "Prepare a manual refund before verifying it.");
    }
    return checkEscrowRefundStatus(orderId, escrowPaymentKey(), refundId, auth.uid);
  }
);

async function startEscrowRefund(orderId, secret, initiatedBy, requiredStatus) {
  if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) {
    throw new HttpsError("invalid-argument", "Choose a valid escrow order.");
  }
  const orderRef = db.collection("escrowOrders").doc(orderId);
  const refundRef = db.collection("escrowRefunds").doc(orderId);
  const details = await db.runTransaction(async transaction => {
    const pendingRef = db.collection("escrowPendingPayments").doc(orderId);
    const [orderSnapshot, refundSnapshot, pendingSnapshot] = await Promise.all([
      transaction.get(orderRef), transaction.get(refundRef),
      ...(initiatedBy === "automatic" ? [transaction.get(pendingRef)] : [])
    ]);
    if (!orderSnapshot.exists) throw new HttpsError("not-found", "Escrow order not found.");
    const order = orderSnapshot.data();
    if (order.status !== requiredStatus || refundSnapshot.exists) {
      throw new HttpsError("failed-precondition", "This refund is not available or needs reconciliation.");
    }
    if (initiatedBy === "automatic" &&
        (!pendingSnapshot.exists || pendingSnapshot.data().reservationStatus !== "REFUND_NEEDED")) {
      throw new HttpsError("failed-precondition", "The automatic refund needs reconciliation.");
    }
    if (typeof order.transactionId !== "string" || !/^\d{1,32}$/.test(order.transactionId)) {
      throw new HttpsError("failed-precondition", "The payment needs reconciliation before refund.");
    }
    const amountKobo = initiatedBy !== "automatic" && order.fulfillment && order.shippedAt
      ? escrowAmountKobo(order.productPrice) : escrowAmountKobo(order.totalPaid);
    if (amountKobo < 10000) {
      throw new HttpsError("failed-precondition", "Flutterwave's minimum refund is NGN 100; contact support.");
    }
    transaction.create(refundRef, {
      orderId, transactionId: order.transactionId, amountKobo,
      retainedKobo: escrowAmountKobo(order.totalPaid) - amountKobo,
      status: "INITIATING", initiatedBy, createdAt: FieldValue.serverTimestamp()
    });
    transaction.update(orderRef, {
      status: "REFUND_INITIATING", refundRequestedAt: FieldValue.serverTimestamp()
    });
    if (initiatedBy === "automatic") {
      transaction.update(pendingRef, { reservationStatus: "CONSUMED" });
    }
    return { transactionId: order.transactionId, amountKobo };
  });

  let refund;
  try {
    const response = await fetch(
      `https://api.flutterwave.com/v3/transactions/${details.transactionId}/refund`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ amount: details.amountKobo / 100, comments: "Escrow dispute refund" }),
        signal: AbortSignal.timeout(15000)
      }
    );
    if (!response.ok) throw new Error(`Refund request returned HTTP ${response.status}.`);
    refund = await response.json();
  } catch (error) {
    logger.error("Escrow test refund requires reconciliation.", { orderId, error: error.message });
    throw new HttpsError("unavailable", "Refund status is uncertain. Contact an administrator; do not retry.");
  }
  const data = refund.data;
  const refundId = String(data?.id || "");
  const amountKobo = Number(data?.amount_refunded) * 100;
  if (refund.status !== "success" || !/^\d{1,32}$/.test(refundId) ||
      String(data?.tx_id || data?.transaction_id || "") !== details.transactionId ||
      !Number.isFinite(amountKobo) || Math.abs(amountKobo - details.amountKobo) > 0.00001) {
    logger.error("Escrow test refund response needs reconciliation.", { orderId });
    throw new HttpsError("unavailable", "Refund status is uncertain. Contact an administrator; do not retry.");
  }
  const status = await db.runTransaction(async transaction => {
    const [orderSnapshot, refundSnapshot] = await Promise.all([
      transaction.get(orderRef), transaction.get(refundRef)
    ]);
    if (!orderSnapshot.exists || !refundSnapshot.exists) {
      throw new HttpsError("failed-precondition", "The refund needs reconciliation.");
    }
    if (refundSnapshot.data().providerRefundId === refundId &&
        ((refundSnapshot.data().status === "PENDING" && orderSnapshot.data().status === "REFUND_PENDING") ||
         (refundSnapshot.data().status === "REFUNDED" && orderSnapshot.data().status === "REFUNDED"))) {
      return orderSnapshot.data().status;
    }
    if (
        orderSnapshot.data().status !== "REFUND_INITIATING" ||
        refundSnapshot.data().status !== "INITIATING") {
      throw new HttpsError("failed-precondition", "The refund needs reconciliation.");
    }
    transaction.update(refundRef, {
      status: "PENDING", providerRefundId: refundId,
      providerStatus: typeof data.status === "string" ? data.status : "unknown",
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.update(orderRef, { status: "REFUND_PENDING" });
    return "REFUND_PENDING";
  });
  return { status };
}

async function checkEscrowRefundStatus(orderId, secret, notifiedRefundId, verifiedBy) {
    if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) {
      throw new HttpsError("invalid-argument", "Choose a valid escrow order.");
    }
    const orderRef = db.collection("escrowOrders").doc(orderId);
    const refundRef = db.collection("escrowRefunds").doc(orderId);
    const refundSnapshot = await refundRef.get();
    if (!refundSnapshot.exists) throw new HttpsError("not-found", "Refund not found.");
    const refund = refundSnapshot.data();
    if (refund.status === "REFUNDED") {
      if (notifiedRefundId && notifiedRefundId !== refund.providerRefundId) {
        throw new HttpsError("failed-precondition", "The refund needs reconciliation.");
      }
      return { status: "REFUNDED" };
    }
    const refundId = refund.providerRefundId || notifiedRefundId;
    if (!["INITIATING", "PENDING"].includes(refund.status) ||
        !/^\d{1,32}$/.test(refundId || "") ||
        (notifiedRefundId && refund.providerRefundId && refund.providerRefundId !== notifiedRefundId)) {
      throw new HttpsError("failed-precondition", "The refund needs reconciliation.");
    }
    const response = await fetch(`https://api.flutterwave.com/v3/refunds/${refundId}`, {
      headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new HttpsError("unavailable", "Flutterwave could not check the refund.");
    const result = await response.json();
    const data = result.data || result;
    const returnedAmount = Number(data.amount_refunded) * 100;
    if (String(data.id) !== refundId ||
        String(data.transaction_id || data.tx_id || "") !== refund.transactionId ||
        !Number.isFinite(returnedAmount) || Math.abs(returnedAmount - refund.amountKobo) > 0.00001 ||
        typeof data.status !== "string") {
      throw new HttpsError("failed-precondition", "The refund needs reconciliation.");
    }
    const finalStatuses = ["completed-bank-transfer", "completed-momo", "completed-mpgs",
      "completed-offline", "completed-preauth"];
    const isFinal = finalStatuses.includes(data.status);
    const status = await db.runTransaction(async transaction => {
      const revenueRef = db.collection("escrowPlatformAccounting").doc("revenue");
      const [orderSnapshot, current, revenueSnapshot] = await Promise.all([
        transaction.get(orderRef), transaction.get(refundRef), transaction.get(revenueRef)
      ]);
      if (!orderSnapshot.exists || !current.exists ||
          !["INITIATING", "PENDING", "REFUNDED"].includes(current.data().status) ||
          current.data().transactionId !== refund.transactionId ||
          current.data().amountKobo !== refund.amountKobo ||
          (current.data().providerRefundId && current.data().providerRefundId !== refundId)) {
        throw new HttpsError("failed-precondition", "The refund needs reconciliation.");
      }
      if (current.data().status === "REFUNDED" && orderSnapshot.data().status === "REFUNDED") return "REFUNDED";
      if (!["REFUND_INITIATING", "REFUND_PENDING"].includes(orderSnapshot.data().status)) {
        throw new HttpsError("failed-precondition", "The refund needs reconciliation.");
      }
      if (isFinal && current.data().retainedKobo) {
        const retainedKobo = current.data().retainedKobo;
        const revenueKobo = escrowStoredBalance(revenueSnapshot, "retainedKobo") + retainedKobo;
        if (!Number.isSafeInteger(retainedKobo) || retainedKobo < 0 || !Number.isSafeInteger(revenueKobo)) {
          throw new HttpsError("failed-precondition", "The refund ledger needs reconciliation.");
        }
        transaction.set(revenueRef, { retainedKobo: revenueKobo, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      transaction.update(refundRef, {
        status: isFinal ? "REFUNDED" : "PENDING", providerRefundId: refundId,
        providerStatus: data.status, updatedAt: FieldValue.serverTimestamp(),
        ...(verifiedBy ? { verifiedBy } : {}),
        ...(isFinal ? { completedAt: FieldValue.serverTimestamp() } : {})
      });
      transaction.update(orderRef, isFinal
        ? { status: "REFUNDED", refundedAt: FieldValue.serverTimestamp() }
        : { status: "REFUND_PENDING" });
      return isFinal ? "REFUNDED" : "REFUND_PENDING";
    });
    return { status, providerStatus: data.status };
}

exports.checkEscrowRefund = onCall(
  { secrets: [FLW_SECRET_KEY] },
  async request => {
    const auth = requireVerifiedUser(request);
    if (!isOwnerAdmin(auth)) {
      throw new HttpsError("permission-denied", "Administrator access is required.");
    }
    const secret = escrowSandboxKey();
    return checkEscrowRefundStatus(request.data?.orderId, secret);
  }
);

exports.reconcileEscrowRefund = onCall(
  { secrets: [FLW_SECRET_KEY] },
  async request => {
    const auth = requireVerifiedUser(request);
    if (!isOwnerAdmin(auth)) {
      throw new HttpsError("permission-denied", "Administrator access is required.");
    }
    const secret = escrowSandboxKey();
    const orderId = request.data?.orderId;
    const refundId = request.data?.refundId;
    if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId) ||
        typeof refundId !== "string" || !/^\d{1,32}$/.test(refundId)) {
      throw new HttpsError("invalid-argument", "Provide a valid order and Flutterwave refund ID.");
    }
    const orderRef = db.collection("escrowOrders").doc(orderId);
    const refundRef = db.collection("escrowRefunds").doc(orderId);
    const snapshot = await refundRef.get();
    if (!snapshot.exists) throw new HttpsError("not-found", "Refund not found.");
    const refund = snapshot.data();
    if (refund.status !== "INITIATING") {
      throw new HttpsError("failed-precondition", "Only an uncertain refund can be reconciled here.");
    }
    const response = await fetch(`https://api.flutterwave.com/v3/refunds/${refundId}`, {
      headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new HttpsError("unavailable", "Flutterwave could not verify the refund.");
    const result = await response.json();
    const data = result.data || result;
    const amountKobo = Number(data.amount_refunded) * 100;
    if (String(data.id) !== refundId ||
        String(data.transaction_id || data.tx_id || "") !== refund.transactionId ||
        !Number.isFinite(amountKobo) || Math.abs(amountKobo - refund.amountKobo) > 0.00001 ||
        typeof data.status !== "string") {
      throw new HttpsError("failed-precondition", "The refund does not match the reserved payment.");
    }
    await db.runTransaction(async transaction => {
      const [current, order] = await Promise.all([transaction.get(refundRef), transaction.get(orderRef)]);
      if (!current.exists || current.data().status !== "INITIATING" ||
          current.data().transactionId !== refund.transactionId ||
          !order.exists || order.data().status !== "REFUND_INITIATING") {
        throw new HttpsError("failed-precondition", "The refund changed. Review it again.");
      }
      transaction.update(refundRef, {
        status: "PENDING", providerRefundId: refundId, providerStatus: data.status,
        reconciledBy: auth.uid, updatedAt: FieldValue.serverTimestamp()
      });
      transaction.update(orderRef, { status: "REFUND_PENDING" });
    });
    return { status: "REFUND_PENDING" };
  }
);

exports.markOrderShipped = onCall(request => updateEscrowOrder(request, "ship"));
exports.confirmDeliveryAndRelease = onCall(request => updateEscrowOrder(request, "confirm"));
exports.openEscrowDispute = onCall(request => updateEscrowOrder(request, "dispute"));
exports.resolveEscrowDispute = onCall(
  { secrets: [FLW_SECRET_KEY] },
  request => request.data?.decision === "refund"
    ? initiateEscrowRefund(request)
    : updateEscrowOrder(request, "resolve")
);

exports.getOrCreateGoldenChat = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const otherUid = request.data?.otherUid;
  const productId = request.data?.productId || "";
  if (typeof otherUid !== "string" || otherUid === auth.uid ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(otherUid) ||
      (productId && (typeof productId !== "string" ||
        !/^[A-Za-z0-9_-]{1,160}$/.test(productId)))) {
    throw new HttpsError("invalid-argument", "Choose a valid marketplace member and listing.");
  }

  const [myProfileSnapshot, otherProfileSnapshot] = await Promise.all([
    db.collection("users").doc(auth.uid).get(),
    db.collection("users").doc(otherUid).get()
  ]);
  if (!myProfileSnapshot.exists || !otherProfileSnapshot.exists) {
    throw new HttpsError("not-found", "One of these marketplace profiles could not be found.");
  }
  const myProfile = myProfileSnapshot.data();
  const otherProfile = otherProfileSnapshot.data();
  if (!profileIsChatReady(auth.uid, myProfile) || !profileIsChatReady(otherUid, otherProfile)) {
    throw new HttpsError("failed-precondition", "Both members must complete their profiles before starting Golden Chat.");
  }
  if (![myProfile.role, otherProfile.role].every(role => ["Buyer", "Vendor"].includes(role))) {
    throw new HttpsError("failed-precondition", "Only Buyers and Vendors can use Golden Chat.");
  }
  if (productId && myProfile.role === otherProfile.role) {
    throw new HttpsError("failed-precondition", "Product-linked chats require a Buyer and a Vendor. Start a general chat from the member profile instead.");
  }

  const vendorUid = myProfile.role === "Vendor" ? auth.uid : otherUid;
  let product = null;
  if (productId) {
    const productSnapshot = await db.collection("products").doc(productId).get();
    if (!productSnapshot.exists || productSnapshot.data().ownerUid !== vendorUid) {
      throw new HttpsError("not-found", "This Vendor listing could not be found.");
    }
    const productData = productSnapshot.data();
    product = {
      id: productId,
      title: typeof productData.title === "string" ? productData.title.slice(0, 160) : "Marketplace listing",
      stock: Number.isInteger(productData.stock) ? Math.max(0, productData.stock) : 0,
      price: Number.isFinite(productData.price) ? productData.price : 0,
      vendorUid
    };
  }

  const participantIds = [auth.uid, otherUid].sort();
  const chatKey = `${participantIds.join(":")}:${productId || "general"}`;
  const chatId = `chat_${crypto.createHash("sha256").update(chatKey).digest("hex").slice(0, 40)}`;
  const chatRef = db.collection("goldenChats").doc(chatId);
  const walletRef = accountWalletRef(auth.uid);
  const memberName = profile => typeof profile.name === "string" &&
    profile.name.trim() &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.name.trim())
    ? profile.name.trim().slice(0, 120)
    : "Marketplace member";
  const participants = {
    [auth.uid]: {
      name: memberName(myProfile),
      role: myProfile.role
    },
    [otherUid]: {
      name: memberName(otherProfile),
      role: otherProfile.role
    }
  };
  let created = false;
  await db.runTransaction(async transaction => {
    const chatSnapshot = await transaction.get(chatRef);
    if (chatSnapshot.exists) {
      if (!chatSnapshot.data().participantIds?.includes(auth.uid)) {
        throw new HttpsError("permission-denied", "You cannot access this conversation.");
      }
      return;
    }
    const walletSnapshot = await transaction.get(walletRef);
    if (normalizedWallet(walletSnapshot.data()).coins < 1) {
      throw new HttpsError(
        "failed-precondition",
        "You need at least 1 available Golden Chat coin to start a new conversation. Starting is free; sent messages still use coins."
      );
    }
    transaction.create(chatRef, {
      participantIds,
      participants,
      unreadCounts: {
        [participantIds[0]]: 0,
        [participantIds[1]]: 0
      },
      product,
      productId: productId || null,
      lastMessage: product ? `Product enquiry: ${product.title}` : "Conversation started",
      lastMessageType: "system",
      lastMessageAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      createdBy: auth.uid
    });
    created = true;
  });
  return { chatId, created, product, other: participants[otherUid] };
});

exports.publishMarketplaceProduct = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const profileRef = db.collection("users").doc(auth.uid);
  const data = request.data?.product;
  const suppliedFields = [
    "id", "title", "category", "price", "stock", "imageUrl", "imageUrls", "videoUrl",
    "shortDesc", "fullDesc", "vendorName", "vendorLocation", "vendorContact", "rating", "createdAt"
  ];
  if (!data || typeof data !== "object" ||
      Object.keys(data).some(key => !suppliedFields.includes(key))) {
    throw new HttpsError("invalid-argument", "Submit a valid product listing.");
  }
  const productId = data.id;
  if (typeof productId !== "string" || !/^prod-[A-Za-z0-9_-]{1,160}$/.test(productId)) {
    throw new HttpsError("invalid-argument", "The product ID is invalid.");
  }
  const phoneFields = [
    "title", "shortDesc", "fullDesc", "vendorName", "vendorLocation", "vendorContact"
  ];
  try {
    assertNoPhoneNumbers(data, phoneFields);
  } catch (error) {
    if (!(error instanceof HttpsError)) throw error;
    const violation = await recordPostingViolation(auth, "product-listing", productId);
    throw new HttpsError(
      "permission-denied",
      `Contact details are prohibited. Warning ${violation.warningCount}: posting is restricted for one week.`
    );
  }
  await assertCanPublish(auth);
  const profileSnapshot = await profileRef.get();
  if (!profileSnapshot.exists || profileSnapshot.data().role !== "Vendor") {
    throw new HttpsError("permission-denied", "Only approved Vendors can publish products.");
  }
  if (typeof data.title !== "string" || !data.title.trim() || data.title.length > 160 ||
      typeof data.category !== "string" || !data.category.trim() || data.category.length > 120 ||
      typeof data.price !== "number" || !Number.isFinite(data.price) || data.price <= 0 ||
      !Number.isSafeInteger(data.stock) || data.stock < 0 ||
      typeof data.shortDesc !== "string" || data.shortDesc.length > 500 ||
      typeof data.fullDesc !== "string" || data.fullDesc.length > 3000 ||
      typeof data.vendorName !== "string" || data.vendorName.length > 120 ||
      typeof data.vendorLocation !== "string" || data.vendorLocation.length > 200 ||
      typeof data.vendorContact !== "string" || data.vendorContact.length > 80 ||
      typeof data.rating !== "number" || !Number.isFinite(data.rating) ||
      typeof data.createdAt !== "string" ||
      typeof data.imageUrl !== "string" ||
      !Array.isArray(data.imageUrls) ||
      data.imageUrls.length > 20 ||
      data.imageUrls.some(url => typeof url !== "string" || url.length > 2048) ||
      typeof data.videoUrl !== "string" || data.videoUrl.length > 2048 ||
      (!data.imageUrl && data.imageUrls.length === 0 && !data.videoUrl)) {
    throw new HttpsError("invalid-argument", "Complete every required product field.");
  }
  const productRef = db.collection("products").doc(productId);
  await productRef.create({
    ...data,
    vendorName: profileSnapshot.data().name || data.vendorName,
    vendorContact: "In-app chat only",
    ownerUid: auth.uid
  });
  return { productId, published: true };
});

exports.deleteOwnedMarketplaceContent = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const { kind, itemId } = request.data || {};
  if (!["product", "communityPost"].includes(kind) ||
      typeof itemId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(itemId)) {
    throw new HttpsError("invalid-argument", "Choose valid content to delete.");
  }
  const parentRef = kind === "product"
    ? db.collection("products").doc(itemId)
    : db.collection("communityPosts").doc(itemId);
  const snapshot = await parentRef.get();
  if (!snapshot.exists || snapshot.data().ownerUid !== auth.uid) {
    throw new HttpsError("permission-denied", "You can only delete your own content.");
  }
  await parentRef.delete();
  if (kind === "product") {
    await Promise.all([
      db.recursiveDelete(db.collection("productDiscussions").doc(itemId)),
      db.collection("productDiscussionStats").doc(itemId).delete()
    ]);
    const bucket = getStorage().bucket();
    const [files] = await bucket.getFiles({ prefix: `products/${auth.uid}/${itemId}/` });
    await Promise.all(files.map(file => file.delete({ ignoreNotFound: true })));
  } else {
    await db.recursiveDelete(parentRef);
    await db.collection("communityPostStats").doc(itemId).delete();
  }
  await db.collection("adminSecurityAudit").doc().create({
    action: `delete-${kind}`,
    actorUid: auth.uid,
    targetUid: auth.uid,
    itemId,
    createdAt: FieldValue.serverTimestamp()
  });
  return { deleted: true, kind, itemId };
});

exports.boostProductListing = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const { productId, operationId } = request.data || {};
  if (typeof productId !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(productId) ||
      typeof operationId !== "string" ||
      !/^[A-Za-z0-9_-]{20}$/.test(operationId)) {
    throw new HttpsError("invalid-argument", "Choose a valid product to boost.");
  }

  const profileRef = db.collection("users").doc(auth.uid);
  const productRef = db.collection("products").doc(productId);
  const walletRef = accountWalletRef(auth.uid);
  const purchaseRef = profileRef.collection("productBoostPurchases").doc(operationId);
  let boostedUntilMs = 0;
  let coinsRemaining = 0;
  let duplicate = false;

  await db.runTransaction(async transaction => {
    const [profileSnapshot, productSnapshot, walletSnapshot, purchaseSnapshot] = await Promise.all([
      transaction.get(profileRef),
      transaction.get(productRef),
      transaction.get(walletRef),
      transaction.get(purchaseRef)
    ]);
    if (!profileSnapshot.exists || profileSnapshot.data().role !== "Vendor") {
      throw new HttpsError("permission-denied", "Only Vendors can boost product listings.");
    }
    if (!productSnapshot.exists) {
      throw new HttpsError("not-found", "This product listing could not be found.");
    }
    const product = productSnapshot.data();
    if (product.ownerUid !== auth.uid) {
      throw new HttpsError("permission-denied", "You can only boost your own product listings.");
    }

    const wallet = normalizedWallet(walletSnapshot.data());
    coinsRemaining = wallet.coins;
    if (purchaseSnapshot.exists) {
      const purchase = purchaseSnapshot.data();
      if (purchase.productId !== productId || purchase.uid !== auth.uid) {
        throw new HttpsError("already-exists", "This boost request ID was already used.");
      }
      boostedUntilMs = typeof product.boostedUntil?.toMillis === "function"
        ? product.boostedUntil.toMillis()
        : product.boostedUntil instanceof Date
          ? product.boostedUntil.getTime()
          : 0;
      if (!Number.isSafeInteger(boostedUntilMs) || boostedUntilMs <= 0) {
        throw new HttpsError("failed-precondition", "The product boost expiry could not be verified.");
      }
      duplicate = true;
      return;
    }
    if (wallet.coins < PRODUCT_BOOST_COST) {
      throw new HttpsError(
        "failed-precondition",
        `Boosting a listing costs ${PRODUCT_BOOST_COST} coins. Add coins to your Golden Chat wallet and try again.`
      );
    }

    const currentBoostUntilMs = typeof product.boostedUntil?.toMillis === "function"
      ? product.boostedUntil.toMillis()
      : product.boostedUntil instanceof Date
        ? product.boostedUntil.getTime()
        : 0;
    boostedUntilMs = Math.max(Date.now(), currentBoostUntilMs) + PRODUCT_BOOST_DURATION_MS;
    coinsRemaining = wallet.coins - PRODUCT_BOOST_COST;
    const boostedUntil = new Date(boostedUntilMs);
    transaction.update(productRef, { boostedUntil });
    transaction.set(walletRef, {
      ...wallet,
      coins: coinsRemaining,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.create(purchaseRef, {
      uid: auth.uid,
      productId,
      cost: PRODUCT_BOOST_COST,
      boostedUntil,
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return {
    boosted: true,
    duplicate,
    productId,
    boostedUntilMs,
    coinsRemaining,
    cost: PRODUCT_BOOST_COST
  };
});

exports.sendStockAlertToFollowers = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const { productId, operationId } = request.data || {};
  if (typeof productId !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(productId) ||
      typeof operationId !== "string" ||
      !/^[A-Za-z0-9_-]{20}$/.test(operationId)) {
    throw new HttpsError("invalid-argument", "Choose a valid product for the stock alert.");
  }

  const profileRef = db.collection("users").doc(auth.uid);
  const productRef = db.collection("products").doc(productId);
  const walletRef = accountWalletRef(auth.uid);
  const broadcastRef = profileRef.collection("stockAlertBroadcasts").doc(operationId);
  const followersQuery = profileRef.collection("followers").limit(1);
  let duplicate = false;
  let coinsRemaining = 0;

  await db.runTransaction(async transaction => {
    const [profileSnapshot, productSnapshot, walletSnapshot, broadcastSnapshot, followersSnapshot] =
      await Promise.all([
        transaction.get(profileRef),
        transaction.get(productRef),
        transaction.get(walletRef),
        transaction.get(broadcastRef),
        transaction.get(followersQuery)
      ]);

    if (!profileSnapshot.exists || profileSnapshot.data().role !== "Vendor") {
      throw new HttpsError("permission-denied", "Only Vendors can send stock alerts.");
    }
    const profile = profileSnapshot.data();
    if (typeof profile.name !== "string" || !profile.name.trim()) {
      throw new HttpsError("failed-precondition", "Complete your Vendor profile before sending a stock alert.");
    }

    const wallet = normalizedWallet(walletSnapshot.data());
    coinsRemaining = wallet.coins;
    if (broadcastSnapshot.exists) {
      const previousBroadcast = broadcastSnapshot.data();
      if (previousBroadcast.productId !== productId || previousBroadcast.uid !== auth.uid) {
        throw new HttpsError("already-exists", "This stock alert request ID was already used.");
      }
      duplicate = true;
      return;
    }

    if (!productSnapshot.exists) {
      throw new HttpsError("not-found", "This product listing could not be found.");
    }
    const product = productSnapshot.data();
    if (product.ownerUid !== auth.uid) {
      throw new HttpsError("permission-denied", "You can only send stock alerts for your own listings.");
    }
    if (!Number.isSafeInteger(product.stock) || product.stock <= 0) {
      throw new HttpsError("failed-precondition", "Add available stock before sending a stock alert.");
    }
    if (followersSnapshot.empty) {
      throw new HttpsError("failed-precondition", "You need at least one follower to send a stock alert.");
    }
    if (wallet.coins < STOCK_ALERT_COST) {
      throw new HttpsError(
        "failed-precondition",
        `Sending a stock alert costs ${STOCK_ALERT_COST} Golden Chat coins. Add coins to your wallet and try again.`
      );
    }

    coinsRemaining = wallet.coins - STOCK_ALERT_COST;
    transaction.set(walletRef, {
      ...wallet,
      coins: coinsRemaining,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.create(broadcastRef, {
      uid: auth.uid,
      productId,
      productTitle: typeof product.title === "string" ? product.title.trim().slice(0, 160) : "Marketplace listing",
      vendorName: profile.name.trim().slice(0, 120),
      stock: product.stock,
      cost: STOCK_ALERT_COST,
      status: "pending",
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return {
    sent: true,
    queued: !duplicate,
    duplicate,
    productId,
    coinsRemaining,
    cost: STOCK_ALERT_COST
  };
});

exports.deliverStockAlertNotifications = onDocumentCreated(
  {
    document: "users/{vendorUid}/stockAlertBroadcasts/{broadcastId}",
    memory: "1GiB",
    timeoutSeconds: 540,
    retry: true
  },
  async event => {
    const broadcastSnapshot = event.data;
    if (!broadcastSnapshot?.exists) return;
    const broadcast = broadcastSnapshot.data();
    const { vendorUid, broadcastId } = event.params;
    if (broadcast.status !== "pending" ||
        broadcast.uid !== vendorUid ||
        typeof broadcast.productId !== "string" ||
        typeof broadcast.productTitle !== "string" ||
        typeof broadcast.vendorName !== "string" ||
        !Number.isSafeInteger(broadcast.stock) ||
        broadcast.stock <= 0) {
      logger.error("Stock alert broadcast data is invalid.", { vendorUid, broadcastId });
      throw new Error("Stock alert broadcast data is invalid.");
    }

    const followersRef = db.collection("users").doc(vendorUid).collection("followers");
    const notificationId = crypto.createHash("sha256")
      .update(`${vendorUid}:${broadcastId}`)
      .digest("hex");
    let cursor = null;
    let recipientCount = 0;
    while (true) {
      let followersQuery = followersRef
        .orderBy(FieldPath.documentId())
        .limit(STOCK_ALERT_PAGE_SIZE);
      if (cursor) followersQuery = followersQuery.startAfter(cursor);
      const followersSnapshot = await followersQuery.get();
      if (followersSnapshot.empty) break;

      const batch = db.batch();
      let pageRecipientCount = 0;
      for (const followerSnapshot of followersSnapshot.docs) {
        if (followerSnapshot.id === vendorUid) continue;
        const notificationRef = db.collection("users")
          .doc(followerSnapshot.id)
          .collection("notifications")
          .doc(notificationId);
        batch.set(notificationRef, {
          type: "stock_alert",
          title: "In-stock alert",
          message: `${broadcast.vendorName} has ${broadcast.productTitle} in stock (${broadcast.stock} available).`,
          vendorUid,
          vendorName: broadcast.vendorName,
          productId: broadcast.productId,
          productTitle: broadcast.productTitle,
          stock: broadcast.stock,
          createdAt: broadcast.createdAt
        }, { merge: true });
        recipientCount += 1;
        pageRecipientCount += 1;
      }
      if (pageRecipientCount > 0) await batch.commit();
      cursor = followersSnapshot.docs[followersSnapshot.docs.length - 1];
      if (followersSnapshot.size < STOCK_ALERT_PAGE_SIZE) break;
    }

    await broadcastSnapshot.ref.update({
      status: "sent",
      recipientCount,
      deliveredAt: FieldValue.serverTimestamp()
    });
  }
);

exports.listVendorApplications = onCall(async request => {
  requireEscrowAdmin(request);
  const snapshot = await db.collection("vendorApplications")
    .where("status", "==", "pending")
    .limit(50)
    .get();
  return {
    items: snapshot.docs.map(document => ({
      uid: document.id,
      name: document.data().name,
      status: document.data().status
    }))
  };
});

exports.listRestrictedAccounts = onCall(async request => {
  requireEscrowAdmin(request);
  const snapshot = await db.collection("accountSanctions")
    .where("ownerReviewRequired", "==", true)
    .limit(50)
    .get();
  return {
    items: snapshot.docs.map(document => ({
      uid: document.id,
      warningCount: document.data().warningCount || 0,
      restrictedUntilMs: timestampMillis(document.data().restrictedUntil),
      permanent: document.data().permanent === true
    }))
  };
});

exports.adminConfirmPermanentRestriction = onCall(async request => {
  const auth = requireEscrowAdmin(request);
  const uid = request.data?.uid;
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid) ||
      uid === OWNER_ADMIN_UID || uid === PERMANENT_VERIFIED_DEALER_UID) {
    throw new HttpsError("invalid-argument", "Choose a valid restricted account.");
  }
  const sanctionRef = db.collection("accountSanctions").doc(uid);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(sanctionRef);
    if (!snapshot.exists || snapshot.data().ownerReviewRequired !== true ||
        snapshot.data().warningCount < 3) {
      throw new HttpsError(
        "failed-precondition",
        "The account must have three recorded warnings before permanent restriction."
      );
    }
    transaction.set(sanctionRef, {
      permanent: true,
      permanentAt: FieldValue.serverTimestamp(),
      reviewedBy: auth.uid
    }, { merge: true });
    transaction.create(db.collection("adminSecurityAudit").doc(), {
      action: "permanent-account-restriction-approved",
      actorUid: auth.uid,
      targetUid: uid,
      warningCount: snapshot.data().warningCount,
      createdAt: FieldValue.serverTimestamp()
    });
  });
  await getAuth().updateUser(uid, { disabled: true });
  return { uid, restricted: true };
});

exports.adminSetVendorApproval = onCall(async request => {
  const auth = requireEscrowAdmin(request);
  const { uid, approved } = request.data || {};
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid) ||
      typeof approved !== "boolean") {
    throw new HttpsError("invalid-argument", "Choose a valid vendor application.");
  }
  const profileRef = db.collection("users").doc(uid);
  const applicationRef = db.collection("vendorApplications").doc(uid);
  await db.runTransaction(async transaction => {
    const [profileSnapshot, applicationSnapshot] = await Promise.all([
      transaction.get(profileRef),
      transaction.get(applicationRef)
    ]);
    if (!profileSnapshot.exists || !applicationSnapshot.exists) {
      throw new HttpsError("not-found", "This vendor application could not be found.");
    }
    if (uid === PERMANENT_VERIFIED_DEALER_UID && approved !== true) {
      throw new HttpsError(
        "failed-precondition",
        "The permanent verified account cannot be removed from the Vendor role."
      );
    }
    transaction.set(profileRef, {
      role: approved ? "Vendor" : "Buyer",
      ...(approved ? {} : {
        verifiedDealerUntil: FieldValue.delete(),
        verifiedDealerAutoRenew: FieldValue.delete(),
        verifiedDealerRenewalDueAt: FieldValue.delete(),
        verifiedDealerAutoRenewPaused: FieldValue.delete()
      })
    }, { merge: true });
    transaction.set(applicationRef, {
      status: approved ? "approved" : "rejected",
      reviewedBy: auth.uid,
      reviewedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (!approved) transaction.delete(db.collection("verifiedDealers").doc(uid));
    transaction.create(db.collection("adminSecurityAudit").doc(), {
      action: approved ? "approve-vendor" : "reject-vendor",
      targetUid: uid,
      actorUid: auth.uid,
      createdAt: FieldValue.serverTimestamp()
    });
  });
  return { uid, approved };
});

exports.adminSetVerifiedDealerBadge = onCall(async request => {
  const auth = requireEscrowAdmin(request);
  const { uid, enabled } = request.data || {};
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid) ||
      typeof enabled !== "boolean") {
    throw new HttpsError("invalid-argument", "Choose a valid verified dealer request.");
  }
  const profileRef = db.collection("users").doc(uid);
  const publicBadgeRef = db.collection("verifiedDealers").doc(uid);
  let verifiedUntilMs = null;
  if (uid === PERMANENT_VERIFIED_DEALER_UID) {
    const userRecord = await getAuth().getUser(uid);
    if (!enabled || userRecord.email?.toLowerCase() !== PERMANENT_VERIFIED_DEALER_EMAIL) {
      throw new HttpsError(
        "permission-denied",
        "This permanent verification marker is bound to the exact approved account and cannot be revoked."
      );
    }
  }
  await db.runTransaction(async transaction => {
    const profileSnapshot = await transaction.get(profileRef);
    if (!profileSnapshot.exists || profileSnapshot.data().role !== "Vendor") {
      throw new HttpsError("failed-precondition", "Approve this account as a Vendor first.");
    }
    if (uid === PERMANENT_VERIFIED_DEALER_UID) {
      verifiedUntilMs = null;
      transaction.set(profileRef, {
        permanentVerifiedDealer: true,
        verifiedDealerAutoRenew: false,
        verifiedDealerRenewalDueAt: FieldValue.delete(),
        verifiedDealerAutoRenewPaused: false
      }, { merge: true });
      transaction.set(publicBadgeRef, {
        permanent: true,
        approvedBy: auth.uid,
        boundEmail: PERMANENT_VERIFIED_DEALER_EMAIL,
        updatedAt: FieldValue.serverTimestamp()
      });
    } else if (enabled) {
      const verifiedUntil = addOneUtcCalendarMonth(new Date());
      verifiedUntilMs = verifiedUntil.getTime();
      transaction.set(profileRef, {
        verifiedDealerUntil: verifiedUntil,
        verifiedDealerAutoRenew: false,
        verifiedDealerRenewalDueAt: FieldValue.delete(),
        verifiedDealerAutoRenewPaused: false
      }, { merge: true });
      transaction.set(publicBadgeRef, {
        verifiedUntil,
        approvedBy: auth.uid,
        updatedAt: FieldValue.serverTimestamp()
      });
    } else {
      transaction.set(profileRef, {
        verifiedDealerUntil: FieldValue.delete(),
        verifiedDealerAutoRenew: FieldValue.delete(),
        verifiedDealerRenewalDueAt: FieldValue.delete(),
        verifiedDealerAutoRenewPaused: FieldValue.delete()
      }, { merge: true });
      transaction.delete(publicBadgeRef);
    }
    transaction.create(db.collection("adminSecurityAudit").doc(), {
      action: enabled ? "grant-dealer-badge" : "revoke-dealer-badge",
      targetUid: uid,
      actorUid: auth.uid,
      createdAt: FieldValue.serverTimestamp()
    });
  });
  return { uid, enabled, verifiedUntilMs };
});

exports.purchaseVerifiedDealerBadge = onCall(async request => {
  requireVerifiedUser(request);
  throw new HttpsError(
    "permission-denied",
    "Dealer verification badges are granted only after owner review. Contact support."
  );
  const auth = requireVerifiedUser(request);
  const profileRef = db.collection("users").doc(auth.uid);
  const walletRef = accountWalletRef(auth.uid);
  const publicBadgeRef = db.collection("verifiedDealers").doc(auth.uid);
  const now = Date.now();
  let verifiedUntilMs = 0;
  let coinsRemaining = 0;
  let alreadyActive = false;

  await db.runTransaction(async transaction => {
    const [profileSnapshot, walletSnapshot, publicBadgeSnapshot] = await Promise.all([
      transaction.get(profileRef),
      transaction.get(walletRef),
      transaction.get(publicBadgeRef)
    ]);
    if (!profileSnapshot.exists || profileSnapshot.data().role !== "Vendor") {
      throw new HttpsError("permission-denied", "Only Vendors can purchase a Verified Dealer Badge.");
    }

    const profile = profileSnapshot.data();
    const wallet = normalizedWallet(walletSnapshot.data());
    const currentBadgeExpiryMs = timestampMillis(profile.verifiedDealerUntil);
    coinsRemaining = wallet.coins;
    if (currentBadgeExpiryMs > now) {
      const publicBadge = publicBadgeSnapshot.data();
      const publicBadgeExpiryMs = timestampMillis(publicBadge?.verifiedUntil);
      verifiedUntilMs = currentBadgeExpiryMs;
      alreadyActive = true;
      if (!publicBadgeSnapshot.exists || publicBadgeExpiryMs !== currentBadgeExpiryMs) {
        transaction.set(publicBadgeRef, {
          verifiedUntil: new Date(currentBadgeExpiryMs),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
      if (profile.verifiedDealerAutoRenew === true
        && timestampMillis(profile.verifiedDealerRenewalDueAt) !== currentBadgeExpiryMs) {
        transaction.set(profileRef, {
          verifiedDealerRenewalDueAt: new Date(currentBadgeExpiryMs)
        }, { merge: true });
      }
      return;
    }
    if (wallet.coins < VERIFIED_DEALER_BADGE_COST) {
      throw new HttpsError(
        "failed-precondition",
        `You don’t have enough Golden Chat coins. The badge costs ${VERIFIED_DEALER_BADGE_COST} coins per calendar month. Buy Golden Coins and try again.`
      );
    }

    const verifiedUntil = addOneUtcCalendarMonth(new Date(now));
    verifiedUntilMs = verifiedUntil.getTime();
    coinsRemaining = wallet.coins - VERIFIED_DEALER_BADGE_COST;
    transaction.set(profileRef, {
      verifiedDealerUntil: verifiedUntil,
      verifiedDealerRenewalDueAt: profile.verifiedDealerAutoRenew === true
        ? verifiedUntil
        : FieldValue.delete(),
      verifiedDealerAutoRenewPaused: false
    }, { merge: true });
    transaction.set(publicBadgeRef, {
      verifiedUntil,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(walletRef, {
      ...wallet,
      coins: coinsRemaining,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return {
    purchased: !alreadyActive,
    alreadyActive,
    verifiedUntilMs,
    coinsRemaining,
    cost: alreadyActive ? 0 : VERIFIED_DEALER_BADGE_COST
  };
});

exports.setVerifiedDealerAutoRenew = onCall(async request => {
  requireVerifiedUser(request);
  throw new HttpsError(
    "permission-denied",
    "Dealer verification is managed by the owner and is not automatically renewed."
  );
  const auth = requireVerifiedUser(request);
  const enabled = request.data?.enabled;
  if (typeof enabled !== "boolean") {
    throw new HttpsError("invalid-argument", "Choose whether automatic badge renewal is enabled.");
  }

  const profileRef = db.collection("users").doc(auth.uid);
  const walletRef = accountWalletRef(auth.uid);
  const publicBadgeRef = db.collection("verifiedDealers").doc(auth.uid);
  let renewed = false;
  let verifiedUntilMs = 0;
  let coinsRemaining = null;
  await db.runTransaction(async transaction => {
    renewed = false;
    verifiedUntilMs = 0;
    coinsRemaining = null;
    const profileSnapshot = await transaction.get(profileRef);
    if (!profileSnapshot.exists || profileSnapshot.data().role !== "Vendor") {
      throw new HttpsError("permission-denied", "Only Vendors can change badge renewal settings.");
    }

    const profile = profileSnapshot.data();
    const badgeExpiryMs = timestampMillis(profile.verifiedDealerUntil);
    const badgeIsExpired = badgeExpiryMs <= Date.now();
    if (enabled && badgeIsExpired && profile.verifiedDealerAutoRenewPaused !== true) {
      throw new HttpsError(
        "failed-precondition",
        "Purchase or renew your Verified Dealer Badge before enabling automatic renewal."
      );
    }

    if (enabled && badgeIsExpired) {
      const renewalRef = profileRef.collection("verifiedDealerRenewals")
        .doc(`${badgeExpiryMs}-reenable`);
      const [walletSnapshot, renewalSnapshot] = await Promise.all([
        transaction.get(walletRef),
        transaction.get(renewalRef)
      ]);
      if (renewalSnapshot.exists) {
        throw new HttpsError("failed-precondition", "This badge renewal has already been processed.");
      }

      const wallet = normalizedWallet(walletSnapshot.data());
      if (wallet.coins < VERIFIED_DEALER_BADGE_COST) {
        throw new HttpsError(
          "failed-precondition",
          `Add at least ${VERIFIED_DEALER_BADGE_COST} coins before re-enabling automatic renewal.`
        );
      }

      const now = Date.now();
      const verifiedUntil = addOneUtcCalendarMonth(new Date(now));
      verifiedUntilMs = verifiedUntil.getTime();
      coinsRemaining = wallet.coins - VERIFIED_DEALER_BADGE_COST;
      renewed = true;
      transaction.set(profileRef, {
        verifiedDealerUntil: verifiedUntil,
        verifiedDealerAutoRenew: true,
        verifiedDealerRenewalDueAt: verifiedUntil,
        verifiedDealerAutoRenewPaused: false
      }, { merge: true });
      transaction.set(publicBadgeRef, {
        verifiedUntil,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(walletRef, {
        ...wallet,
        coins: coinsRemaining,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.create(renewalRef, {
        status: "renewed-after-pause",
        cost: VERIFIED_DEALER_BADGE_COST,
        badgeExpiredAt: new Date(badgeExpiryMs),
        verifiedUntil,
        processedAt: FieldValue.serverTimestamp()
      });
      return;
    }

    verifiedUntilMs = badgeExpiryMs;
    transaction.set(profileRef, {
      verifiedDealerAutoRenew: enabled,
      verifiedDealerRenewalDueAt: enabled
        ? new Date(badgeExpiryMs)
        : FieldValue.delete(),
      verifiedDealerAutoRenewPaused: false
    }, { merge: true });
  });

  return { enabled, renewed, verifiedUntilMs, coinsRemaining };
});

exports.processVerifiedDealerBadgeRenewals = onSchedule("every 10 minutes", async () => {
  return { renewed: 0, pausedForInsufficientCoins: 0, skipped: 0 };
  const nowMs = Date.now();
  const query = db.collection("users")
    .where("verifiedDealerRenewalDueAt", "<=", new Date(nowMs))
    .orderBy("verifiedDealerRenewalDueAt")
    .orderBy(FieldPath.documentId())
    .limit(100);
  let cursor = null;
  let renewed = 0;
  let pausedForInsufficientCoins = 0;
  let skipped = 0;

  while (true) {
    let pageQuery = query;
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    const page = await pageQuery.get();
    if (page.empty) break;

    const outcomes = await Promise.all(page.docs.map(async profileDocument => {
      const profileRef = profileDocument.ref;
      const uid = profileDocument.id;
      const initialExpiryMs = timestampMillis(profileDocument.data().verifiedDealerRenewalDueAt);
      if (initialExpiryMs <= 0 || initialExpiryMs > nowMs) return "skipped";

      const walletRef = accountWalletRef(uid);
      const publicBadgeRef = db.collection("verifiedDealers").doc(uid);
      const renewalRef = profileRef.collection("verifiedDealerRenewals").doc(String(initialExpiryMs));
      let outcome = "skipped";

      await db.runTransaction(async transaction => {
        outcome = "skipped";
        const [profileSnapshot, walletSnapshot, renewalSnapshot] = await Promise.all([
          transaction.get(profileRef),
          transaction.get(walletRef),
          transaction.get(renewalRef)
        ]);
        if (!profileSnapshot.exists || renewalSnapshot.exists) return;

        const profile = profileSnapshot.data();
        const dueAtMs = timestampMillis(profile.verifiedDealerUntil);
        const renewalDueMs = timestampMillis(profile.verifiedDealerRenewalDueAt);
        const processedAt = Date.now();
        if (profile.role !== "Vendor"
          || profile.verifiedDealerAutoRenew !== true
          || dueAtMs <= 0
          || renewalDueMs !== dueAtMs
          || dueAtMs > processedAt) {
          return;
        }

        const wallet = normalizedWallet(walletSnapshot.data());
        if (wallet.coins < VERIFIED_DEALER_BADGE_COST) {
          transaction.set(profileRef, {
            verifiedDealerAutoRenew: false,
            verifiedDealerRenewalDueAt: FieldValue.delete(),
            verifiedDealerAutoRenewPaused: true
          }, { merge: true });
          transaction.create(renewalRef, {
            status: "insufficient-coins",
            requiredCoins: VERIFIED_DEALER_BADGE_COST,
            availableCoins: wallet.coins,
            badgeExpiredAt: new Date(dueAtMs),
            processedAt: FieldValue.serverTimestamp()
          });
          outcome = "paused";
          return;
        }

        const verifiedUntil = addOneUtcCalendarMonth(new Date(processedAt));
        const coinsRemaining = wallet.coins - VERIFIED_DEALER_BADGE_COST;
        transaction.set(profileRef, {
          verifiedDealerUntil: verifiedUntil,
          verifiedDealerRenewalDueAt: verifiedUntil,
          verifiedDealerAutoRenewPaused: false
        }, { merge: true });
        transaction.set(publicBadgeRef, {
          verifiedUntil,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(walletRef, {
          ...wallet,
          coins: coinsRemaining,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.create(renewalRef, {
          status: "renewed",
          cost: VERIFIED_DEALER_BADGE_COST,
          badgeExpiredAt: new Date(dueAtMs),
          verifiedUntil,
          processedAt: FieldValue.serverTimestamp()
        });
        outcome = "renewed";
      });

      return outcome;
    }));

    for (const outcome of outcomes) {
      if (outcome === "renewed") renewed += 1;
      else if (outcome === "paused") pausedForInsufficientCoins += 1;
      else skipped += 1;
    }
    cursor = page.docs[page.docs.length - 1];
    if (page.size < 100) break;
  }

  logger.info("Processed Verified Dealer Badge renewals.", {
    renewed,
    pausedForInsufficientCoins,
    skipped
  });
});

function goldenChatMediaReservationRef(chatId, messageId) {
  return db.collection("goldenChatMediaReservations")
    .doc(chatId)
    .collection("messages")
    .doc(messageId);
}

exports.reserveGoldenChatMedia = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const { chatId, messageId, type } = request.data || {};
  if (typeof chatId !== "string" || !/^chat_[a-f0-9]{40}$/.test(chatId) ||
      typeof messageId !== "string" || !/^[A-Za-z0-9_-]{20}$/.test(messageId) ||
      !["image", "video", "voice"].includes(type)) {
    throw new HttpsError("invalid-argument", "The chat-media reservation is invalid.");
  }
  const chatRef = db.collection("goldenChats").doc(chatId);
  const reservationRef = goldenChatMediaReservationRef(chatId, messageId);
  const walletRef = accountWalletRef(auth.uid);
  const cost = CHAT_ACTION_COSTS[type];
  const now = Date.now();
  let coinsRemaining = 0;
  await db.runTransaction(async transaction => {
    const [chatSnapshot, reservationSnapshot, walletSnapshot] = await Promise.all([
      transaction.get(chatRef),
      transaction.get(reservationRef),
      transaction.get(walletRef)
    ]);
    if (!chatSnapshot.exists || !chatSnapshot.data().participantIds?.includes(auth.uid)) {
      throw new HttpsError("permission-denied", "You are not a participant in this conversation.");
    }
    const wallet = normalizedWallet(walletSnapshot.data());
    if (reservationSnapshot.exists) {
      const reservation = reservationSnapshot.data();
      if (reservation.uid !== auth.uid || reservation.type !== type ||
          reservation.status !== "pending" || reservation.expiresAtMs <= now) {
        throw new HttpsError("failed-precondition", "This media reservation expired. Prepare the media again.");
      }
      coinsRemaining = wallet.coins;
      return;
    }
    if (wallet.coins < cost) {
      const mediaName = type === "voice" ? "voice note" : type === "video" ? "video clip" : "photo";
      throw new HttpsError(
        "failed-precondition",
        `A ${mediaName} costs ${cost} coins. Top up your Golden Chat wallet to send it.`
      );
    }
    const expiresAtMs = now + CHAT_MEDIA_RESERVATION_MS;
    transaction.set(walletRef, {
      ...wallet,
      coins: wallet.coins - cost,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.create(reservationRef, {
      uid: auth.uid,
      chatId,
      messageId,
      type,
      cost,
      status: "pending",
      expiresAtMs,
      expiresAt: new Date(expiresAtMs),
      createdAt: FieldValue.serverTimestamp()
    });
    coinsRemaining = wallet.coins - cost;
  });
  return { reserved: true, cost, coinsRemaining };
});

exports.cancelGoldenChatMediaReservation = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const { chatId, messageId } = request.data || {};
  if (typeof chatId !== "string" || !/^chat_[a-f0-9]{40}$/.test(chatId) ||
      typeof messageId !== "string" || !/^[A-Za-z0-9_-]{20}$/.test(messageId)) {
    throw new HttpsError("invalid-argument", "The media reservation ID is invalid.");
  }
  const reservationRef = goldenChatMediaReservationRef(chatId, messageId);
  const walletRef = accountWalletRef(auth.uid);
  let cancelled = false;
  await db.runTransaction(async transaction => {
    const reservationSnapshot = await transaction.get(reservationRef);
    if (!reservationSnapshot.exists ||
        reservationSnapshot.data().uid !== auth.uid ||
        reservationSnapshot.data().status !== "pending") return;
    const reservation = reservationSnapshot.data();
    const walletSnapshot = await transaction.get(walletRef);
    const wallet = normalizedWallet(walletSnapshot.data());
    transaction.set(walletRef, {
      ...wallet,
      coins: wallet.coins + reservation.cost,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.delete(reservationRef);
    cancelled = true;
  });
  if (cancelled) {
    try {
      await getStorage().bucket()
        .file(`golden-chat-media/${chatId}/${auth.uid}/${messageId}`)
        .delete({ ignoreNotFound: true });
    } catch (error) {
      logger.warn("Cancelled Golden Chat media could not be removed from Storage.", {
        chatId,
        messageId,
        error
      });
    }
  }
  return { cancelled };
});

exports.sendGoldenChatMessage = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const chatId = request.data?.chatId;
  const messageId = request.data?.messageId;
  const type = request.data?.type;
  const text = typeof request.data?.text === "string" ? request.data.text.trim() : "";
  const mediaPath = request.data?.mediaPath;
  const replyToMessageId = request.data?.replyToMessageId;
  if (typeof chatId !== "string" || !/^chat_[a-f0-9]{40}$/.test(chatId) ||
      typeof messageId !== "string" || !/^[A-Za-z0-9_-]{20}$/.test(messageId) ||
      (replyToMessageId !== undefined && (typeof replyToMessageId !== "string" ||
        !/^[A-Za-z0-9_-]{20}$/.test(replyToMessageId) || replyToMessageId === messageId)) ||
      !["text", "image", "video", "voice"].includes(type) ||
      (type === "text" && (!text || text.length > 2000)) ||
      (type !== "text" && (typeof mediaPath !== "string" ||
        mediaPath !== `golden-chat-media/${chatId}/${auth.uid}/${messageId}` ||
        text.length > 500))) {
    throw new HttpsError("invalid-argument", "The chat message is invalid.");
  }

  let mediaMetadata = null;
  if (type !== "text") {
    try {
      const [metadata] = await getStorage().bucket().file(mediaPath).getMetadata();
      const size = Number(metadata.size);
      const contentType = metadata.contentType || "";
      const validImage = type === "image" &&
        /^image\/(jpeg|png|webp|gif)$/.test(contentType) &&
        size > 0 && size <= MAX_CHAT_IMAGE_BYTES;
      const validVoice = type === "voice" &&
        /^audio\/(webm|ogg|mp4|mpeg|wav|x-wav)(;.*)?$/.test(contentType) &&
        size > 0 && size <= MAX_CHAT_VOICE_BYTES;
      const validVideo = type === "video" &&
        /^video\/(mp4|webm|quicktime)$/.test(contentType) &&
        size > 0 && size <= MAX_CHAT_VIDEO_BYTES;
      if (!validImage && !validVoice && !validVideo) {
        throw new HttpsError("invalid-argument", "The uploaded chat media type or size is not allowed.");
      }
      mediaMetadata = { contentType, size };
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.warn("Golden Chat media could not be verified.", { chatId, messageId, error });
      throw new HttpsError("failed-precondition", "Upload the chat media again before sending.");
    }
  }

  const cost = CHAT_ACTION_COSTS[type];
  const chatRef = db.collection("goldenChats").doc(chatId);
  const messageRef = chatRef.collection("messages").doc(messageId);
  const reservationRef = type === "text"
    ? null
    : goldenChatMediaReservationRef(chatId, messageId);
  const walletRef = accountWalletRef(auth.uid);
  let coinsRemaining = 0;
  let duplicate = false;
  await db.runTransaction(async transaction => {
    const messageSnapshot = await transaction.get(messageRef);
    if (messageSnapshot.exists) {
      if (messageSnapshot.data().senderUid !== auth.uid) {
        throw new HttpsError("already-exists", "This message ID is already in use.");
      }
      duplicate = true;
      return;
    }
    const [chatSnapshot, reservationSnapshot, walletSnapshot] = await Promise.all([
      transaction.get(chatRef),
      reservationRef ? transaction.get(reservationRef) : Promise.resolve(null),
      transaction.get(walletRef)
    ]);
    if (!chatSnapshot.exists || !chatSnapshot.data().participantIds?.includes(auth.uid)) {
      throw new HttpsError("permission-denied", "You are not a participant in this conversation.");
    }
    const chat = chatSnapshot.data();
    const recipientUid = chat.participantIds.find(uid => uid !== auth.uid);
    if (!recipientUid) {
      throw new HttpsError("failed-precondition", "This conversation does not have a valid recipient.");
    }
    let replyTo = null;
    if (replyToMessageId) {
      const parentSnapshot = await transaction.get(chatRef.collection("messages").doc(replyToMessageId));
      if (!parentSnapshot.exists) {
        throw new HttpsError("not-found", "The message you are replying to is no longer available.");
      }
      const parent = parentSnapshot.data();
      const parentText = typeof parent.text === "string" ? parent.text.trim() : "";
      const mediaLabel = parent.type === "image" ? "Photo"
        : parent.type === "video" ? "Video clip"
          : parent.type === "voice" ? "Voice note" : "Message";
      replyTo = {
        messageId: replyToMessageId,
        senderName: typeof parent.senderName === "string" ? parent.senderName.slice(0, 120) : "Marketplace member",
        preview: (parentText || mediaLabel).slice(0, 200)
      };
    }
    const [senderProfileSnapshot, recipientProfileSnapshot] = await Promise.all([
      transaction.get(db.collection("users").doc(auth.uid)),
      transaction.get(db.collection("users").doc(recipientUid))
    ]);
    const senderRole = senderProfileSnapshot.data()?.role;
    const recipientRole = recipientProfileSnapshot.data()?.role;
    if (!["Buyer", "Vendor"].includes(senderRole) ||
        !["Buyer", "Vendor"].includes(recipientRole)) {
      throw new HttpsError("failed-precondition", "Member roles could not be verified for this conversation.");
    }
    const vendorShareRef = ["text", "voice"].includes(type) &&
      senderRole === "Buyer" &&
      recipientRole === "Vendor"
      ? accountWalletRef(recipientUid)
      : null;
    const vendorWalletSnapshot = vendorShareRef
      ? await transaction.get(vendorShareRef)
      : null;
    const vendorWallet = normalizedWallet(vendorWalletSnapshot?.data());
    const wallet = normalizedWallet(walletSnapshot.data());
    if (type === "text") {
      if (wallet.coins < cost) {
        throw new HttpsError(
          "failed-precondition",
          `This message costs ${cost} coin. Top up your Golden Chat wallet to send it.`
        );
      }
    } else {
      const reservation = reservationSnapshot?.data();
      if (!reservationSnapshot?.exists ||
          reservation.uid !== auth.uid ||
          reservation.chatId !== chatId ||
          reservation.messageId !== messageId ||
          reservation.type !== type ||
          reservation.status !== "pending" ||
          reservation.expiresAtMs <= Date.now()) {
        throw new HttpsError("failed-precondition", "The media reservation expired. Please prepare the media again.");
      }
    }
    const senderName = chat.participants?.[auth.uid]?.name || "Marketplace member";
    const preview = type === "text"
      ? text.slice(0, 180)
      : type === "image" ? "Photo" : type === "video" ? "Video clip" : "Voice note";
    const message = {
      senderUid: auth.uid,
      senderName,
      type,
      text,
      mediaPath: mediaPath || "",
      mediaContentType: mediaMetadata?.contentType || "",
      mediaSize: mediaMetadata?.size || 0,
      coinCost: cost,
      createdAt: FieldValue.serverTimestamp()
    };
    if (replyTo) message.replyTo = replyTo;
    if (type === "text") {
      transaction.set(walletRef, {
        ...wallet,
        coins: wallet.coins - cost,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } else if (reservationRef) {
      transaction.delete(reservationRef);
    }
    if (vendorShareRef) {
      transaction.set(vendorShareRef, {
        ...vendorWallet,
        coins: vendorWallet.coins + cost / 2,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    transaction.create(messageRef, message);
    const unreadCounts = chat.unreadCounts && typeof chat.unreadCounts === "object"
      ? chat.unreadCounts
      : {};
    const recipientUnreadCount = Number.isSafeInteger(unreadCounts[recipientUid]) &&
      unreadCounts[recipientUid] >= 0
      ? unreadCounts[recipientUid]
      : 0;
    transaction.update(chatRef, {
      lastMessage: preview,
      lastMessageType: type,
      lastMessageAt: FieldValue.serverTimestamp(),
      lastMessageId: messageId,
      unreadCounts: {
        ...unreadCounts,
        [recipientUid]: Math.min(Number.MAX_SAFE_INTEGER, recipientUnreadCount + 1)
      }
    });
    coinsRemaining = wallet.coins - (type === "text" ? cost : 0);
  });
  if (duplicate) {
    const walletSnapshot = await walletRef.get();
    coinsRemaining = normalizedWallet(walletSnapshot.data()).coins;
  }
  return { sent: true, duplicate, messageId, coinsRemaining };
});

exports.markGoldenChatRead = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const { chatId, messageId } = request.data || {};
  if (typeof chatId !== "string" || !/^chat_[a-f0-9]{40}$/.test(chatId) ||
      typeof messageId !== "string" || !/^[A-Za-z0-9_-]{20}$/.test(messageId)) {
    throw new HttpsError("invalid-argument", "The conversation read marker is invalid.");
  }

  const chatRef = db.collection("goldenChats").doc(chatId);
  const messageRef = chatRef.collection("messages").doc(messageId);
  let markedRead = false;
  await db.runTransaction(async transaction => {
    markedRead = false;
    const [chatSnapshot, messageSnapshot] = await Promise.all([
      transaction.get(chatRef),
      transaction.get(messageRef)
    ]);
    if (!chatSnapshot.exists || !chatSnapshot.data().participantIds?.includes(auth.uid)) {
      throw new HttpsError("permission-denied", "You are not a participant in this conversation.");
    }
    if (!messageSnapshot.exists) {
      throw new HttpsError("not-found", "The latest conversation message could not be found.");
    }
    const chat = chatSnapshot.data();
    if (chat.lastMessageId !== messageId) return;
    const unreadCounts = chat.unreadCounts && typeof chat.unreadCounts === "object"
      ? chat.unreadCounts
      : {};
    if (!Number.isSafeInteger(unreadCounts[auth.uid]) || unreadCounts[auth.uid] <= 0) return;
    transaction.update(chatRef, {
      unreadCounts: {
        ...unreadCounts,
        [auth.uid]: 0
      }
    });
    markedRead = true;
  });
  return { markedRead };
});

exports.refundExpiredGoldenChatMedia = onSchedule("every 10 minutes", async () => {
  const now = Date.now();
  const expired = await db.collectionGroup("messages")
    .where("expiresAtMs", "<=", now)
    .limit(100)
    .get();
  await Promise.all(expired.docs.map(async reservationDoc => {
    const chatId = reservationDoc.ref.parent.parent?.id;
    const messageId = reservationDoc.id;
    if (!chatId || !/^chat_[a-f0-9]{40}$/.test(chatId)) return;
    let refundedUid = null;
    await db.runTransaction(async transaction => {
      const currentSnapshot = await transaction.get(reservationDoc.ref);
      if (!currentSnapshot.exists ||
          currentSnapshot.data().expiresAtMs > now) return;
      const reservation = currentSnapshot.data();
      const walletRef = accountWalletRef(reservation.uid);
      const walletSnapshot = await transaction.get(walletRef);
      const wallet = normalizedWallet(walletSnapshot.data());
      transaction.set(walletRef, {
        ...wallet,
        coins: wallet.coins + reservation.cost,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.delete(reservationDoc.ref);
      refundedUid = reservation.uid;
    });
    if (refundedUid) {
      try {
        await getStorage().bucket()
          .file(`golden-chat-media/${chatId}/${refundedUid}/${messageId}`)
          .delete({ ignoreNotFound: true });
      } catch (error) {
        logger.warn("Expired Golden Chat media could not be removed from Storage.", {
          chatId,
          messageId,
          error
        });
      }
    }
  }));
});

exports.getDailyQuizStatus = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const dayKey = new Date().toISOString().slice(0, 10);
  const usageSnapshot = await dailyQuizUsageRef(auth.uid, dayKey).get();
  const usage = usageSnapshot.data() || {};
  const rewardAttemptsUsed = Number.isInteger(usage.rewardAttemptsStarted) &&
    usage.rewardAttemptsStarted >= 0 ? usage.rewardAttemptsStarted : 0;
  const extraPackPurchased = usage.extraPackPurchased === true;
  const rewardAttemptsLimit = FREE_DAILY_REWARD_PLAYS +
    (extraPackPurchased ? PAID_DAILY_REWARD_PLAYS : 0);
  return {
    rewardAttemptsUsed,
    rewardAttemptsLimit,
    rewardAttemptsRemaining: Math.max(0, rewardAttemptsLimit - rewardAttemptsUsed),
    extraPackPurchased,
    extraPackInProgress: typeof usage.extraPackPurchaseRef === "string"
  };
});

exports.startTimedQuiz = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const mode = request.data?.mode || "reward";
  if (!["reward", "practice"].includes(mode)) {
    throw new HttpsError("invalid-argument", "Choose reward play or free practice.");
  }
  await ensureDefaultQuizQuestion();
  const questionsSnapshot = await db.collection("quizQuestions")
    .where("enabled", "==", true)
    .get();
  if (questionsSnapshot.empty) {
    return {
      ready: false,
      reason: "no-enabled-questions",
      questionCount: 0
    };
  }
  const now = Date.now();
  const enabledQuestions = questionsSnapshot.docs;
  const attemptRef = db.collection("quizAttempts").doc();
  const dailyKey = new Date(now).toISOString().slice(0, 10);
  const usageRef = dailyQuizUsageRef(auth.uid, dailyKey);
  const cycleRef = db.collection("quizQuestionCycles").doc(auth.uid);
  const historyCollection = cycleRef.collection("questions");
  let rewardAttemptsRemaining = null;
  let preparedQuestions = [];
  let questionCount = 0;
  let questionCycle = 1;
  let likeRewardEligible = false;

  await db.runTransaction(async transaction => {
    let rewardEligible = false;
    let rewardAttemptsUsed = 0;
    let extraPackPurchased = false;
    const cycleSnapshot = await transaction.get(cycleRef);
    questionCycle = Number.isInteger(cycleSnapshot.data()?.cycle) &&
      cycleSnapshot.data().cycle > 0
      ? cycleSnapshot.data().cycle
      : 1;
    const historySnapshot = await transaction.get(
      historyCollection.where("cycle", "==", questionCycle)
    );
    let usageSnapshot = null;
    if (mode === "reward") {
      usageSnapshot = await transaction.get(usageRef);
      const usage = usageSnapshot.data() || {};
      rewardAttemptsUsed = Number.isInteger(usage.rewardAttemptsStarted) &&
        usage.rewardAttemptsStarted >= 0 ? usage.rewardAttemptsStarted : 0;
      extraPackPurchased = usage.extraPackPurchased === true;
      const rewardAttemptsLimit = FREE_DAILY_REWARD_PLAYS +
        (extraPackPurchased ? PAID_DAILY_REWARD_PLAYS : 0);
      if (rewardAttemptsUsed >= rewardAttemptsLimit) {
        throw new HttpsError(
          "resource-exhausted",
          extraPackPurchased
            ? "You have used all 7 reward plays for today. Free practice remains unlimited."
            : "Your 2 free reward plays are used. Buy 5 extra plays for ₦1,000 or continue with free practice."
        );
      }
      rewardEligible = true;
      likeRewardEligible = rewardAttemptsUsed < FREE_DAILY_REWARD_PLAYS;
      rewardAttemptsUsed += 1;
      rewardAttemptsRemaining = rewardAttemptsLimit - rewardAttemptsUsed;
    }
    const usedQuestionIds = new Set(historySnapshot.docs.map(document => document.id));
    let unseenQuestions = enabledQuestions.filter(document => !usedQuestionIds.has(document.id));
    if (unseenQuestions.length === 0) {
      questionCycle += 1;
      unseenQuestions = enabledQuestions;
    }
    const selected = shuffle(unseenQuestions).slice(0, QUIZ_QUESTION_COUNT);
    questionCount = selected.length;
    preparedQuestions = selected.map(document => {
      const question = document.data();
      const options = shuffle(question.options.map((text, index) => ({ text, index })));
      return {
        question: question.question,
        options: options.map(option => option.text),
        correctOption: options.findIndex(option => option.index === question.correctOption)
      };
    });
    transaction.create(attemptRef, {
      uid: auth.uid,
      questionIds: selected.map(document => document.id),
      questions: preparedQuestions.map(({ question, options }) => ({ question, options })),
      correctOptions: preparedQuestions.map(question => question.correctOption),
      questionCount,
      questionCycle,
      answers: [],
      currentIndex: 0,
      createdAtMs: now,
      currentDeadlineMs: now + QUIZ_SECONDS_PER_QUESTION * 1000,
      status: "started",
      dayKey: dailyKey,
      rewardEligible,
      likeRewardEligible
    });
    transaction.set(cycleRef, {
      cycle: questionCycle,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(historyCollection.doc(selected[0].id), {
      cycle: questionCycle,
      seenAt: FieldValue.serverTimestamp()
    });
    if (rewardEligible) {
      transaction.set(usageRef, {
        rewardAttemptsStarted: rewardAttemptsUsed,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  });

  return {
    ready: true,
    attemptId: attemptRef.id,
    rewardEligible: mode === "reward",
    likeRewardEligible,
    rewardAttemptsRemaining,
    question: {
      question: preparedQuestions[0].question,
      options: preparedQuestions[0].options
    },
    questionCount,
    questionCycle,
    questionIndex: 0,
    durationSeconds: QUIZ_SECONDS_PER_QUESTION
  };
});

exports.cancelTimedQuiz = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const attemptId = request.data?.attemptId;
  if (typeof attemptId !== "string" || !/^[A-Za-z0-9_-]{20}$/.test(attemptId)) {
    throw new HttpsError("invalid-argument", "The quiz attempt ID is invalid.");
  }
  const attemptRef = db.collection("quizAttempts").doc(attemptId);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(attemptRef);
    if (!snapshot.exists || snapshot.data().uid !== auth.uid) {
      throw new HttpsError("not-found", "This quiz attempt could not be found.");
    }
    const attempt = snapshot.data();
    if (attempt.status === "submitted") {
      return { cancelled: false, complete: true };
    }
    if (attempt.status !== "started") {
      return { cancelled: true, complete: false };
    }
    transaction.update(attemptRef, {
      status: "abandoned",
      abandonedAt: FieldValue.serverTimestamp()
    });
    return { cancelled: true, complete: false };
  });
});

exports.submitTimedQuiz = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const attemptId = request.data?.attemptId;
  const questionIndex = request.data?.questionIndex;
  const answer = request.data?.answer;
  if (typeof attemptId !== "string" || !/^[A-Za-z0-9_-]{20}$/.test(attemptId) ||
      !Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= QUIZ_QUESTION_COUNT ||
      !Number.isInteger(answer) || answer < -1 || answer > 3) {
    throw new HttpsError("invalid-argument", "The quiz submission is invalid.");
  }

  const attemptRef = db.collection("quizAttempts").doc(attemptId);
  const now = Date.now();
  const walletRef = accountWalletRef(auth.uid);
  let result = null;

  await db.runTransaction(async transaction => {
    const attemptSnapshot = await transaction.get(attemptRef);
    if (!attemptSnapshot.exists || attemptSnapshot.data().uid !== auth.uid) {
      throw new HttpsError("not-found", "This quiz attempt could not be found.");
    }
    const attempt = attemptSnapshot.data();
    const questionCount = Number.isInteger(attempt.questionCount)
      ? attempt.questionCount
      : QUIZ_QUESTION_COUNT;
    if (questionIndex >= questionCount) {
      throw new HttpsError("invalid-argument", "This question is not part of the quiz.");
    }
    if (attempt.status === "submitted") {
      result = {
        complete: true,
        perfect: attempt.perfect === true,
        awardedLikes: Number.isInteger(attempt.awardedLikes) ? attempt.awardedLikes : 0,
        rewardEligible: attempt.rewardEligible === true,
        questionCount,
        wasCorrect: attempt.answers[questionIndex] === attempt.correctOptions[questionIndex],
        correctOption: attempt.correctOptions[questionIndex]
      };
      return;
    }
    if (attempt.status !== "started") {
      throw new HttpsError("failed-precondition", "This quiz was exited and cannot earn a reward.");
    }
    if (attempt.currentIndex > questionIndex) {
      const previousAnswer = attempt.answers[questionIndex];
      result = {
        complete: false,
        question: attempt.questions[attempt.currentIndex],
        questionIndex: attempt.currentIndex,
        durationSeconds: Math.max(1, Math.ceil((attempt.currentDeadlineMs - now) / 1000)),
        wasCorrect: previousAnswer === attempt.correctOptions[questionIndex],
        correctOption: attempt.correctOptions[questionIndex],
        questionCount
      };
      return;
    }
    if (attempt.currentIndex !== questionIndex) {
      throw new HttpsError("failed-precondition", "This answer is out of sequence.");
    }

    const recordedAnswer = now <= attempt.currentDeadlineMs ? answer : -1;
    const answers = [...attempt.answers, recordedAnswer];
    const nextIndex = questionIndex + 1;
    const wasCorrect = recordedAnswer === attempt.correctOptions[questionIndex];
    const finalQuestion = nextIndex >= questionCount;
    const perfect = finalQuestion && answers.every((submittedAnswer, index) =>
      submittedAnswer === attempt.correctOptions[index]);
    const rewardEligible = attempt.rewardEligible === true;
    const likeReward = typeof attempt.likeRewardEligible === "boolean"
      ? attempt.likeRewardEligible
      : rewardEligible && perfect;
    const awardedLikes = quizLikeRewardAmount(
      finalQuestion,
      perfect,
      rewardEligible,
      likeReward
    );
    let wallet = null;
    if (awardedLikes > 0) {
      const walletSnapshot = await transaction.get(walletRef);
      wallet = normalizedWallet(walletSnapshot.data());
    }
    const historyCollection = db.collection("quizQuestionCycles")
      .doc(auth.uid)
      .collection("questions");
    const currentQuestionId = attempt.questionIds?.[questionIndex];
    if (typeof currentQuestionId === "string" && Number.isInteger(attempt.questionCycle)) {
      transaction.set(historyCollection.doc(currentQuestionId), {
        cycle: attempt.questionCycle,
        seenAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    if (!finalQuestion) {
      const currentDeadlineMs = now + QUIZ_SECONDS_PER_QUESTION * 1000;
      const nextQuestionId = attempt.questionIds?.[nextIndex];
      if (typeof nextQuestionId === "string" && Number.isInteger(attempt.questionCycle)) {
        transaction.set(historyCollection.doc(nextQuestionId), {
          cycle: attempt.questionCycle,
          seenAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
      transaction.update(attemptRef, {
        answers,
        currentIndex: nextIndex,
        currentDeadlineMs
      });
      result = {
        complete: false,
        question: attempt.questions[nextIndex],
        questionIndex: nextIndex,
        durationSeconds: QUIZ_SECONDS_PER_QUESTION,
        wasCorrect,
        correctOption: attempt.correctOptions[questionIndex],
        questionCount
      };
      return;
    }

    if (awardedLikes > 0 && wallet) {
      transaction.set(walletRef, {
        ...wallet,
        likes: wallet.likes + awardedLikes,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    transaction.update(attemptRef, {
      status: "submitted",
      answers,
      perfect,
      rewardEligible,
      likeRewardEligible: likeReward,
      awardedLikes,
      submittedAt: FieldValue.serverTimestamp()
    });
    result = {
      complete: true,
      perfect,
      awardedLikes,
      rewardEligible,
      likeRewardEligible: likeReward,
      questionCount,
      wasCorrect,
      correctOption: attempt.correctOptions[questionIndex]
    };
  });

  return result;
});

exports.toggleCommunityCommentLike = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const { postId, commentId } = request.data || {};
  const validDocumentId = value =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (!validDocumentId(postId) || !validDocumentId(commentId)) {
    throw new HttpsError("invalid-argument", "Choose a valid community comment.");
  }

  const postRef = db.collection("communityPosts").doc(postId);
  const commentRef = postRef.collection("comments").doc(commentId);
  const likeRef = commentRef.collection("likes").doc(auth.uid);
  let result;
  await db.runTransaction(async transaction => {
    const [postSnapshot, commentSnapshot, likeSnapshot] = await Promise.all([
      transaction.get(postRef),
      transaction.get(commentRef),
      transaction.get(likeRef)
    ]);
    if (!postSnapshot.exists || !commentSnapshot.exists) {
      throw new HttpsError("not-found", "This community comment is no longer available.");
    }
    if (commentSnapshot.data().authorUid === auth.uid) {
      throw new HttpsError("failed-precondition", "You cannot like your own comment.");
    }

    const currentCount = Number.isSafeInteger(commentSnapshot.data().likesCount) &&
      commentSnapshot.data().likesCount > 0
      ? commentSnapshot.data().likesCount
      : 0;
    const liked = !likeSnapshot.exists;
    const likesCount = Math.max(0, currentCount + (liked ? 1 : -1));
    if (liked) {
      transaction.create(likeRef, {
        userUid: auth.uid,
        createdAt: FieldValue.serverTimestamp()
      });
    } else {
      transaction.delete(likeRef);
    }
    transaction.update(commentRef, { likesCount });
    result = { liked, likesCount };
  });
  return result;
});

exports.toggleCommunityPostLike = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const { postId } = request.data || {};
  if (typeof postId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(postId)) {
    throw new HttpsError("invalid-argument", "Choose a valid community post.");
  }

  const postRef = db.collection("communityPosts").doc(postId);
  const likeRef = postRef.collection("likes").doc(auth.uid);
  const statsRef = db.collection("communityPostStats").doc(postId);
  const walletRef = accountWalletRef(auth.uid);
  let result;
  await db.runTransaction(async transaction => {
    const [postSnapshot, likeSnapshot, statsSnapshot, walletSnapshot] = await Promise.all([
      transaction.get(postRef),
      transaction.get(likeRef),
      transaction.get(statsRef),
      transaction.get(walletRef)
    ]);
    if (!postSnapshot.exists) {
      throw new HttpsError("not-found", "This community post is no longer available.");
    }

    const currentCount = Number.isSafeInteger(statsSnapshot.data()?.likes) &&
      statsSnapshot.data().likes >= 0
      ? statsSnapshot.data().likes
      : 0;
    const wallet = normalizedWallet(walletSnapshot.data());
    if (likeSnapshot.exists) {
      const existing = likeSnapshot.data();
      const now = Date.now();
      if (existing.walletSpent === 1 && isReactionUndoable(existing, now)) {
        const likesCount = Math.max(0, currentCount - 1);
        wallet.likes += 1;
        transaction.delete(likeRef);
        transaction.set(statsRef, {
          likes: likesCount,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(walletRef, {
          ...wallet,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        result = {
          liked: false,
          removed: true,
          likesCount,
          likesRemaining: wallet.likes
        };
        return;
      }
      result = {
        liked: true,
        alreadyLiked: true,
        likesCount: currentCount,
        likesRemaining: wallet.likes
      };
      return;
    }
    if (wallet.likes < 1) {
      throw new HttpsError(
        "failed-precondition",
        "You need an available Like credit to like this post. Earn credits by completing a reward quiz."
      );
    }

    const likesCount = currentCount + 1;
    const now = Date.now();
    transaction.create(likeRef, {
      userUid: auth.uid,
      walletSpent: 1,
      createdAt: new Date(now)
    });
    transaction.set(statsRef, {
      likes: likesCount,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(walletRef, {
      ...wallet,
      likes: wallet.likes - 1,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    result = {
      liked: true,
      alreadyLiked: false,
      removed: false,
      likesCount,
      likesRemaining: wallet.likes - 1
    };
  });
  return result;
});

exports.applyProductReaction = onCall(async request => {
  const auth = requireVerifiedUser(request);
  const { productId, type } = request.data || {};
  if (typeof productId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(productId) ||
      !["like", "love", "hate"].includes(type)) {
    throw new HttpsError("invalid-argument", "Choose a valid product and reaction.");
  }

  const reactionRef = db.collection("productDiscussions").doc(productId)
    .collection("reactions").doc(auth.uid);
  const productRef = db.collection("products").doc(productId);
  const walletRef = accountWalletRef(auth.uid);
  const statsRef = db.collection("productDiscussionStats").doc(productId);
  let removed = false;
  let result = null;
  await db.runTransaction(async transaction => {
    const [productSnapshot, reactionSnapshot, walletSnapshot, statsSnapshot] = await Promise.all([
      transaction.get(productRef),
      transaction.get(reactionRef),
      transaction.get(walletRef),
      transaction.get(statsRef)
    ]);
    requireProductReactionTarget(productSnapshot, auth.uid);
    const wallet = normalizedWallet(walletSnapshot.data());
    const existing = reactionSnapshot.exists ? reactionSnapshot.data() : null;
    const now = Date.now();
    const stats = statsSnapshot.data() || {};
    const counts = {
      likes: Number.isSafeInteger(stats.likes) && stats.likes >= 0 ? stats.likes : 0,
      loves: Number.isSafeInteger(stats.loves) && stats.loves >= 0 ? stats.loves : 0,
      hates: Number.isSafeInteger(stats.hates) && stats.hates >= 0 ? stats.hates : 0
    };
    if (existing?.type === "like" || existing?.type === "hate") {
      const balanceKey = `${existing.type}s`;
      const canUndo = existing.walletSpent === balanceKey && isReactionUndoable(existing, now);
      if (type !== existing.type) {
        throw new HttpsError(
          "failed-precondition",
          canUndo
            ? `Tap the same ${existing.type === "like" ? "Like" : "Hate"} again within 10 seconds to undo it; reactions cannot be switched.`
            : `This Product ${existing.type === "like" ? "Like" : "Hate"} is permanent and cannot be changed.`
        );
      }
      if (canUndo) {
        wallet[balanceKey] += 1;
        counts[balanceKey] = Math.max(0, counts[balanceKey] - 1);
        transaction.delete(reactionRef);
        transaction.set(walletRef, {
          ...wallet,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(statsRef, {
          ...counts,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        removed = true;
        result = {
          removed: true,
          liked: false,
          hated: false,
          likesRemaining: wallet.likes,
          hatesRemaining: wallet.hates
        };
        return;
      }
      result = {
        removed: false,
        liked: existing.type === "like",
        hated: existing.type === "hate",
        alreadyApplied: true,
        permanent: true,
        likesRemaining: wallet.likes,
        hatesRemaining: wallet.hates
      };
      return;
    }
    if (type === "love") {
      if (existing?.type !== "love") {
        throw new HttpsError("failed-precondition", "Love reactions are no longer available.");
      }
      if (existing.walletSpent && ["likes", "loves", "hates"].includes(existing.walletSpent)) {
        wallet[existing.walletSpent] += 1;
        transaction.set(walletRef, { ...wallet, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      transaction.delete(reactionRef);
      removed = true;
      result = { removed: true };
      return;
    }
    const balanceKey = `${type}s`;
    if (existing?.type === type) {
      if (existing.walletSpent && ["likes", "loves", "hates"].includes(existing.walletSpent)) {
        wallet[existing.walletSpent] += 1;
        transaction.set(walletRef, { ...wallet, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      transaction.delete(reactionRef);
      removed = true;
      result = { removed: true };
      return;
    }

    if (existing?.walletSpent && ["likes", "loves", "hates"].includes(existing.walletSpent)) {
      wallet[existing.walletSpent] += 1;
    }
    if (existing?.type === "love") {
      counts.loves = Math.max(0, counts.loves - 1);
    }
    if (wallet[balanceKey] < 1) {
      throw new HttpsError(
        "failed-precondition",
        type === "like"
          ? "Earn likes by passing the timed quiz."
          : `Add ${type} credits in the reaction store before using this reaction.`
      );
    }
    wallet[balanceKey] -= 1;
    counts[balanceKey] += 1;
    transaction.set(reactionRef, {
      type,
      walletSpent: balanceKey,
      createdAt: new Date(now),
      counterManaged: true,
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.set(walletRef, { ...wallet, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(statsRef, {
      ...counts,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    result = {
      removed: false,
      liked: type === "like",
      hated: type === "hate",
      likesRemaining: wallet.likes,
      hatesRemaining: wallet.hates
    };
  });
  return result || { removed };
});

exports.adminListQuizQuestions = onCall(async request => {
  requireQuizAdmin(request);
  const snapshot = await db.collection("quizQuestions").orderBy("question").get();
  return {
    questions: snapshot.docs.map(document => ({ id: document.id, ...document.data() }))
  };
});

exports.adminSaveQuizQuestion = onCall(async request => {
  requireQuizAdmin(request);
  const { questionId, question, options, correctOption, enabled } = request.data || {};
  if (typeof question !== "string" || !question.trim() || question.length > 400 ||
      !Array.isArray(options) || options.length !== 4 ||
      options.some(option => typeof option !== "string" || !option.trim() || option.length > 160) ||
      !Number.isInteger(correctOption) || correctOption < 0 || correctOption > 3 ||
      typeof enabled !== "boolean") {
    throw new HttpsError("invalid-argument", "Enter a question, four answers, and one correct answer.");
  }
  const ref = typeof questionId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(questionId)
    ? db.collection("quizQuestions").doc(questionId)
    : db.collection("quizQuestions").doc();
  await ref.set({
    question: question.trim(),
    options: options.map(option => option.trim()),
    correctOption,
    enabled,
    updatedAt: FieldValue.serverTimestamp()
  });
  return { id: ref.id };
});

exports.adminDeleteQuizQuestion = onCall(async request => {
  requireQuizAdmin(request);
  const questionId = request.data?.questionId;
  if (typeof questionId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(questionId)) {
    throw new HttpsError("invalid-argument", "The quiz question ID is invalid.");
  }
  await db.collection("quizQuestions").doc(questionId).delete();
  return { deleted: true };
});

exports.updateProductReactionCounts = onDocumentWritten(
  "productDiscussions/{productId}/reactions/{userId}",
  async event => {
    const beforeData = event.data?.before.exists ? event.data.before.data() : null;
    const afterData = event.data?.after.exists ? event.data.after.data() : null;
    if (beforeData?.counterManaged === true || afterData?.counterManaged === true) return;

    const before = beforeData?.type || null;
    const after = afterData?.type || null;
    if (before === after) return;

    const productId = event.params.productId;
    const statsRef = db.collection("productDiscussionStats").doc(productId);
    const processedRef = db.collection("_reactionEvents").doc(event.id);

    await db.runTransaction(async transaction => {
      const processed = await transaction.get(processedRef);
      if (processed.exists) return;

      const statsSnapshot = await transaction.get(statsRef);
      const stats = statsSnapshot.exists ? statsSnapshot.data() : {};
      let likes = Number.isInteger(stats.likes) ? stats.likes : 0;
      let loves = Number.isInteger(stats.loves) ? stats.loves : 0;
      let hates = Number.isInteger(stats.hates) ? stats.hates : 0;

      if (before === "like") likes = Math.max(0, likes - 1);
      if (before === "love") loves = Math.max(0, loves - 1);
      if (before === "hate") hates = Math.max(0, hates - 1);
      if (after === "like") likes += 1;
      if (after === "love") loves += 1;
      if (after === "hate") hates += 1;

      transaction.set(statsRef, {
        likes,
        loves,
        hates,
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.create(processedRef, {
        processedAt: FieldValue.serverTimestamp()
      });
    });

    logger.info("Updated product discussion reaction counts.", { productId });
  }
);

exports.deleteProductVoiceComment = onDocumentDeleted(
  "productDiscussions/{productId}/comments/{commentId}",
  async event => {
    const voicePath = event.data?.data().voicePath;
    if (!voicePath) return;

    await getStorage().bucket().file(voicePath).delete({ ignoreNotFound: true });
    logger.info("Deleted voice recording for removed product comment.", {
      productId: event.params.productId,
      commentId: event.params.commentId
    });
  }
);

exports.deleteCommunityCommentVoice = onDocumentDeleted(
  "communityPosts/{postId}/comments/{commentId}",
  async event => {
    const comment = event.data?.data();
    const voicePath = comment?.voicePath;
    if (!voicePath) return;

    const expectedPath =
      `community-comment-voice/${event.params.postId}/${event.params.commentId}/${comment.authorUid}/voice`;
    if (voicePath !== expectedPath) {
      logger.warn("Skipped cleanup for an unexpected community voice path.", {
        postId: event.params.postId,
        commentId: event.params.commentId
      });
      return;
    }

    await getStorage().bucket().file(voicePath).delete({ ignoreNotFound: true });
    logger.info("Deleted voice recording for removed community comment.", {
      postId: event.params.postId,
      commentId: event.params.commentId
    });
  }
);
