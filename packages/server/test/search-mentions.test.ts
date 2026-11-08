import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import type { ChatServer, Conversation, LinkPreview, Message, NotificationSettings, SearchResults, ServerInvite } from "@dendrop/shared";
import { parseMeta, sniffImage } from "../src/link-previews.js";
import { ftsQuery } from "../src/search.js";
import { BlockedError, checkUrl, isPublicAddress, safeFetch } from "../src/safe-fetch.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe("search, replies, mentions and notification settings", () => {
  let s: TestServer;
  let ann: string, bob: string, cat: string;
  let annId: number, bobId: number, catId: number;
  let group: Conversation;
  let serverId: number;
  let general: number;
  const fetched: string[] = [];

  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const post = async (cookie: string, cid: number, body: string, extra: object = {}) => call(cookie, "POST", `/api/conversations/${cid}/messages`, { body, ...extra });
  const search = async (cookie: string, qs: string) => call(cookie, "GET", `/api/search?${qs}`);

  before(async () => {
    s = await startServer(
      { DENDROP_SIGNUP: "true" },
      {
        previewFetch: async (url) => {
          fetched.push(url);
          if (url.endsWith(".png")) return { status: 200, contentType: "image/png", body: PNG, url };
          if (url.includes("empty")) return { status: 200, contentType: "text/html", body: Buffer.from("<html><body>hi</body></html>"), url };
          const html = `<html><head><title>Fallback</title><meta property="og:title" content="Raccoons &amp; you">
            <meta name="description" content="All about trash pandas"><meta property="og:image" content="/pic.png"></head></html>`;
          return { status: 200, contentType: "text/html; charset=utf-8", body: Buffer.from(html), url };
        },
      },
    );
    ann = await account(s, "ann");
    bob = await account(s, "bob");
    cat = await account(s, "cat");
    [annId, bobId, catId] = ["ann", "bob", "cat"].map((n) => s.ctx.users.byUsername(n)!.id) as [number, number, number];
    for (const [who, other] of [
      [ann, "bob"],
      [ann, "cat"],
    ] as const) {
      await call(who, "POST", "/api/friends", { username: other });
      const otherCookie = other === "bob" ? bob : cat;
      await call(otherCookie, "POST", `/api/friends/${annId}/accept`);
    }
    group = (await call(ann, "POST", "/api/conversations", { userIds: [bobId, catId], name: "Den" })).body as Conversation;
    const sv = (await call(ann, "POST", "/api/servers", { name: "Hideout" })).body as ChatServer;
    serverId = sv.id;
    general = sv.channels[0]!.conversationId;
    for (const who of [bob, cat]) {
      const inv = (await call(ann, "POST", `/api/servers/${serverId}/invites`, {})).body as ServerInvite;
      assert.equal((await call(who, "POST", `/api/invites/${inv.code}/accept`)).status, 200);
    }
  });
  after(() => s.close());

  it("finds plain messages by words and prefixes, only where you can read them", async () => {
    await post(ann, group.id, "Pizza night on Friday at the treehouse");
    await post(bob, general, "Who brought the pizza cutter?");
    await post(bob, general, "Nothing to see");
    const r = (await search(cat, "q=pizz")).body as SearchResults;
    assert.equal(r.hits.length, 2);
    assert.match(r.hits[0]!.message.body, /cutter/);
    assert.equal(r.hits[0]!.serverId, serverId);
    assert.equal(r.hits[1]!.serverId, null);
    // Narrowed to one place, or one person.
    assert.equal(((await search(cat, `q=pizza&conversationId=${group.id}`)).body as SearchResults).hits.length, 1);
    assert.equal(((await search(cat, `q=pizza&serverId=${serverId}`)).body as SearchResults).hits.length, 1);
    assert.equal(((await search(cat, `q=pizza&authorId=${annId}`)).body as SearchResults).hits.length, 1);
    // Someone outside the conversation and the server finds nothing.
    const out = await account(s, "out");
    assert.equal(((await search(out, "q=pizza")).body as SearchResults).hits.length, 0);
    assert.equal((await search(out, `q=pizza&conversationId=${group.id}`)).status, 404);
    assert.equal((await search(out, `q=pizza&serverId=${serverId}`)).status, 404);
  });

  it("keeps edits and deletions in step, and never indexes encrypted messages", async () => {
    const m = (await post(ann, group.id, "secret marshmallow stash")).body as Message;
    assert.equal(((await search(bob, "q=marshmallow")).body as SearchResults).hits.length, 1);
    await call(ann, "PATCH", `/api/messages/${m.id}`, { body: "secret cookie stash" });
    assert.equal(((await search(bob, "q=marshmallow")).body as SearchResults).hits.length, 0);
    assert.equal(((await search(bob, "q=cookie")).body as SearchResults).hits.length, 1);
    await call(ann, "DELETE", `/api/messages/${m.id}`);
    assert.equal(((await search(bob, "q=cookie")).body as SearchResults).hits.length, 0);
    // An encrypted row (as an E2EE client would store it) stays out of the index.
    s.ctx.db
      .prepare("INSERT INTO messages (conversation_id, author_id, body, created_at, key_version) VALUES (?, ?, ?, ?, 1)")
      .run(group.id, annId, "AAAAAAAAAAAAAAAA.encryptedciphertextbananas", new Date().toISOString());
    assert.equal(((await search(bob, "q=encryptedciphertextbananas")).body as SearchResults).hits.length, 0);
  });

  it("treats search syntax as plain words, pages through results, and needs something to look for", async () => {
    assert.equal(ftsQuery('pizza "game night" NEAR(x'), '"pizza" "game night" "NEAR x"*');
    assert.equal(ftsQuery('"exact phrase"'), '"exact phrase"');
    assert.equal(ftsQuery("***"), "");
    assert.equal((await search(bob, 'q=a" OR body:*')).status, 200);
    assert.equal((await search(bob, "q=")).status, 400);
    for (let i = 0; i < 30; i++) await post(bob, general, `paging test ${i}`);
    const first = (await search(bob, "q=paging")).body as SearchResults;
    assert.equal(first.hits.length, 25);
    assert.ok(first.next);
    const second = (await search(bob, `q=paging&before=${first.next}`)).body as SearchResults;
    assert.equal(second.hits.length, 5);
    assert.equal(second.next, null);
  });

  it("replies show what they answer and ping its author", async () => {
    const original = (await post(bob, group.id, "Anyone seen my hat?")).body as Message;
    const live = await listen(s, bob);
    const r = await post(ann, group.id, "It's on the porch", { replyToId: original.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const reply = r.body as Message;
    assert.deepEqual(reply.replyTo, { id: original.id, authorId: bobId, body: "Anyone seen my hat?", keyVersion: null, deleted: false, webhookName: null });
    assert.deepEqual(reply.mentions, [bobId]);
    const e = await live.waitFor("message.created");
    assert.equal(e.mentioned, true);
    assert.equal(e.notify, true);
    live.ws.close();
    // Without the ping, and never to a message elsewhere.
    assert.deepEqual(((await post(ann, group.id, "quiet reply", { replyToId: original.id, replyPing: false })).body as Message).mentions, []);
    assert.equal((await post(ann, general, "wrong place", { replyToId: original.id })).status, 404);
    // A reply to a message deleted later shows it as deleted.
    await call(bob, "DELETE", `/api/messages/${original.id}`);
    const hist = (await call(ann, "GET", `/api/conversations/${group.id}/messages`)).body as Message[];
    assert.equal(hist.find((m) => m.id === reply.id)!.replyTo!.deleted, true);
    assert.equal(hist.find((m) => m.id === reply.id)!.replyTo!.body, "");
    assert.equal((await post(ann, group.id, "too late", { replyToId: original.id })).status, 409);
  });

  it("mentions only count people in the conversation, and @everyone needs the permission in servers", async () => {
    const outId = s.ctx.users.byUsername("out")!.id;
    const m = (await post(ann, group.id, `hey <@${bobId}> and <@${outId}> and <@${annId}>`)).body as Message;
    assert.deepEqual(m.mentions, [bobId]);
    assert.equal(((await post(ann, group.id, "@everyone dinner!")).body as Message).mentionsEveryone, true);
    // Bob is a plain member of the server: his @everyone posts but pings nobody. The owner's does.
    assert.equal(((await post(bob, general, "@everyone look")).body as Message).mentionsEveryone, false);
    assert.equal(((await post(ann, general, "@everyone look")).body as Message).mentionsEveryone, true);
    // Edits work the pings out again.
    const e = (await call(ann, "PATCH", `/api/messages/${m.id}`, { body: `now <@${catId}>` })).body as Message;
    assert.deepEqual(e.mentions, [catId]);
    // Encrypted messages say who they ping; the server still keeps it to members.
    const enc = (await call(ann, "POST", `/api/conversations/${group.id}/messages`, { body: "x", mentions: [catId, outId] })).body as Message;
    assert.deepEqual(enc.mentions, [], "plain messages ignore the list and read the text");
  });

  it("follows per-conversation and per-server notification settings", async () => {
    assert.deepEqual((await call(cat, "GET", "/api/notification-settings")).body, { conversations: {}, servers: {} });
    assert.equal((await call(cat, "PUT", "/api/notification-settings", { serverId, level: "mentions" })).status, 200);
    const settings = (await call(cat, "PUT", "/api/notification-settings", { conversationId: group.id, level: "nothing" })).body as NotificationSettings;
    assert.deepEqual(settings, { conversations: { [group.id]: "nothing" }, servers: { [serverId]: "mentions" } });
    assert.equal((await call(cat, "PUT", "/api/notification-settings", { conversationId: group.id, level: "loud" })).status, 400);
    const outCookie = await account(s, "out2");
    assert.equal((await call(outCookie, "PUT", "/api/notification-settings", { conversationId: group.id, level: "all" })).status, 404);

    const live = await listen(s, cat);
    await post(bob, general, "just chatting");
    let e = await live.waitFor("message.created");
    assert.deepEqual([e.notify, e.mentioned, e.muted], [false, false, false]);
    await post(bob, general, `<@${catId}> look`);
    e = await live.waitFor("message.created");
    assert.deepEqual([e.notify, e.mentioned, e.muted], [true, true, false]);
    // Muted: nothing pops up, even for a ping.
    await post(bob, group.id, `<@${catId}> muted?`);
    e = await live.waitFor("message.created");
    assert.deepEqual([e.notify, e.mentioned, e.muted], [false, true, true]);
    // A channel setting beats the server's.
    await call(cat, "PUT", "/api/notification-settings", { conversationId: general, level: "all" });
    await post(bob, general, "everything now");
    e = await live.waitFor("message.created");
    assert.equal(e.notify, true);
    // Back to the default.
    await call(cat, "PUT", "/api/notification-settings", { conversationId: group.id, level: null });
    assert.equal(((await call(cat, "GET", "/api/notification-settings")).body as NotificationSettings).conversations[group.id], undefined);
    live.ws.close();
  });

  it("only sends phone wake-ups to people who want to hear about it", async () => {
    for (let i = 0; i < 100 && [annId, bobId, catId].some((u) => s.ctx.gateway.isOnline(u)); i++) await new Promise((r) => setTimeout(r, 10));
    const sent: number[][] = [];
    const orig = s.ctx.push.notify.bind(s.ctx.push);
    s.ctx.push.notify = async (ids) => {
      sent.push(ids);
    };
    try {
      s.ctx.notifications.set(bobId, "conversation", group.id, "nothing");
      const m = s.ctx.db.prepare("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1").get(group.id) as { id: number };
      const msg = { id: m.id, conversationId: group.id, authorId: annId, mentions: [], mentionsEveryone: false } as unknown as Message;
      s.ctx.notifications.deliver(msg, [annId, bobId, catId], annId);
      assert.deepEqual(sent, [[catId]]);
    } finally {
      s.ctx.push.notify = orig;
      s.ctx.notifications.set(bobId, "conversation", group.id, null);
    }
  });

  it("link previews are off until a super admin turns them on, and kids need a parent's OK", async () => {
    assert.equal((await call(bob, "GET", "/api/link-previews?url=https://example.com/a")).status, 404);
    assert.deepEqual((await call(bob, "GET", "/api/link-previews/settings")).body, { enabled: false });
    assert.equal((await call(bob, "PUT", "/api/admin/link-previews", { enabled: true })).status, 403);
    assert.equal((await call(ann, "PUT", "/api/admin/link-previews", { enabled: true })).status, 200);

    const r = await call(bob, "GET", "/api/link-previews?url=https://example.com/a");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = (r.body as { preview: LinkPreview }).preview;
    assert.equal(p.title, "Raccoons & you");
    assert.equal(p.description, "All about trash pandas");
    assert.equal(p.site, "example.com");
    assert.match(p.image!, /^\/api\/link-previews\/image\/[0-9a-f]{32}\.png$/);
    assert.deepEqual(fetched, ["https://example.com/a", "https://example.com/pic.png"]);
    const img = await s.app.inject({ method: "GET", url: p.image!, headers: { cookie: bob } });
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers["content-type"], "image/png");
    // Cached: no second fetch.
    await call(cat, "GET", "/api/link-previews?url=https://example.com/a");
    assert.equal(fetched.length, 2);
    // Pages with nothing to show get no card.
    assert.equal(((await call(bob, "GET", "/api/link-previews?url=https://example.com/empty")).body as { preview: null }).preview, null);
    assert.equal((await call(bob, "GET", "/api/link-previews?url=ftp://example.com/")).status, 400);

    // A kid account: no previews (or their pictures) until a parent allows them.
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(catId, annId, new Date().toISOString());
    s.ctx.db.prepare("INSERT INTO kid_rules (kid_id) VALUES (?)").run(catId);
    const kidView = await s.app.inject({ method: "GET", url: "/api/link-previews?url=https://example.com/a", headers: { cookie: cat } });
    assert.equal(kidView.statusCode, 403);
    assert.equal((await s.app.inject({ method: "GET", url: p.image!, headers: { cookie: cat } })).statusCode, 404);
    s.ctx.family.setRules(catId, { linkPreviews: true });
    assert.equal((await s.app.inject({ method: "GET", url: "/api/link-previews?url=https://example.com/a", headers: { cookie: cat } })).statusCode, 200);
  });
});

describe("link preview fetching stays off private networks", () => {
  it("knows public addresses from private ones", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(a), true, a);
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.10",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "fc00::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a00:1",
      "2002:c0a8:0101::1",
      "2001:db8::1",
      "not an ip",
    ])
      assert.equal(isPublicAddress(a), false, a);
  });

  it("refuses odd schemes, ports, credentials, private names and private IPs before connecting", () => {
    for (const u of [
      "file:///etc/passwd",
      "gopher://example.com/",
      "http://example.com:8080/",
      "http://user:pw@example.com/",
      "http://localhost/",
      "http://router/",
      "http://nas.local/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://0x7f000001/",
      "http://2130706433/",
    ])
      assert.throws(() => checkUrl(u), BlockedError, u);
    assert.equal(checkUrl("https://example.com/page").hostname, "example.com");
  });

  let local: Server;
  let port = 0;
  before(async () => {
    local = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://127.0.0.1/secret" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("x".repeat(10_000));
    });
    await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
    port = (local.address() as { port: number }).port;
  });
  after(() => local.close());

  it("won't reach a server on this machine, by IP or by a name that points at one", async () => {
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`, { maxBytes: 1000, accept: "*/*" }), BlockedError);
    await assert.rejects(safeFetch(`http://localhost.:${port}/`, { maxBytes: 1000, accept: "*/*" }));
  });

  it("checks every redirect and caps how much it reads (with private addresses allowed for the test)", async () => {
    const r = await safeFetch(`http://127.0.0.1:${port}/`, { maxBytes: 1000, accept: "*/*", allowPrivate: true });
    assert.equal(r.body.length, 1000);
    // The redirect target is checked like the first URL (here, its port-less private address is fine
    // only because private is allowed; without it, it would be refused).
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/redirect`, { maxBytes: 1000, accept: "*/*", allowPrivate: true, maxRedirects: 0 }), BlockedError);
  });

  it("reads Open Graph tags and only trusts real picture bytes", () => {
    const m = parseMeta(`<meta content="Hello" property="og:title"><meta property='og:site_name' content='Den &#38; Co'><meta name="twitter:image" content="https://cdn.example/x.jpg">`, "https://example.com/");
    assert.deepEqual(m, { title: "Hello", description: "", site: "Den & Co", image: "https://cdn.example/x.jpg" });
    assert.equal(parseMeta(`<meta property="og:image" content="javascript:alert(1)"><title>T</title>`, "https://example.com/").image, null);
    assert.equal(sniffImage(PNG), "png");
    assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
  });
});
