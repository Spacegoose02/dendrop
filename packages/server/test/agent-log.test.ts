import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import type { ChatServer, NewBotToken } from "@dendrop/shared";
import { account, startServer, type TestServer } from "./helpers.js";

const run = promisify(execFile);
/** scripts/agent-log.mjs, from packages/server/dist/test. */
const script = path.resolve(import.meta.dirname, "../../../../scripts/agent-log.mjs");

describe("agent log script", () => {
  let s: TestServer;
  let token: string;
  let channelId: number;

  const agent = async (args: string[], extra: Record<string, string> = {}) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", DENDROP_URL: s.url, DENDROP_AGENT_TOKEN: token, ...extra };
    return run(process.execPath, [script, ...args], { env });
  };

  before(async () => {
    s = await startServer({ DENDROP_SIGNUP: "true" });
    const owner = await account(s, "owner");
    const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => {
      const res = await s.app.inject({ method, url, headers: { cookie: owner }, payload });
      assert.ok(res.statusCode < 300, `${url}: ${res.statusCode} ${res.body}`);
      return res.json();
    };
    const sv = (await call("POST", "/api/servers", { name: "Dendrop dev" })) as ChatServer;
    channelId = (await call("POST", `/api/servers/${sv.id}/channels`, { name: "agent-log" })).id;
    const made = (await call("POST", "/api/bots", { username: "agentlog", displayName: "Agent log" })) as NewBotToken;
    token = made.token;
    await call("PATCH", `/api/bots/${made.bot.id}`, { readsMessages: true });
    await call("POST", `/api/servers/${sv.id}/bots`, { botId: made.bot.id });
  });
  after(() => s.close());

  it("finds #agent-log by name, posts with the agent's name, and reads it back", async () => {
    const first = await agent(["post", "Started on the Safari export bug"], { DENDROP_AGENT_NAME: "Fix Safari export" });
    const firstId = Number(/posted (\d+)/.exec(first.stdout)![1]);
    await agent(["post", "--tag", "done", "PR is up"], { DENDROP_AGENT_NAME: "Fix Safari export" });

    const read = await agent(["read", "--json"]);
    const msgs = JSON.parse(read.stdout) as { id: number; author: string; body: string }[];
    assert.deepEqual(
      msgs.map((m) => m.body),
      ["**Fix Safari export**: Started on the Safari export bug", "**Fix Safari export** [done]: PR is up"],
    );
    assert.equal(msgs[0]!.author, "Agent log");

    // --after shows only what's new; a channel ID works as well as a name.
    const since = await agent(["read", "--after", String(firstId), "--json"], { DENDROP_AGENT_CHANNEL: String(channelId) });
    assert.deepEqual(JSON.parse(since.stdout).map((m: { body: string }) => m.body), ["**Fix Safari export** [done]: PR is up"]);
  });

  it("says what's wrong instead of crashing", async () => {
    await assert.rejects(agent(["post", "hi"], { DENDROP_AGENT_CHANNEL: "nope" }), /can't see a text channel named #nope/);
    await assert.rejects(agent(["read"], { DENDROP_AGENT_TOKEN: "1.wrongwrongwrongwrong" }), /401/);
  });
});
