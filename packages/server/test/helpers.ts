import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { ServerEvent } from "@dendrop/shared";
import { buildApp, type BuiltApp } from "../src/app.js";
import { loadConfig, type ServerConfig } from "../src/config.js";

process.env.NODE_ENV = "test";

export interface TestServer extends BuiltApp {
  url: string;
  close(): Promise<void>;
}

/** A server on a random port with its own data folder. */
export async function startServer(env: Record<string, string> = {}, options: { callRingMs?: number } = {}): Promise<TestServer> {
  const dir = mkdtempSync(path.join(tmpdir(), "dendrop-test-"));
  const config: ServerConfig = loadConfig({ DENDROP_DATA_DIR: dir, DENDROP_WEB_DIR: path.join(dir, "no-web"), ...env });
  const built = await buildApp(config, undefined, options);
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = built.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    ...built,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Signs up (or sets up, for the first account) and returns the session cookie. */
export async function account(s: TestServer, username: string, password = "correct horse battery"): Promise<string> {
  const first = s.ctx.users.count() === 0;
  const res = await s.app.inject({ method: "POST", url: first ? "/api/auth/setup" : "/api/auth/signup", payload: { username, password } });
  if (res.statusCode !== 200) throw new Error(`account ${username}: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === "dendrop_session");
  return `dendrop_session=${c!.value}`;
}

/** A gateway connection that collects events. */
export async function listen(s: TestServer, cookie: string) {
  const events: ServerEvent[] = [];
  const ws = new WebSocket(`${s.url.replace("http", "ws")}/api/gateway`, { headers: { cookie } });
  await new Promise<void>((resolve, reject) => {
    ws.on("message", (d) => {
      const e = JSON.parse(String(d)) as ServerEvent;
      events.push(e);
      if (e.type === "ready") resolve();
    });
    ws.once("error", reject);
  });
  const waitFor = async <T extends ServerEvent["type"]>(type: T, timeout = 2000): Promise<Extract<ServerEvent, { type: T }>> => {
    const start = Date.now();
    for (;;) {
      const i = events.findIndex((e) => e.type === type);
      if (i >= 0) return events.splice(i, 1)[0] as Extract<ServerEvent, { type: T }>;
      if (Date.now() - start > timeout) throw new Error(`no ${type} event`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ws, events, waitFor };
}

