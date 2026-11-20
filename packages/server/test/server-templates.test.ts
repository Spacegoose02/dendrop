import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { SERVER_TEMPLATES, type ChatServer, type CustomRole, type ServerInvite } from "@dendrop/shared";
import { account, startServer, type TestServer } from "./helpers.js";

describe("server templates", () => {
  let s: TestServer;
  let owner: string, bob: string;
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const make = (cookie: string, body: object) => call(cookie, "POST", "/api/servers", body);
  const catName = (sv: ChatServer, id: number | null) => sv.categories.find((c) => c.id === id)?.name ?? null;
  const roleName = (sv: ChatServer, id: number) => sv.roles.find((r) => r.id === id)!.name;

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    owner = await account(s, "owner");
    bob = await account(s, "bob");
    s.ctx.db.prepare("UPDATE users SET can_create_servers = 1 WHERE username = 'bob'").run();
  });
  after(() => s.close());

  it("still starts a plain server with just #general", async () => {
    const sv = (await make(owner, { name: "Plain" })).body as ChatServer;
    assert.deepEqual(
      sv.channels.map((c) => c.name),
      ["general"],
    );
    assert.deepEqual(sv.roles, []);
  });

  it("builds every template's channels, categories and roles", async () => {
    for (const t of SERVER_TEMPLATES) {
      const res = await make(owner, { name: t.name, template: t.id });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const sv = res.body as ChatServer;
      assert.deepEqual(
        sv.roles.map((r) => r.name),
        t.roles.map((r) => r.name),
      );
      assert.deepEqual(
        sv.categories.map((c) => c.name),
        t.categories.flatMap((c) => (c.name === null ? [] : [c.name])),
      );
      const want = t.categories.flatMap((cat) => cat.channels.map((c) => ({ name: c.name, kind: c.kind ?? "text", category: cat.name })));
      assert.deepEqual(
        sv.channels.map((c) => ({ name: c.name, kind: c.kind, category: catName(sv, c.categoryId) })),
        want,
      );
    }
  });

  it("sets up locked and read-only channels in the Family template", async () => {
    const sv = (await make(owner, { name: "Fam", template: "family" })).body as ChatServer;
    const ann = sv.channels.find((c) => c.name === "announcements")!;
    assert.equal(ann.readOnly, true);
    assert.deepEqual(ann.postRoleIds.map((id) => roleName(sv, id)), ["Parents"]);
    const parents = sv.channels.find((c) => c.name === "parents")!;
    assert.equal(parents.locked, true);
    assert.deepEqual(parents.roleIds.map((id) => roleName(sv, id)), ["Parents"]);

    // Someone without the Parents role doesn't see the locked channel, or get to post in announcements.
    const invite = (await call(owner, "POST", `/api/servers/${sv.id}/invites`, {})).body as ServerInvite;
    await call(bob, "POST", `/api/invites/${invite.code}/accept`);
    const seen = (await call(bob, "GET", `/api/servers/${sv.id}`)).body as ChatServer;
    assert.ok(!seen.channels.some((c) => c.name === "parents"));
    assert.equal(seen.channels.find((c) => c.name === "announcements")!.canPost, false);
  });

  it("checks the template and copy options", async () => {
    assert.equal((await make(owner, { name: "X", template: "spaceship" })).status, 400);
    assert.equal((await make(owner, { name: "X", template: "family", copyFrom: 1 })).status, 400);
    assert.equal((await make(owner, { name: "X", copyFrom: 999999 })).status, 404);
  });

  it("copies a server's layout, settings and welcome screen, without its members", async () => {
    const src = (await make(owner, { name: "Original", template: "gaming" })).body as ChatServer;
    const id = src.id;
    // Customize it a little.
    const vip = (await call(owner, "POST", `/api/servers/${id}/roles`, { name: "VIP", color: "#123456", permissions: ["createInvites"] })).body as CustomRole;
    const cat = (await call(owner, "POST", `/api/servers/${id}/categories`, { name: "Extra" })).body as { id: number };
    const ch = await call(owner, "POST", `/api/servers/${id}/channels`, { name: "vip-lounge", locked: true, roleIds: [vip.id], categoryId: cat.id, slowmode: 10 });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    await call(owner, "PATCH", `/api/servers/${id}`, { levels: false });
    const w = await call(owner, "PUT", `/api/servers/${id}/welcome`, { enabled: true, message: "Hi!", rules: ["Be nice"], requireAgree: true, roles: [{ roleId: vip.id, emoji: "⭐" }] });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const invite = (await call(owner, "POST", `/api/servers/${id}/invites`, {})).body as ServerInvite;
    await call(bob, "POST", `/api/invites/${invite.code}/accept`);
    const before = (await call(owner, "GET", `/api/servers/${id}`)).body as ChatServer;

    const res = await make(owner, { name: "Copy", copyFrom: id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const copy = res.body as ChatServer;
    assert.notEqual(copy.id, id);
    assert.equal(copy.name, "Copy");
    assert.deepEqual(
      copy.members.map((m) => m.user.username),
      ["owner"],
    );
    const shape = (sv: ChatServer) => ({
      roles: sv.roles.map((r) => [r.name, r.color, r.permissions]),
      categories: sv.categories.map((c) => c.name),
      channels: sv.channels.map((c) => [
        c.name,
        c.kind,
        c.topic,
        catName(sv, c.categoryId),
        c.locked,
        c.roleIds.map((r) => roleName(sv, r)),
        c.readOnly,
        c.postRoleIds.map((r) => roleName(sv, r)),
        c.slowmode,
        c.tags,
      ]),
      levels: sv.levels,
      welcome: { ...sv.welcome, roles: sv.welcome.roles.map((r) => [roleName(sv, r.roleId), r.emoji]) },
    });
    assert.deepEqual(shape(copy), shape(before));
    assert.equal(copy.levels, false);
    // The copy's channels are new conversations, not the original's.
    const old = new Set(before.channels.map((c) => c.conversationId));
    assert.ok(copy.channels.every((c) => !old.has(c.conversationId)));
  });

  it("only lets people who manage a server copy it", async () => {
    const src = (await make(owner, { name: "Mine" })).body as ChatServer;
    // Not a member: same answer as a server that doesn't exist.
    const bobs = (await make(bob, { name: "Bob's" })).body as ChatServer;
    assert.ok(bobs.id);
    assert.equal((await make(owner, { name: "Peek", copyFrom: bobs.id })).status, 404);
    const invite = (await call(owner, "POST", `/api/servers/${src.id}/invites`, {})).body as ServerInvite;
    await call(bob, "POST", `/api/invites/${invite.code}/accept`);
    assert.equal((await make(bob, { name: "Steal", copyFrom: src.id })).status, 403);
  });
});
