import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, screen, session, shell, Tray, type IpcMainInvokeEvent } from "electron";
import WebSocket from "ws";
import type { Conversation, ServerEvent } from "@dendrop/shared";
import { isExternalLink, isFile, isPopout, onOrigin, permissionAllowed } from "./links.js";
import { GatewayWatcher, notificationFor, Throttle, type SocketLike } from "./notify.js";
import {
  cleanOverlayState,
  cleanQuickChat,
  DEFAULT_OVERLAY_HOTKEY,
  EMPTY_OVERLAY,
  isOverlayCorner,
  isOverlayMode,
  overlayBounds,
  overlayVisible,
  type OverlayCorner,
  type OverlayMode,
  type OverlayState,
} from "./overlay.js";
import { cleanCombo, setBackgroundPtt, stopBackgroundPtt } from "./ptt.js";
import { normalizeServerUrl, originOf } from "./serverUrl.js";
import { SettingsStore, type DesktopSettings } from "./settings.js";
import { downloadUpdate, findUpdate, installKind, launchUpdate, verifyUpdate, type AvailableUpdate } from "./updater.js";

const APP_ID = "io.github.spacegoose02.dendrop";
/** The Den theme's main background (--dd-bg-main), so the window doesn't flash white while loading. */
const BACKGROUND = "#20242a";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: SettingsStore;
let watcher: GatewayWatcher;
/** Set once the app is really quitting, so closing the window stops hiding it. */
let quitting = false;
/** Started at login: stay in the tray until opened. */
const startHidden = process.argv.includes("--hidden");
/** New messages since the window last had focus. */
let unread = 0;
/** Whether the app's own gateway connection is up and signed in (shown in the tray). */
let listening = false;

// The same data folder in development as in the installed app (which is named "Dendrop").
app.setName("Dendrop");
app.setPath("userData", path.join(app.getPath("appData"), "Dendrop"));
if (!app.requestSingleInstanceLock()) app.quit();
// Windows only shows notifications for an app with an id that matches its Start menu shortcut.
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

const SETUP_PAGE = path.join(__dirname, "..", "setup", "index.html");
const OFFLINE_PAGE = path.join(__dirname, "..", "setup", "offline.html");
const OVERLAY_PAGE = path.join(__dirname, "..", "setup", "overlay.html");
const asset = (name: string) => path.join(__dirname, "..", "build", name);

const origin = () => originOf(settings.get().serverUrl);

/** IPC from the server's own pages only. */
function fromServer(e: IpcMainInvokeEvent): void {
  if (!onOrigin(e.senderFrame?.url ?? "", origin())) throw new Error("Not allowed from this page");
}

/** IPC from one of the app's bundled pages only, not any file:// page. */
function fromPage(e: IpcMainInvokeEvent, ...pages: string[]): void {
  const url = e.senderFrame?.url ?? "";
  if (!pages.some((p) => isFile(url, p))) throw new Error("Not allowed from this page");
}

/** Whether a Dendrop server answers at the address within a few seconds. */
async function serverUp(at: string): Promise<boolean> {
  if (!at) return false;
  try {
    const res = await net.fetch(`${at}/api/health`, { signal: AbortSignal.timeout(5000) });
    return ((await res.json()) as { status?: string }).status === "ok";
  } catch {
    return false;
  }
}

/** The window's sign-in cookies for the server, as a Cookie header. */
async function cookieHeader(at = origin()): Promise<string> {
  if (!at) return "";
  const cookies = await session.defaultSession.cookies.get({ url: at });
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** A JSON GET to the server with the window's sign-in. */
async function serverJson<T>(apiPath: string): Promise<T> {
  const res = await fetch(`${origin()}${apiPath}`, { headers: { Cookie: await cookieHeader() }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`The server answered ${res.status}`);
  return (await res.json()) as T;
}

function openExternal(url: string): void {
  if (isExternalLink(url)) void shell.openExternal(url);
}

// ---- Window ---------------------------------------------------------------------------

function showWindow(): void {
  if (!win) return void createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** The window is on another site than the server, which only a sign-in redirect (TinyAuth) leads to. */
function onSignInPages(): boolean {
  const current = win?.webContents.getURL() ?? "";
  return !!origin() && /^https?:\/\//.test(current) && !onOrigin(current, origin());
}

function showOffline(): void {
  void win?.loadFile(OFFLINE_PAGE, { query: { server: origin() } });
}

/** Loads the server, or the setup page when there isn't one, or the offline page when it's down. */
async function loadHome(): Promise<void> {
  if (!win) return;
  const at = origin();
  if (!at) return void (await win.loadFile(SETUP_PAGE));
  // A reverse proxy answers with its own error page when the server behind it is down, so ask the server itself first.
  if (!(await serverUp(at))) return showOffline();
  await win.loadURL(at).catch(() => {});
}

function saveBounds(): void {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  settings.update({ bounds: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
}

async function createWindow(): Promise<void> {
  const b = settings.get().bounds;
  win = new BrowserWindow({
    width: b?.width ?? 1200,
    height: b?.height ?? 800,
    x: b?.x,
    y: b?.y,
    minWidth: 380,
    minHeight: 500,
    backgroundColor: BACKGROUND,
    show: !(startHidden && tray),
    autoHideMenuBar: true,
    title: "Dendrop",
    icon: asset("icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  if (b?.maximized) win.maximize();
  Menu.setApplicationMenu(null);

  // Links in messages open in the system browser, never in a new app window. The one exception
  // is a pop-out chat: the app's own page with ?popout=, in a small window of its own.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isPopout(url, origin())) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 460,
          height: 720,
          minWidth: 320,
          minHeight: 400,
          backgroundColor: BACKGROUND,
          autoHideMenuBar: true,
          title: "Dendrop",
          icon: asset("icon.png"),
          webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
        },
      };
    }
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-create-window", (child) => {
    // A pop-out follows the same rules as the main window: links go to the browser.
    child.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });
    child.webContents.on("will-navigate", (event, url) => {
      if (onOrigin(url, origin())) return;
      event.preventDefault();
      openExternal(url);
    });
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isFile(url, SETUP_PAGE) || isFile(url, OFFLINE_PAGE) || onOrigin(url, origin())) return;
    // Single sign-on: the server redirects the window to TinyAuth, which may hand on to another
    // provider. Those pages keep their cookies here, so they stay until it sends the window back.
    if (onSignInPages() && /^https?:\/\//.test(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  // A reload or a new page never asked for background push to talk: stop the keyboard hook.
  win.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      stopBackgroundPtt();
      setOverlayState(EMPTY_OVERLAY);
    }
  });
  win.webContents.on("render-process-gone", () => {
    stopBackgroundPtt();
    setOverlayState(EMPTY_OVERLAY);
  });
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    // -3 is a load replaced by another navigation, not a failure.
    if (isMainFrame && code !== -3 && onOrigin(url, origin())) showOffline();
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    const zoom = win?.webContents.getZoomLevel() ?? 0;
    if (ctrl && (input.key === "=" || input.key === "+")) win?.webContents.setZoomLevel(Math.min(zoom + 0.5, 4));
    else if (ctrl && input.key === "-") win?.webContents.setZoomLevel(Math.max(zoom - 0.5, -3));
    else if (ctrl && input.key === "0") win?.webContents.setZoomLevel(0);
    else if (input.key === "F5" || (ctrl && input.key.toLowerCase() === "r")) void loadHome();
    else if (input.key === "Escape" && onSignInPages()) void loadHome(); // Back out of a sign-in.
    else return;
    event.preventDefault();
  });

  win.on("focus", clearUnread);
  win.on("resized", saveBounds);
  win.on("moved", saveBounds);
  // Closing hides the window to the tray, so messages still notify.
  win.on("close", (event) => {
    saveBounds();
    if (quitting || !tray || !settings.get().closeToTray) return;
    event.preventDefault();
    win?.hide();
    if (!settings.get().trayHintShown) {
      settings.update({ trayHintShown: true });
      if (Notification.isSupported())
        new Notification({ title: "Dendrop is still running", body: "You'll still hear about new messages. Right-click the raccoon in the tray to quit or change this." }).show();
    }
    if (update.state === "ready" && settings.get().autoUpdate) void installNow();
  });
  win.on("closed", () => {
    win = null;
    // The overlay only shows what the window tells it; without the window it goes too.
    setOverlayState(EMPTY_OVERLAY);
    overlay?.destroy();
  });
  await loadHome();
}

// ---- Notifications --------------------------------------------------------------------

const throttle = new Throttle();
const conversations = new Map<number, Conversation>();

/** Names for "New message from …", fetched only when that setting is on. */
async function conversation(id: number): Promise<Conversation | undefined> {
  if (!conversations.has(id)) {
    try {
      for (const c of await serverJson<Conversation[]>("/api/conversations")) conversations.set(c.id, c);
    } catch {
      // Older server or offline: the notification just says "New message".
    }
  }
  return conversations.get(id);
}

const windowInFront = () => !!win && win.isVisible() && win.isFocused() && !win.isMinimized();

async function onGatewayEvent(event: ServerEvent, meId: number): Promise<void> {
  if (event.type === "conversation.created") conversations.set(event.conversation.id, event.conversation);
  const s = settings.get();
  if (!s.notifications || windowInFront()) return;
  const id = event.type === "message.created" ? event.message.conversationId : undefined;
  if (s.notifySender && id !== undefined) await conversation(id);
  const content = notificationFor(event, { meId, notifySender: s.notifySender, conversation: (cid) => conversations.get(cid) });
  if (!content) return;
  if (event.type === "message.created") setUnread(unread + 1);
  if (!throttle.allow(String(content.conversationId ?? content.body)) || !Notification.isSupported()) return;
  const n = new Notification({ title: content.title, body: content.body, icon: asset("icon.png") });
  n.on("click", showWindow);
  n.show();
}

function setUnread(count: number): void {
  unread = count;
  app.setBadgeCount(count); // The Linux launcher (Unity, KDE); ignored elsewhere.
  if (process.platform === "win32" && win) win.setOverlayIcon(count ? nativeImage.createFromPath(asset("badge.png")) : null, count ? `${count} new messages` : "");
  if (count) win?.flashFrame(true);
  refreshTray();
}

function clearUnread(): void {
  win?.flashFrame(false);
  if (unread) setUnread(0);
}

function openSocket(url: string, headers: Record<string, string>): SocketLike {
  return new WebSocket(url, { headers, handshakeTimeout: 15_000 }) as unknown as SocketLike;
}

// ---- Tray -----------------------------------------------------------------------------

function trayImage(): Electron.NativeImage {
  return nativeImage.createFromPath(asset(unread ? "tray-unread.png" : "tray.png")).resize({ width: 16, height: 16 });
}

function toggle(key: "openAtLogin" | "closeToTray" | "notifications" | "notifySender" | "autoUpdate"): Electron.MenuItemConstructorOptions["click"] {
  return (item) => {
    const s = settings.update({ [key]: item.checked });
    if (key === "openAtLogin") void applyLoginItem(s);
    if (key === "autoUpdate" && s.autoUpdate) void checkForUpdate();
    refreshTray();
  };
}

function refreshTray(): void {
  if (!tray) return;
  const s = settings.get();
  tray.setImage(trayImage());
  const status = !origin() ? "Not set up yet" : listening ? "Connected" : "Not connected or signed out";
  tray.setToolTip(`Dendrop${unread ? ` · ${unread} new message${unread === 1 ? "" : "s"}` : ""}`);
  const u = update;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Dendrop", click: showWindow },
      { label: status, enabled: false },
      { type: "separator" },
      { label: "Open when this PC starts", type: "checkbox", checked: s.openAtLogin, click: toggle("openAtLogin") },
      { label: "Keep running when closed", type: "checkbox", checked: s.closeToTray, click: toggle("closeToTray") },
      { label: "Message notifications", type: "checkbox", checked: s.notifications, click: toggle("notifications") },
      { label: "Show who messages are from", type: "checkbox", checked: s.notifySender, enabled: s.notifications, click: toggle("notifySender") },
      { label: "Install updates automatically", type: "checkbox", checked: s.autoUpdate, click: toggle("autoUpdate") },
      {
        label: "In-game overlay",
        submenu: [
          ...OVERLAY_MODE_LABELS.map(([mode, label]) => ({
            label,
            type: "radio" as const,
            checked: overlayMode() === mode,
            click: () => setOverlaySettings({ overlay: mode }),
          })),
          { type: "separator" as const },
          ...OVERLAY_CORNER_LABELS.map(([corner, label]) => ({
            label,
            type: "radio" as const,
            checked: overlayCorner() === corner,
            click: () => setOverlaySettings({ overlayCorner: corner }),
          })),
          { type: "separator" as const },
          { label: `${overlayHotkey()} makes it clickable to chat`, enabled: false },
        ],
      },
      { label: "Change server…", click: () => void changeServer() },
      { type: "separator" },
      u.state === "ready"
        ? { label: `Restart to update to ${u.version}`, click: () => void installNow() }
        : u.state === "downloading"
          ? { label: `Downloading update ${u.version}…`, enabled: false }
          : u.state === "unsupported"
            ? { label: `Version ${app.getVersion()}`, enabled: false }
            : { label: "Check for updates", click: () => void checkForUpdate(true) },
      { type: "separator" },
      { label: "Quit Dendrop", click: () => void quitApp() },
    ]),
  );
}

function createTray(): void {
  if (tray) return;
  try {
    tray = new Tray(trayImage());
  } catch {
    tray = null; // No tray on this desktop: closing quits instead.
    return;
  }
  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  refreshTray();
}

async function changeServer(): Promise<void> {
  settings.update({ serverUrl: "" });
  conversations.clear();
  watcher.poke();
  showWindow();
  await loadHome();
  refreshTray();
}

async function quitApp(): Promise<void> {
  quitting = true;
  if (update.state === "ready" && update.file) await launchUpdate(installKind(), update.file).catch(() => {});
  app.quit();
}

// ---- Open when the PC starts ----------------------------------------------------------

/**
 * The file to start. The portable build runs from a copy it unpacks into the temp folder,
 * gone after a restart, so name the portable .exe itself; an AppImage likewise names its file.
 */
const appExe = () => process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath;
/** The Run key value. Fixed, so the uninstaller can remove it (build/installer.nsh). */
const LOGIN_ITEM_NAME = "Dendrop";
const AUTOSTART_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart", "dendrop.desktop");

/** Windows: the Run key. Linux: an XDG autostart entry, which GNOME, KDE and most desktops read. */
async function applyLoginItem(s: DesktopSettings): Promise<void> {
  if (process.platform === "win32") {
    app.setLoginItemSettings({ openAtLogin: s.openAtLogin, name: LOGIN_ITEM_NAME, path: appExe(), args: ["--hidden"] });
    return;
  }
  if (process.platform !== "linux" || !app.isPackaged) return;
  if (!s.openAtLogin) return void (await rm(AUTOSTART_FILE, { force: true }).catch(() => {}));
  await mkdir(path.dirname(AUTOSTART_FILE), { recursive: true });
  const quote = (p: string) => `"${p.replace(/(["`$\\])/g, "\\$1")}"`;
  await writeFile(
    AUTOSTART_FILE,
    ["[Desktop Entry]", "Type=Application", "Name=Dendrop", "Comment=Private chat for family and friends", `Exec=${quote(appExe())} --hidden`, "Icon=dendrop", "Terminal=false", "X-GNOME-Autostart-enabled=true", ""].join("\n"),
  );
}

// ---- App updates ----------------------------------------------------------------------

interface UpdateState {
  state: "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error" | "unsupported";
  version?: string;
  error?: string;
  /** The downloaded installer or app file, once state is "ready". */
  file?: string;
}
let update: UpdateState = { state: installKind() === "other" ? "unsupported" : "idle" };

function setUpdate(next: UpdateState): void {
  update = next;
  refreshTray();
}

/**
 * Looks at the latest GitHub release for a newer build of this app, downloads it, checks it
 * against that release's SHA256SUMS, and installs it when the window is closed.
 */
async function checkForUpdate(manual = false): Promise<void> {
  const kind = installKind();
  if (kind === "other") return;
  if (update.state === "downloading" || update.state === "checking" || (update.state === "ready" && !manual)) return;
  setUpdate({ state: "checking" });
  let found: AvailableUpdate | null;
  try {
    found = await findUpdate((u, i) => net.fetch(u, i), app.getVersion(), kind);
  } catch (err) {
    setUpdate({ state: "error", error: (err as Error).message });
    return;
  }
  if (!found) return setUpdate({ state: "none" });
  setUpdate({ state: "available", version: found.version });
  if (manual || settings.get().autoUpdate) await fetchUpdate(found);
}

async function fetchUpdate(found: AvailableUpdate): Promise<void> {
  const target = path.join(app.getPath("temp"), "dendrop-update", found.file);
  try {
    setUpdate({ state: "downloading", version: found.version });
    await downloadUpdate((u, i) => net.fetch(u, i), found.url, {}, target, () => {});
    if (!settings.get().allowUnverifiedUpdates) await verifyUpdate((u, i) => net.fetch(u, i), found, target);
    setUpdate({ state: "ready", version: found.version, file: target });
    if (!win?.isVisible() && settings.get().autoUpdate) await installNow();
  } catch (err) {
    setUpdate({ state: "error", version: found.version, error: (err as Error).message });
  }
}

async function installNow(): Promise<void> {
  if (update.state !== "ready" || !update.file) return;
  quitting = true;
  try {
    await launchUpdate(installKind(), update.file);
  } catch (err) {
    quitting = false;
    setUpdate({ state: "error", version: update.version, error: (err as Error).message });
    return;
  }
  app.quit();
}

// ---- In-game overlay ----------------------------------------------------------------------
// A see-through window over the game with who's in voice and who's talking (see overlay.ts).
// It lets clicks through to the game until the hotkey makes it clickable for a quick message.
// Games in exclusive full screen draw over every window, so it shows over borderless or
// windowed games only.

const OVERLAY_MODE_LABELS: [OverlayMode, string][] = [
  ["game", "Show while I'm playing (LootDen) and in voice"],
  ["voice", "Show whenever I'm in voice"],
  ["off", "Off"],
];
const OVERLAY_CORNER_LABELS: [OverlayCorner, string][] = [
  ["top-left", "Top left"],
  ["top-right", "Top right"],
  ["bottom-left", "Bottom left"],
  ["bottom-right", "Bottom right"],
];

let overlay: BrowserWindow | null = null;
let overlayState: OverlayState = EMPTY_OVERLAY;
let overlayInteractive = false;
/** The hotkey registered right now, if any (only while the overlay is up). */
let overlayKey: string | null = null;
/** Quick messages waiting for the main window to say whether they went. */
const quickChats = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();
let quickChatId = 0;

const overlayMode = (): OverlayMode => (isOverlayMode(settings.get().overlay) ? settings.get().overlay : "game");
const overlayCorner = (): OverlayCorner => (isOverlayCorner(settings.get().overlayCorner) ? settings.get().overlayCorner : "top-left");
const overlayHotkey = () => settings.get().overlayHotkey || DEFAULT_OVERLAY_HOTKEY;

function setOverlaySettings(patch: Partial<Pick<DesktopSettings, "overlay" | "overlayCorner">>): void {
  const cornerChanged = !!patch.overlayCorner && patch.overlayCorner !== overlayCorner();
  settings.update(patch);
  // The page lays itself out for top or bottom corners, so it's made again.
  if (cornerChanged && overlay) {
    overlay.destroy();
    overlay = null;
  }
  updateOverlay();
  refreshTray();
}

function createOverlay(): BrowserWindow {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const o = new BrowserWindow({
    ...overlayBounds(area, overlayCorner()),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    title: "Dendrop overlay",
    webPreferences: { preload: path.join(__dirname, "overlay-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  // Above games in borderless full screen, too.
  o.setAlwaysOnTop(true, "screen-saver");
  o.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  o.setIgnoreMouseEvents(true);
  o.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  o.webContents.on("will-navigate", (e) => e.preventDefault());
  o.webContents.on("did-finish-load", () => sendOverlay());
  o.on("blur", () => setOverlayInteractive(false));
  o.on("closed", () => {
    if (overlay === o) overlay = null;
  });
  void o.loadFile(OVERLAY_PAGE, { query: { corner: overlayCorner() } });
  return o;
}

function sendOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send("ov:state", overlayState, overlayInteractive, overlayHotkey());
}

/** Shows or hides the overlay for the latest state, and registers its hotkey only while it's up. */
function updateOverlay(): void {
  const visible = overlayVisible(overlayState, overlayMode());
  if (!visible) {
    setOverlayInteractive(false);
    overlay?.hide();
    if (overlayKey) globalShortcut.unregister(overlayKey);
    overlayKey = null;
    return;
  }
  overlay ??= createOverlay();
  sendOverlay();
  if (!overlay.isVisible()) {
    // On the screen you're on (the game's), in the chosen corner.
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    overlay.setBounds(overlayBounds(area, overlayCorner()));
    overlay.showInactive();
  }
  const key = overlayHotkey();
  if (overlayKey !== key) {
    if (overlayKey) globalShortcut.unregister(overlayKey);
    overlayKey = null;
    try {
      if (!Object.values(shortcuts).includes(key) && globalShortcut.register(key, () => setOverlayInteractive(!overlayInteractive))) overlayKey = key;
    } catch {
      overlayKey = null; // Not a key Electron knows: the overlay still shows, without chat.
    }
  }
}

function setOverlayState(state: OverlayState): void {
  overlayState = state;
  updateOverlay();
}

/** Clickable (for a quick message) or not (clicks go through to the game). */
function setOverlayInteractive(on: boolean): void {
  if (on && (!overlay || !overlay.isVisible())) return;
  if (overlayInteractive === on) return;
  overlayInteractive = on;
  if (overlay && !overlay.isDestroyed()) {
    overlay.setIgnoreMouseEvents(!on);
    overlay.setFocusable(on);
    if (on) overlay.focus();
    else overlay.blur();
  }
  sendOverlay();
}

/** Asks the main window to send a quick message to the voice channel's chat. */
function quickChat(text: string): Promise<void> {
  const target = win?.webContents;
  if (!target || target.isDestroyed()) return Promise.reject(new Error("Dendrop isn't open"));
  const id = ++quickChatId;
  return new Promise((resolve, reject) => {
    quickChats.set(id, { resolve, reject });
    target.send("dd:overlayChat", id, text);
    setTimeout(() => {
      if (quickChats.delete(id)) reject(new Error("No answer from Dendrop"));
    }, 15_000);
  });
}

// ---- IPC ------------------------------------------------------------------------------

type AppSettingsPatch = Partial<Pick<DesktopSettings, "closeToTray" | "openAtLogin" | "notifications" | "notifySender" | "autoUpdate">>;
const SETTING_KEYS = ["closeToTray", "openAtLogin", "notifications", "notifySender", "autoUpdate"] as const;

// ---- Screen sharing ----------------------------------------------------------------------
// Electron has no screen picker of its own on Windows and Linux. The web client shows its own
// (a list of screens and windows from dd:screenSources), says which one with dd:pickScreen, and
// then asks for the screen as a browser would; the display media handler hands over that one.

let pickedScreen: { id: string; audio: boolean; at: number } | null = null;

function screenSharing(ses: Electron.Session): void {
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const pick = pickedScreen;
    pickedScreen = null;
    // Only the server's pages, and only right after someone picked a screen in the app.
    if (!onOrigin(request.frame?.url ?? "", origin()) || !pick || Date.now() - pick.at > 30_000) return callback(null);
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"] }).catch(() => []);
    const source = sources.find((x) => x.id === pick.id);
    if (!source) return callback(null);
    // Sound from the whole PC ("loopback") works on Windows; elsewhere the screen is shared without it.
    callback({ video: source, ...(pick.audio && process.platform === "win32" ? { audio: "loopback" as const } : {}) });
  });
}

// ---- Voice shortcuts ---------------------------------------------------------------------
// Mute and deafen work while Dendrop is in the background. Electron's shortcuts only see the
// keys registered here (no keyboard hook), and they fire on press only, so push-to-talk stays
// in the window.

const SHORTCUT_ACTIONS = ["mute", "deafen"] as const;
let shortcuts: Partial<Record<(typeof SHORTCUT_ACTIONS)[number], string>> = {};

function setShortcuts(wanted: Record<string, unknown>): Record<string, boolean> {
  for (const acc of Object.values(shortcuts)) if (acc) globalShortcut.unregister(acc);
  shortcuts = {};
  const ok: Record<string, boolean> = {};
  for (const action of SHORTCUT_ACTIONS) {
    const acc = wanted[action];
    ok[action] = false;
    if (typeof acc !== "string" || !acc || acc.length > 64 || Object.values(shortcuts).includes(acc)) continue;
    try {
      ok[action] = globalShortcut.register(acc, () => win?.webContents.send("dd:shortcut", action));
    } catch {
      ok[action] = false;
    }
    if (ok[action]) shortcuts[action] = acc;
  }
  return ok;
}

function registerIpc(): void {
  // The in-game overlay: the page sends what to show; the overlay page sends quick messages back.
  ipcMain.handle("dd:overlayState", (e, state: unknown) => {
    fromServer(e);
    setOverlayState(cleanOverlayState(state));
  });
  ipcMain.handle("dd:overlayChatResult", (e, id: unknown, error: unknown) => {
    fromServer(e);
    const p = typeof id === "number" ? quickChats.get(id) : undefined;
    if (!p) return;
    quickChats.delete(id as number);
    if (typeof error === "string" && error) p.reject(new Error(error.slice(0, 200)));
    else p.resolve();
  });
  ipcMain.handle("ov:chat", async (e, text: unknown) => {
    fromPage(e, OVERLAY_PAGE);
    const clean = cleanQuickChat(text);
    if (!clean || !overlayState.canChat) throw new Error("Nothing to send");
    await quickChat(clean);
  });
  ipcMain.handle("ov:voice", (e, action: unknown) => {
    fromPage(e, OVERLAY_PAGE);
    if (action === "mute" || action === "deafen") win?.webContents.send("dd:shortcut", action);
  });
  ipcMain.handle("ov:done", (e) => {
    fromPage(e, OVERLAY_PAGE);
    setOverlayInteractive(false);
  });

  // Push to talk in the background (see ptt.ts): the page turns it on while you're in voice with
  // push to talk, and off again; only "held" and "let go" come back.
  ipcMain.handle("dd:backgroundPtt", (e, combo: unknown) => {
    fromServer(e);
    const sender = e.sender;
    return setBackgroundPtt(cleanCombo(combo), (held) => {
      if (!sender.isDestroyed()) sender.send("dd:ptt", held);
    });
  });
  ipcMain.handle("dd:setShortcuts", (e, wanted: unknown) => {
    fromServer(e);
    return setShortcuts(wanted && typeof wanted === "object" ? (wanted as Record<string, unknown>) : {});
  });
  ipcMain.handle("dd:screenSources", async (e) => {
    fromServer(e);
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    return {
      audio: process.platform === "win32",
      sources: sources.map((x) => ({ id: x.id, name: x.name, kind: x.id.startsWith("screen:") ? "screen" : "window", thumbnail: x.thumbnail.toDataURL() })),
    };
  });
  ipcMain.handle("dd:pickScreen", (e, id: unknown, audio: unknown) => {
    fromServer(e);
    pickedScreen = typeof id === "string" ? { id, audio: audio === true, at: Date.now() } : null;
  });

  // The setup page: check the address really is a Dendrop server, then save it and load it.
  ipcMain.handle("dd:setServer", async (e, input: unknown) => {
    fromPage(e, SETUP_PAGE, OFFLINE_PAGE);
    const at = normalizeServerUrl(String(input ?? ""));
    if (!(await serverUp(at))) throw new Error(`No Dendrop server answered at ${at}. Check the address, and that this PC can reach it.`);
    settings.update({ serverUrl: at });
    conversations.clear();
    await win?.loadURL(at).catch(() => {});
    watcher.poke();
    refreshTray();
    void checkForUpdate();
  });
  ipcMain.handle("dd:retry", async (e) => {
    fromPage(e, OFFLINE_PAGE);
    if (!(await serverUp(origin()))) return false;
    await win?.loadURL(origin()).catch(() => {});
    watcher.poke();
    return true;
  });
  ipcMain.handle("dd:changeServer", async (e) => {
    const url = e.senderFrame?.url ?? "";
    if (!isFile(url, OFFLINE_PAGE)) fromServer(e);
    await changeServer();
  });
  // The web client can show these in its own settings later; the tray has them today.
  ipcMain.handle("dd:appSettings", (e, patch?: AppSettingsPatch) => {
    fromServer(e);
    if (patch && typeof patch === "object") {
      const clean: AppSettingsPatch = {};
      for (const k of SETTING_KEYS) if (typeof patch[k] === "boolean") clean[k] = patch[k];
      const s = settings.update(clean);
      if ("openAtLogin" in clean) void applyLoginItem(s);
      refreshTray();
    }
    const s = settings.get();
    return { ...Object.fromEntries(SETTING_KEYS.map((k) => [k, s[k]])), version: app.getVersion(), platform: process.platform, trayAvailable: !!tray, update: { state: update.state, version: update.version, error: update.error } };
  });
  ipcMain.handle("dd:checkForUpdates", async (e) => {
    fromServer(e);
    await checkForUpdate(true);
    return { state: update.state, version: update.version, error: update.error };
  });
}

// ---- Start ----------------------------------------------------------------------------

app.on("second-instance", () => showWindow());
app.on("before-quit", () => (quitting = true));
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopBackgroundPtt();
});
app.on("window-all-closed", () => {
  if (quitting || !tray || !settings.get().closeToTray) app.quit();
});

void app.whenReady().then(async () => {
  settings = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
  registerIpc();

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => callback(permissionAllowed(permission, details.requestingUrl, origin())));
  // The page's own Notification API stays off: the app shows its own, without message text.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permission !== "notifications" && permissionAllowed(permission, requestingOrigin, origin()));
  screenSharing(ses);

  watcher = new GatewayWatcher({
    origin,
    cookies: cookieHeader,
    open: openSocket,
    onEvent: (event, meId) => void onGatewayEvent(event, meId),
    onStatus: (online) => {
      listening = online;
      refreshTray();
    },
  });
  // Signing in or out in the window changes the session cookie: reconnect with it.
  let cookieTimer: NodeJS.Timeout | undefined;
  ses.cookies.on("changed", (_e, cookie) => {
    const at = origin();
    if (!at || !cookie.domain || !new URL(at).hostname.endsWith(cookie.domain.replace(/^\./, ""))) return;
    clearTimeout(cookieTimer);
    cookieTimer = setTimeout(() => watcher.poke(), 1000);
  });

  createTray();
  await applyLoginItem(settings.get()).catch(() => {});
  await createWindow();
  watcher.start();

  // The copy replaced by the last update, and its download.
  const self = process.env.PORTABLE_EXECUTABLE_FILE ?? process.env.APPIMAGE;
  if (self && existsSync(`${self}.old`)) void rm(`${self}.old`, { force: true }).catch(() => {});
  void rm(path.join(app.getPath("temp"), "dendrop-update"), { recursive: true, force: true }).catch(() => {});
  setTimeout(() => void checkForUpdate(), 30_000);
  setInterval(() => void checkForUpdate(), 4 * 3600_000);
});
