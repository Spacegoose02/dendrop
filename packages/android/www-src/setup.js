// The Android and iPhone apps' own page: pick the server and turn on notifications.
// Shown on first launch, from the "Server settings" shortcut (#settings), and when the server
// can't be reached (as dendrop-offline.html). Talks to DendropPlugin.java on Android and
// DendropPlugin.swift on iOS (packages/ios builds this same page).
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);

  // In a desktop browser (no Capacitor) a stand-in lets you preview the page.
  const native =
    window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
      ? (method, options) => window.Capacitor.nativePromise("Dendrop", method, options || {})
      : previewNative();

  const isOfflinePage = location.pathname.endsWith("/dendrop-offline.html");
  const isSettings = location.hash === "#settings";
  let state = null;
  let pollTimer = null;

  async function refresh() {
    state = await native("getState");
    render();
  }

  function render() {
    const hasServer = Boolean(state.serverUrl);
    const offline = isOfflinePage && !isSettings && hasServer;

    $("offline").hidden = !offline;
    if (offline) $("offline-url").textContent = state.serverUrl;

    const input = $("server-url");
    if (hasServer && !input.dataset.touched) input.value = state.serverUrl;
    $("server-save").textContent = hasServer ? "Save" : "Connect";
    $("server-save").className = hasServer ? "wide" : "primary wide";
    $("server-hint").textContent = hasServer
      ? "Change this only if your server moved. You'll need to sign in again."
      : "The address you open Dendrop at in a browser.";

    $("push-card").hidden = !hasServer;
    if (hasServer) renderPush(state.push);

    $("open").hidden = !hasServer || offline;
    $("open").textContent = isSettings ? "Back to Dendrop" : "Open Dendrop";
    $("tagline").textContent = hasServer ? state.serverUrl.replace(/^https?:\/\//, "") : "Your family's own chat.";
    $("version").textContent = state.appVersion ? `App version ${state.appVersion}` : "";
  }

  function renderPush(push) {
    if (state.platform === "ios") return renderPushIos(push);
    const status = $("push-status");
    const actions = $("push-actions");
    actions.replaceChildren();
    status.className = "status";

    const button = (label, primary, onClick) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (primary) b.className = "primary";
      b.addEventListener("click", onClick);
      actions.append(b);
      return b;
    };
    const link = (label, href) => {
      const a = document.createElement("a");
      a.className = "button";
      a.textContent = label;
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      actions.append(a);
    };

    if (!push.enabled) {
      if (push.distributors.length === 0) {
        status.textContent = "Install ntfy first, then come back here.";
        status.classList.add("warn");
        link("Get ntfy (F-Droid)", "https://f-droid.org/packages/io.heckel.ntfy/");
        link("Get ntfy (Play Store)", "https://play.google.com/store/apps/details?id=io.heckel.ntfy");
        button("I installed it", false, () => void refresh());
      } else {
        status.textContent = "Off";
        button("Turn on notifications", true, enablePush);
      }
      return;
    }

    if (!push.notificationsAllowed) {
      status.textContent = "Android is blocking Dendrop's notifications. Allow them in the app's settings.";
      status.classList.add("warn");
    } else if (!push.hasEndpoint) {
      status.textContent = "Waiting for ntfy to connect…";
      startPolling();
    } else if (push.serverStatus === "synced") {
      status.textContent = "On. This phone gets notifications.";
      status.classList.add("ok");
    } else if (push.serverStatus === "server-unsupported") {
      status.textContent = "Ready on this phone, but your server doesn't send phone notifications yet. They'll start once it's updated.";
      status.classList.add("warn");
    } else if (push.serverStatus === "error") {
      status.textContent = "Ready on this phone. Couldn't tell your server yet; the app will keep trying.";
      status.classList.add("warn");
    } else {
      status.textContent = "Ready on this phone. Sign in to Dendrop to finish.";
    }
    button("Turn off", false, async () => {
      await native("disablePush");
      await refresh();
    });
  }

  // iPhones get pushes from Apple: no extra app to install, and calls ring on iOS's own call screen.
  function renderPushIos(push) {
    $("push-intro").textContent =
      "Notifications come through Apple, and calls ring like a phone call, even when the iPhone is locked. " +
      "A notification only says that something arrived, never what was said or who said it.";
    const status = $("push-status");
    const actions = $("push-actions");
    actions.replaceChildren();
    status.className = "status";
    const button = (label, primary, onClick) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (primary) b.className = "primary";
      b.addEventListener("click", onClick);
      actions.append(b);
    };

    if (!push.enabled) {
      status.textContent = "Off";
      button("Turn on notifications", true, enablePush);
      return;
    }
    if (!push.notificationsAllowed) {
      status.textContent = "iOS is blocking Dendrop's notifications. Allow them in Settings, Dendrop, Notifications.";
      status.classList.add("warn");
    } else if (!push.hasEndpoint) {
      status.textContent = "Waiting for Apple…";
      startPolling();
    } else if (push.serverStatus === "synced") {
      status.textContent = "On. This iPhone gets notifications and calls.";
      status.classList.add("ok");
    } else if (push.serverStatus === "server-no-apns") {
      status.textContent = "Ready on this iPhone, but your server doesn't have an Apple push key yet, so nothing arrives. Whoever runs the server can add one (see the iPhone app's README).";
      status.classList.add("warn");
    } else if (push.serverStatus === "server-unsupported") {
      status.textContent = "Ready on this iPhone, but your server doesn't send iPhone notifications yet. They'll start once it's updated.";
      status.classList.add("warn");
    } else if (push.serverStatus === "error") {
      status.textContent = "Ready on this iPhone. Couldn't tell your server yet; the app will keep trying.";
      status.classList.add("warn");
    } else {
      status.textContent = "Ready on this iPhone. Sign in to Dendrop to finish.";
    }
    button("Turn off", false, async () => {
      await native("disablePush");
      await refresh();
    });
  }

  async function enablePush() {
    const result = await native("enablePush");
    if (!result.ok && result.reason === "permission-denied") {
      $("push-status").textContent =
        state.platform === "ios"
          ? "Notifications weren't allowed. You can turn them on later in Settings, Dendrop, Notifications."
          : "Notifications weren't allowed. You can turn them on later in Android's settings for Dendrop.";
      $("push-status").className = "status warn";
      return;
    }
    await refresh();
    startPolling();
  }

  // The distributor answers in the background, so look again for a little while.
  function startPolling() {
    if (pollTimer) return;
    let left = 15;
    pollTimer = setInterval(async () => {
      await refresh();
      if (--left <= 0 || (state.push.hasEndpoint && state.push.serverStatus !== "not-synced")) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 2000);
  }

  $("server-url").addEventListener("input", (e) => (e.target.dataset.touched = "1"));

  $("server-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const save = $("server-save");
    const error = $("server-error");
    error.hidden = true;
    save.disabled = true;
    save.textContent = "Checking…";
    try {
      const before = state && state.serverUrl;
      const result = await native("setServer", { url: $("server-url").value });
      $("server-url").dataset.touched = "";
      await refresh();
      // A server that moved is opened straight away; a first setup goes on to notifications.
      if (before && before !== result.serverUrl) await native("openServer");
    } catch (err) {
      error.textContent = (err && err.message) || String(err);
      error.hidden = false;
      render();
    } finally {
      save.disabled = false;
    }
  });

  $("open").addEventListener("click", () => void native("openServer"));
  $("retry").addEventListener("click", () => location.replace(state.serverUrl + "/"));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });

  void refresh();

  function previewNative() {
    const s = {
      serverUrl: null,
      appVersion: "preview",
      push: { enabled: false, notificationsAllowed: true, distributors: ["io.heckel.ntfy"], hasEndpoint: false, serverStatus: "not-synced" },
    };
    return async (method, options) => {
      if (method === "getState") return JSON.parse(JSON.stringify(s));
      if (method === "setServer") {
        if (!options.url.includes(".")) throw new Error("That doesn't look like a web address. Try something like chat.example.com.");
        s.serverUrl = "https://" + options.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        return { serverUrl: s.serverUrl };
      }
      if (method === "enablePush") {
        Object.assign(s.push, { enabled: true, hasEndpoint: true, serverStatus: "server-unsupported" });
        return { ok: true };
      }
      if (method === "disablePush") Object.assign(s.push, { enabled: false, hasEndpoint: false });
      return {};
    };
  }
})();
