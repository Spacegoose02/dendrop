import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { gifIdFromLink, isUnicodeEmoji, type ChatServer, type CustomEmoji, type Message, type Reaction, type ServerInvite, type Sticker } from "@dendrop/shared";
import { sniffPicture } from "../src/expressions.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

/** A 1x1 PNG. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000301010018dd8db00000000049454e44ae426082", "hex");
/** A 1x1 GIF with one frame, and the same with two. */
const GIF1 = Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex");
const GIF2 = Buffer.from(
  "47494638396101000100800000000000ffffff21ff0b4e45545343415045322e300301000000" +
    "21f90404000000002c000000000100010000020244010021f90404000000002c00000000010001000002024401003b",
  "hex",
);

describe("custom emoji, stickers, reactions and GIFs", () => {
  let s: TestServer;
  let owner: string, mia: string, bob: string, kit: string, out: string;
  let miaId: number, bobId: number, kitId: number, momId: number;
  let serverId: number;
  let general: { id: number; conversationId: number };
  const giphyCalls: string[] = [];
  const giphy = {
    rating: "g",
    async fetch(url: string): Promise<Response> {
      giphyCalls.push(url);
      const u = new URL(url);
      if (u.hostname === "media.giphy.com") return new Response(new Uint8Array(GIF2), { headers: { "content-type": "image/gif" } });
      if (u.searchParams.get("api_key") !== "KEY") return new Response("{}", { status: 401 });
      if (/\/v1\/gifs\/(search|trending)$/.test(u.pathname)) {
        return Response.json({
          data: [
            { id: "abcd1234", title: "Raccoon wave", url: "https://giphy.com/gifs/raccoon-wave-abcd1234", rating: "g", images: { fixed_width: { width: "200", height: "150" } } },
            { id: "spicy9999", title: "Spicy", rating: "r", images: {} },
          ],
          pagination: { total_count: 2, count: 2, offset: 0 },
        });
      }
      const one = /\/v1\/gifs\/([A-Za-z0-9]+)$/.exec(u.pathname);
      if (one) return Response.json({ data: { id: one[1], rating: one[1]!.startsWith("spicy") ? "r" : giphy.rating } });
      return new Response("{}", { status: 404 });
    },
  };

  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? res.json() : res.rawPayload };
  };
  const upload = async (cookie: string, url: string, fields: Record<string, string>, data: Buffer, type = "image/png") => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", new Blob([new Uint8Array(data)], { type }), "pic");
    const res = await fetch(`${s.url}${url}`, { method: "POST", headers: { cookie }, body: form });
    return { status: res.status, body: (await res.json()) as CustomEmoji & Sticker & { error?: string } };
  };
  const view = async (cookie: string) => (await call(cookie, "GET", `/api/servers/${serverId}`)).body as ChatServer;
  const send = async (cookie: string, body: string) => (await call(cookie, "POST", `/api/conversations/${general.conversationId}/messages`, { body })).body as Message;
  const react = (cookie: string, messageId: number, emoji: string, on = true) =>
    call(cookie, on ? "PUT" : "DELETE", `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" }, { gifFetch: (url) => giphy.fetch(url) });
    owner = await account(s, "owner");
    mia = await account(s, "mia");
    bob = await account(s, "bob");
    kit = await account(s, "kit");
    out = await account(s, "out");
    await account(s, "mom");
    [miaId, bobId, kitId, momId] = ["mia", "bob", "kit", "mom"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number, number];
    const sv = (await call(owner, "POST", "/api/servers", { name: "Den" })).body as ChatServer;
    serverId = sv.id;
    general = sv.channels[0]!;
    const invite = (await call(owner, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
    for (const who of [mia, bob, kit]) assert.equal((await call(who, "POST", `/api/invites/${invite.code}/accept`)).status, 200);
    // Kit becomes a kid (linking itself is covered in family.test.ts).
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(kitId, momId, new Date().toISOString());
    s.ctx.db.prepare("INSERT INTO kid_rules (kid_id, can_join_servers) VALUES (?, 1)").run(kitId);
  });
  after(() => s.close());

  it("tells pictures apart by their bytes, and finds the ones that move", () => {
    assert.deepEqual(sniffPicture(PNG), { type: "image/png", animated: false });
    assert.deepEqual(sniffPicture(GIF1), { type: "image/gif", animated: false });
    assert.deepEqual(sniffPicture(GIF2), { type: "image/gif", animated: true });
    assert.equal(sniffPicture(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), undefined);
  });

  it("knows emoji from text", () => {
    for (const e of ["👍", "❤️", "🦝", "👨‍👩‍👧", "🇺🇸", "1️⃣", "👋🏽"]) assert.ok(isUnicodeEmoji(e), e);
    for (const e of ["a", "1", "", " ", "<script>", "👍 hi", "x".repeat(40)]) assert.ok(!isUnicodeEmoji(e), e);
  });

  it("lets people with Manage emoji & stickers upload emoji, still and animated", async () => {
    // Members can't, until a role lets them.
    assert.equal((await upload(mia, `/api/servers/${serverId}/emojis`, { name: "wave" }, PNG)).status, 403);
    const role = (await call(owner, "POST", `/api/servers/${serverId}/roles`, { name: "Artists", permissions: ["manageExpressions"] })).body as { id: number };
    await call(owner, "PUT", `/api/servers/${serverId}/members/${miaId}/roles`, { roleIds: [role.id] });

    const live = await listen(s, bob);
    const still = await upload(mia, `/api/servers/${serverId}/emojis`, { name: "raccoon_wave" }, PNG);
    assert.equal(still.status, 200, JSON.stringify(still.body));
    assert.equal(still.body.animated, false);
    assert.equal(still.body.url, `/api/emojis/${still.body.id}`);
    // Everyone in the server hears about it.
    assert.deepEqual((await live.waitFor("server.updated")).server.emojis.map((e) => e.name), ["raccoon_wave"]);
    live.ws.close();

    const moving = await upload(mia, `/api/servers/${serverId}/emojis`, { name: "dance" }, GIF2, "image/gif");
    assert.equal(moving.body.animated, true);
    assert.deepEqual((await view(bob)).emojis.map((e) => [e.name, e.animated]), [["dance", true], ["raccoon_wave", false]]);

    // Anyone signed in can see the picture (it travels in messages), with its real type.
    const pic = await s.app.inject({ method: "GET", url: moving.body.url, headers: { cookie: out } });
    assert.equal(pic.statusCode, 200);
    assert.equal(pic.headers["content-type"], "image/gif");
    assert.equal(pic.headers["x-content-type-options"], "nosniff");
    assert.equal((await s.app.inject({ method: "GET", url: moving.body.url })).statusCode, 401);
  });

  it("checks emoji names and pictures", async () => {
    const url = `/api/servers/${serverId}/emojis`;
    assert.equal((await upload(owner, url, { name: "a" }, PNG)).status, 400);
    assert.equal((await upload(owner, url, { name: "has space" }, PNG)).status, 400);
    assert.equal((await upload(owner, url, { name: "shit_happens" }, PNG)).status, 400);
    assert.equal((await upload(owner, url, { name: "RACCOON_WAVE" }, PNG)).status, 409);
    // The upload's type isn't trusted: an SVG (which could run script) labelled PNG is refused.
    assert.equal((await upload(owner, url, { name: "sneaky" }, Buffer.from("<svg onload='alert(1)'></svg>"), "image/png")).status, 400);
    assert.equal((await upload(owner, url, { name: "huge" }, Buffer.concat([PNG, Buffer.alloc(300 * 1024)]))).status, 413);

    const emoji = (await view(owner)).emojis.find((e) => e.name === "dance")!;
    assert.equal((await call(bob, "PATCH", `${url}/${emoji.id}`, { name: "boogie" })).status, 403);
    assert.equal(((await call(mia, "PATCH", `${url}/${emoji.id}`, { name: "boogie" })).body as CustomEmoji).name, "boogie");
  });

  it("adds stickers, which are sent as a message of their own", async () => {
    const url = `/api/servers/${serverId}/stickers`;
    assert.equal((await upload(bob, url, { name: "hi" }, PNG)).status, 403);
    const st = await upload(mia, url, { name: "trash_panda", description: "Our mascot", emoji: "🦝" }, GIF2, "image/gif");
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.emoji, "🦝");
    assert.equal(st.body.animated, true);
    assert.equal((await upload(mia, url, { name: "bad_emoji", emoji: "abc" }, PNG)).status, 400);
    assert.deepEqual((await view(kit)).stickers.map((x) => x.name), ["trash_panda"]);
    assert.equal(((await call(mia, "PATCH", `${url}/${st.body.id}`, { description: "Hello!" })).body as Sticker).description, "Hello!");

    const m = await send(bob, `<sticker:trash_panda:${st.body.id}>`);
    assert.equal(m.body, `<sticker:trash_panda:${st.body.id}>`);
    assert.equal((await s.app.inject({ method: "GET", url: st.body.url, headers: { cookie: kit } })).statusCode, 200);
  });

  it("reacts with emoji and custom emoji, and tells everyone in the chat", async () => {
    const m = await send(bob, "Pizza tonight?");
    assert.deepEqual(m.reactions, []);
    const live = await listen(s, bob);
    const first = await react(mia, m.id, "🍕");
    assert.equal(first.status, 200);
    const ev = await live.waitFor("message.reactions");
    assert.equal(ev.messageId, m.id);
    assert.deepEqual(ev.reactions, [{ emoji: "🍕", count: 1, userIds: [miaId] }]);
    live.ws.close();

    await react(bob, m.id, "🍕");
    await react(bob, m.id, "🍕"); // twice is still once
    const emoji = (await view(owner)).emojis.find((e) => e.name === "boogie")!;
    const token = `<a:boogie:${emoji.id}>`;
    assert.equal((await react(owner, m.id, token)).status, 200);
    // A custom emoji's name in the token doesn't matter; the id does.
    await react(bob, m.id, `<a:whatever:${emoji.id}>`);

    let reactions = ((await call(bob, "GET", `/api/conversations/${general.conversationId}/messages`)).body as Message[]).find((x) => x.id === m.id)!.reactions;
    assert.deepEqual(reactions, [
      { emoji: "🍕", count: 2, userIds: [miaId, bobId] },
      { emoji: token, count: 2, userIds: [s.ctx.users.byUsername("owner")!.id, bobId] },
    ]);

    reactions = (await react(bob, m.id, "🍕", false)).body as Reaction[];
    assert.deepEqual(reactions[0], { emoji: "🍕", count: 1, userIds: [miaId] });

    // Not emoji, deleted emoji, outsiders.
    assert.equal((await react(bob, m.id, "lol")).status, 400);
    assert.equal((await react(bob, m.id, "<:nope:99999>")).status, 404);
    assert.equal((await react(out, m.id, "👍")).status, 404);
  });

  it("only lets people use custom emoji from servers they're in, and caps different reactions", async () => {
    const m = await send(bob, "React away");
    // "out" has a DM with nobody here; make a server of their own to hold an emoji.
    s.ctx.db.prepare("UPDATE users SET can_create_servers = 1 WHERE username = 'out'").run();
    const theirs = (await call(out, "POST", "/api/servers", { name: "Elsewhere" })).body as ChatServer;
    const e = await upload(out, `/api/servers/${theirs.id}/emojis`, { name: "elsewhere" }, PNG);
    assert.equal((await react(bob, m.id, `<:elsewhere:${e.body.id}>`)).status, 403);

    const many = ["😀", "😂", "🥹", "😊", "😍", "🥰", "😘", "😉", "😎", "🤔", "😴", "🤗", "😅", "😭", "😤", "😱", "🙄", "😬", "🥳", "🤩"];
    for (const x of many) assert.equal((await react(bob, m.id, x)).status, 200);
    assert.equal((await react(mia, m.id, "🦝")).status, 400);
    // Joining one that's there is fine.
    assert.equal((await react(mia, m.id, "😀")).status, 200);
  });

  it("drops reactions when a message is deleted, and stops timed-out people reacting", async () => {
    const m = await send(bob, "Oops");
    await react(mia, m.id, "👍");
    const deleted = (await call(bob, "DELETE", `/api/messages/${m.id}`)).body as Message;
    assert.deepEqual(deleted.reactions, []);
    assert.equal((await react(mia, m.id, "👍")).status, 409);

    const m2 = await send(owner, "Behave");
    assert.equal((await call(owner, "PUT", `/api/servers/${serverId}/timeouts/${bobId}`, { minutes: 10, reason: "test" })).status, 200);
    assert.equal((await react(bob, m2.id, "👍")).status, 403);
    await call(owner, "DELETE", `/api/servers/${serverId}/timeouts/${bobId}`);
  });

  it("removes the pictures when emoji, stickers or the whole server go", async () => {
    const uploads = path.join(s.ctx.config.dataDir, "uploads");
    const fileOf = (table: string, id: number) => (s.ctx.db.prepare(`SELECT file FROM ${table} WHERE id = ?`).get(id) as { file: string }).file;
    const e = await upload(owner, `/api/servers/${serverId}/emojis`, { name: "temp" }, PNG);
    const f = fileOf("server_emojis", e.body.id);
    assert.ok(existsSync(path.join(uploads, f)));
    assert.equal((await call(owner, "DELETE", `/api/servers/${serverId}/emojis/${e.body.id}`)).status, 200);
    assert.ok(!existsSync(path.join(uploads, f)));

    const sv = (await call(owner, "POST", "/api/servers", { name: "Temp" })).body as ChatServer;
    const st = await upload(owner, `/api/servers/${sv.id}/stickers`, { name: "bye" }, PNG);
    const sf = fileOf("server_stickers", st.body.id);
    await call(owner, "DELETE", `/api/servers/${sv.id}`);
    assert.ok(!existsSync(path.join(uploads, sf)));
  });

  it("keeps GIFs off until a super admin sets them up", async () => {
    assert.equal(((await call(bob, "GET", "/api/server")).body as { gifs: boolean }).gifs, false);
    assert.equal((await call(bob, "GET", "/api/gifs?q=hi")).status, 404);
    assert.equal((await call(bob, "PUT", "/api/admin/gifs", { enabled: true, apiKey: "KEY" })).status, 403);
    assert.equal((await call(owner, "PUT", "/api/admin/gifs", { enabled: true })).status, 400);
    const set = (await call(owner, "PUT", "/api/admin/gifs", { enabled: true, apiKey: "KEY", rating: "pg-13" })).body;
    assert.deepEqual(set, { enabled: true, provider: "giphy", hasKey: true, rating: "pg-13" });
    // The key is never sent back.
    assert.ok(!JSON.stringify((await call(owner, "GET", "/api/admin/gifs")).body).includes("KEY"));
    assert.equal(((await call(bob, "GET", "/api/server")).body as { gifs: boolean }).gifs, true);
  });

  it("searches through the server, with pictures through the server too", async () => {
    giphyCalls.length = 0;
    const page = (await call(bob, "GET", "/api/gifs?q=raccoon")).body as { gifs: { id: string; url: string; previewUrl: string }[]; next: number | null };
    // The R-rated one is dropped: over this server's PG-13.
    assert.deepEqual(page.gifs.map((g) => g.id), ["abcd1234"]);
    assert.equal(page.gifs[0]!.previewUrl, "/api/gifs/media/abcd1234/preview");
    assert.equal(gifIdFromLink(page.gifs[0]!.url), "abcd1234");
    assert.match(giphyCalls[0]!, /rating=pg-13/);
    assert.match(giphyCalls[0]!, /q=raccoon/);

    const pic = await s.app.inject({ method: "GET", url: "/api/gifs/media/abcd1234/full", headers: { cookie: bob } });
    assert.equal(pic.statusCode, 200);
    assert.equal(pic.headers["content-type"], "image/gif");
    // Cached: the second look doesn't go to GIPHY.
    giphyCalls.length = 0;
    await s.app.inject({ method: "GET", url: "/api/gifs/media/abcd1234/full", headers: { cookie: bob } });
    assert.deepEqual(giphyCalls, []);
    assert.equal((await s.app.inject({ method: "GET", url: "/api/gifs/media/spicy9999/full", headers: { cookie: bob } })).statusCode, 403);
  });

  it("lets GIF links through automod's link rule while GIFs are on", async () => {
    await call(owner, "PATCH", `/api/servers/${serverId}/automod`, { links: { enabled: true, actions: ["block"], exemptRoles: [] } });
    assert.equal((await call(bob, "POST", `/api/conversations/${general.conversationId}/messages`, { body: "https://giphy.com/gifs/raccoon-wave-abcd1234" })).status, 200);
    assert.equal((await call(bob, "POST", `/api/conversations/${general.conversationId}/messages`, { body: "https://example.com" })).status, 400);
    await call(owner, "PATCH", `/api/servers/${serverId}/automod`, { links: { enabled: false } });
  });

  it("keeps GIFs off for kids until a parent allows them, and then only rated G", async () => {
    assert.equal((await call(kit, "GET", "/api/gifs?q=raccoon")).status, 403);
    assert.equal((await s.app.inject({ method: "GET", url: "/api/gifs/media/abcd1234/full", headers: { cookie: kit } })).statusCode, 403);

    s.ctx.family.setRules(kitId, { gifs: true });
    giphyCalls.length = 0;
    const page = (await call(kit, "GET", "/api/gifs?q=raccoon")).body as { gifs: { id: string }[] };
    assert.deepEqual(page.gifs.map((g) => g.id), ["abcd1234"]);
    assert.match(giphyCalls[0]!, /rating=g&/);
    // A search with a word the family filter blocks finds nothing, without asking GIPHY.
    giphyCalls.length = 0;
    assert.deepEqual(((await call(kit, "GET", "/api/gifs?q=shit")).body as { gifs: unknown[] }).gifs, []);
    assert.deepEqual(giphyCalls, []);

    assert.equal((await s.app.inject({ method: "GET", url: "/api/gifs/media/abcd1234/full", headers: { cookie: kit } })).statusCode, 200);
    // A GIF a friend sends that isn't rated G doesn't show for the kid.
    giphy.rating = "pg";
    assert.equal((await s.app.inject({ method: "GET", url: "/api/gifs/media/pgpg1234/full", headers: { cookie: kit } })).statusCode, 403);
    assert.equal((await s.app.inject({ method: "GET", url: "/api/gifs/media/pgpg1234/full", headers: { cookie: bob } })).statusCode, 200);
  });

  it("stops kids reacting outside their chat time", async () => {
    const m = await send(bob, "Bedtime?");
    assert.equal((await react(kit, m.id, "👍")).status, 200);
    s.ctx.family.setRules(kitId, { dailyMinutes: 5 });
    s.ctx.db.prepare("INSERT OR REPLACE INTO kid_usage (kid_id, day, minutes) VALUES (?, ?, 600)").run(kitId, new Date().toISOString().slice(0, 10));
    assert.equal((await react(kit, m.id, "😴")).status, 403);
  });

  it("reads GIF links", () => {
    assert.equal(gifIdFromLink("https://giphy.com/gifs/happy-raccoon-l0HlBO7eyXzSZkJri"), "l0HlBO7eyXzSZkJri");
    assert.equal(gifIdFromLink("https://media.giphy.com/media/l0HlBO7eyXzSZkJri/giphy.gif"), "l0HlBO7eyXzSZkJri");
    assert.equal(gifIdFromLink("https://media2.giphy.com/media/v1.Y2lk/l0HlBO7eyXzSZkJri/200w.gif"), "l0HlBO7eyXzSZkJri");
    assert.equal(gifIdFromLink("https://i.giphy.com/l0HlBO7eyXzSZkJri.webp"), "l0HlBO7eyXzSZkJri");
    assert.equal(gifIdFromLink("https://example.com/gifs/abc-l0HlBO7eyXzSZkJri"), null);
    assert.equal(gifIdFromLink("not a link"), null);
  });
});
