import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AutomodEvent, ChatServer, CustomRole, ServerInvite } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("custom server roles", () => {
  let s: TestServer;
  let owner: string, mia: string, bob: string, cat: string, kit: string;
  let miaId: number, bobId: number, catId: number, kitId: number, momId: number;
  let serverId: number;
  let general: { id: number; conversationId: number };
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const view = async (cookie: string) => (await call(cookie, "GET", `/api/servers/${serverId}`)).body as ChatServer;
  const roleNamed = async (name: string) => (await view(owner)).roles.find((r) => r.name === name)!;
  /** Links a parent, which is what makes a kid account (the linking itself is covered in family.test.ts). */
  const setKid = (userId: number, kid: boolean) =>
    kid
      ? s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(userId, momId, new Date().toISOString())
      : s.ctx.db.prepare("DELETE FROM family_links WHERE kid_id = ?").run(userId);
  const give = (cookie: string, userId: number, roleIds: number[]) => call(cookie, "PUT", `/api/servers/${serverId}/members/${userId}/roles`, { roleIds });

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    owner = await account(s, "owner");
    mia = await account(s, "mia");
    bob = await account(s, "bob");
    cat = await account(s, "cat");
    kit = await account(s, "kit");
    await account(s, "mom");
    momId = s.ctx.users.byUsername("mom")!.id;
    [miaId, bobId, catId, kitId] = ["mia", "bob", "cat", "kit"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number, number];
    const sv = (await call(owner, "POST", "/api/servers", { name: "Den" })).body as ChatServer;
    serverId = sv.id;
    general = sv.channels[0]!;
    const invite = (await call(owner, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
    for (const who of [mia, bob, cat, kit]) assert.equal((await call(who, "POST", `/api/invites/${invite.code}/accept`)).status, 200);
    setKid(kitId, true);
  });
  after(() => s.close());

  it("lets the owner make roles with colors and permissions, ranked newest lowest", async () => {
    const mods = await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Mods", color: "#E91E63", permissions: ["manageRoles", "kickMembers", "timeoutMembers", "manageAutomod"] });
    assert.equal(mods.status, 200, JSON.stringify(mods.body));
    assert.equal((mods.body as CustomRole).color, "#e91e63");
    assert.equal((mods.body as CustomRole).position, 0);
    const cousins = (await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Cousins", color: "#1e88e5" })).body as CustomRole;
    assert.equal(cousins.position, 1);
    assert.deepEqual(cousins.permissions, []);
    await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Gamers", color: null });

    // Members see the roles too, highest first.
    assert.deepEqual(
      (await view(bob)).roles.map((r) => r.name),
      ["Mods", "Cousins", "Gamers"],
    );
    assert.deepEqual((await view(bob)).myPermissions, []);
    assert.equal((await view(owner)).myPermissions.length, 10);
  });

  it("checks names, colors and permissions", async () => {
    const make = (body: object) => call(owner, "POST", `/api/servers/${serverId}/roles`, body);
    assert.equal((await make({ name: "  " })).status, 400);
    assert.equal((await make({ name: "x".repeat(33) })).status, 400);
    assert.equal((await make({ name: "Red", color: "red" })).status, 400);
    assert.equal((await make({ name: "Wizards", permissions: ["castSpells"] })).status, 400);
    // Role names show to kids, so the kid-safe word filter applies.
    assert.equal((await make({ name: "sh1t posters" })).status, 400);
    // Only people with Manage roles can make them.
    assert.equal((await call(bob, "POST", `/api/servers/${serverId}/roles`, { name: "Mine" })).status, 403);
  });

  it("gives members roles, and shows their highest colored role's color over their own", async () => {
    const cousins = await roleNamed("Cousins");
    const gamers = await roleNamed("Gamers");
    await call(bob, "PATCH", "/api/me", { nameColor: "#00ff00" });
    assert.equal((await give(owner, bobId, [gamers.id, cousins.id])).status, 200);
    let me = (await view(cat)).members.find((m) => m.user.id === bobId)!;
    // Highest first: Cousins (blue) outranks Gamers (no color) and decides the color.
    assert.deepEqual(me.roleIds, [cousins.id, gamers.id]);
    assert.equal(me.color, "#1e88e5");
    assert.equal(me.user.nameColor, "#00ff00", "their own color is still there for DMs");

    // No colored role: their own color is used (color is null).
    await give(owner, bobId, [gamers.id]);
    me = (await view(cat)).members.find((m) => m.user.id === bobId)!;
    assert.equal(me.color, null);
    await give(owner, bobId, [cousins.id]);

    // Recoloring the role changes it for everyone, live.
    const live = await listen(s, cat);
    await call(owner, "PATCH", `/api/servers/${serverId}/roles/${cousins.id}`, { color: "#ff9800" });
    const ev = await live.waitFor("server.updated");
    assert.equal(ev.server.members.find((m) => m.user.id === bobId)!.color, "#ff9800");
    live.ws.close();
    assert.equal((await give(owner, bobId, [99999])).status, 400);
  });

  it("lets a role with Manage roles change only roles below it, and hand out only its own permissions", async () => {
    const mods = await roleNamed("Mods");
    const cousins = await roleNamed("Cousins");
    await give(owner, miaId, [mods.id]);
    assert.deepEqual((await view(mia)).myPermissions, ["manageRoles", "manageAutomod", "kickMembers", "timeoutMembers"]);

    // Below: fine. Their own role or above: no.
    assert.equal((await call(mia, "PATCH", `/api/servers/${serverId}/roles/${cousins.id}`, { name: "Cousins!" })).status, 200);
    assert.equal((await call(mia, "PATCH", `/api/servers/${serverId}/roles/${mods.id}`, { color: "#000000" })).status, 403);
    assert.equal((await call(mia, "DELETE", `/api/servers/${serverId}/roles/${mods.id}`)).status, 403);
    // Can't grant what they don't have.
    assert.equal((await call(mia, "PATCH", `/api/servers/${serverId}/roles/${cousins.id}`, { permissions: ["manageServer"] })).status, 403);
    assert.equal((await call(mia, "POST", `/api/servers/${serverId}/roles`, { name: "Bans", permissions: ["deleteMessages"] })).status, 403);
    assert.equal((await call(mia, "PATCH", `/api/servers/${serverId}/roles/${cousins.id}`, { permissions: ["timeoutMembers"] })).status, 200);
    assert.equal((await call(mia, "PATCH", `/api/servers/${serverId}/roles/${cousins.id}`, { permissions: [] })).status, 200);

    // Can't move a role above their own.
    const order = (await view(owner)).roles.map((r) => r.id);
    assert.equal((await call(mia, "PUT", `/api/servers/${serverId}/roles/order`, { ids: [order[1], order[0], order[2]] })).status, 403);
    const swapped = (await call(mia, "PUT", `/api/servers/${serverId}/roles/order`, { ids: [order[0], order[2], order[1]] })).body as ChatServer;
    assert.deepEqual(
      swapped.roles.map((r) => r.name),
      ["Mods", "Gamers", "Cousins!"],
    );
    assert.equal((await call(owner, "PUT", `/api/servers/${serverId}/roles/order`, { ids: [order[0]] })).status, 400);
    await call(owner, "PUT", `/api/servers/${serverId}/roles/order`, { ids: order });
    await call(owner, "PATCH", `/api/servers/${serverId}/roles/${cousins.id}`, { name: "Cousins" });

    // Can give roles below them to people below them, not their own role.
    assert.equal((await give(mia, catId, [cousins.id])).status, 200);
    assert.equal((await give(mia, catId, [cousins.id, mods.id])).status, 403);
    assert.equal((await give(bob, catId, [])).status, 403, "no Manage roles");
  });

  it("lets roles remove and time out only people ranked below them", async () => {
    const mods = await roleNamed("Mods");
    // Mia (Mods) can time out Cat (Cousins), but not the owner, and not someone with the same role.
    assert.equal((await call(mia, "PUT", `/api/servers/${serverId}/timeouts/${catId}`, { minutes: 5 })).status, 200);
    assert.equal((await call(mia, "GET", `/api/servers/${serverId}/timeouts`)).body.length, 1);
    assert.equal((await call(mia, "DELETE", `/api/servers/${serverId}/timeouts/${catId}`)).status, 200);
    const ownerId = (await view(owner)).ownerId;
    assert.equal((await call(mia, "PUT", `/api/servers/${serverId}/timeouts/${ownerId}`, { minutes: 5 })).status, 403);
    await give(owner, bobId, [mods.id]);
    assert.equal((await call(mia, "PUT", `/api/servers/${serverId}/timeouts/${bobId}`, { minutes: 5 })).status, 403);
    assert.equal((await call(mia, "DELETE", `/api/servers/${serverId}/members/${bobId}`)).status, 403);
    await give(owner, bobId, [(await roleNamed("Cousins")).id]);

    // No Manage channels or Manage server.
    assert.equal((await call(mia, "POST", `/api/servers/${serverId}/channels`, { name: "mods-only" })).status, 403);
    assert.equal((await call(mia, "PATCH", `/api/servers/${serverId}`, { name: "Mia's" })).status, 403);
    // Plain members still can't.
    assert.equal((await call(cat, "PUT", `/api/servers/${serverId}/timeouts/${bobId}`, { minutes: 5 })).status, 403);
  });

  it("opens locked channels to picked roles", async () => {
    const cousins = await roleNamed("Cousins");
    const c = (await call(owner, "POST", `/api/servers/${serverId}/channels`, { name: "cousins-corner", locked: true, roleIds: [cousins.id] })).body;
    assert.deepEqual(c.roleIds, [cousins.id]);
    const sees = async (cookie: string) => (await view(cookie)).channels.some((x) => x.id === c.id);
    assert.equal(await sees(cat), true, "Cat has Cousins");
    assert.equal(await sees(kit), false);
    // Members don't see who was picked; channel managers do.
    assert.deepEqual((await view(cat)).channels.find((x) => x.id === c.id)!.roleIds, []);
    // Taking the role away hides it again.
    await give(owner, catId, []);
    assert.equal(await sees(cat), false);
    assert.equal((await call(cat, "GET", `/api/conversations/${c.conversationId}/messages`)).status, 404);
    await give(owner, catId, [cousins.id]);
    assert.equal(await sees(cat), true);
    assert.equal((await call(owner, "PATCH", `/api/servers/${serverId}/channels/${c.id}`, { roleIds: [12345] })).status, 400);

    // Manage channels lets you see every locked channel, to manage it.
    const builders = (await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Builders", permissions: ["manageChannels"] })).body as CustomRole;
    await give(owner, bobId, [builders.id]);
    assert.equal(await sees(bob), true);
    assert.equal((await call(bob, "PATCH", `/api/servers/${serverId}/channels/${c.id}`, { topic: "Hi cousins" })).status, 200);
    assert.deepEqual((await view(bob)).channels.find((x) => x.id === c.id)!.roleIds, [cousins.id]);

    // Deleting a role takes its access with it.
    assert.equal((await call(owner, "DELETE", `/api/servers/${serverId}/roles/${cousins.id}`)).status, 200);
    assert.equal(await sees(cat), false);
    assert.equal((await view(cat)).members.find((m) => m.user.id === catId)!.color, null);
    assert.deepEqual(
      (await view(owner)).roles.map((r) => [r.name, r.position]),
      [
        ["Mods", 0],
        ["Gamers", 1],
        ["Builders", 2],
      ],
    );
  });

  it("keeps moderator roles away from kid accounts", async () => {
    const mods = await roleNamed("Mods");
    const gamers = await roleNamed("Gamers");
    // A kid can't get a role that moderates, or be made an admin.
    const r = await give(owner, kitId, [mods.id]);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /kid account/);
    assert.equal((await call(owner, "PATCH", `/api/servers/${serverId}/members/${kitId}`, { role: "admin" })).status, 400);
    // Color-only roles are fine.
    assert.equal((await give(owner, kitId, [gamers.id])).status, 200);
    // And such a role can't later be given moderator permissions while the kid has it.
    const up = await call(owner, "PATCH", `/api/servers/${serverId}/roles/${gamers.id}`, { permissions: ["kickMembers"] });
    assert.equal(up.status, 400);
    assert.equal((await call(owner, "PATCH", `/api/servers/${serverId}/roles/${gamers.id}`, { permissions: ["createInvites"] })).status, 200);

    // Someone who became a kid account after getting a moderator role loses its powers.
    await give(owner, catId, [mods.id]);
    setKid(catId, true);
    assert.deepEqual((await view(cat)).myPermissions, []);
    assert.equal((await call(cat, "PUT", `/api/servers/${serverId}/timeouts/${bobId}`, { minutes: 5 })).status, 403);
    setKid(catId, false);
    await give(owner, catId, []);
  });

  it("lets Make invites override the server's invite setting", async () => {
    await call(owner, "PATCH", `/api/servers/${serverId}`, { memberInvites: false });
    assert.equal((await call(kit, "POST", `/api/servers/${serverId}/invites`, {})).status, 200, "Gamers has Make invites");
    assert.equal((await call(cat, "POST", `/api/servers/${serverId}/invites`, {})).status, 403);
  });

  it("works with automod: exempt roles, and alerts to roles with Manage automod", async () => {
    const gamers = await roleNamed("Gamers");
    const words = { enabled: true, actions: ["block", "alert"], useBuiltinList: false, words: ["pineapple"] };
    assert.equal((await call(owner, "PATCH", `/api/servers/${serverId}/automod`, { words: { ...words, exemptRoleIds: [424242] } })).status, 400);
    const set = await call(mia, "PATCH", `/api/servers/${serverId}/automod`, { words: { ...words, exemptRoleIds: [gamers.id] } });
    assert.equal(set.status, 200, "Mods has Manage automod");
    assert.deepEqual(set.body.words.exemptRoleIds, [gamers.id]);

    const post = (cookie: string, body: string) => call(cookie, "POST", `/api/conversations/${general.conversationId}/messages`, { body });
    // Kit has Gamers, so the rule leaves them alone.
    assert.equal((await post(kit, "pineapple pizza")).status, 200);
    // Cat doesn't, and Mia (Mods, Manage automod) is alerted.
    const miaLive = await listen(s, mia);
    assert.equal((await post(cat, "pineapple pizza")).status, 400);
    const alert = await miaLive.waitFor("automod.alert");
    assert.equal((alert.event as AutomodEvent).user!.id, catId);
    miaLive.ws.close();
    assert.equal((await call(mia, "GET", `/api/servers/${serverId}/automod/events`)).status, 200);
    assert.equal((await call(bob, "GET", `/api/servers/${serverId}/automod`)).status, 403);

    // A deleted role drops out of the exemptions.
    await call(owner, "DELETE", `/api/servers/${serverId}/roles/${gamers.id}`);
    assert.deepEqual((await call(owner, "GET", `/api/servers/${serverId}/automod`)).body.words.exemptRoleIds, []);
  });

  it("removes someone's roles when they leave", async () => {
    const mods = await roleNamed("Mods");
    assert.equal((await call(mia, "POST", `/api/servers/${serverId}/leave`)).status, 200);
    assert.equal((await view(owner)).roles.find((r) => r.id === mods.id)!.memberCount, 0);
  });
});
