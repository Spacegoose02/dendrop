import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ServerHealth } from "@dendrop/shared";
import { account, listen, startServer, type TestServer } from "./helpers.js";

describe("server health", () => {
  let s: TestServer;
  let admin: string, member: string;

  before(async () => {
    s = await startServer();
    admin = await account(s, "admin");
    await s.ctx.signin.save({ signup: true });
    member = await account(s, "mel");
  });
  after(() => s.close());

  it("is only for super admins", async () => {
    assert.equal((await s.app.inject({ method: "GET", url: "/api/admin/health" })).statusCode, 401);
    assert.equal((await s.app.inject({ method: "GET", url: "/api/admin/health", headers: { cookie: member } })).statusCode, 403);
  });

  it("reports CPU, memory, disks, storage, connections and counts", async () => {
    const uploads = path.join(s.ctx.config.dataDir, "uploads", "avatars");
    mkdirSync(uploads, { recursive: true });
    writeFileSync(path.join(uploads, "a.png"), Buffer.alloc(3000));
    writeFileSync(path.join(uploads, "b.png"), Buffer.alloc(2000));
    const a = await listen(s, admin);
    const m1 = await listen(s, member);
    const m2 = await listen(s, member);
    m2.ws.send(JSON.stringify({ type: "active", active: false }));
    await new Promise((r) => setTimeout(r, 50));

    const res = await s.app.inject({ method: "GET", url: "/api/admin/health", headers: { cookie: admin } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    const h = res.json<ServerHealth>();
    assert.ok(h.uptimeSeconds >= 0);
    assert.ok(h.cpu.cores >= 1 && h.cpu.processPercent >= 0 && h.cpu.loadAverage.length === 3);
    assert.ok(h.memory.processBytes > 0 && h.memory.totalBytes >= h.memory.usedBytes && h.memory.usedBytes > 0);
    // Data and backups share the test's temporary disk.
    assert.equal(h.disks.length, 1);
    assert.equal(h.disks[0]!.label, "Data and backups");
    assert.ok(h.disks[0]!.totalBytes >= h.disks[0]!.freeBytes && h.disks[0]!.freeBytes > 0);
    assert.ok(h.storage.databaseBytes > 0);
    assert.deepEqual({ bytes: h.storage.uploadsBytes, files: h.storage.uploadFiles }, { bytes: 5000, files: 2 });
    assert.deepEqual({ bytes: h.storage.backupsBytes, n: h.storage.backups }, { bytes: 0, n: 0 });
    assert.deepEqual(h.connections, { sockets: 3, onlineUsers: 2, idleSockets: 1 });
    assert.deepEqual({ users: h.counts.users, servers: h.counts.servers }, { users: 2, servers: 0 });

    for (const c of [a, m1, m2]) c.ws.close();
  });
});
