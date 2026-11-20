import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("works as an agent hook: silent when nothing's new, the notes as context when there are", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-log-"));
    const a = { DENDROP_AGENT_STATE: path.join(dir, "a.json"), DENDROP_AGENT_NAME: "Fix Safari export" };
    const b = { DENDROP_AGENT_STATE: path.join(dir, "b.json"), DENDROP_AGENT_NAME: "Release 0.9" };
    const hook = async (who: Record<string, string>, event: string, ...args: string[]) => {
      const { stdout } = await agent(["check", ...args], { ...who, DENDROP_HOOK_INPUT: JSON.stringify({ hook_event_name: event, session_id: "x" }) });
      return stdout.trim() ? (JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput : null;
    };

    // A new session gets the recent notes.
    const start = await hook(a, "SessionStart");
    assert.equal(start!.hookEventName, "SessionStart");
    assert.match(start!.additionalContext, /Recent notes[\s\S]*PR is up/);
    // Right after, a tool call is throttled, and with no throttle there's nothing new: no output.
    assert.equal(await hook(a, "PostToolUse", "--every", "60"), null);
    assert.equal(await hook(a, "PostToolUse", "--every", "0"), null);

    // Another agent posts; this agent's own post isn't handed back to it.
    await agent(["post", "Fixed it"], a);
    await agent(["post", "@fix safari export can you rebase on main before I tag?"], b);
    const next = await hook(a, "PostToolUse", "--every", "0");
    assert.equal(next!.hookEventName, "PostToolUse");
    assert.match(next!.additionalContext, /New in Dendrop's #agent-log/);
    assert.match(next!.additionalContext, /\(mentions you\): \*\*Release 0\.9\*\*: @fix safari export can you rebase/);
    assert.doesNotMatch(next!.additionalContext, /Fixed it/);
    // Seen once, not again; a new turn (Gemini's BeforeAgent) always looks, and finds nothing.
    assert.equal(await hook(a, "BeforeAgent"), null);

    // Not set up, or Dendrop unreachable: silent, and never a failing hook.
    assert.equal((await agent(["check"], { DENDROP_URL: "", DENDROP_HOOK_INPUT: "{}" })).stdout, "");
    const down = await agent(["check", "--every", "0"], { DENDROP_URL: "http://127.0.0.1:9", DENDROP_AGENT_STATE: path.join(dir, "c.json") });
    assert.equal(down.stdout, "");
  });

  it("says what's wrong instead of crashing", async () => {
    await assert.rejects(agent(["post", "hi"], { DENDROP_AGENT_CHANNEL: "nope" }), /can't see a text channel named #nope/);
    await assert.rejects(agent(["read"], { DENDROP_AGENT_TOKEN: "1.wrongwrongwrongwrong" }), /401/);
  });
});
