import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { FamilyKid, KidStatus } from "@dendrop/shared";
import type { LootdenFetch } from "../src/lootden.js";
import { account, listen, startServer, type TestServer } from "./helpers.js";

const b64 = (n: number) => randomBytes(n).toString("base64url");
const publicKey = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
};

describe("LootDen play limits and kids' time rules", () => {
  let s: TestServer;
  let admin: string, mom: string, kit: string;
  let kitId: number;
  // Friday 6 November 2026 in UTC, LootDen's time zone here.
  const friday = (hhmm: string) => new Date(`2026-11-06T${hhmm}:00Z`);
  let limits: unknown = {
    limits: { weekdayMinutes: 60, weekendMinutes: 120, bedtime: { from: "21:00", to: "07:00" }, hardStop: false },
    allowance: { date: "2026-11-06", timeZone: "UTC", usedSeconds: 40 * 60, bonusSeconds: 15 * 60 },
  };
  let playing: object[] = [];
  let limitsAnswer = 200;

  const reply = (status: number, body: unknown) => ({
    ok: status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Headers({ "content-type": "application/json" }),
  });
  const fetchImpl: LootdenFetch = async (url) => {
    const p = new URL(url).pathname;
    if (p === "/api/users")
      return reply(200, [
        { id: 1, username: "mom", displayName: "Mom", email: null, kidMode: false, role: "admin" },
        { id: 7, username: "kit", displayName: "Kit", email: null, kidMode: true, role: "user" },
      ]);
    if (p === "/api/family/now-playing") return reply(200, playing);
    if (p === "/api/users/7/limits") return reply(limitsAnswer, limits);
    return reply(404, { error: "Not found" });
  };

  const req = (cookie: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });
  const rules = (patch: object) => req(mom, "PATCH", `/api/family/kids/${kitId}`, patch);
  const status = (at: Date): KidStatus => s.ctx.family.status(kitId, at);

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" }, { lootdenFetch: fetchImpl });
    admin = await account(s, "admin");
    mom = await account(s, "mom");
    kit = await account(s, "kit");
    kitId = s.ctx.users.byUsername("kit")!.id;
    assert.equal((await req(mom, "PUT", "/api/e2ee", { publicKey: publicKey(), backup: { salt: b64(16), iterations: 600_000, iv: b64(12), ciphertext: b64(150) } })).statusCode, 200);
    assert.equal((await req(admin, "POST", "/api/admin/family", { parent: "mom", kid: "kit", timezone: "UTC" })).statusCode, 200);
    assert.equal((await req(admin, "PUT", "/api/admin/lootden", { url: "https://games.example.net", token: "t" })).statusCode, 200);
  });
  after(() => s.close());

  it("shows parents the kid's LootDen limits, and changes nothing until they turn it on", async () => {
    const kid = (await rules({})).json<FamilyKid>();
    assert.ok(kid.status.lootden);
    assert.deepEqual(s.ctx.lootden.kidLimits(kitId, friday("12:00")), { bedtime: { from: "21:00", to: "07:00" }, dailyMinutes: 75, playedMinutes: 40, timezone: "UTC" });
    assert.equal(kid.rules.lootdenBedtime, false);
    assert.equal(kid.rules.lootdenPlayTime, false);
    assert.equal(status(friday("22:00")).allowedNow, true);
    assert.equal(status(friday("12:00")).gameMinutesToday, 0);
    assert.equal(status(friday("12:00")).limitMinutes, null);
    assert.equal((await rules({ lootdenBedtime: "yes" })).statusCode, 400);
  });

  it("closes chat at LootDen's bedtime, past midnight too", async () => {
    assert.equal((await rules({ lootdenBedtime: true })).statusCode, 200);
    assert.equal(status(friday("20:59")).allowedNow, true);
    const late = status(friday("21:30"));
    assert.equal(late.allowedNow, false);
    assert.match(late.reason!, /bedtime until 07:00/);
    assert.equal(status(new Date("2026-11-07T06:30:00Z")).allowedNow, false);
    assert.equal(status(new Date("2026-11-07T07:00:00Z")).allowedNow, true);
    // The server enforces it on sending, like chat hours.
    const now = new Date();
    const h = now.getUTCHours();
    limits = { ...(limits as object), limits: { weekdayMinutes: 60, weekendMinutes: 120, bedtime: { from: `${String(h).padStart(2, "0")}:00`, to: `${String((h + 2) % 24).padStart(2, "0")}:00` } }, allowance: { date: "2026-11-06", timeZone: "UTC", usedSeconds: 40 * 60, bonusSeconds: 15 * 60 } };
    await s.ctx.lootden.poll();
    const r = await req(kit, "POST", "/api/conversations", { userIds: [s.ctx.users.byUsername("mom")!.id] });
    assert.equal(r.statusCode, 403);
    assert.match(r.json<{ error: string }>().error, /bedtime/);
    await rules({ lootdenBedtime: false });
  });

  it("shares one budget for chat and games: the kid's daily time, else LootDen's", async () => {
    limits = {
      limits: { weekdayMinutes: 60, weekendMinutes: 120, bedtime: null, hardStop: false },
      allowance: { date: "2026-11-06", timeZone: "UTC", usedSeconds: 40 * 60, bonusSeconds: 15 * 60 },
    };
    await s.ctx.lootden.poll();
    await rules({ lootdenPlayTime: true });
    // No daily time of its own: LootDen's 60 minutes plus 15 bonus, with 40 played.
    let st = status(friday("12:00"));
    assert.equal(st.limitMinutes, 75);
    assert.equal(st.gameMinutesToday, 40);
    assert.equal(st.allowedNow, true);
    // Its own daily time wins when there is one.
    await rules({ dailyMinutes: 30 });
    st = status(friday("12:00"));
    assert.equal(st.limitMinutes, 30);
    assert.equal(st.allowedNow, false);
    assert.match(st.reason!, /30 minutes of chat and games/);
    await rules({ dailyMinutes: null });
    // Another day: yesterday's games and bonus don't count, and the weekend's time applies.
    st = status(new Date("2026-11-07T12:00:00Z"));
    assert.equal(st.gameMinutesToday, 0);
    assert.equal(st.limitMinutes, 120);
  });

  it("counts the game running now", async () => {
    playing = [{ userId: 7, device: "Den-PC", title: "Stardew Valley", href: null, startedAt: "2026-11-06T11:30:00Z" }];
    await s.ctx.lootden.poll();
    const st = status(friday("12:00"));
    assert.equal(st.gameMinutesToday, 70);
    assert.equal(st.allowedNow, true);
    assert.equal(status(friday("12:05")).allowedNow, false);
    playing = [];
    await s.ctx.lootden.poll();
  });

  it("tells parents once when the shared time runs out", async () => {
    // The minute counter runs on the real clock, so LootDen's numbers are for today here.
    limits = {
      limits: { weekdayMinutes: 60, weekendMinutes: 120, bedtime: null, hardStop: false },
      allowance: { date: new Date().toISOString().slice(0, 10), timeZone: "UTC", usedSeconds: 40 * 60, bonusSeconds: 0 },
    };
    await s.ctx.lootden.poll();
    await rules({ dailyMinutes: 41 });
    const kitWs = await listen(s, kit);
    const momWs = await listen(s, mom);
    s.ctx.family.tick();
    assert.equal((await momWs.waitFor("family.alert")).alert.type, "time_limit");
    kitWs.ws.close();
    momWs.ws.close();
    await rules({ dailyMinutes: null });
  });

  it("keeps the last limits when LootDen can't answer, and drops them when it's unlinked", async () => {
    limitsAnswer = 500;
    await s.ctx.lootden.poll();
    assert.equal(status(friday("12:00")).lootden?.dailyMinutes, 60);
    limitsAnswer = 200;
    await req(admin, "PUT", "/api/admin/lootden", { url: "" });
    const st = status(friday("12:00"));
    assert.equal(st.lootden, null);
    assert.equal(st.limitMinutes, null);
    assert.equal(st.allowedNow, true);
  });
});
