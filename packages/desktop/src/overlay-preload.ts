import { contextBridge, ipcRenderer } from "electron";

/** The in-game overlay page (setup/overlay.html) only; main.ts checks every call comes from it. */
contextBridge.exposeInMainWorld("dendropOverlay", {
  /** The overlay's state, and whether it's clickable right now (with the hotkey's name). */
  onState: (cb: (state: unknown, interactive: boolean, hotkey: string) => void) => {
    ipcRenderer.on("ov:state", (_e, state: unknown, interactive: boolean, hotkey: string) => cb(state, interactive === true, String(hotkey ?? "")));
  },
  /** Sends a message to the voice channel's chat. */
  send: (text: string) => ipcRenderer.invoke("ov:chat", text),
  /** Mute or deafen, like the shortcut keys. */
  voice: (action: "mute" | "deafen") => ipcRenderer.invoke("ov:voice", action),
  /** Done chatting: let clicks through to the game again. */
  done: () => ipcRenderer.invoke("ov:done"),
});
