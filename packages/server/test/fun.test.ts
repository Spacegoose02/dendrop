import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { parseDice, type ChatServer, type Conversation, type Message, type Reminder, type ServerInvite } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const b64 = (n: number) => randomBytes(n).toString("base64url");
const publicKey = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
};
const backup = () => ({ salt: b64(16), iterations: 600_000, iv: b64(12), ciphertext: b64(150) });
const wrapped = () => `${b64(65)}.${b64(12)}.${b64(48)}`;
const ciphertext = (n = 40) => `${b64(12)}.${b64(n)}`;

describe("polls, quick games, nudges and reminders", () => {
  let s: TestServer;
  let ana: string, ben: string, cat: string, kid: string;
  let anaId: number, benId: number, catId: number, kidId: number;
  let dm: number, group: number, kidDm: number;

  const call = async <T = Message>(cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json<T & { error?: string }>() };
  };
  const befriend = async (a: string, b: string, bId: number, aId: number) => {
    await call(a, "POST", "/api/friends", { username: s.ctx.users.byId(bId)!.username });
    await call(b, "POST", `/api/friends/${aId}/accept`);
  };

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    ana = await account(s, "ana");
    ben = await account(s, "ben");
    cat = await account(s, "cat");
    kid = await account(s, "kid");
    [anaId, benId, catId, kidId] = ["ana", "ben", "cat", "kid"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number, number];
    await befriend(ana, ben, benId, anaId);
    await befriend(ana, cat, catId, anaId);
    await befriend(ana, kid, kidId, anaId);
    dm = (await call<Conversation>(ana, "POST", "/api/conversations", { userId: benId })).body.id;
    group = (await call<Conversation>(ana, "POST", "/api/conversations", { userIds: [benId, catId], name: "Den" })).body.id;
    kidDm = (await call<Conversation>(ana, "POST", "/api/conversations", { userId: kidId })).body.id;
    // Kid becomes a kid account of ana's, with "broccoli" on the family filter.
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(kidId, catId, new Date().toISOString());
    s.ctx.db.prepare("INSERT INTO kid_rules (kid_id, blocked_words) VALUES (?, ?)").run(kidId, JSON.stringify(["broccoli"]));
  });
  after(() => s.close());

  describe("polls", () => {
    it("posts a plain poll that everyone sees, and checks it", async () => {
      const bad = [
        {},
        { question: "Pizza?", options: ["Yes"] },
        { question: "Pizza?", options: ["Yes", "yes"] },
        { question: "", options: ["A", "B"] },
        { question: "Q", options: Array.from({ length: 11 }, (_, i) => `o${i}`) },
        { question: "Q", options: ["A", "B"], closesInMinutes: 0 },
      ];
      for (const payload of bad) assert.equal((await call(ana, "POST", `/api/conversations/${group}/polls`, payload)).status, 400, JSON.stringify(payload));
      const l = await listen(s, ben);
      const r = await call(ana, "POST", `/api/conversations/${group}/polls`, { question: "  Movie   night? ", options: ["Friday", " Saturday ", ""], closesInMinutes: 60 });
      assert.equal(r.status, 200);
      assert.equal(r.body.body, "Movie night?");
      assert.deepEqual(r.body.poll?.options, ["Friday", "Saturday"]);
      assert.equal(r.body.poll?.optionCount, 2);
      assert.equal(r.body.poll?.closed, false);
      assert.ok(r.body.poll?.closesAt);
      assert.deepEqual(r.body.poll?.votes, [[], []]);
      const e = await l.waitFor("message.created");
      assert.equal(e.message.poll?.question, "Movie night?");
      l.ws.close();
      assert.equal((await call(ana, "POST", `/api/conversations/${dm}/polls`, { question: "Q", options: ["A", "B"] })).status, 200);
      assert.equal((await call(cat, "POST", `/api/conversations/${dm}/polls`, { question: "Q", options: ["A", "B"] })).status, 404, "not in that chat");
    });

    it("counts votes: one pick unless multi, changeable until it closes", async () => {
      const p = (await call(ana, "POST", `/api/conversations/${group}/polls`, { question: "Snacks?", options: ["Chips", "Grapes", "Trash"] })).body;
      assert.equal((await call(ben, "POST", `/api/messages/${p.id}/votes`, { options: [0, 1] })).status, 400, "single choice");
      assert.equal((await call(ben, "POST", `/api/messages/${p.id}/votes`, { options: [3] })).status, 400);
      assert.equal((await call(ben, "POST", `/api/messages/${p.id}/votes`, { options: "0" })).status, 400);
      assert.deepEqual((await call(ben, "POST", `/api/messages/${p.id}/votes`, { options: [0] })).body.poll?.votes, [[benId], [], []]);
      const l = await listen(s, ana);
      const r = await call(cat, "POST", `/api/messages/${p.id}/votes`, { options: [0] });
      assert.deepEqual(r.body.poll?.votes, [[benId, catId], [], []]);
      assert.deepEqual((await l.waitFor("message.updated")).message.poll?.votes, [[benId, catId], [], []]);
      l.ws.close();
      assert.deepEqual((await call(ben, "POST", `/api/messages/${p.id}/votes`, { options: [2] })).body.poll?.votes, [[catId], [], [benId]], "changed");
      assert.deepEqual((await call(ben, "POST", `/api/messages/${p.id}/votes`, { options: [] })).body.poll?.votes, [[catId], [], []], "taken back");
      const plain = (await call(ana, "POST", `/api/conversations/${group}/messages`, { body: "not a poll" })).body;
      assert.equal((await call(ben, "POST", `/api/messages/${plain.id}/votes`, { options: [0] })).status, 404);

      const multi = (await call(ana, "POST", `/api/conversations/${group}/polls`, { question: "Which?", options: ["A", "B"], multi: true })).body;
      assert.deepEqual((await call(ben, "POST", `/api/messages/${multi.id}/votes`, { options: [0, 1, 1] })).body.poll?.votes, [[benId], [benId]]);

      assert.equal((await call(ben, "POST", `/api/messages/${p.id}/close-poll`)).status, 403, "only its maker");
      const closed = await call(ana, "POST", `/api/messages/${p.id}/close-poll`);
      assert.equal(closed.body.poll?.closed, true);
      assert.equal((await call(ben, "POST", `/api/messages/${p.id}/votes`, { options: [1] })).status, 409);
      assert.equal((await call(ana, "POST", `/api/messages/${p.id}/close-poll`)).status, 409);
    });

    it("closes by itself when its time is up", async () => {
      const p = (await call(ana, "POST", `/api/conversations/${dm}/polls`, { question: "Quick?", options: ["Y", "N"], closesInMinutes: 5 })).body;
      s.ctx.db.prepare("UPDATE polls SET closes_at = ? WHERE message_id = ?").run(new Date(Date.now() - 1000).toISOString(), p.id);
      assert.equal((await call(ben, "POST", `/api/messages/${p.id}/votes`, { options: [0] })).status, 409);
    });

    it("can't be edited, and loses its poll when deleted", async () => {
      const p = (await call(ana, "POST", `/api/conversations/${dm}/polls`, { question: "Edit me?", options: ["Y", "N"] })).body;
      assert.equal((await call(ana, "PATCH", `/api/messages/${p.id}`, { body: "Changed" })).status, 400);
      const d = await call(ana, "DELETE", `/api/messages/${p.id}`);
      assert.equal(d.body.poll, null);
      assert.equal((await call(ben, "POST", `/api/messages/${p.id}/votes`, { options: [0] })).status, 409);
    });

    it("keeps an encrypted chat's question and options in the ciphertext", async () => {
      const keys: Record<number, string> = {};
      for (const [cookie, uid] of [
        [ana, anaId],
        [ben, benId],
      ] as const) {
        keys[uid] = publicKey();
        await call(cookie, "PUT", "/api/e2ee", { publicKey: keys[uid], backup: backup() });
      }
      const keysFor = Object.fromEntries([anaId, benId].map((u) => [u, { publicKey: keys[u], wrapped: wrapped() }]));
      assert.equal((await call(ana, "POST", `/api/conversations/${dm}/keys`, { version: 1, keys: keysFor })).status, 200);

      assert.equal((await call(ana, "POST", `/api/conversations/${dm}/polls`, { question: "Plain?", options: ["A", "B"] })).status, 409, "must be encrypted now");
      assert.equal((await call(ana, "POST", `/api/conversations/${dm}/polls`, { body: "not cipher", keyVersion: 1, optionCount: 2 })).status, 400);
      assert.equal((await call(ana, "POST", `/api/conversations/${dm}/polls`, { body: ciphertext(), keyVersion: 1, optionCount: 1 })).status, 400);
      const body = ciphertext();
      const r = await call(ana, "POST", `/api/conversations/${dm}/polls`, { body, keyVersion: 1, optionCount: 3, question: "leaked?", options: ["x", "y", "z"] });
      assert.equal(r.status, 200);
      assert.equal(r.body.body, body);
      assert.equal(r.body.keyVersion, 1);
      assert.equal(r.body.poll?.question, null, "the server never stores the words");
      assert.equal(r.body.poll?.options, null);
      assert.equal(r.body.poll?.optionCount, 3);
      const row = s.ctx.db.prepare("SELECT question, options FROM polls WHERE message_id = ?").get(r.body.id) as { question: null; options: null };
      assert.deepEqual({ ...row }, { question: null, options: null });
      assert.deepEqual((await call(ben, "POST", `/api/messages/${r.body.id}/votes`, { options: [2] })).body.poll?.votes, [[], [], [benId]]);

      // Games and nudges have no words, so they still work in an encrypted chat.
      const g = await call(ana, "POST", `/api/conversations/${dm}/games`, { kind: "dice", dice: "d20" });
      assert.equal(g.status, 200);
      assert.equal(g.body.keyVersion, null);
      assert.equal(g.body.body, "");
    });
  });

  describe("games", () => {
    it("plays tic-tac-toe in a DM, checking turns and wins", async () => {
      const g = (await call(ana, "POST", `/api/conversations/${dm}/games`, { kind: "tictactoe" })).body;
      assert.deepEqual(g.game?.players, [anaId, benId], "the other person is seated");
      assert.equal(g.game?.turn, anaId);
      const move = (cookie: string, cell: number) => call(cookie, "POST", `/api/messages/${g.id}/game`, { action: "move", cell });
      assert.equal((await move(ben, 0)).status, 409, "not ben's turn");
      assert.equal((await move(cat, 0)).status, 404, "not in the chat");
      assert.equal((await move(ana, 9)).status, 400);
      await move(ana, 0);
      assert.equal((await move(ben, 0)).status, 400, "taken");
      await move(ben, 3);
      await move(ana, 1);
      await move(ben, 4);
      const won = (await move(ana, 2)).body.game!;
      assert.equal(won.winner, anaId);
      assert.deepEqual(won.line, [0, 1, 2]);
      assert.equal(won.done, true);
      assert.equal(won.turn, null);
      assert.deepEqual(won.board, [1, 1, 1, 2, 2, 0, 0, 0, 0]);
      assert.equal((await move(ben, 5)).status, 409, "over");
    });

    it("calls a full board with no line a draw", async () => {
      const g = (await call(ben, "POST", `/api/conversations/${dm}/games`, { kind: "tictactoe" })).body;
      const order: [string, number][] = [
        [ben, 0],
        [ana, 1],
        [ben, 2],
        [ana, 4],
        [ben, 3],
        [ana, 5],
        [ben, 7],
        [ana, 6],
        [ben, 8],
      ];
      let last: Message | undefined;
      for (const [who, cell] of order) last = (await call(who, "POST", `/api/messages/${g.id}/game`, { action: "move", cell })).body;
      assert.equal(last?.game?.draw, true);
      assert.equal(last?.game?.winner, null);
    });

    it("opens a seat in a group chat for whoever joins first", async () => {
      const g = (await call(ana, "POST", `/api/conversations/${group}/games`, { kind: "tictactoe" })).body;
      assert.deepEqual(g.game?.players, [anaId]);
      assert.equal(g.game?.turn, null);
      assert.equal((await call(ana, "POST", `/api/messages/${g.id}/game`, { action: "move", cell: 0 })).status, 409, "waiting for a player");
      assert.equal((await call(ana, "POST", `/api/messages/${g.id}/game`, { action: "join" })).status, 409);
      const j = await call(cat, "POST", `/api/messages/${g.id}/game`, { action: "join" });
      assert.deepEqual(j.body.game?.players, [anaId, catId]);
      assert.equal(j.body.game?.turn, anaId);
      assert.equal((await call(ben, "POST", `/api/messages/${g.id}/game`, { action: "join" })).status, 409, "full");
      assert.equal((await call(ben, "POST", `/api/messages/${g.id}/game`, { action: "move", cell: 0 })).status, 403);
    });

    it("keeps rock paper scissors picks secret until both are in", async () => {
      const g = (await call(ana, "POST", `/api/conversations/${dm}/games`, { kind: "rps" })).body;
      assert.equal((await call(ana, "POST", `/api/messages/${g.id}/game`, { action: "pick", pick: "lizard" })).status, 400);
      const l = await listen(s, ben);
      const one = await call(ana, "POST", `/api/messages/${g.id}/game`, { action: "pick", pick: "rock" });
      assert.deepEqual(one.body.game?.picked, [anaId]);
      assert.equal(one.body.game?.picks, null);
      const seen = await l.waitFor("message.updated");
      assert.ok(!JSON.stringify(seen).includes("rock"), "ben can't see ana's pick");
      l.ws.close();
      assert.equal((await call(ana, "POST", `/api/messages/${g.id}/game`, { action: "pick", pick: "paper" })).status, 409);
      const both = (await call(ben, "POST", `/api/messages/${g.id}/game`, { action: "pick", pick: "scissors" })).body.game!;
      assert.deepEqual(both.picks, ["rock", "scissors"]);
      assert.equal(both.winner, anaId);
      assert.equal(both.done, true);
    });

    it("rolls dice on the server", async () => {
      assert.deepEqual(parseDice("2d6"), { count: 2, sides: 6 });
      assert.deepEqual(parseDice("d20"), { count: 1, sides: 20 });
      for (const bad of ["0d6", "11d6", "2d1", "2d1001", "pizza", "2x6"]) assert.equal(parseDice(bad), null, bad);
      assert.equal((await call(ana, "POST", `/api/conversations/${group}/games`, { kind: "dice", dice: "99d6" })).status, 400);
      assert.equal((await call(ana, "POST", `/api/conversations/${group}/games`, { kind: "chess" })).status, 400);
      const g = (await call(ana, "POST", `/api/conversations/${group}/games`, { kind: "dice", dice: "3d6" })).body.game!;
      assert.equal(g.dice?.spec, "3d6");
      assert.equal(g.dice?.rolls.length, 3);
      assert.ok(g.dice!.rolls.every((r) => r >= 1 && r <= 6));
      assert.equal(g.dice?.total, g.dice!.rolls.reduce((a, b) => a + b, 0));
      assert.equal(g.done, true);
      const plain = (await call(ana, "POST", `/api/conversations/${group}/games`, { kind: "dice" })).body.game!;
      assert.equal(plain.dice?.spec, "1d6");
    });
  });

  describe("nudges", () => {
    it("sends raccoon nudges, one every 30 seconds", async () => {
      assert.equal((await call(ana, "POST", `/api/conversations/${group}/nudges`, { kind: "slap" })).status, 400);
      const l = await listen(s, cat);
      const n = await call(ana, "POST", `/api/conversations/${group}/nudges`, { kind: "snack" });
      assert.equal(n.status, 200);
      assert.equal(n.body.nudge, "snack");
      assert.equal((await l.waitFor("message.created")).message.nudge, "snack");
      l.ws.close();
      const again = await call(ana, "POST", `/api/conversations/${group}/nudges`, { kind: "wave" });
      assert.equal(again.status, 429);
      assert.match(again.body.error!, /nudge again in \d+ seconds/);
      assert.equal((await call(ben, "POST", `/api/conversations/${group}/nudges`, { kind: "wave" })).status, 200, "per person");
      assert.equal((await call(ana, "PATCH", `/api/messages/${n.body.id}`, { body: "hi" })).status, 400);
    });
  });

  describe("server channels", () => {
    it("allows polls and games but not nudges, under automod", async () => {
      s.ctx.db.prepare("UPDATE users SET can_create_servers = 1 WHERE id = ?").run(anaId);
      const sv = (await call<ChatServer>(ana, "POST", "/api/servers", { name: "Den" })).body;
      const invite = (await call<ServerInvite>(ana, "POST", `/api/servers/${sv.id}/invites`, {})).body;
      await call(ben, "POST", `/api/invites/${invite.code}/accept`);
      const cid = sv.channels[0]!.conversationId;
      const p = await call(ben, "POST", `/api/conversations/${cid}/polls`, { question: "Game night?", options: ["Fri", "Sat"] });
      assert.equal(p.status, 200);
      const g = await call(ben, "POST", `/api/conversations/${cid}/games`, { kind: "tictactoe" });
      assert.deepEqual(g.body.game?.players, [benId], "open seat in a channel");
      assert.equal((await call(ben, "POST", `/api/conversations/${cid}/nudges`, { kind: "poke" })).status, 400);
      // A timed-out member can't vote or play.
      s.ctx.db
        .prepare("INSERT INTO server_timeouts (server_id, user_id, until, reason, created_at) VALUES (?, ?, ?, '', ?)")
        .run(sv.id, benId, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
      assert.equal((await call(ben, "POST", `/api/messages/${p.body.id}/votes`, { options: [0] })).status, 403);
      assert.equal((await call(ben, "POST", `/api/conversations/${cid}/polls`, { question: "Again?", options: ["Y", "N"] })).status, 403);
    });
  });

  describe("kids", () => {
    it("runs a kid's plain poll through the family filter, and stops play when chat time is over", async () => {
      const r = await call(kid, "POST", `/api/conversations/${kidDm}/polls`, { question: "Dinner?", options: ["Pizza", "Broccoli"] });
      assert.equal(r.status, 400);
      assert.match(r.body.error!, /family filter/);
      assert.equal((await call(kid, "POST", `/api/conversations/${kidDm}/polls`, { question: "Dinner?", options: ["Pizza", "Tacos"] })).status, 200);
      const g = (await call(ana, "POST", `/api/conversations/${kidDm}/games`, { kind: "tictactoe" })).body;
      await call(ana, "POST", `/api/messages/${g.id}/game`, { action: "move", cell: 4 });
      // Chat time over: no moves, votes, games or nudges.
      s.ctx.db.prepare("UPDATE kid_rules SET daily_minutes = 0 WHERE kid_id = ?").run(kidId);
      for (const [url, payload] of [
        [`/api/messages/${g.id}/game`, { action: "move", cell: 0 }],
        [`/api/conversations/${kidDm}/games`, { kind: "dice" }],
        [`/api/conversations/${kidDm}/nudges`, { kind: "wave" }],
      ] as const) {
        assert.equal((await call(kid, "POST", url, payload)).status, 403, url);
      }
      s.ctx.db.prepare("UPDATE kid_rules SET daily_minutes = NULL WHERE kid_id = ?").run(kidId);
      assert.equal((await call(kid, "POST", `/api/messages/${g.id}/game`, { action: "move", cell: 0 })).status, 200);
    });
  });

  describe("reminders", () => {
    it("pings you about a message later, only you", async () => {
      const m = (await call(ben, "POST", `/api/conversations/${group}/messages`, { body: "Bring the trash bags" })).body;
      const soon = new Date(Date.now() + 60_000).toISOString();
      assert.equal((await call(ana, "POST", `/api/messages/${m.id}/reminders`, { at: "tomorrow-ish" })).status, 400);
      assert.equal((await call(ana, "POST", `/api/messages/${m.id}/reminders`, { at: new Date(Date.now() - 1000).toISOString() })).status, 400);
      assert.equal((await call(ana, "POST", `/api/messages/${m.id}/reminders`, { at: new Date(Date.now() + 400 * 86_400_000).toISOString() })).status, 400);
      assert.equal((await call(kid, "POST", `/api/messages/${m.id}/reminders`, { at: soon })).status, 404, "not in that chat");
      const r = await call<Reminder>(ana, "POST", `/api/messages/${m.id}/reminders`, { at: soon });
      assert.equal(r.status, 200);
      assert.equal(r.body.messageId, m.id);
      assert.equal(r.body.firedAt, null);
      const other = (await call<Reminder>(ana, "POST", `/api/messages/${m.id}/reminders`, { at: new Date(Date.now() + 3_600_000).toISOString() })).body;
      assert.equal((await call<Reminder[]>(ana, "GET", "/api/reminders")).body.length, 2);
      assert.equal((await call<Reminder[]>(ben, "GET", "/api/reminders")).body.length, 0);
      assert.equal((await call(ben, "DELETE", `/api/reminders/${other.id}`)).status, 404, "not ben's");
      assert.equal((await call(ana, "DELETE", `/api/reminders/${other.id}`)).status, 200);

      const la = await listen(s, ana);
      const lb = await listen(s, ben);
      s.ctx.fireReminders!(new Date(Date.now() + 30_000));
      s.ctx.fireReminders!(new Date(Date.now() + 120_000));
      const e = await la.waitFor("reminder");
      assert.equal(e.reminder.id, r.body.id);
      assert.ok(e.reminder.firedAt);
      assert.equal(e.message?.body, "Bring the trash bags");
      s.ctx.fireReminders!(new Date(Date.now() + 240_000));
      await new Promise((res) => setTimeout(res, 100));
      assert.equal(la.events.filter((x) => x.type === "reminder").length, 0, "fires once");
      assert.equal(lb.events.filter((x) => x.type === "reminder").length, 0);
      la.ws.close();
      lb.ws.close();
      // It stays listed as gone off until dismissed.
      const list = (await call<Reminder[]>(ana, "GET", "/api/reminders")).body;
      assert.equal(list.length, 1);
      assert.ok(list[0]!.firedAt);
      await call(ana, "DELETE", `/api/reminders/${r.body.id}`);
      assert.equal((await call<Reminder[]>(ana, "GET", "/api/reminders")).body.length, 0);
    });
  });
});
