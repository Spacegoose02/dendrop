import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import type { AuditEntry, BackupStatus, ChatServer } from "@dendrop/shared";
import { extractTarGz, restoreIfAsked } from "../src/backup.js";
import { account, startServer, type TestServer } from "./helpers.js";

describe("the audit log", () => {
  let s: TestServer;
  let admin: string, owner: string, mod: string, member: string;
  let modId: number, memberId: number;
  let sid: number;

  const req = (cookie: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });
  const log = async (cookie = owner, q = "") => (await req(cookie, "GET", `/api/servers/${sid}/audit${q}`)).json<AuditEntry[]>();

  before(async () => {
    s = await startServer();
    admin = await account(s, "admin");
    await s.ctx.signin.save({ signup: true });
    owner = await account(s, "olive");
    mod = await account(s, "mo");
    member = await account(s, "mel");
    modId = s.ctx.users.byUsername("mo")!.id;
    memberId = s.ctx.users.byUsername("mel")!.id;
    await req(admin, "PUT", `/api/admin/server-creators/${s.ctx.users.byUsername("olive")!.id}`, { allowed: true });
    sid = (await req(owner, "POST", "/api/servers", { name: "Den", isPublic: true })).json<ChatServer>().id;
    await req(mod, "POST", `/api/servers/${sid}/join`);
    await req(member, "POST", `/api/servers/${sid}/join`);
  });
  after(() => s.close());

  it("records what moderators do, with names that outlive what was deleted", async () => {
    await req(owner, "PATCH", `/api/servers/${sid}/members/${modId}`, { role: "admin" });
    const ch = (await req(mod, "POST", `/api/servers/${sid}/channels`, { name: "memes" })).json<{ id: number }>();
    await req(mod, "PATCH", `/api/servers/${sid}/channels/${ch.id}`, { topic: "only the best" });
    await req(mod, "DELETE", `/api/servers/${sid}/channels/${ch.id}`);
    await req(mod, "PUT", `/api/servers/${sid}/timeouts/${memberId}`, { minutes: 10, reason: "spam" });
    await req(mod, "DELETE", `/api/servers/${sid}/members/${memberId}?ban=true`);

    const entries = await log();
    assert.deepEqual(
      entries.map((e) => e.action),
      ["member.ban", "member.timeout", "channel.delete", "channel.update", "channel.create", "member.role"],
    );
    const [ban, timeout, del, upd] = entries;
    assert.deepEqual({ actor: ban!.actor.name, target: ban!.target.name }, { actor: "mo", target: "mel" });
    assert.equal(timeout!.details, "10 min: spam");
    assert.equal(del!.target.name, "#memes");
    assert.equal(upd!.details, "topic");

    // Filters: one kind of action, or one person.
    assert.deepEqual((await log(owner, "?action=member")).map((e) => e.action), ["member.ban", "member.timeout", "member.role"]);
    assert.equal((await log(owner, `?userId=${memberId}`)).length, 2);
    assert.equal((await log(owner, `?before=${entries[1]!.id}`)).length, 4);
  });

  it("leaves out what didn't happen", async () => {
    const before = (await log()).length;
    // Can't ban the owner: a 403, and nothing logged.
    assert.equal((await req(mod, "DELETE", `/api/servers/${sid}/members/${s.ctx.users.byUsername("olive")!.id}`)).statusCode, 403);
    assert.equal((await log()).length, before);
  });

  it("is for moderators only, and private servers stay hidden", async () => {
    await req(mod, "PATCH", `/api/servers/${sid}/members/${modId}`, { role: "member" });
    await req(owner, "PATCH", `/api/servers/${sid}/members/${modId}`, { role: "member" });
    assert.equal((await req(mod, "GET", `/api/servers/${sid}/audit`)).statusCode, 403);
    assert.equal((await req(member, "GET", `/api/servers/${sid}/audit`)).statusCode, 404);
  });

  it("keeps the instance's own log of super admin actions", async () => {
    await req(admin, "PUT", "/api/admin/signin", { signup: false });
    await req(admin, "PUT", `/api/admin/accounts/${memberId}/password`, { password: "a brand new password" });
    const entries = (await req(admin, "GET", "/api/admin/audit")).json<AuditEntry[]>();
    assert.deepEqual(entries.slice(0, 2).map((e) => [e.action, e.target.name ?? e.details]), [
      ["account.password", "mel"],
      ["signin.update", "signup off"],
    ]);
    assert.ok(entries.some((e) => e.action === "creator.allow"));
    assert.equal((await req(owner, "GET", "/api/admin/audit")).statusCode, 403);
    // A deleted server's entry lands in the instance log.
    await req(owner, "DELETE", `/api/servers/${sid}`);
    const last = (await req(admin, "GET", "/api/admin/audit")).json<AuditEntry[]>()[0]!;
    assert.deepEqual([last.action, last.target.name, last.actor.name], ["server.delete", "Den", "olive"]);
  });
});

describe("backups", () => {
  let s: TestServer;
  let admin: string, sam: string;
  let backupDir: string;
  const req = (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });

  before(async () => {
    backupDir = mkdtempSync(path.join(tmpdir(), "dendrop-backups-"));
    s = await startServer({ DENDROP_BACKUP_DIR: backupDir });
    admin = await account(s, "admin");
    await s.ctx.signin.save({ signup: true });
    sam = await account(s, "sam");
    mkdirSync(path.join(s.ctx.config.dataDir, "uploads"), { recursive: true });
    writeFileSync(path.join(s.ctx.config.dataDir, "uploads", "0123456789abcdef0123456789abcdef"), "a raccoon picture");
  });
  after(async () => {
    await s.close();
    rmSync(backupDir, { recursive: true, force: true });
  });

  it("makes a backup with the database and uploads, that tar can read too", async () => {
    assert.equal((await req(sam, "POST", "/api/admin/backups")).statusCode, 403);
    const status = (await req(admin, "POST", "/api/admin/backups")).json<BackupStatus>();
    assert.equal(status.dir, backupDir);
    assert.equal(status.backups.length, 1);
    const name = status.backups[0]!.name;
    assert.match(name, /^dendrop-backup-.*\.tar\.gz$/);

    const listing = execFileSync("tar", ["tzf", path.join(backupDir, name)], { encoding: "utf8" }).trim().split("\n").sort();
    assert.deepEqual(listing, ["backup.json", "dendrop.db", "uploads/0123456789abcdef0123456789abcdef"]);

    const out = mkdtempSync(path.join(tmpdir(), "dendrop-extract-"));
    await extractTarGz(path.join(backupDir, name), out);
    const db = new DatabaseSync(path.join(out, "dendrop.db"));
    const users = (db.prepare("SELECT username FROM users ORDER BY id").all() as { username: string }[]).map((u) => u.username);
    db.close();
    assert.deepEqual(users, ["admin", "sam"]);
    assert.equal(readFileSync(path.join(out, "uploads/0123456789abcdef0123456789abcdef"), "utf8"), "a raccoon picture");
    rmSync(out, { recursive: true, force: true });

    const download = await req(admin, "GET", `/api/admin/backups/${name}`);
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers["content-type"], "application/gzip");
    assert.equal((await req(admin, "GET", "/api/admin/backups/..%2Fdendrop.db")).statusCode, 404);
  });

  it("keeps only the newest few, and can leave uploads out", async () => {
    const st = (await req(admin, "PUT", "/api/admin/backups/settings", { keep: 2, includeUploads: false, everyHours: 6 })).json<BackupStatus>();
    assert.deepEqual(st.settings, { keep: 2, includeUploads: false, everyHours: 6 });
    assert.equal((await req(admin, "PUT", "/api/admin/backups/settings", { keep: 0 })).statusCode, 400);
    await req(admin, "POST", "/api/admin/backups");
    await new Promise((r) => setTimeout(r, 1100));
    const last = (await req(admin, "POST", "/api/admin/backups")).json<BackupStatus>();
    assert.equal(last.backups.length, 2);
    const listing = execFileSync("tar", ["tzf", path.join(backupDir, last.backups[0]!.name)], { encoding: "utf8" });
    assert.doesNotMatch(listing, /uploads/);

    const audit = (await req(admin, "GET", "/api/admin/audit?action=backup")).json<AuditEntry[]>();
    assert.ok(audit.some((e) => e.action === "backup.download"));
    assert.ok(audit.some((e) => e.action === "backup.settings"));
  });

  it("restores at start-up from restore.tar.gz, keeping the old data aside", async () => {
    await req(admin, "PUT", "/api/admin/backups/settings", { includeUploads: true });
    const name = (await req(admin, "POST", "/api/admin/backups")).json<BackupStatus>().backups[0]!.name;

    const data = mkdtempSync(path.join(tmpdir(), "dendrop-restore-"));
    writeFileSync(path.join(data, "dendrop.db"), "the old database");
    mkdirSync(path.join(data, "uploads"));
    writeFileSync(path.join(data, "uploads", "old"), "old file");
    writeFileSync(path.join(data, "restore.tar.gz"), readFileSync(path.join(backupDir, name)));

    const messages: string[] = [];
    assert.equal(await restoreIfAsked(data, (m) => messages.push(m)), true, messages.join("; "));
    assert.match(messages[0]!, /Restored/);
    assert.ok(existsSync(path.join(data, "restore.tar.gz.done")));
    assert.ok(existsSync(path.join(data, "uploads/0123456789abcdef0123456789abcdef")));
    const aside = readdirSync(data).find((n) => n.startsWith("before-restore-"))!;
    assert.equal(readFileSync(path.join(data, aside, "dendrop.db"), "utf8"), "the old database");
    assert.equal(readFileSync(path.join(data, aside, "uploads", "old"), "utf8"), "old file");
    const db = new DatabaseSync(path.join(data, "dendrop.db"));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 2);
    db.close();

    // Something that isn't a backup changes nothing.
    writeFileSync(path.join(data, "restore.tar.gz"), "nope");
    assert.equal(await restoreIfAsked(data, () => {}), false);
    assert.ok(existsSync(path.join(data, "restore.tar.gz.failed")));
    rmSync(data, { recursive: true, force: true });
  });
});
