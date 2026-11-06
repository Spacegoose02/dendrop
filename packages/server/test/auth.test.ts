import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";
import { account, startServer, type TestServer } from "./helpers.js";

describe("auth", () => {
  let s: TestServer;
  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
  });
  after(() => s.close());

  it("asks for setup until the first account exists, which becomes super admin", async () => {
    const info = await s.app.inject("/api/auth/info");
    assert.equal(info.json().needsSetup, true);
    const cookie = await account(s, "mama_raccoon");
    const me = await s.app.inject({ url: "/api/me", headers: { cookie } });
    assert.equal(me.json().isSuperAdmin, true);
    assert.equal((await s.app.inject("/api/auth/info")).json().needsSetup, false);
    const again = await s.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "x2", password: "long enough pw" } });
    assert.equal(again.statusCode, 409);
  });

  it("signs in and out with a password; later accounts aren't admins", async () => {
    await account(s, "kit");
    const bad = await s.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "kit", password: "nope nope nope" } });
    assert.equal(bad.statusCode, 401);
    const ok = await s.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "KIT", password: "correct horse battery" } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().isSuperAdmin, false);
    const cookie = `dendrop_session=${ok.cookies.find((c) => c.name === "dendrop_session")!.value}`;
    await s.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    assert.equal((await s.app.inject({ url: "/api/me", headers: { cookie } })).statusCode, 401);
  });

  it("rejects weak passwords and taken names", async () => {
    const short = await s.app.inject({ method: "POST", url: "/api/auth/signup", payload: { username: "newbie", password: "short" } });
    assert.equal(short.statusCode, 400);
    const taken = await s.app.inject({ method: "POST", url: "/api/auth/signup", payload: { username: "Kit", password: "long enough pw" } });
    assert.equal(taken.statusCode, 409);
  });

  it("links OIDC sign-ins by subject and makes the admin group super admins", async () => {
    const t = await startServer({ DENDROP_OIDC_ADMIN_GROUP: "admins" });
    try {
      const first = t.ctx.oidc.provision({ sub: "abc", preferred_username: "dad", email: "dad@example.com", groups: ["family"] });
      assert.equal(first.isSuperAdmin, true, "the very first account is the super admin");
      const wife = t.ctx.oidc.provision({ sub: "def", preferred_username: "dad", name: "Mom", groups: "family,admins" });
      assert.equal(wife.username, "dad_2", "a taken username gets a suffix instead of linking");
      assert.equal(wife.isSuperAdmin, true);
      assert.equal(t.ctx.oidc.provision({ sub: "def" }).id, wife.id);
    } finally {
      await t.close();
    }
  });

  it("only lets signed-in users from this site open the gateway", async () => {
    const cookie = await account(s, "gateway_user");
    const ready = await new Promise<{ type: string }>((resolve, reject) => {
      const ws = new WebSocket(`${s.url.replace("http", "ws")}/api/gateway`, { headers: { cookie } });
      ws.once("message", (d) => {
        resolve(JSON.parse(String(d)));
        ws.close();
      });
      ws.once("error", reject);
    });
    assert.equal(ready.type, "ready");

    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${s.url.replace("http", "ws")}/api/gateway`, { headers: { cookie, origin: "https://evil.example" } });
      ws.once("close", (c) => resolve(c));
    });
    assert.equal(code, 4401);
  });
});
