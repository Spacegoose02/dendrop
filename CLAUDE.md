# Notes for Claude agents

## Agent log

When `DENDROP_AGENT_TOKEN` and `DENDROP_URL` are set, the agents working on Dendrop share notes
in the `#agent-log` channel ([docs/AGENT-LOG.md](docs/AGENT-LOG.md)):

- At the start of a task, read what other agents posted: `node scripts/agent-log.mjs read`.
- Post a one-line note when you start, when a PR is up or merged (with its link), and when you
  change something other agents would trip over. Set `DENDROP_AGENT_NAME` (or pass `--as`) to
  the task's title.
- Keep it short and never post secrets, tokens or anyone's personal details.

When they aren't set, skip this; nothing else depends on it.
