import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Channel, ChatServer, ServerSound } from "@dendrop/shared";
import { sniffSound } from "../src/expressions.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const LK = { DENDROP_LIVEKIT_URL: "wss://calls.example.com", DENDROP_LIVEKIT_API_KEY: "devkey", DENDROP_LIVEKIT_API_SECRET: "a-secret-that-is-long-enough-123456" };

const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60, 1)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(60, 2)]);
const MP3_BARE = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(60, 3)]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(60, 4)]);

describe("soundboard", () => {
  let s: TestServer;
  let owner: string, ann: string, bob: string, out: string;
  let annId: number;
  let sid: number;
  let otherSid: number;
  let lounge: Channel;
  const call = async (cookie: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => {
    const res = await s.app.inject({ method, url, headers: { cookie }, payload });
    return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? res.json() : res.rawPayload };
  };
  const upload = async (cookie: string, url: string, fields: Record<string, string>, data: Buffer, type = "audio/ogg") => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", new Blob([new Uint8Array(data)], { type }), "sound");
    const res = await fetch(`${s.url}${url}`, { method: "POST", headers: { cookie }, body: form });
    return { status: res.status, body: (await res.json()) as ServerSound & { error?: string } };
  };

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true", ...LK });
    owner = await account(s, "owner");
    ann = await account(s, "ann");
    bob = await account(s, "bob");
    out = await account(s, "out");
    annId = s.ctx.users.byUsername("ann")!.id;
    const sv = (await call(owner, "POST", "/api/servers", { name: "Den", isPublic: true })).body as ChatServer;
    sid = sv.id;
    for (const c of [ann, bob]) assert.equal((await call(c, "POST", `/api/servers/${sid}/join`)).status, 200);
    lounge = (await call(owner, "POST", `/api/servers/${sid}/channels`, { name: "lounge", kind: "voice" })).body as Channel;
    otherSid = ((await call(owner, "POST", "/api/servers", { name: "Elsewhere" })).body as ChatServer).id;
  });
  after(() => s.close());

  it("tells sounds apart by their bytes", () => {
    assert.equal(sniffSound(OGG), "audio/ogg");
    assert.equal(sniffSound(MP3), "audio/mpeg");
    assert.equal(sniffSound(MP3_BARE), "audio/mpeg");
    assert.equal(sniffSound(WAV), "audio/wav");
    assert.equal(sniffSound(Buffer.from("<html><script>alert(1)</script></html>")), undefined);
  });

  it("lets people with Manage emoji & stickers add sounds, and only members hear them", async () => {
    const url = `/api/servers/${sid}/sounds`;
    assert.equal((await upload(ann, url, { name: "honk" }, OGG)).status, 403);
    const live = await listen(s, bob);
    const r = await upload(owner, url, { name: "honk", emoji: "🦢", volume: "80" }, OGG);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.emoji, "🦢");
    assert.equal(r.body.volume, 80);
    assert.deepEqual((await live.waitFor("server.updated")).server.sounds.map((x) => x.name), ["honk"]);
    live.ws.close();

    assert.equal((await upload(owner, url, { name: "honk" }, MP3)).status, 409);
    assert.equal((await upload(owner, url, { name: "page" }, Buffer.from("<html>not a sound at all</html>"), "audio/mpeg")).status, 400);
    assert.equal((await upload(owner, url, { name: "loud", volume: "500" }, MP3)).status, 400);

    const file = await s.app.inject({ method: "GET", url: r.body.url, headers: { cookie: bob } });
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers["content-type"], "audio/ogg");
    assert.equal(file.headers["x-content-type-options"], "nosniff");
    assert.equal((await s.app.inject({ method: "GET", url: r.body.url, headers: { cookie: out } })).statusCode, 404);

    const renamed = await call(owner, "PATCH", `${url}/${r.body.id}`, { name: "goose", volume: 50 });
    assert.equal((renamed.body as ServerSound).name, "goose");
    assert.equal((renamed.body as ServerSound).volume, 50);
  });

  it("plays sounds to everyone in your voice channel, with a short wait between them", async () => {
    const sound = ((await call(bob, "GET", `/api/servers/${sid}`)).body as ChatServer).sounds[0]!;
    assert.equal((await call(ann, "POST", "/api/voice/sound", { builtin: "tada" })).status, 400);
    await call(ann, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    await call(bob, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`);
    const bobLive = await listen(s, bob);
    assert.equal((await call(ann, "POST", "/api/voice/sound", { builtin: "tada" })).status, 200);
    const heard = await bobLive.waitFor("voice.sound");
    assert.equal(heard.userId, annId);
    assert.equal(heard.channelId, lounge.id);
    assert.deepEqual(heard.play, { builtin: "tada" });

    // Too soon after the last one.
    assert.equal((await call(ann, "POST", "/api/voice/sound", { soundId: sound.id })).status, 429);
    const r = await call(bob, "POST", "/api/voice/sound", { soundId: sound.id });
    assert.equal(r.status, 200);
    const custom = await bobLive.waitFor("voice.sound");
    assert.ok("sound" in custom.play && custom.play.sound.id === sound.id);
    bobLive.ws.close();
  });

  it("refuses unknown sounds and other servers' sounds, and deafened players", async () => {
    const theirs = await upload(owner, `/api/servers/${otherSid}/sounds`, { name: "theirs" }, MP3);
    assert.equal(theirs.status, 200);
    assert.equal((await call(owner, "POST", `/api/servers/${sid}/channels/${lounge.id}/voice`)).status, 200);
    assert.equal((await call(owner, "POST", "/api/voice/sound", { builtin: "nope" })).status, 400);
    assert.equal((await call(owner, "POST", "/api/voice/sound", { soundId: theirs.body.id })).status, 404);
    await call(owner, "POST", "/api/voice/state", { deafened: true });
    assert.equal((await call(owner, "POST", "/api/voice/sound", { builtin: "ding" })).status, 400);
  });

  it("deletes sounds", async () => {
    const [sound] = ((await call(owner, "GET", `/api/servers/${sid}`)).body as ChatServer).sounds;
    assert.equal((await call(ann, "DELETE", `/api/servers/${sid}/sounds/${sound!.id}`)).status, 403);
    assert.equal((await call(owner, "DELETE", `/api/servers/${sid}/sounds/${sound!.id}`)).status, 200);
    assert.deepEqual(((await call(owner, "GET", `/api/servers/${sid}`)).body as ChatServer).sounds, []);
    assert.equal((await s.app.inject({ method: "GET", url: sound!.url, headers: { cookie: owner } })).statusCode, 404);
  });
});
