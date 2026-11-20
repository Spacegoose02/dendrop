# Agent log

`#agent-log` is a channel where the Claude agents working on Dendrop leave each other notes:
"started on X", "PR is up", "heads up, I changed the bots API", "release notes are here". You
can read along, and each agent can read what the others wrote before it starts.

It's built on the existing [bot API](BOTS.md): one bot, **Agent log**, that posts and reads in
one channel. Nothing new runs on the server.

## Setting it up (once, in Dendrop)

1. Pick a server you own (or make a small *Dendrop dev* one) and add a text channel named
   **agent-log**. Lock it if you don't want everyone on the server to see it; then pick the
   bot for it in step 3.
2. **Server settings → Bots → Make a bot**: username `agentlog`, display name *Agent log*.
   Copy the token it shows; it's shown only once.
3. On the bot, **Settings**: turn on **reads messages** (so agents can read the channel back).
   Leave *public* off.

That's all the server needs. The bot follows the same rules as any bot: it only lives in
server channels, posts 30 times a minute at most, and goes through automod. Raccoon-cartel
profile pictures for the agent bots (`El-Chapo`, `El-Dorado`, `Okie`) live in
[`docs/bot-avatars/`](bot-avatars/).

## Giving the agents access

The agents read their settings from environment variables, so the token never goes in the
repo. In the Claude Code environment that works on Dendrop, add:

| Variable | Value |
| --- | --- |
| `DENDROP_URL` | your Dendrop address, e.g. `https://chat.example.com` |
| `DENDROP_AGENT_TOKEN` | the Agent log bot's token |
| `DENDROP_AGENT_CHANNEL` | optional: the channel's ID or name (default `agent-log`) |

The address has to be reachable from where the agents run. A cloud agent can't see
`192.168.x.x` or a Tailscale-only name: use the public address behind your reverse proxy or
Cloudflare Tunnel, and allow that host in the environment's network settings if it limits
outbound traffic.

If the token leaks, **New token** on the bot closes the old one at once.

## Posting and reading

[`scripts/agent-log.mjs`](../scripts/agent-log.mjs) needs only Node 22:

```sh
# Post. DENDROP_AGENT_NAME (or --as) goes in front, so you can tell agents apart.
DENDROP_AGENT_NAME="Fix Safari export" node scripts/agent-log.mjs post "Started; looking at Webhooks.tsx"
node scripts/agent-log.mjs post --as "Release 0.9" --tag done "Tagged v0.9.0, notes in release/"
git log -1 --format=%B | node scripts/agent-log.mjs post -      # text from stdin

# Read the last 20 notes, or only the ones after a message you've already seen.
node scripts/agent-log.mjs read
node scripts/agent-log.mjs read --after 1234
node scripts/agent-log.mjs read --limit 50 --json

# Which servers and channels the bot can see, with IDs.
node scripts/agent-log.mjs channels
```

A post looks like **Fix Safari export** [done]: PR is up. Posts over 4000 characters are cut.
The script uses the sandbox's `HTTPS_PROXY` when there is one.

Without the script, it's two calls to the bot API:

```sh
curl -s -H "Authorization: Bot $DENDROP_AGENT_TOKEN" -H "content-type: application/json" \
  -d '{"content":"**Fix Safari export**: PR is up"}' \
  "$DENDROP_URL/api/bot/v1/channels/$CHANNEL_ID/messages"
curl -s -H "Authorization: Bot $DENDROP_AGENT_TOKEN" \
  "$DENDROP_URL/api/bot/v1/channels/$CHANNEL_ID/messages?limit=20"
```

### Post-only, with a webhook

Something that only needs to post (a CI job, a script) can use a webhook instead:
**Server settings → Webhooks** on `#agent-log`, and set `DENDROP_AGENT_WEBHOOK` to its address.
With no `DENDROP_AGENT_TOKEN`, `agent-log.mjs post` sends there, shown under the agent's name.
Webhooks can't read, so `read` still needs the bot.

## Seeing new notes while working

Agents don't just read the log when they start. The repo has hooks for **Claude Code**
([`.claude/settings.json`](../.claude/settings.json)), **Gemini CLI**
([`.gemini/settings.json`](../.gemini/settings.json)), and **Antigravity**
([`.agents/hooks.json`](../.agents/hooks.json)) that run `agent-log.mjs check`:

| When | Claude Code | Gemini CLI | Antigravity | How often |
| --- | --- | --- | --- | --- |
| A session starts | `SessionStart` | `SessionStart` | `SessionStart` | always: the last 10 notes |
| A new turn starts (you write to the agent) | `UserPromptSubmit` | `BeforeAgent` | `PreInvocation` (`invocationNum: 0`) | always |
| After each tool / mid-turn | `PostToolUse` | `AfterTool` | `PreInvocation` (`invocationNum > 0`) | at most once a minute |

When there's nothing new, `check` prints nothing and the agent never sees it, so a quiet log
costs nothing. When there are new notes, they're added to what the agent reads next, marked
*(mentions you)* when a note has `@` plus the agent's `DENDROP_AGENT_NAME`. An agent's own
posts aren't handed back to it. So while an agent is working, something posted in
`#agent-log` reaches it within about a minute.

`check` never gets in the agent's way: with no `DENDROP_URL` or token it does nothing (in
about 30 ms), and if Dendrop is down it gives up quietly and tries again a minute later.
What it has seen is kept in the temp folder, one file per checkout; set
`DENDROP_AGENT_STATE` to put it somewhere else. Change `--every 60` in the settings files to
look more or less often.

### What it can't do: wake an idle agent

An agent only runs while it's working on a turn. Between turns nothing is running to hear a
new note, so `#agent-log` can't wake it up: a note waits until the agent's next turn or tool
call. To get an idle agent's attention, message it where it runs (its Claude thread, or the
Gemini CLI prompt); its first step will pick up the notes.

## What's worth posting

Short, useful notes, not a running commentary:

- when you **start** a piece of work, and what you'll touch;
- when a **PR is up** or **merged**, with its link;
- **heads-ups** another agent would want: a changed API or table, a renamed file, a flaky test;
- where a **result** lives (release notes, screenshots).
