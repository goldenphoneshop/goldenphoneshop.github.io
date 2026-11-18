# Firebase setup for Golden Eagle Marketplace

The app's product discussions, community-post comments, vendor-following feed, community photo/video posts, profiles, timed quiz, reaction store, and Golden Chat use Firebase Authentication, Cloud Firestore, Cloud Storage, and Cloud Functions. Golden Chat supports private Buyer–Vendor conversations with paid text, photo, and voice-note messages. Comments and product-discussion voice recordings are visible to visitors; verified signed-in users can comment. A reaction is limited to one per account per product. Quiz-earned likes and purchased love/hate/chat coins are credited or debited by callable Cloud Functions, never directly by the browser. The side menu has a Quiz & reaction store entry; Followers and Following remain under My profile. Product-discussion voice recordings have no time limit and are capped at 25 MB per upload. Following the vendor feed, profile editing, presence, and dark-mode behavior remain as described below.

## One-time Firebase Console setup

1. In project `golden-eagle-marketplace`, enable **Authentication → Sign-in method → Email/Password** and **Phone** if those methods will be used.
2. Add `goldenphoneshop.github.io` under **Authentication → Settings → Authorized domains**. For local testing, add `localhost`.
3. Create a Cloud Firestore database and a Cloud Storage bucket in the project.
4. Enable billing for the project before deploying Cloud Functions. Firestore, Storage, Functions, and audio downloads can incur charges. Set a budget alert in Google Cloud Billing and monitor Firebase usage.
5. To upload and display profile photos without public download-token URLs, configure CORS on the Storage bucket. The configuration must include the website's exact origin and the upload methods (`POST` and `PUT`) as well as read methods. Install the Google Cloud CLI, authenticate it with an account that can administer the bucket, then run:

   ```powershell
   gcloud storage buckets update gs://golden-eagle-marketplace.firebasestorage.app --cors-file=storage.cors.json
   ```

   `storage.cors.json` allows profile-photo uploads and reads from the GitHub Pages website and local HTTP test servers on ports 5000 and 5500. If the site uses a different domain or local port, add that exact origin to the file before applying it. Opening the HTML directly as a `file://` URL is not supported for Firebase Storage uploads; serve it over HTTP or test on the hosted HTTPS site. Apply CORS after changing the file.

## Configure Flutterwave before taking payments

The store uses fixed prices in NGN: N500 for 10 loves, N500 for 5 hates, and N1,000 for one daily pack of 5 extra quiz plays. Every account receives 2 free reward plays daily; completing either awards 10 likes regardless of score. The five paid extra plays do not award likes. Unlimited practice is free and does not award likes. Buying loves or hates does not require playing a quiz. The page fetches a public NGN/USD rate only to show an approximate dollar equivalent; Flutterwave is charged the fixed NGN amount. A phone-only account is prompted for an email address for its payment receipt.

1. Enable Flutterwave checkout for your merchant account and configure your **settlement bank account** in the Flutterwave dashboard. The app does not directly transfer money to a bank, and never collects bank account details. Flutterwave settles funds according to the merchant account's dashboard settings.
2. Set the Flutterwave API secret key and the webhook secret hash as Firebase Functions secrets. Do not put either secret in HTML, source control, or a chat message:

   ```powershell
   firebase functions:secrets:set FLUTTERWAVE_SECRET_KEY
   firebase functions:secrets:set FLUTTERWAVE_WEBHOOK_HASH
   ```

3. After deploying functions, copy the HTTPS URL printed for `flutterwaveWalletWebhook` into Flutterwave's webhook settings. Use the same webhook secret hash stored as `FLUTTERWAVE_WEBHOOK_HASH`.
4. Checkout redirects to `https://goldenphoneshop.github.io/Markertplace.html`; update `PAYMENT_REDIRECT_URL` in `functions/index.js` if the published page uses another URL.

The backend creates each checkout from a server-side price table, verifies the transaction with Flutterwave, checks currency, amount, reference, and receipt email, and credits the wallet only once. The webhook and browser return both use that verification path; a browser redirect alone never grants credits. Secret configuration, deployment, and the merchant settlement account must be completed before checkout can work.

Golden Chat coin packs use the same verified Flutterwave flow: 12 coins for ₦350, 50 for ₦1,500, and 350 for ₦7,500 (300 + 50 bonus). The server credits coins to the signed-in member's wallet only after verified payment. There is no six-month Chat subscription.

## Golden Chat

- Golden Chat connects a Buyer with a Vendor. A conversation may be started from a Vendor's product listing or a member profile. Product-linked conversations display the listing's current recorded stock so the Buyer can ask the Vendor to confirm that the exact item is still available; a listing's stock count is not a reservation or guarantee.
- The sender pays 1 coin per text message, 2 per photo, or 3 per voice note. The receiving participant is not charged. Text deductions and message creation happen together in a server-side transaction; photo/voice coins are reserved before upload and finalized only when a message is created. Failed or abandoned media reservations are refunded, and a scheduled Cloud Function cleans up expired uploads. The browser cannot write messages or adjust balances directly. Photo uploads are limited to 5 MB; voice notes to 25 MB.
- Chat media is stored at private participant-only paths. The page loads it using authenticated Storage reads, so configure the Storage CORS origins before testing media. Coin purchases require the Flutterwave setup above.
- Voice and video calling are not active yet and are not charged. **Recommended next provider: LiveKit Cloud** for browser voice/video. Configure an account and secrets, and issue short-lived room credentials only from trusted Cloud Functions after checking conversation membership and reserving the initiator's coins. Reserve 5 coins for the first voice-call minute or 10 for the first video-call minute, bill the initiator by the minute, stop the call when their balance cannot cover the next minute, and refund unused reserved time after a failed/declined call or early disconnect. Do not treat these prototype call rates as live until provider billing, participant authorization, minute accounting, and disconnect/refund behavior are tested. Scheduled cleanup for media reservations requires Cloud Scheduler; Firebase provisions its schedule when the function deploys, and Cloud billing must be enabled.

## Quiz and reaction-store behavior

- Each quiz selects up to 5 questions the member has not seen in the current rotation of enabled questions. If fewer than 5 unseen questions remain, the quiz uses that smaller number; a new rotation begins only after the enabled bank has been seen. Each question has four shuffled options and a separate 30-second deadline enforced by the server. Answers are recorded one question at a time, and the correct answer is shown after each submitted question. The first 2 free reward plays per UTC day award 10 likes each when completed, regardless of score. A verified N1,000 purchase adds 5 more daily plays, but these additional plays do not award likes. Every started reward play consumes a daily play, including one that is abandoned. Exiting an active quiz asks for confirmation; confirmed exits are marked abandoned and cannot be submitted for rewards. Free practice is unlimited and never awards likes. Daily limits reset at 00:00 UTC. No monthly quiz subscription is required.
- Correct answers are returned only after the corresponding question is submitted; answers to current and future questions are not exposed beforehand. The admin editor is shown only when the signed-in Firebase ID token has the `admin: true` custom claim. Grant this claim only to a trusted administrator using the Firebase Admin SDK in a controlled environment; do not make a client-side role field authoritative. For example, from a trusted environment already initialized for this Firebase project with Admin SDK credentials:

  ```js
  const { getAuth } = require("firebase-admin/auth");
  (async () => {
    const user = await getAuth().getUserByEmail("admin@example.com");
    await getAuth().setCustomUserClaims(user.uid, {
      ...(user.customClaims || {}),
      admin: true
    });
  })().catch(console.error);
  ```

  Replace the example email with the intended administrator account. Never place service-account credentials in the website or commit them. Sign out and back in after changing the claim. An admin can add, edit, disable, and delete questions in App Settings. Add at least 5 questions before enabling quizzes. Correct-answer indices are stored in Firestore and are not included in the public page or function source.
- Wallet, daily-play usage, attempt, purchase, and reaction writes are Cloud Function-only. Firestore rules allow account owners to read their balance but block client-side writes to balances and quiz usage. A missing or undeployed function means rewards and reactions will fail explicitly rather than being credited locally.
- Existing reactions created before the wallet feature are treated as legacy reactions. Removing a new wallet-funded reaction refunds its credit; legacy reactions have no wallet credit to refund.

## Deploy the rules and Cloud Functions

Install Node.js 20 or later and the Firebase CLI on the deployment computer. From the project root:

```powershell
npm install --prefix functions
firebase login
firebase use golden-eagle-marketplace
firebase deploy --only firestore:rules,storage,functions
```

The rules restrict vendor product creation and editing to a verified account whose Firebase user profile has the `Vendor` role. The role is created once for the signed-in account and cannot be changed by later profile updates. Verified users can read marketplace profiles; profile photos are read through authenticated Storage access rather than stored public URLs. Profile photos are limited to 5 MB and JPG, PNG, WebP, or GIF. Users can update their display name, photo, location, gender, age range, description, and `allowMediaDownloads` preference, but not their account role. Verified Buyers and Vendors can publish community photo/video posts and reshare existing community posts. The app permits any number of photos per community post or product listing (5 MB per photo) and one video. Buyers can upload community videos up to 500 MB with no client-side duration cap; vendors can upload community videos up to 50 MB and the browser checks a 10-second duration limit. Product videos remain limited to 50 MB and a browser-checked 10 seconds. Firestore documents have a 1 MiB maximum size, so extremely large photo URL lists may exceed the platform's document limit despite no app-level count cap. Storage rules enforce role-specific video size limits, but cannot inspect duration; vendor duration checks are a client-side usability limit that can be bypassed by a modified client. Community media and post records are publicly readable. The download setting controls the app's download button and is checked before it starts a download; it cannot prevent people from saving media through other browser/device methods or using a previously copied public Firebase media URL. Buyers and vendors with verified sign-in can read and comment on public product discussions. Reactions are changed only through `applyProductReaction`; totals are maintained by a Cloud Function. Verified members can search for Buyers and Vendors by exact email address or by prefixes of a display name, location, role, or public business/about information. Email addresses are used only for matching and are never returned or shown. Search is server-mediated and rate-limited; directory and search-limit documents are not client-readable. A member directory entry is created when a profile changes or when its owner signs in after the feature is deployed. Buyers and Vendors can follow each other; reciprocal following/follower records are written together. Vendor product listings are also shown on each Vendor profile and remain available in the public marketplace. The `presence/{userId}/sessions/{sessionId}` rules allow public reads of presence state only; only the verified account owner can update or delete their own session records.

Golden Chat requires a completed member profile and verified sign-in. Conversation creation, Buyer–Vendor roles, message reads, coin purchases, and coin deductions are enforced by Cloud Functions, Firestore rules, and Storage rules. After deploying, test two separate verified accounts (one Buyer and one Vendor), a product-linked conversation, text/photo/voice-note sends, insufficient balances, each Flutterwave coin pack, and access denial for a nonparticipant. Real-time calls remain unavailable until a provider is configured; do not advertise or charge for them before end-to-end testing.

## Vendor product photo and video uploads

The vendor listing form accepts any number of uploaded photos and one uploaded video. Photos must be JPG, PNG, WebP, or GIF and are limited to 5 MB each. Product videos must be MP4, WebM, or MOV, no larger than 50 MB, and the page checks their duration is at most 10 seconds before upload and again before publishing. Firebase Storage rules restrict uploads to verified Vendor accounts, restrict media MIME types and size, and make the resulting product media readable for public marketplace listings. They do not inspect video duration: the 10-second duration check runs in the browser, so it is a usability limit, not a server-side media-transcoding guarantee.

Deploy `storage.rules` along with the page changes. Product media is stored at `products/{vendorUid}/{productId}/{fileName}` and the resulting Firebase download URLs are saved with the listing. Buyer/vendor community media is stored at `community-media/{uid}/{postId}/{fileName}` and referenced by public download URLs in `communityPosts`. Community comments are stored at `communityPosts/{postId}/comments/{commentId}`; verified users can create comments, and only the author can delete their own comment. Buyer community video uploads may be up to 500 MB; vendor community and product videos remain limited to 50 MB. Existing starter products and older listings may still display their prior images; the new vendor-post flow no longer accepts external image URLs.

## Publish the app

Upload the updated `Markertplace.html` to the root of the GitHub Pages repository. Deploy the Firestore and Storage rules before using comments, reactions, shared listings, community posts, media uploads, following, profile editing, or voice uploads. Apply the Storage CORS configuration before profile-photo previews can load in the browser. Configure the two Flutterwave secrets, then deploy Cloud Functions before offering quiz rewards or paid reaction credits. Deploy Cloud Functions to enable member search and directory synchronization. Search matches exact account emails without returning email addresses, or prefixes in public profile text. Existing profiles are indexed when they are next updated or their owner signs in after the functions are deployed. New follow actions update both the follower's `users/{followerUid}/following/{memberUid}` document and the target member's `users/{memberUid}/followers/{followerUid}` document. Existing following records created before this reciprocal record was added remain visible in the Following list; the updated UI can unfollow these records, and new records work for both Buyer and Vendor accounts.

New vendor listings are written to Firestore and shared across visitors and appear on the Vendor's profile. On sign-in, a vendor's older local listings are migrated only when their IDs were generated by the app (`prod-` followed by a 13-digit timestamp) and the saved vendor name matches the account name. Built-in starter listings remain in the page but their discussions are still shared by their fixed product IDs. Other old local-only listings are not uploaded automatically.

## Voice recordings and deletion

Voice recording requires microphone permission and an HTTPS page (or localhost). Recordings stop when the 25 MB limit is reached. Deleting your own comment triggers a Cloud Function that removes its audio file from Storage. Public voice-note downloads may incur Storage egress charges.

If deployment fails, check that Firestore and Storage are enabled, billing is active for Functions, the selected Firebase project is correct, and the Firebase CLI is logged in to an account with deployment permission.
