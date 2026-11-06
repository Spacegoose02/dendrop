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

export const getAuthInfo = () => api<AuthInfo>("/api/auth/info");
export const getMe = () => api<Me>("/api/me");
export const logout = () => api<{ ok: true }>("/api/auth/logout", { method: "POST", body: {} });

/**
 * Keeps a WebSocket to the gateway open, reconnecting with backoff.
 * Returns a function that closes it for good.
 */
export function connectGateway(onEvent: (e: ServerEvent) => void, onStatus: (online: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 1000;
  let ping: ReturnType<typeof setInterval> | undefined;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/gateway`);
    ws.onopen = () => {
      delay = 1000;
      onStatus(true);
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
  return () => {
    stopped = true;
    ws?.close();
  };
}
