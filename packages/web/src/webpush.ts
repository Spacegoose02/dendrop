import { api } from "./api.ts";
import { inIosApp } from "./native.ts";

/**
 * Notifications for Dendrop opened in a browser, on a phone or a PC: Web Push through the
 * browser's own push service, shown by public/sw.js. Like the Android and iPhone apps, a push
 * carries only "message", "mention", "call" or "event", never who or what.
 *
 * The phone apps and the PC app have notifications of their own, so this stays out of their way.
 */
export type WebPushState =
  /** Inside the Android, iPhone or PC app, which notify on their own. */
  | "app"
  /** iPhone or iPad Safari: Apple only allows it once Dendrop is added to the Home Screen. */
  | "needs-install"
  /** Opened over plain http://, where browsers don't allow push. */
  | "insecure"
  | "unsupported"
  /** Notifications were blocked for this site in the browser's settings. */
  | "denied"
  | "off"
  | "on";

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const inNativeApp = () => !!(window as { Capacitor?: unknown }).Capacitor || inIosApp() || !!(window as { dendrop?: unknown }).dendrop;
const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration("/")) ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function webPushState(): Promise<WebPushState> {
  if (inNativeApp()) return "app";
  if (!window.isSecureContext) return "insecure";
  if (!supported()) return isIos() && !standalone() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

const deviceName = (): string => {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "PC";
  return `${browser} on ${device}`;
};

async function save(sub: PushSubscription): Promise<void> {
  await api("/api/push/subscriptions", { method: "POST", body: { ...sub.toJSON(), provider: "webpush", deviceName: deviceName() } });
}

/** Asks the browser for permission and signs this browser up. Must run from a tap or click. */
export async function enableWebPush(): Promise<WebPushState> {
  if (!supported()) return webPushState();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return webPushState();
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const { vapidPublicKey } = await api<{ vapidPublicKey: string }>("/api/push/config");
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server key can't be used; start over.
  if (sub && sub.options.applicationServerKey && toBase64Url(sub.options.applicationServerKey) !== vapidPublicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(vapidPublicKey) });
  await save(sub);
  return "on";
}

export async function disableWebPush(): Promise<WebPushState> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api("/api/push/subscriptions", { method: "DELETE", body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  return webPushState();
}

/**
 * On every start: hands this browser's subscription to the server again (it may have been
 * signed in as someone else, or restored from a backup), and clears message notifications once
 * Dendrop is in front.
 */
export function startWebPush(): void {
  if (inNativeApp() || !supported() || !window.isSecureContext) return;
  void (async () => {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (sub && Notification.permission === "granted") await save(sub);
  })().catch(() => {});
  const clear = () => {
    if (document.visibilityState !== "visible") return;
    void navigator.serviceWorker
      .getRegistration("/")
      .then((reg) => reg?.getNotifications())
      .then((ns) => ns?.forEach((n) => n.tag !== "event" && n.tag !== "call" && n.close()))
      .catch(() => {});
  };
  clear();
  document.addEventListener("visibilitychange", clear);
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64Url(key: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(key)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
