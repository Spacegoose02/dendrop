import { contextBridge, ipcRenderer } from "electron";

/**
 * window.dendrop tells the web client it runs in the desktop app. Calls only work from the
 * configured server's pages (checked in main.ts), so a link to another site can't use them.
 */
contextBridge.exposeInMainWorld("dendrop", {
  version: 1,
  platform: process.platform,
  /** The app's settings (tray, startup, notifications, updates); pass a patch to change them. */
  appSettings: (patch?: object) => ipcRenderer.invoke("dd:appSettings", patch),
  checkForUpdates: () => ipcRenderer.invoke("dd:checkForUpdates"),
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
