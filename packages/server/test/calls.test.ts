import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { TokenVerifier } from "livekit-server-sdk";
import type { CallJoin } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const LK = { DENDROP_LIVEKIT_URL: "wss://calls.example.com", DENDROP_LIVEKIT_API_KEY: "devkey", DENDROP_LIVEKIT_API_SECRET: "a-secret-that-is-long-enough-123456" };

describe("calls", () => {
  let s: TestServer;
  let dad: string, mom: string, kit: string;
  let dm: number, group: number;
  let dadId: number, momId: number, kitId: number;
  const post = (cookie: string, url: string, payload: object = {}) => s.app.inject({ method: "POST", url, headers: { cookie }, payload });

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true", ...LK }, { callRingMs: 300 });
    dad = await account(s, "dad");
    mom = await account(s, "mom");
    kit = await account(s, "kit");
    [dadId, momId, kitId] = ["dad", "mom", "kit"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number];
    for (const [c, other, otherId] of [
      [mom, "dad", dadId],
      [kit, "dad", dadId],
    ] as const) {
      await post(dad, "/api/friends", { username: other === "dad" ? (c === mom ? "mom" : "kit") : other });
      await post(c, `/api/friends/${otherId}/accept`);
    }
    dm = (await post(dad, "/api/conversations", { userId: momId })).json().id;
    group = (await post(dad, "/api/conversations", { userIds: [momId, kitId] })).json().id;
  });
  after(() => s.close());

  it("says calls are on, rings the other person and hands out a token for this room only", async () => {
    assert.equal((await s.app.inject({ url: "/api/server", headers: { cookie: dad } })).json().calls, true);
    const momLive = await listen(s, mom);
    const start = await post(dad, `/api/conversations/${dm}/call`, { video: true });
    assert.equal(start.statusCode, 200);
    const join = start.json() as CallJoin;
    assert.equal(join.url, LK.DENDROP_LIVEKIT_URL);
    assert.deepEqual([join.call.joined, join.call.ringing, join.call.video], [[dadId], [momId], true]);
    const ring = await momLive.waitFor("call.updated");
    assert.deepEqual(ring.call.ringing, [momId]);

    const grant = await new TokenVerifier(LK.DENDROP_LIVEKIT_API_KEY, LK.DENDROP_LIVEKIT_API_SECRET).verify(join.token);
    assert.equal(grant.sub, String(dadId));
    assert.equal(grant.video?.room, `dendrop-conversation-${dm}`);

    // Mom answers; then she hangs up, which ends a 1:1 call for both.
    const answer = (await post(mom, `/api/conversations/${dm}/call`)).json() as CallJoin;
    assert.deepEqual(answer.call.joined.sort(), [dadId, momId].sort());
    assert.deepEqual(answer.call.ringing, []);
    await post(mom, `/api/conversations/${dm}/call/leave`);
    const ended = await momLive.waitFor("call.ended");
    assert.deepEqual([ended.conversationId, ended.missed], [dm, false]);
    assert.deepEqual((await s.app.inject({ url: "/api/calls", headers: { cookie: dad } })).json(), []);
    momLive.ws.close();
  });

  it("declining a 1:1 call ends it; no answer counts as missed", async () => {
    const dadLive = await listen(s, dad);
    await post(dad, `/api/conversations/${dm}/call`);
    await post(mom, `/api/conversations/${dm}/call/decline`);
    assert.equal((await dadLive.waitFor("call.ended")).missed, false);

    await post(dad, `/api/conversations/${dm}/call`);
    const missed = await dadLive.waitFor("call.ended", 2000);
    assert.equal(missed.missed, true);
    dadLive.ws.close();
  });

  it("keeps a group call going until the last person leaves", async () => {
    await post(dad, `/api/conversations/${group}/call`);
    await post(kit, `/api/conversations/${group}/call`);
    await post(dad, `/api/conversations/${group}/call/leave`);
    const calls = (await s.app.inject({ url: "/api/calls", headers: { cookie: kit } })).json();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].joined, [kitId]);
    await post(kit, `/api/conversations/${group}/call/leave`);
    assert.deepEqual((await s.app.inject({ url: "/api/calls", headers: { cookie: kit } })).json(), []);
  });

  it("only lets members call, and takes people out of calls when they disconnect", async () => {
    assert.equal((await post(kit, `/api/conversations/${dm}/call`)).statusCode, 404);
    const momLive = await listen(s, mom);
    const dadLive = await listen(s, dad);
    await post(dad, `/api/conversations/${dm}/call`);
    await post(mom, `/api/conversations/${dm}/call`);
    dadLive.ws.close();
    assert.equal((await momLive.waitFor("call.ended")).conversationId, dm);
    momLive.ws.close();
  });

  it("is off without LiveKit settings, or when turned off", async () => {
    for (const env of [{ DENDROP_LIVEKIT_BIN: "/nowhere/livekit-server" }, { DENDROP_CALLS: "off", ...LK }] as Record<string, string>[]) {
      const t = await startServer(env);
      try {
        const c = await account(t, "solo");
        assert.equal((await t.app.inject({ url: "/api/server", headers: { cookie: c } })).json().calls, false);
      } finally {
        await t.close();
      }
    }
  });
});

describe("built-in LiveKit", () => {
  let s: TestServer;
  let dir: string;

  before(async () => {
    // A stand-in for livekit-server: answers /rtc/validate and echoes WebSocket messages on
    // the signal port from --config-body, and prints its arguments and keys.
    dir = mkdtempSync(path.join(tmpdir(), "dendrop-lk-"));
    const fake = path.join(dir, "fake.mjs");
    writeFileSync(
      fake,
      `import http from "node:http";
import { WebSocketServer } from ${JSON.stringify(import.meta.resolve("ws"))};
const body = process.argv[process.argv.indexOf("--config-body") + 1];
const port = Number(/^port: (\\d+)/m.exec(body)[1]);
const server = http.createServer((req, res) => res.end(JSON.stringify({ url: req.url, auth: req.headers.authorization ?? "", keys: process.env.LIVEKIT_KEYS, body })));
new WebSocketServer({ server }).on("connection", (ws, req) => { ws.send("hello " + req.url); ws.on("message", (m) => ws.send(m)); });
server.listen(port, "127.0.0.1");
`,
    );
    const bin = path.join(dir, "livekit-server");
    writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`);
    chmodSync(bin, 0o755);
    s = await startServer({ DENDROP_SIGNUP: "true", DENDROP_LIVEKIT_BIN: bin, DENDROP_CALLS_SIGNAL_PORT: "17880", DENDROP_CALLS_UDP_PORT: "17882" });
  });
  after(async () => {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("turns calls on and hands out Dendrop's own address with a token LiveKit accepts", async () => {
    const dad = await account(s, "dad");
    const mom = await account(s, "mom");
    const momId = s.ctx.users.byUsername("mom")!.id;
    const dadId = s.ctx.users.byUsername("dad")!.id;
    assert.equal((await s.app.inject({ url: "/api/server", headers: { cookie: dad } })).json().calls, true);
    await s.app.inject({ method: "POST", url: "/api/friends", headers: { cookie: dad }, payload: { username: "mom" } });
    await s.app.inject({ method: "POST", url: `/api/friends/${dadId}/accept`, headers: { cookie: mom } });
    const dm = (await s.app.inject({ method: "POST", url: "/api/conversations", headers: { cookie: dad }, payload: { userId: momId } })).json().id;
    // Through the real port, so the address comes from the request like it would behind a proxy.
    const res = await fetch(`${s.url}/api/conversations/${dm}/call`, { method: "POST", headers: { cookie: dad, "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    const join = (await res.json()) as CallJoin;
    assert.equal(join.url, s.url.replace("http", "ws"));
    const l = s.ctx.config.livekit;
    await new TokenVerifier(l.apiKey, l.apiSecret).verify(join.token);
  });

  it("starts LiveKit with one UDP port and passes /rtc through, HTTP and WebSocket", async () => {
    let info: { url: string; auth: string; keys: string; body: string } | undefined;
    for (let i = 0; i < 50 && !info; i++) {
      const r = await fetch(`${s.url}/rtc/v1/validate?access_token=x`, { headers: { authorization: "Bearer abc" } });
      if (r.status === 200) info = (await r.json()) as typeof info;
      else await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(info, "the fake LiveKit never answered");
    assert.equal(info.url, "/rtc/v1/validate?access_token=x");
    assert.equal(info.auth, "Bearer abc");
    assert.equal(info.keys, `dendrop: ${s.ctx.config.livekit.apiSecret}`);
    assert.match(info.body, /udp_port: 17882/);
    assert.match(info.body, /- "127\.0\.0\.1"/);

    const ws = new WebSocket(`${s.url.replace("http", "ws")}/rtc/v1?access_token=x`);
    const got: string[] = [];
    await new Promise<void>((done, fail) => {
      ws.on("message", (m) => {
        got.push(String(m));
        if (got.length === 1) ws.send("x".repeat(200_000));
        else done();
      });
      ws.on("error", fail);
    });
    ws.close();
    assert.equal(got[0], "hello /rtc/v1?access_token=x");
    // Bigger than the gateway's 64 KB limit: the proxy doesn't apply it.
    assert.equal(got[1]!.length, 200_000);
  });
});
