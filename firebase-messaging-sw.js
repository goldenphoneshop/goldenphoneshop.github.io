/* global firebase, clients */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAuEIGypz6qdsHfTYuSg4nS-CloXcqDGGc",
  authDomain: "golden-eagle-marketplace.firebaseapp.com",
  projectId: "golden-eagle-marketplace",
  storageBucket: "golden-eagle-marketplace.firebasestorage.app",
  messagingSenderId: "120512676475",
  appId: "1:120512676475:web:9f451f54ff3d36771258de"
});

firebase.messaging().onBackgroundMessage(payload => {
  const title = payload.notification?.title || "Golden Eagle Football";
  self.registration.showNotification(title, {
    body: payload.notification?.body || "Open the Football Hub for a match update.",
    icon: "./Image/app-logo.jpg",
    badge: "./Image/app-logo.jpg",
    data: { url: payload.data?.url || "./football.html" }
  });
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "./football.html";
  event.waitUntil(clients.openWindow(new URL(url, self.location.href).href));
});
