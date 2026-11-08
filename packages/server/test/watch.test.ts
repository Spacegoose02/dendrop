import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseWatchLink, watchPosition, type Channel, type ChatServer, type Message, type ServerInfo, type VoiceChannelState, type WatchVideo } from "@dendrop/shared";
import { Watch } from "../src/watch.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const LK = { DENDROP_LIVEKIT_URL: "wss://calls.example.com", DENDROP_LIVEKIT_API_KEY: "devkey", DENDROP_LIVEKIT_API_SECRET: "a-secret-that-is-long-enough-123456" };

describe("watch together links and timing", () => {
  it("reads YouTube links in their usual shapes, and video links", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://youtube.com/shorts/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ])
      assert.deepEqual(parseWatchLink(u), { kind: "youtube", videoId: "dQw4w9WgXcQ" }, u);
    assert.deepEqual(parseWatchLink(" https://cdn.example.com/films/raccoons.mp4 "), { kind: "link", url: "https://cdn.example.com/films/raccoons.mp4" });
    assert.equal(parseWatchLink("https://youtube.com/watch?v=nope"), null);
    assert.equal(parseWatchLink("javascript:alert(1)"), null);
    assert.equal(parseWatchLink("ftp://example.com/a.mp4"), null);
    assert.equal(parseWatchLink("https://user:pw@example.com/a.mp4"), null);
    assert.equal(parseWatchLink("not a link"), null);
  });

  it("works out where the video should be", () => {
    assert.equal(watchPosition({ playing: true, position: 10, updatedAt: 1000 }, 3500), 12.5);
    assert.equal(watchPosition({ playing: false, position: 10, updatedAt: 1000 }, 3500), 10);
    const item = (id: string) => ({ id, kind: "link" as const, src: "https://x/a.mp4", title: id, addedBy: 1 });
    let w = Watch.add(null, item("a"), 0);
    w = Watch.add(w, item("b"), 0);
    w = Watch.control(w, { playing: false }, 4000);
    assert.equal(w.position, 4);
    // Two devices both say "a" ended: it moves on once.
    const after1 = Watch.next(w, 5000, "a")!;
    assert.equal(after1.current.id, "b");
    assert.equal(Watch.next(after1, 5001, "a"), after1);
    assert.equal(Watch.next(after1, 5002, "b"), null);
  });
});

describe("watch together in voice channels", () => {
  let s: TestServer;
  let owner: string, ann: string, kid: string, out: string;
  let sid: number;
  let lounge: Channel, stage: Channel;
  const closeLater: (() => void)[] = [];
  const call = async (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.json() };
  };
  const postVideo = async (cookie: string, cid: number, name: string, type: string, data: Buffer) => {
    const form = new FormData();
    form.append("body", "");
    form.append("file", new Blob([new Uint8Array(data)], { type }), name);
    const res = await fetch(`${s.url}/api/conversations/${cid}/messages`, { method: "POST", headers: { cookie }, body: form });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as Message;
  };
  const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true", ...LK });
    owner = await account(s, "owner");
    ann = await account(s, "ann");
    kid = await account(s, "kid");
    out = await account(s, "out");
    const sv = (await call(owner, "POST", "/api/servers", { name: "Den", isPublic: true })).body as ChatServer;
    sid = sv.id;
    for (const c of [ann, kid]) assert.equal((await call(c, "POST", `/api/servers/${sid}/join`)).status, 200);
    // kid becomes owner's kid account (after joining, so no parent's OK is needed for the server).
    const u = (n: string) => s.ctx.users.byUsername(n)!.id;
    s.ctx.db.prepare("INSERT INTO family_links (kid_id, parent_id, created_at) VALUES (?, ?, ?)").run(u("kid"), u("owner"), new Date().toISOString());
    lounge = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "lounge", kind: "voice" })).body;
    stage = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "movies", kind: "stage" })).body;
  });
  after(async () => {
    for (const f of closeLater) f();
    await s.close();
  });

  it("needs you in the channel, and tells everyone what's on", async () => {
    assert.equal((await call(ann, "POST", "/api/voice/watch", { url: "https://cdn.example.com/raccoons.mp4" })).status, 400);
    await call(ann, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    await call(owner, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    const ownerLive = await listen(s, owner);
    const r = await call(ann, "POST", "/api/voice/watch", { url: "https://cdn.example.com/raccoons.mp4" });
    assert.equal(r.status, 200);
    const v = r.body as VoiceChannelState;
    assert.equal(v.watch?.current.kind, "link");
    assert.equal(v.watch?.current.title, "raccoons.mp4");
    assert.equal(v.watch?.playing, true);
    const seen = await ownerLive.waitFor("voice.updated");
    assert.equal(seen.voice.watch?.current.id, v.watch?.current.id);
    // Going offline takes you out of voice, so the owner's gateway stays open for the other tests.
    closeLater.push(() => ownerLive.ws.close());
    const time = (await call(ann, "GET", "/api/time")).body as { now: number };
    assert.ok(Math.abs(time.now - Date.now()) < 5000);
  });

  it("queues, pauses, seeks, skips and stops", async () => {
    let v = (await call(owner, "POST", "/api/voice/watch", { url: "https://cdn.example.com/second.webm", title: "  Second   one " })).body as VoiceChannelState;
    assert.deepEqual(v.watch?.queue.map((i) => i.title), ["Second one"]);
    v = (await call(owner, "POST", "/api/voice/watch/control", { playing: false, position: 42.5 })).body;
    assert.equal(v.watch?.playing, false);
    assert.equal(v.watch?.position, 42.5);
    assert.equal((await call(owner, "POST", "/api/voice/watch/control", { position: -1 })).status, 400);
    assert.equal((await call(owner, "POST", "/api/voice/watch/control", { playing: "yes" })).status, 400);
    const first = v.watch!.current.id;
    // A device whose video ended moves it on; a second, late one doesn't skip again.
    v = (await call(ann, "POST", "/api/voice/watch/next", { itemId: first })).body;
    assert.equal(v.watch?.current.title, "Second one");
    assert.equal(v.watch?.position, 0);
    v = (await call(owner, "POST", "/api/voice/watch/next", { itemId: first })).body;
    assert.equal(v.watch?.current.title, "Second one");
    v = (await call(ann, "POST", "/api/voice/watch", { url: "https://cdn.example.com/third.mp4" })).body;
    v = (await call(ann, "DELETE", `/api/voice/watch/queue/${v.watch!.queue[0]!.id}`)).body;
    assert.equal(v.watch?.queue.length, 0);
    v = (await call(ann, "DELETE", "/api/voice/watch")).body;
    assert.equal(v.watch, null);
  });

  it("keeps YouTube off until a super admin turns it on", async () => {
    const yt = { url: "https://youtu.be/dQw4w9WgXcQ" };
    assert.equal((await call(ann, "POST", "/api/voice/watch", yt)).status, 403);
    assert.equal(((await call(ann, "GET", "/api/server")).body as ServerInfo).watchYoutube, false);
    assert.equal((await call(ann, "PUT", "/api/admin/watch", { youtube: true })).status, 403);
    assert.deepEqual((await call(owner, "PUT", "/api/admin/watch", { youtube: true })).body, { youtube: true });
    assert.equal(((await call(ann, "GET", "/api/server")).body as ServerInfo).watchYoutube, true);
    const v = (await call(ann, "POST", "/api/voice/watch", yt)).body as VoiceChannelState;
    assert.deepEqual([v.watch?.current.kind, v.watch?.current.src], ["youtube", "dQw4w9WgXcQ"]);
    await call(ann, "DELETE", "/api/voice/watch");
  });

  it("plays videos from the channel's chat, streamed with ranges to people who can see it", async () => {
    const msg = await postVideo(ann, lounge.conversationId, "cats.mp4", "video/mp4", VIDEO);
    await postVideo(ann, lounge.conversationId, "notes.txt", "text/plain", Buffer.from("hi"));
    const list = (await call(owner, "GET", `/api/servers/${sid}/channels/${lounge.id}/watch/videos`)).body as WatchVideo[];
    assert.deepEqual(list.map((x) => x.name), ["cats.mp4"]);
    assert.equal((await call(out, "GET", `/api/servers/${sid}/channels/${lounge.id}/watch/videos`)).status, 404);

    const v = (await call(owner, "POST", "/api/voice/watch", { attachmentId: msg.attachments[0]!.id })).body as VoiceChannelState;
    assert.equal(v.watch?.current.kind, "file");
    assert.equal(v.watch?.current.title, "cats");
    const src = v.watch!.current.src;
    const whole = await s.app.inject({ method: "GET", url: src, headers: { cookie: kid } });
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers["content-type"], "video/mp4");
    assert.equal(whole.rawPayload.length, 1000);
    const part = await s.app.inject({ method: "GET", url: src, headers: { cookie: kid, range: "bytes=100-199" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers["content-range"], "bytes 100-199/1000");
    assert.deepEqual([...part.rawPayload], [...VIDEO.subarray(100, 200)]);
    const tail = await s.app.inject({ method: "GET", url: src, headers: { cookie: kid, range: "bytes=-10" } });
    assert.equal(tail.headers["content-range"], "bytes 990-999/1000");
    assert.equal((await s.app.inject({ method: "GET", url: src, headers: { cookie: kid, range: "bytes=5000-" } })).statusCode, 416);
    // Not in the server: no video.
    assert.equal((await s.app.inject({ method: "GET", url: src, headers: { cookie: out } })).statusCode, 404);
    // A file from another channel can't be put on here.
    const other = (await call(owner, "GET", `/api/servers/${sid}`)).body as ChatServer;
    const general = other.channels.find((c) => c.kind === "text")!;
    const elsewhere = await postVideo(owner, general.conversationId, "dogs.mp4", "video/mp4", VIDEO);
    assert.equal((await call(owner, "POST", "/api/voice/watch", { attachmentId: elsewhere.attachments[0]!.id })).status, 404);
    await call(owner, "DELETE", "/api/voice/watch");
  });

  it("lets kids put on the chat's videos but not links", async () => {
    await call(kid, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    assert.equal((await call(kid, "POST", "/api/voice/watch", { url: "https://cdn.example.com/raccoons.mp4" })).status, 403);
    const list = (await call(kid, "GET", `/api/servers/${sid}/channels/${lounge.id}/watch/videos`)).body as WatchVideo[];
    assert.equal((await call(kid, "POST", "/api/voice/watch", { attachmentId: list[0]!.attachmentId })).status, 200);
    await call(kid, "DELETE", "/api/voice/watch");
  });

  it("on a stage, only speakers pick what's on; it ends when everyone leaves", async () => {
    await call(owner, "POST", `/api/servers/${sid}/channels/${stage.id}/voice`);
    await call(ann, "POST", `/api/servers/${sid}/channels/${stage.id}/voice`);
    assert.equal((await call(ann, "POST", "/api/voice/watch", { url: "https://cdn.example.com/a.mp4" })).status, 403);
    assert.equal((await call(owner, "POST", "/api/voice/watch", { url: "https://cdn.example.com/a.mp4" })).status, 200);
    assert.equal((await call(ann, "POST", "/api/voice/watch/control", { playing: false })).status, 403);
    await call(ann, "POST", "/api/voice/leave");
    await call(owner, "POST", "/api/voice/leave");
    await call(owner, "POST", `/api/servers/${sid}/channels/${stage.id}/voice`);
    const all = (await call(owner, "GET", "/api/voice")).body as VoiceChannelState[];
    assert.equal(all.find((v) => v.channelId === stage.id)?.watch, null);
  });
});
