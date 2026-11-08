import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { levelOf, RACCOON_RANKS, xpForLevel, type ChatServer, type CustomRole, type LeaderboardEntry, type ServerInvite } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("level math", () => {
  it("needs 100 XP for level 1, 300 for 2, and gives raccoon ranks", () => {
    assert.equal(xpForLevel(1), 100);
    assert.equal(xpForLevel(2), 300);
    assert.deepEqual(levelOf(0), { level: 0, rank: RACCOON_RANKS[0], into: 0, needed: 100 });
    assert.equal(levelOf(99).level, 0);
    assert.equal(levelOf(100).level, 1);
    assert.equal(levelOf(299).level, 1);
    assert.equal(levelOf(300).rank.name, "Scavenger");
    assert.equal(levelOf(xpForLevel(10)).rank.name, "Night Prowler");
    assert.equal(levelOf(xpForLevel(50) + 5).rank.name, "Raccoon Royalty");
    for (let xp = 0; xp < 20000; xp += 37) {
      const p = levelOf(xp);
      assert.ok(xpForLevel(p.level) <= xp && xp < xpForLevel(p.level + 1));
    }
  });
});

describe("server levels and the welcome screen", () => {
  let s: TestServer;
  let owner: string, mia: string, bob: string, kit: string;
  let ownerId: number, miaId: number, bobId: number, kitId: number, momId: number;
  let serverId: number;
  let general: { id: number; conversationId: number };
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const view = async (cookie: string) => (await call(cookie, "GET", `/api/servers/${serverId}`)).body as ChatServer;
  const say = (cookie: string, body: string) => call(cookie, "POST", `/api/conversations/${general.conversationId}/messages`, { body });
  const xpOf = async (userId: number) => (await view(owner)).members.find((m) => m.user.id === userId)!.xp;

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    owner = await account(s, "owner");
    mia = await account(s, "mia");
    bob = await account(s, "bob");
    kit = await account(s, "kit");
    await account(s, "mom");
    [ownerId, miaId, bobId, kitId, momId] = ["owner", "mia", "bob", "kit", "mom"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number, number, number];
    const sv = (await call(owner, "POST", "/api/servers", { name: "Den" })).body as ChatServer;
    serverId = sv.id;
    general = sv.channels[0]!;
    const invite = (await call(owner, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
    for (const who of [mia, bob, kit]) assert.equal((await call(who, "POST", `/api/invites/${invite.code}/accept`)).status, 200);
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(kitId, momId, new Date().toISOString());
  });
  after(() => s.close());

  it("gives XP for chatting, once a minute", async () => {
    assert.equal((await view(mia)).levels, true);
    assert.equal(await xpOf(miaId), 0);
    assert.equal((await say(mia, "hi all")).status, 200);
    const first = (await xpOf(miaId))!;
    assert.ok(first >= 15 && first <= 25, String(first));
    assert.equal((await say(mia, "spam spam")).status, 200);
    assert.equal(await xpOf(miaId), first, "no XP inside the cooldown");
  });

  it("tells you when you level up and shows the leaderboard", async () => {
    s.ctx.levels!.setXp(serverId, bobId, 95);
    const bobEvents = await listen(s, bob);
    try {
      assert.equal((await say(bob, "level me")).status, 200);
      const up = await bobEvents.waitFor("level.up");
      assert.equal(up.serverId, serverId);
      assert.equal(up.level, 1);
      assert.equal(up.rank.name, "Kit");
      assert.equal(up.rankUp, false);
      // Level 2 is a new rank.
      s.ctx.levels!.setXp(serverId, bobId, 295);
      await say(bob, "again");
      const next = await bobEvents.waitFor("level.up");
      assert.equal(next.rank.name, "Scavenger");
      assert.equal(next.rankUp, true);
    } finally {
      bobEvents.ws.close();
    }
    const board = (await call(kit, "GET", `/api/servers/${serverId}/levels`)).body as LeaderboardEntry[];
    assert.deepEqual(
      board.map((e) => e.userId),
      [bobId, miaId],
    );
  });

  it("lets moderators reset XP and turn levels off", async () => {
    assert.equal((await call(mia, "DELETE", `/api/servers/${serverId}/levels/${bobId}`)).status, 403);
    assert.equal((await call(owner, "DELETE", `/api/servers/${serverId}/levels/${bobId}`)).status, 200);
    assert.equal(await xpOf(bobId), 0);

    assert.equal((await call(mia, "PATCH", `/api/servers/${serverId}`, { levels: false })).status, 403);
    assert.equal((await call(owner, "PATCH", `/api/servers/${serverId}`, { levels: false })).status, 200);
    const off = await view(mia);
    assert.equal(off.levels, false);
    assert.ok(off.members.every((m) => m.xp === null));
    s.ctx.levels!.setXp(serverId, ownerId, 0);
    await say(owner, "no xp now");
    assert.deepEqual((await call(mia, "GET", `/api/servers/${serverId}/levels`)).body, []);
    await call(owner, "PATCH", `/api/servers/${serverId}`, { levels: true });
    assert.equal(await xpOf(ownerId), 0);

    assert.equal((await call(owner, "DELETE", `/api/servers/${serverId}/levels`)).status, 200);
    assert.ok((await view(owner)).members.every((m) => m.xp === 0));
  });

  it("lets moderators set up a welcome screen with rules and roles to pick", async () => {
    const gamers = (await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Gamers", color: "#43a047" })).body as CustomRole;
    const artists = (await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Artists" })).body as CustomRole;
    const mods = (await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Mods", permissions: ["deleteMessages"] })).body as CustomRole;

    assert.equal((await call(mia, "PUT", `/api/servers/${serverId}/welcome`, { enabled: true })).status, 403);
    // A role that moderates can't be picked by anyone.
    const bad = await call(owner, "PUT", `/api/servers/${serverId}/welcome`, { roles: [{ roleId: mods.id }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /moderate/);
    // Rude words are kept out, since kids see it.
    assert.equal((await call(owner, "PUT", `/api/servers/${serverId}/welcome`, { rules: ["no shit"] })).status, 400);

    const res = await call(owner, "PUT", `/api/servers/${serverId}/welcome`, {
      enabled: true,
      message: "Welcome to the den!",
      rules: ["Be kind", "  ", "No spoilers"],
      requireAgree: true,
      roles: [
        { roleId: gamers.id, emoji: "🎮", description: "Game nights" },
        { roleId: artists.id, emoji: "🎨" },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const w = (await view(kit)).welcome;
    assert.equal(w.enabled, true);
    assert.deepEqual(w.rules, ["Be kind", "No spoilers"]);
    assert.deepEqual(
      w.roles.map((r) => [r.roleId, r.emoji, r.description]),
      [
        [gamers.id, "🎮", "Game nights"],
        [artists.id, "🎨", ""],
      ],
    );
    // And a role on the welcome screen can't be turned into a moderator role.
    const upgrade = await call(owner, "PATCH", `/api/servers/${serverId}/roles/${gamers.id}`, { permissions: ["kickMembers"] });
    assert.equal(upgrade.status, 400);
    assert.match(upgrade.body.error, /welcome screen/);
  });

  it("keeps members from posting until they agree, and lets them pick roles", async () => {
    const before = await view(kit);
    assert.equal(before.welcomedAt, null);
    const blocked = await say(kit, "hello?");
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /agree/);
    // The owner and admins never have to.
    assert.equal((await say(owner, "rules are up")).status, 200);

    const [gamers, artists] = before.welcome.roles.map((r) => r.roleId) as [number, number];
    const modsId = before.roles.find((r) => r.name === "Mods")!.id;
    assert.equal((await call(kit, "POST", `/api/servers/${serverId}/welcome/done`, { roleIds: [modsId] })).status, 403);
    assert.equal((await view(kit)).welcomedAt, null, "nothing changes when a pick is refused");

    const done = await call(kit, "POST", `/api/servers/${serverId}/welcome/done`, { roleIds: [gamers] });
    assert.equal(done.status, 200);
    const after = done.body as ChatServer;
    assert.ok(after.welcomedAt);
    assert.deepEqual(after.members.find((m) => m.user.id === kitId)!.roleIds, [gamers]);
    assert.deepEqual(after.myPermissions, []);
    assert.equal((await say(kit, "hello!")).status, 200);

    // Picking again later swaps welcome roles but leaves other roles alone.
    const cousins = (await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Cousins" })).body as CustomRole;
    assert.equal((await call(owner, "PUT", `/api/servers/${serverId}/members/${kitId}/roles`, { roleIds: [gamers, cousins.id] })).status, 200);
    const repick = await call(kit, "PUT", `/api/servers/${serverId}/me/roles`, { roleIds: [artists] });
    assert.equal(repick.status, 200);
    assert.deepEqual((repick.body as ChatServer).members.find((m) => m.user.id === kitId)!.roleIds.sort(), [artists, cousins.id].sort());

    // Turning the welcome screen off lifts the requirement for everyone else too.
    assert.equal((await say(mia, "can I talk")).status, 403);
    await call(owner, "PUT", `/api/servers/${serverId}/welcome`, { requireAgree: false });
    assert.equal((await say(mia, "now I can")).status, 200);
  });

  it("lets someone with Manage roles only list roles below their own", async () => {
    const helper = (await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Helpers", permissions: ["manageServer", "manageRoles"] })).body as CustomRole;
    // Helpers ranks lowest, so move it to the top.
    const order = (await view(owner)).roles.map((r) => r.id).filter((x) => x !== helper.id);
    await call(owner, "PUT", `/api/servers/${serverId}/roles/order`, { ids: [helper.id, ...order] });
    await call(owner, "PUT", `/api/servers/${serverId}/members/${bobId}/roles`, { roleIds: [helper.id] });
    const roles = (await view(owner)).roles;
    const top = roles.find((r) => r.name === "Helpers")!;
    const res = await call(bob, "PUT", `/api/servers/${serverId}/welcome`, { roles: [{ roleId: top.id }] });
    assert.equal(res.status, 400, "moderator roles never");
    const gamers = roles.find((r) => r.name === "Gamers")!;
    assert.equal((await call(bob, "PUT", `/api/servers/${serverId}/welcome`, { roles: [{ roleId: gamers.id }] })).status, 200);
  });
});
