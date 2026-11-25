import { contextBridge, ipcRenderer } from "electron";
import { DEFAULT_TITLE_BAR, FULL_SCREEN_CLASS, themedTitleBar, TITLE_BAR_ID, type TitleBarColors } from "./titlebar.js";

/**
 * window.dendrop tells the web client it runs in the desktop app. Calls only work from the
 * configured server's pages (checked in main.ts), so a link to another site can't use them.
 */
contextBridge.exposeInMainWorld("dendrop", {
  version: 1,
  platform: process.platform,
  /** This app opens the server's ?popout= pages in app windows. Older apps sent them to the browser. */
  popOutWindows: true,
  /** The app's settings (tray, startup, notifications, updates); pass a patch to change them. */
  appSettings: (patch?: object) => ipcRenderer.invoke("dd:appSettings", patch),
  checkForUpdates: () => ipcRenderer.invoke("dd:checkForUpdates"),
  /** Restarts into a downloaded update (the page's update button). */
  installUpdate: () => ipcRenderer.invoke("dd:installUpdate"),
  changeServer: () => ipcRenderer.invoke("dd:changeServer"),
  /** Screens and windows to share, for the app's own picker; then pickScreen says which before sharing. */
  screenSources: () => ipcRenderer.invoke("dd:screenSources"),
  pickScreen: (id: string | null, audio: boolean) => ipcRenderer.invoke("dd:pickScreen", id, audio),
  /** Mute and deafen shortcuts that work while the app is in the background; says which took. */
  setShortcuts: (accelerators: Record<string, string | null>) => ipcRenderer.invoke("dd:setShortcuts", accelerators),
  /** Push to talk while the app is in the background: a combo turns it on, null off. Says whether it runs. */
  backgroundPtt: (combo: object | null) => ipcRenderer.invoke("dd:backgroundPtt", combo),
  onPtt: (cb: (held: boolean) => void) => {
    const listener = (_e: unknown, held: boolean) => cb(held === true);
    ipcRenderer.on("dd:ptt", listener);
    return () => void ipcRenderer.off("dd:ptt", listener);
  },
  /** What the in-game overlay shows: the voice channel you're in, who's talking, the last few messages. */
  overlayState: (state: object | null) => ipcRenderer.invoke("dd:overlayState", state),
  /** Quick messages typed in the overlay: send it, then the promise's result goes back to the overlay. */
  onOverlayChat: (cb: (text: string) => Promise<void>) => {
    const listener = (_e: unknown, id: number, text: string) => {
      void cb(String(text)).then(
        () => ipcRenderer.invoke("dd:overlayChatResult", id, null),
        (err: Error) => ipcRenderer.invoke("dd:overlayChatResult", id, err?.message || "Couldn't send"),
      );
    };
    ipcRenderer.on("dd:overlayChat", listener);
    return () => void ipcRenderer.off("dd:overlayChat", listener);
  },
  onShortcut: (cb: (action: string) => void) => {
    const listener = (_e: unknown, action: string) => cb(action);
    ipcRenderer.on("dd:shortcut", listener);
    return () => void ipcRenderer.off("dd:shortcut", listener);
  },
});

// The bundled setup and offline pages (checked in main.ts too).
contextBridge.exposeInMainWorld("dendropSetup", {
  connect: (url: string) => ipcRenderer.invoke("dd:setServer", url),
  retry: () => ipcRenderer.invoke("dd:retry"),
  changeServer: () => ipcRenderer.invoke("dd:changeServer"),
});

// The themed title bar (titlebar.ts): a bar to drag the window by, under the window buttons,
// in the theme's colors. The main process only adds its styles to windows that hide the system bar.
if (themedTitleBar(process.platform)) {
  let sent = "";
  /** The page's theme colors for the window buttons; the Den theme's on pages without them. */
  const colors = (): TitleBarColors => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return { color: read("--dd-bg-rail", DEFAULT_TITLE_BAR.color), symbolColor: read("--dd-text", DEFAULT_TITLE_BAR.symbolColor) };
  };
  const sync = () => {
    let bar = document.getElementById(TITLE_BAR_ID);
    if (!bar) {
      bar = document.createElement("div");
      bar.id = TITLE_BAR_ID;
      bar.setAttribute("aria-hidden", "true");
    }
    // A modal dialog (Settings) sits above everything else on the page, so the bar moves into it.
    const host = document.querySelector("dialog:modal") ?? document.documentElement;
    if (bar.parentElement !== host) host.append(bar);
    const title = document.title || "Dendrop";
    if (bar.textContent !== title) bar.textContent = title;
    const c = JSON.stringify(colors());
    if (c !== sent) {
      sent = c;
      void ipcRenderer.invoke("dd:titleBarColors", JSON.parse(c)).catch(() => {});
    }
  };
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      sync();
    }, 0);
  };
  window.addEventListener("DOMContentLoaded", () => {
    sync();
    // A theme change sets new colors on <html>; the page's title changes with unread counts;
    // dialogs open and close.
    new MutationObserver(later).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    new MutationObserver(later).observe(document.head, { childList: true, subtree: true, characterData: true });
    new MutationObserver(later).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["open"] });
  });
  ipcRenderer.on("dd:fullScreen", (_e, on: boolean) => document.documentElement.classList.toggle(FULL_SCREEN_CLASS, on === true));
}
