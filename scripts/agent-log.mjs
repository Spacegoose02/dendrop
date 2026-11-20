#!/usr/bin/env node
// Posts to and reads the #agent-log channel, where the Claude agents working on Dendrop leave
// each other notes. Uses the bot API (docs/BOTS.md), so it needs nothing but Node 22.
// See docs/AGENT-LOG.md for setting up the channel and the bot.
//
//   node scripts/agent-log.mjs post "Merged #71, release notes are in release/v0.9.0-notes.md"
//   echo "long note" | node scripts/agent-log.mjs post -
//   node scripts/agent-log.mjs read --limit 20
//   node scripts/agent-log.mjs read --after 1234      # only what's new since message 1234
//   node scripts/agent-log.mjs channels               # what the bot can see, with IDs
//
// Settings come from the environment (never from the repo):
//   DENDROP_URL            e.g. https://chat.example.com
//   DENDROP_AGENT_TOKEN    the agent-log bot's token
//   DENDROP_AGENT_CHANNEL  channel ID or name (default: agent-log)
//   DENDROP_AGENT_NAME     who's speaking, shown in front of each post (e.g. "Fix Safari export")
//   DENDROP_AGENT_WEBHOOK  optional: a webhook address, used for `post` when there's no token

import { spawnSync } from "node:child_process";

// Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set, and cloud sandboxes
// only reach the internet through a proxy. Run again with it on.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, ["--disable-warning=UNDICI-EHPA", ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
  process.exit(r.status ?? 1);
}

const MAX_LENGTH = 4000;
const env = process.env;

function fail(message) {
  console.error(`agent-log: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  agent-log post <text|->  [--as NAME] [--tag TAG]
  agent-log read           [--limit N] [--after MESSAGE_ID] [--json]
  agent-log channels

Environment: DENDROP_URL, DENDROP_AGENT_TOKEN, DENDROP_AGENT_CHANNEL (default agent-log),
DENDROP_AGENT_NAME, DENDROP_AGENT_WEBHOOK (post-only, when there's no token).`);
}

/** Splits argv into positional words and --flags. */
function parse(argv) {
  const words = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (k === "json" || k === "help") flags[k] = true;
      else flags[k] = v ?? argv[++i];
    } else words.push(a);
  }
  return { words, flags };
}

const base = () => {
  const url = env.DENDROP_URL?.replace(/\/+$/, "");
  if (!url) fail("set DENDROP_URL to your Dendrop address, e.g. https://chat.example.com");
  return `${url}/api/bot/v1`;
};

async function api(method, path, body) {
  if (!env.DENDROP_AGENT_TOKEN) fail("set DENDROP_AGENT_TOKEN to the agent-log bot's token");
  let res;
  try {
    res = await fetch(base() + path, {
      method,
      headers: { authorization: `Bot ${env.DENDROP_AGENT_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`couldn't reach ${env.DENDROP_URL}: ${e.cause?.message ?? e.message}`);
  }
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (!res.ok) fail(`${method} ${path}: ${res.status} ${json?.error ?? json?.message ?? text}`);
  return json;
}

/** The channel to use: DENDROP_AGENT_CHANNEL as an ID, or found by name. */
async function channel() {
  const want = (env.DENDROP_AGENT_CHANNEL || "agent-log").replace(/^#/, "");
  if (/^\d+$/.test(want)) return Number(want);
  const servers = await api("GET", "/servers");
  const found = servers.flatMap((s) => s.channels.map((c) => ({ ...c, server: s.name }))).filter((c) => c.name === want && c.kind === "text");
  if (found.length === 0) fail(`the bot can't see a text channel named #${want}; add it to the server, or set DENDROP_AGENT_CHANNEL to the channel ID`);
  if (found.length > 1) fail(`#${want} is in more than one server (${found.map((c) => `${c.server}: ${c.id}`).join(", ")}); set DENDROP_AGENT_CHANNEL to the ID`);
  return found[0].id;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function post(words, flags) {
  let text = words.join(" ");
  if (text === "-") text = await readStdin();
  text = text.trim();
  if (!text) fail("nothing to post");
  const name = flags.as ?? env.DENDROP_AGENT_NAME;
  const head = [name && `**${name}**`, flags.tag && `[${flags.tag}]`].filter(Boolean).join(" ");
  let content = head ? `${head}: ${text}` : text;
  if (content.length > MAX_LENGTH) content = `${content.slice(0, MAX_LENGTH - 2)} …`;

  if (!env.DENDROP_AGENT_TOKEN && env.DENDROP_AGENT_WEBHOOK) {
    const res = await fetch(env.DENDROP_AGENT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, username: name ? `${name}${flags.tag ? ` [${flags.tag}]` : ""}` : undefined }),
    }).catch((e) => fail(`couldn't reach the webhook: ${e.cause?.message ?? e.message}`));
    if (!res.ok) fail(`webhook: ${res.status} ${await res.text()}`);
    console.log("posted (webhook)");
    return;
  }
  const m = await api("POST", `/channels/${await channel()}/messages`, { content });
  console.log(`posted ${m.id}`);
}

async function read(flags) {
  const id = await channel();
  const limit = Math.max(1, Math.min(Number(flags.limit) || 20, 500));
  const after = flags.after !== undefined ? Number(flags.after) : null;
  if (after !== null && !Number.isInteger(after)) fail("--after takes a message ID");
  // Pages come newest first; walk back until there are enough, or until --after.
  let out = [];
  let before;
  for (;;) {
    const page = await api("GET", `/channels/${id}/messages?limit=100${before ? `&before=${before}` : ""}`);
    if (!page.length) break;
    out = [...page, ...out];
    before = page[0].id;
    if (after !== null ? page[0].id <= after : out.length >= limit) break;
  }
  out = out.filter((m) => !m.deleted && (after === null || m.id > after));
  if (after === null) out = out.slice(-limit);
  if (flags.json) {
    console.log(JSON.stringify(out.map((m) => ({ id: m.id, at: m.createdAt, author: m.webhook?.name ?? m.author?.displayName ?? null, body: m.body })), null, 2));
    return;
  }
  for (const m of out) {
    const who = m.webhook?.name ?? m.author?.displayName ?? "?";
    console.log(`#${m.id} ${m.createdAt} ${who}: ${m.body}`);
  }
}

async function channels() {
  for (const s of await api("GET", "/servers")) {
    for (const c of s.channels) console.log(`${c.id}\t${s.name} #${c.name} (${c.kind})`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const { words, flags } = parse(rest);
if (!cmd || cmd === "help" || cmd === "--help" || flags.help) usage();
else if (cmd === "post") await post(words, flags);
else if (cmd === "read") await read(flags);
else if (cmd === "channels") await channels();
else {
  usage();
  process.exit(1);
}
