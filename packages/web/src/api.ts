import type { AuthInfo, Me, ServerEvent } from "@dendrop/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON request to the Dendrop API, with the session cookie. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? res.statusText);
  return data as T;
}

/** Multipart request, for messages with files. */
export async function apiForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", body: form });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? res.statusText);
  return data as T;
}

export const getAuthInfo = () => api<AuthInfo>("/api/auth/info");
export const getMe = () => api<Me>("/api/me");
export const logout = () => api<{ ok: true }>("/api/auth/logout", { method: "POST", body: {} });

/** Minutes without a tap, click or key before a visible app counts as left alone. */
const IDLE_MS = 5 * 60_000;

/**
 * Tells the server whether this app is in front of someone. While it isn't (a phone with the
 * screen off or another app open, a tab in the background, a PC left alone), the server sends
 * pushes to the person's phones as if nothing were open.
 */
function watchActivity(report: (active: boolean) => void): { current: () => boolean; stop: () => void } {
  let lastInput = Date.now();
  let active = true;
  const compute = () => document.visibilityState === "visible" && Date.now() - lastInput < IDLE_MS;
  const update = () => {
    const next = compute();
    if (next !== active) report((active = next));
  };
  const onInput = () => {
    lastInput = Date.now();
    if (!active) update();
  };
  const inputs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
  for (const e of inputs) window.addEventListener(e, onInput, { passive: true, capture: true });
  document.addEventListener("visibilitychange", update);
  window.addEventListener("pagehide", update);
  const timer = setInterval(update, 30_000);
  return {
    current: () => (active = compute()),
    stop: () => {
      for (const e of inputs) window.removeEventListener(e, onInput, { capture: true });
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", update);
      clearInterval(timer);
    },
  };
}

/**
 * Keeps a WebSocket to the gateway open, reconnecting with backoff.
 * Returns send (dropped while disconnected) and close (for good).
 */
export function connectGateway(
  onEvent: (e: ServerEvent) => void,
  onStatus: (online: boolean) => void,
): { send: (data: object) => void; close: () => void } {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 1000;
  let ping: ReturnType<typeof setInterval> | undefined;
  const activity = watchActivity((active) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "active", active }));
  });

  const open = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/gateway`);
    ws.onopen = () => {
      delay = 1000;
      onStatus(true);
      // A new connection counts as active; say so if it isn't (reconnecting in the background).
      if (!activity.current()) ws?.send(JSON.stringify({ type: "active", active: false }));
      ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), 25_000);
    };
    ws.onmessage = (m) => {
      try {
        onEvent(JSON.parse(String(m.data)) as ServerEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      clearInterval(ping);
      onStatus(false);
      if (!stopped) setTimeout(open, (delay = Math.min(delay * 2, 30_000)));
    };
  };
  open();
  return {
    send: (data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    },
    close: () => {
      stopped = true;
      activity.stop();
      ws?.close();
    },
  };
}
