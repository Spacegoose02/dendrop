/*
 * Dendrop's service worker: shows phone and browser notifications from Web Push.
 *
 * A push only ever says what kind of thing happened ({"type":"message"}, "mention", "call" or
 * "event"), never who sent it or what it says, so this file holds the only words a notification
 * can show. Tapping one opens Dendrop, which shows the rest.
 */
const TEXT = {
  message: { title: "Dendrop", body: "You have a new message" },
  mention: { title: "Dendrop", body: "Someone mentioned you" },
  call: { title: "Incoming call", body: "Someone is calling you on Dendrop" },
  event: { title: "Event starting", body: "An event you're going to is starting soon" },
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let type = "message";
  try {
    const t = e.data && e.data.json().type;
    if (typeof t === "string" && TEXT[t]) type = t;
  } catch {
    // Not JSON: still a wake-up for a message.
  }
  e.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Dendrop is open in front of you and already shows new messages.
      if ((type === "message" || type === "mention") && windows.some((w) => w.visibilityState === "visible" && w.focused)) return;
      const { title, body } = TEXT[type];
      await self.registration.showNotification(title, {
        body,
        // One notification per kind: a burst of messages updates it instead of piling up.
        tag: type,
        renotify: true,
        requireInteraction: type === "call",
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        data: { url: "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) return open.focus();
      return self.clients.openWindow("/");
    })(),
  );
});

// The browser replaced the subscription (keys rotated): hand the new one to the server.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    (async () => {
      const cfg = await fetch("/api/push/config", { credentials: "same-origin" }).then((r) => r.json());
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: cfg.vapidPublicKey });
      await fetch("/api/push/subscriptions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...sub.toJSON(), provider: "webpush" }),
      });
    })().catch(() => {}),
  );
});
