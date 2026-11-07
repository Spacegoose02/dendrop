import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ChatServer, InvitePreview, Message, ServerInvite } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("chat servers", () => {
  let s: TestServer;
  let admin: string, ann: string, bob: string, cat: string;
  let adminId: number, annId: number, bobId: number, catId: number;
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  let serverId: number;
  let general: { id: number; conversationId: number };

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    admin = await account(s, "admin");
    ann = await account(s, "ann");
    bob = await account(s, "bob");
    cat = await account(s, "cat");
    [adminId, annId, bobId, catId] = ["admin", "ann", "bob", "cat"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number, number];
  });
  after(() => s.close());

  it("needs a super admin's approval to make servers", async () => {
    assert.equal((await call(ann, "GET", "/api/me")).body.canCreateServers, false);
    assert.equal((await call(ann, "POST", "/api/servers", { name: "Den" })).status, 403);

    const adminLive = await listen(s, admin);
    const req = await call(ann, "POST", "/api/server-requests", { reason: "Family server" });
    assert.equal(req.body.status, "pending");
    assert.equal((await adminLive.waitFor("server.request")).request.user.id, annId);
    adminLive.ws.close();

    // Only super admins see and decide requests.
    assert.equal((await call(bob, "GET", "/api/admin/server-requests")).status, 403);
    assert.equal((await call(bob, "PUT", `/api/admin/server-creators/${annId}`, { allowed: true })).status, 403);
    assert.equal((await call(admin, "GET", "/api/admin/server-requests")).body[0].reason, "Family server");

    const annLive = await listen(s, ann);
    assert.equal((await call(admin, "PUT", `/api/admin/server-creators/${annId}`, { allowed: true })).body.status, "approved");
    assert.equal((await annLive.waitFor("server.request")).request.status, "approved");
    annLive.ws.close();
    assert.equal((await call(ann, "GET", "/api/me")).body.canCreateServers, true);
  });

  it("makes the creator the owner, with a general channel", async () => {
    const r = await call(ann, "POST", "/api/servers", { name: "  The Den ", description: "Family chat" });
    assert.equal(r.status, 200);
    const sv = r.body as ChatServer;
    serverId = sv.id;
    assert.equal(sv.name, "The Den");
    assert.equal(sv.myRole, "owner");
    assert.equal(sv.ownerId, annId);
    assert.equal(sv.isPublic, false);
    assert.deepEqual(
      sv.channels.map((c) => c.name),
      ["general"],
    );
    general = sv.channels[0]!;
    assert.equal((await call(ann, "GET", "/api/servers")).body.length, 1);
  });

  it("keeps private servers hidden from people who aren't in them", async () => {
    assert.equal((await call(bob, "GET", `/api/servers/${serverId}`)).status, 404);
    assert.equal((await call(bob, "POST", `/api/servers/${serverId}/join`)).status, 404);
    assert.equal((await call(bob, "GET", "/api/servers/directory")).body.length, 0);
    assert.equal((await call(bob, "GET", `/api/conversations/${general.conversationId}/messages`)).status, 404);
    // Channel conversations don't show up as DMs.
    assert.equal((await call(ann, "GET", "/api/conversations")).body.length, 0);
  });

  it("joins through an invite link, and limits and expiry work", async () => {
    const inv = (await call(ann, "POST", `/api/servers/${serverId}/invites`, { maxUses: 1 })).body as ServerInvite;
    const preview = (await call(bob, "GET", `/api/invites/${inv.code}`)).body as InvitePreview;
    assert.equal(preview.server.name, "The Den");
    assert.equal(preview.joined, false);

    const annLive = await listen(s, ann);
    const joined = (await call(bob, "POST", `/api/invites/${inv.code}/accept`)).body as ChatServer;
    assert.equal(joined.myRole, "member");
    assert.equal((await annLive.waitFor("server.updated")).server.memberCount, 2);
    annLive.ws.close();

    // Used up.
    assert.equal((await call(cat, "GET", `/api/invites/${inv.code}`)).status, 404);
    assert.equal((await call(cat, "POST", `/api/invites/${inv.code}/accept`)).status, 404);
    assert.equal((await call(cat, "GET", "/api/invites/not-a-real-code")).status, 404);
    const expired = (await call(ann, "POST", `/api/servers/${serverId}/invites`, { expiresInHours: 0.0000001 })).body as ServerInvite;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await call(cat, "POST", `/api/invites/${expired.code}/accept`)).status, 404);
  });

  it("sends channel messages through the conversation endpoints to members only", async () => {
    const bobLive = await listen(s, bob);
    const sent = await call(ann, "POST", `/api/conversations/${general.conversationId}/messages`, { body: "Welcome!" });
    assert.equal(sent.status, 200);
    assert.equal((await bobLive.waitFor("message.created")).message.body, "Welcome!");
    bobLive.ws.close();
    assert.equal((await call(bob, "GET", `/api/conversations/${general.conversationId}/messages`)).body.length, 1);
    assert.equal((await call(cat, "POST", `/api/conversations/${general.conversationId}/messages`, { body: "hi" })).status, 404);
    // No calls or encryption keys in channels yet.
    assert.equal((await call(bob, "POST", `/api/conversations/${general.conversationId}/call`, {})).status, 400);
    assert.equal((await call(bob, "POST", `/api/conversations/${general.conversationId}/keys`, {})).status, 400);
  });

  it("locks channels to picked members", async () => {
    // Members can't make channels.
    assert.equal((await call(bob, "POST", `/api/servers/${serverId}/channels`, { name: "x" })).status, 403);
    const ch = await call(ann, "POST", `/api/servers/${serverId}/channels`, { name: "Grown Ups Only!", locked: true });
    assert.equal(ch.body.name, "grown-ups-only");
    const locked = ch.body as { id: number; conversationId: number };

    const bobView = (await call(bob, "GET", `/api/servers/${serverId}`)).body as ChatServer;
    assert.deepEqual(
      bobView.channels.map((c) => c.name),
      ["general"],
    );
    assert.equal((await call(bob, "GET", `/api/conversations/${locked.conversationId}/messages`)).status, 404);

    // Picking Bob opens it to him; unpicking closes it again.
    await call(ann, "PATCH", `/api/servers/${serverId}/channels/${locked.id}`, { memberIds: [bobId] });
    assert.equal((await call(bob, "GET", `/api/conversations/${locked.conversationId}/messages`)).status, 200);
    assert.equal((await call(ann, "GET", `/api/servers/${serverId}`)).body.channels[1].memberIds[0], bobId);
    assert.deepEqual((await call(bob, "GET", `/api/servers/${serverId}`)).body.channels[1].memberIds, []);
    await call(ann, "PATCH", `/api/servers/${serverId}/channels/${locked.id}`, { memberIds: [] });
    assert.equal((await call(bob, "GET", `/api/conversations/${locked.conversationId}/messages`)).status, 404);

    // Only members can be picked.
    assert.equal((await call(ann, "PATCH", `/api/servers/${serverId}/channels/${locked.id}`, { memberIds: [catId] })).status, 400);

    // Admins always see locked channels.
    await call(ann, "PATCH", `/api/servers/${serverId}/members/${bobId}`, { role: "admin" });
    assert.equal((await call(bob, "GET", `/api/conversations/${locked.conversationId}/messages`)).status, 200);
    await call(ann, "PATCH", `/api/servers/${serverId}/members/${bobId}`, { role: "member" });
    assert.equal((await call(bob, "GET", `/api/conversations/${locked.conversationId}/messages`)).status, 404);

    // Reordering.
    const order = await call(ann, "PUT", `/api/servers/${serverId}/channels/order`, { ids: [locked.id, general.id] });
    assert.equal(order.body.channels[0].id, locked.id);
    assert.equal((await call(ann, "PUT", `/api/servers/${serverId}/channels/order`, { ids: [locked.id] })).status, 400);
  });

  it("invites friends, who accept or decline in the app", async () => {
    assert.equal((await call(ann, "POST", `/api/servers/${serverId}/invites/friend`, { userId: catId })).status, 403);
    await call(ann, "POST", "/api/friends", { username: "cat" });
    await call(cat, "POST", `/api/friends/${annId}/accept`);

    const catLive = await listen(s, cat);
    const inv = (await call(ann, "POST", `/api/servers/${serverId}/invites/friend`, { userId: catId })).body as ServerInvite;
    assert.equal(inv.forUserId, catId);
    assert.equal((await catLive.waitFor("server.invited")).invite.server.id, serverId);
    catLive.ws.close();
    // Nobody else can use it, and it isn't listed as a link.
    assert.equal((await call(bob, "GET", `/api/invites/${inv.code}`)).status, 404);
    assert.equal((await call(ann, "GET", `/api/servers/${serverId}/invites`)).body.some((i: ServerInvite) => i.code === inv.code), false);

    assert.equal((await call(cat, "GET", "/api/invites")).body.length, 1);
    await call(cat, "DELETE", `/api/invites/${inv.code}`);
    assert.equal((await call(cat, "GET", "/api/invites")).body.length, 0);

    const again = (await call(ann, "POST", `/api/servers/${serverId}/invites/friend`, { userId: catId })).body as ServerInvite;
    assert.equal((await call(cat, "POST", `/api/invites/${again.code}/accept`)).body.myRole, "member");
  });

  it("lets moderators remove messages and members, and bans keep people out", async () => {
    const m = (await call(cat, "POST", `/api/conversations/${general.conversationId}/messages`, { body: "spam" })).body as Message;
    assert.equal((await call(bob, "DELETE", `/api/servers/${serverId}/messages/${m.id}`)).status, 403);
    assert.equal((await call(ann, "DELETE", `/api/servers/${serverId}/messages/${m.id}`)).body.deleted, true);

    // Bob is promoted; admins can remove members but not other admins or the owner.
    await call(ann, "PATCH", `/api/servers/${serverId}/members/${bobId}`, { role: "admin" });
    assert.equal((await call(bob, "DELETE", `/api/servers/${serverId}/members/${annId}`)).status, 403);

    const catLive = await listen(s, cat);
    assert.equal((await call(bob, "DELETE", `/api/servers/${serverId}/members/${catId}?ban=true`)).status, 200);
    assert.equal((await catLive.waitFor("server.removed")).serverId, serverId);
    catLive.ws.close();
    assert.equal((await call(cat, "GET", `/api/conversations/${general.conversationId}/messages`)).status, 404);

    const inv = (await call(ann, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
    assert.equal((await call(cat, "POST", `/api/invites/${inv.code}/accept`)).status, 403);
    assert.equal((await call(bob, "GET", `/api/servers/${serverId}/bans`)).body[0].user.id, catId);
    await call(bob, "DELETE", `/api/servers/${serverId}/bans/${catId}`);
    assert.equal((await call(cat, "POST", `/api/invites/${inv.code}/accept`)).status, 200);
  });

  it("only lets moderators make invites when member invites are off", async () => {
    await call(ann, "PATCH", `/api/servers/${serverId}`, { memberInvites: false });
    assert.equal((await call(cat, "POST", `/api/servers/${serverId}/invites`, {})).status, 403);
    assert.equal((await call(bob, "POST", `/api/servers/${serverId}/invites`, {})).status, 200);
  });

  it("lists public servers in the directory, and anyone can join them", async () => {
    assert.equal((await call(cat, "PATCH", `/api/servers/${serverId}`, { isPublic: true })).status, 403);
    await call(ann, "PATCH", `/api/servers/${serverId}`, { isPublic: true });
    const dir = (await call(admin, "GET", "/api/servers/directory?q=den")).body;
    assert.equal(dir[0].name, "The Den");
    assert.equal((await call(admin, "GET", "/api/servers/directory?q=nothing")).body.length, 0);
    assert.equal((await call(admin, "POST", `/api/servers/${serverId}/join`)).body.myRole, "member");
    assert.equal((await call(admin, "POST", `/api/servers/${serverId}/leave`)).status, 200);
  });

  it("sets nicknames, the server profile and pictures", async () => {
    const nick = (await call(bob, "PATCH", `/api/servers/${serverId}/me`, { nickname: "Bobcat" })).body as ChatServer;
    assert.equal(nick.nickname, "Bobcat");
    assert.equal(nick.members.find((m) => m.user.id === bobId)!.nickname, "Bobcat");

    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
      "hex",
    );
    const boundary = "----dendrop";
    const form = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="b.png"\r\ncontent-type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await s.app.inject({
      method: "PUT",
      url: `/api/servers/${serverId}/banner`,
      headers: { cookie: ann, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: form,
    });
    assert.equal(up.statusCode, 200, up.body);
    const url = (up.json() as ChatServer).bannerUrl!;
    assert.ok(url);
    const img = await s.app.inject({ method: "GET", url, headers: { cookie: cat } });
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers["content-type"], "image/png");
    // Members only can upload: cat is a member but not an admin.
    const denied = await s.app.inject({
      method: "PUT",
      url: `/api/servers/${serverId}/icon`,
      headers: { cookie: cat, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: form,
    });
    assert.equal(denied.statusCode, 403);
  });

  it("transfers ownership, and the owner can't just leave", async () => {
    assert.equal((await call(ann, "POST", `/api/servers/${serverId}/leave`)).status, 400);
    assert.equal((await call(bob, "POST", `/api/servers/${serverId}/transfer`, { userId: bobId })).status, 403);
    const t = (await call(ann, "POST", `/api/servers/${serverId}/transfer`, { userId: bobId })).body as ChatServer;
    assert.equal(t.ownerId, bobId);
    assert.equal(t.myRole, "admin");
  });

  it("lets super admins see every server (without messages) and delete any", async () => {
    const list = (await call(admin, "GET", "/api/admin/servers")).body;
    assert.equal(list[0].name, "The Den");
    assert.equal(list[0].owner.id, bobId);
    assert.equal(list[0].channels, undefined);
    assert.equal((await call(admin, "GET", `/api/conversations/${general.conversationId}/messages`)).status, 404);

    const annLive = await listen(s, ann);
    assert.equal((await call(admin, "DELETE", `/api/servers/${serverId}`)).status, 200);
    assert.equal((await annLive.waitFor("server.removed")).serverId, serverId);
    annLive.ws.close();
    assert.equal((await call(ann, "GET", "/api/servers")).body.length, 0);
    void adminId;
  });
});
