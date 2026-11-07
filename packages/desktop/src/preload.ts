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
});

// The bundled setup and offline pages (checked in main.ts too).
contextBridge.exposeInMainWorld("dendropSetup", {
  connect: (url: string) => ipcRenderer.invoke("dd:setServer", url),
  retry: () => ipcRenderer.invoke("dd:retry"),
  changeServer: () => ipcRenderer.invoke("dd:changeServer"),
});
