import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { AdminAccount, AuthInfo, Me, MyTwoFactor, TotpSetup, TwoFactorChallenge } from "@dendrop/shared";
import { totpCode, totpStep } from "../src/auth/twofactor.js";
import { account, startServer, type TestServer } from "./helpers.js";

// ---- A software passkey, standing in for a phone or security key ----------------------

type Cbor = number | string | Buffer | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor };
function cbor(v: Cbor): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

class SoftPasskey {
  readonly id = randomBytes(16);
  private readonly key: KeyObject;
  private readonly pub: KeyObject;
  private counter = 0;
  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    this.pub = publicKey;
  }
  private rpHash = () => createHash("sha256").update(this.rpId).digest();
  private clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));

  create(options: { challenge: string }) {
    const jwk = this.pub.export({ format: "jwk" });
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLen, this.id, cbor(cose)]);
    const id = this.id.toString("base64url");
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: this.clientData("webauthn.create", options.challenge).toString("base64url"),
        attestationObject: cbor({ fmt: "none", attStmt: {}, authData }).toString("base64url"),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  get(options: { challenge: string }) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([this.rpHash(), Buffer.from([0x05]), count]);
    const clientData = this.clientData("webauthn.get", options.challenge);
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), this.key);
    const id = this.id.toString("base64url");
    return {
      id,
      rawId: id,
      type: "public-key",
      response: { clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") },
      clientExtensionResults: {},
    };
  }
}

describe("two-step sign-in and passkeys", () => {
  let s: TestServer;
  let admin: string, sam: string;
  let samId: number;
  let secret: string;
  let recovery: string[];
  const RP = "chat.example.com";
  const ORIGIN = "https://chat.example.com";

  const req = (cookie: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });
  const login = (username = "sam", password = "correct horse battery") => s.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  const cookieOf = (r: { cookies: { name: string; value: string }[] }) => {
    const c = r.cookies.find((x) => x.name === "dendrop_session");
    return c ? `dendrop_session=${c.value}` : "";
  };
  /** The server's clock, moved on 30 seconds for each new code (each code works once). */
  let clock = Date.now();
  const nextCode = () => {
    clock += 30_000;
    return totpCode(secret, totpStep(clock));
  };

  before(async () => {
    s = await startServer({ DENDROP_PUBLIC_URL: ORIGIN, DENDROP_SIGNUP: "true" });
    s.ctx.twofactor.clock = () => clock;
    admin = await account(s, "admin");
    await s.ctx.signin.save({ signup: true });
    sam = await account(s, "sam");
    samId = s.ctx.users.byUsername("sam")!.id;
  });
  after(() => s.close());

  it("sets up an authenticator app with a first code, and hands out recovery codes once", async () => {
    const setup = (await req(sam, "POST", "/api/me/2fa/totp/start")).json<TotpSetup>();
    assert.match(setup.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.uri, /^otpauth:\/\/totp\/Dendrop/);
    assert.match(setup.qrSvg, /^<svg/);
    secret = setup.secret;

    assert.equal((await req(sam, "POST", "/api/me/2fa/totp/confirm", { code: "000000" })).statusCode, 400);
    const ok = await req(sam, "POST", "/api/me/2fa/totp/confirm", { code: totpCode(secret, totpStep(clock)) });
    assert.equal(ok.statusCode, 200);
    recovery = ok.json<{ recoveryCodes: string[] }>().recoveryCodes;
    assert.equal(recovery.length, 10);
    const status = (await req(sam, "GET", "/api/me/2fa")).json<MyTwoFactor>();
    assert.deepEqual({ totp: status.totp, left: status.recoveryCodesLeft, available: status.passkeysAvailable }, { totp: true, left: 10, available: true });
  });

  it("asks for a code after the password, and a code only works once", async () => {
    const first = await login();
    assert.equal(first.statusCode, 200);
    assert.equal(cookieOf(first), "", "no session from the password alone");
    const { twoFactor } = first.json<TwoFactorChallenge>();
    assert.deepEqual({ totp: twoFactor.totp, passkey: twoFactor.passkey }, { totp: true, passkey: false });

    const wrong = await s.app.inject({ method: "POST", url: "/api/auth/2fa", payload: { ticket: twoFactor.ticket, code: "123456" } });
    assert.equal(wrong.statusCode, 401);
    const code = nextCode();
    const right = await s.app.inject({ method: "POST", url: "/api/auth/2fa", payload: { ticket: twoFactor.ticket, code } });
    assert.equal(right.statusCode, 200);
    assert.equal(right.json<Me>().username, "sam");
    sam = cookieOf(right);
    assert.ok(sam);

    // The same code again, on a new ticket, is turned away.
    const again = (await login()).json<TwoFactorChallenge>().twoFactor.ticket;
    assert.equal((await s.app.inject({ method: "POST", url: "/api/auth/2fa", payload: { ticket: again, code } })).statusCode, 401);
    // And the old ticket is spent.
    assert.equal((await s.app.inject({ method: "POST", url: "/api/auth/2fa", payload: { ticket: twoFactor.ticket, code: nextCode() } })).statusCode, 401);
  });

  it("ends a ticket after five wrong codes", async () => {
    const { ticket } = (await login()).json<TwoFactorChallenge>().twoFactor;
    for (let i = 0; i < 4; i++) assert.match((await s.app.inject({ method: "POST", url: "/api/auth/2fa", payload: { ticket, code: "000000" } })).json().error, /isn't right/);
    assert.match((await s.app.inject({ method: "POST", url: "/api/auth/2fa", payload: { ticket, code: "000000" } })).json().error, /Too many/);
    assert.equal((await s.app.inject({ method: "POST", url: "/api/auth/2fa", payload: { ticket, code: nextCode() } })).statusCode, 401);
  });

  it("takes a recovery code once, in any case and with or without the dash", async () => {
    const use = async (code: string) => {
      const { ticket } = (await login()).json<TwoFactorChallenge>().twoFactor;
      return (await s.app.inject({ method: "POST", url: "/api/auth/2fa", payload: { ticket, code } })).statusCode;
    };
    assert.equal(await use(recovery[0]!.toUpperCase().replace("-", "")), 200);
    assert.equal(await use(recovery[0]!), 401);
    assert.equal((await req(sam, "GET", "/api/me/2fa")).json<MyTwoFactor>().recoveryCodesLeft, 9);
  });

  it("adds a passkey, then signs in with it alone or as the second step", async () => {
    const key = new SoftPasskey(RP, ORIGIN);
    const { challengeId, options } = (await req(sam, "POST", "/api/me/passkeys/options")).json<{ challengeId: string; options: { challenge: string; rp: { id: string } } }>();
    assert.equal(options.rp.id, RP);
    const added = await req(sam, "POST", "/api/me/passkeys", { challengeId, response: key.create(options), name: "Sam's phone" });
    assert.equal(added.statusCode, 200, added.body);
    assert.equal(added.json().name, "Sam's phone");

    // On its own.
    const opts = (await s.app.inject({ method: "POST", url: "/api/auth/passkey/options", payload: {} })).json<{ challengeId: string; options: { challenge: string } }>();
    const signed = await s.app.inject({ method: "POST", url: "/api/auth/passkey", payload: { challengeId: opts.challengeId, response: key.get(opts.options) } });
    assert.equal(signed.statusCode, 200, signed.body);
    assert.equal(signed.json<Me>().id, samId);
    assert.ok(cookieOf(signed));
    // A challenge works once.
    assert.equal((await s.app.inject({ method: "POST", url: "/api/auth/passkey", payload: { challengeId: opts.challengeId, response: key.get(opts.options) } })).statusCode, 401);

    // As the second step.
    const { twoFactor } = (await login()).json<TwoFactorChallenge>();
    assert.equal(twoFactor.passkey, true);
    const o2 = (await s.app.inject({ method: "POST", url: "/api/auth/2fa/passkey/options", payload: { ticket: twoFactor.ticket } })).json<{ options: { challenge: string } }>();
    const second = await s.app.inject({ method: "POST", url: "/api/auth/2fa/passkey", payload: { ticket: twoFactor.ticket, response: key.get(o2.options) } });
    assert.equal(second.statusCode, 200, second.body);

    // Someone else's passkey, or one signed for the wrong site, doesn't work.
    const stranger = new SoftPasskey(RP, ORIGIN);
    const o3 = (await s.app.inject({ method: "POST", url: "/api/auth/passkey/options", payload: {} })).json<{ challengeId: string; options: { challenge: string } }>();
    assert.equal((await s.app.inject({ method: "POST", url: "/api/auth/passkey", payload: { challengeId: o3.challengeId, response: stranger.get(o3.options) } })).statusCode, 401);
    const phishing = new SoftPasskey("chat.evil.example", "https://chat.evil.example");
    const o4 = (await req(sam, "POST", "/api/me/passkeys/options")).json<{ challengeId: string; options: { challenge: string } }>();
    assert.equal((await req(sam, "POST", "/api/me/passkeys", { challengeId: o4.challengeId, response: phishing.create(o4.options) })).statusCode, 400);
  });

  it("needs a code to turn the app off", async () => {
    assert.equal((await req(sam, "POST", "/api/me/2fa/totp/disable", { code: "000000" })).statusCode, 403);
    assert.equal((await req(sam, "POST", "/api/me/2fa/totp/disable", { code: nextCode() })).statusCode, 200);
    const r = await login();
    assert.ok(cookieOf(r), "a password alone works again");
  });

  it("lets a super admin reset it for someone who lost their phone, and says so in the instance log", async () => {
    const setup = (await req(sam, "POST", "/api/me/2fa/totp/start")).json<TotpSetup>();
    await req(sam, "POST", "/api/me/2fa/totp/confirm", { code: totpCode(setup.secret, totpStep(clock)) });
    const before = (await req(admin, "GET", "/api/admin/accounts")).json<AdminAccount[]>().find((a) => a.user.id === samId)!;
    assert.deepEqual({ t: before.twoFactor, p: before.passkeys }, { t: true, p: 1 });

    assert.equal((await req(sam, "DELETE", `/api/admin/accounts/${samId}/2fa`)).statusCode, 403);
    assert.equal((await req(admin, "DELETE", `/api/admin/accounts/${samId}/2fa`)).statusCode, 200);
    assert.ok(cookieOf(await login()));
    const log = (await req(admin, "GET", "/api/admin/audit")).json<{ action: string; target: { name: string } }[]>();
    assert.equal(log[0]!.action, "account.reset2fa");
    assert.equal(log[0]!.target.name, "sam");
  });

  it("says when passkeys can't work: plain http on an IP address", async () => {
    const s2 = await startServer();
    try {
      const info = (await s2.app.inject({ method: "GET", url: "/api/auth/info", headers: { host: "192.168.1.5:8080" } })).json<AuthInfo>();
      assert.equal(info.passkeys, false);
    } finally {
      await s2.close();
    }
  });
});
