import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { startServer, type TestServer } from "./helpers.js";

describe("built-in HTTPS", () => {
  let certDir: string;
  let s: TestServer;

  before(async () => {
    certDir = mkdtempSync(path.join(tmpdir(), "dendrop-tls-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-keyout", path.join(certDir, "key.pem"), "-out", path.join(certDir, "cert.pem"),
    ], { stdio: "ignore" });
    s = await startServer({ DENDROP_TLS_CERT: path.join(certDir, "cert.pem"), DENDROP_TLS_KEY: path.join(certDir, "key.pem") });
  });
  after(async () => {
    await s.close();
    rmSync(certDir, { recursive: true, force: true });
  });

  it("answers over https", async () => {
    const url = s.url.replace("http://", "https://");
    const status = await new Promise<number>((resolve, reject) => {
      get(`${url}/api/health`, { rejectUnauthorized: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    assert.equal(status, 200);
  });

  it("marks the session cookie secure", async () => {
    const res = await s.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "dad", password: "correct horse battery" } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cookies.find((c) => c.name === "dendrop_session")?.secure, true);
  });
});

describe("HTTPS settings", () => {
  it("is off by default", () => {
    assert.equal(loadConfig({}).tls, null);
  });
  it("uses the self-signed files in the data folder", () => {
    assert.deepEqual(loadConfig({ DENDROP_HTTPS: "self-signed", DENDROP_DATA_DIR: "/data" }).tls, {
      cert: "/data/tls/self-signed.crt",
      key: "/data/tls/self-signed.key",
    });
  });
  it("prefers your own certificate", () => {
    assert.deepEqual(loadConfig({ DENDROP_HTTPS: "self-signed", DENDROP_TLS_CERT: "/c.pem", DENDROP_TLS_KEY: "/k.pem" }).tls, { cert: "/c.pem", key: "/k.pem" });
  });
});
