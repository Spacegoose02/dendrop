import { useEffect, useState, type FormEvent } from "react";
import { WEBHOOK_LIMITS, type ChatServer, type NewWebhook, type Webhook } from "@dendrop/shared";
import { channelMark } from "./channels.ts";
import { api } from "./api.ts";

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Server settings, Webhooks (owner and admins): secret addresses that post into a channel, for
 * LootDen's alerts, Home Assistant or a script. An address is shown once, right after it's made.
 */
export function WebhooksTab({ server }: { server: ChatServer }) {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [fresh, setFresh] = useState<NewWebhook | null>(null);
  const [name, setName] = useState("LootDen");
  const [channelId, setChannelId] = useState<number>(server.channels[0]?.id ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const channels = new Map(server.channels.map((c) => [c.id, c]));

  const load = () => void api<Webhook[]>(`/api/servers/${server.id}/webhooks`).then(setHooks, (err: Error) => setError(err.message));
  useEffect(load, [server.id]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const show = (h: NewWebhook) => {
    setFresh(h);
    setCopied(false);
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => show(await api<NewWebhook>(`/api/servers/${server.id}/webhooks`, { body: { channelId, name } })));
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      /* select it by hand */
    }
  };

  return (
    <div className="server-settings">
      <p className="muted small">
        A webhook is a secret address that posts into a channel. Paste it into LootDen's alerts (as an Apprise target), Home Assistant or a script, and
        their messages show up here under the webhook's name. Anyone with the address can post, so keep it to yourself.
      </p>
      {error && <p className="error">{error}</p>}

      {fresh && (
        <div className="webhook-fresh">
          <strong>Copy the address for {fresh.name} now. It won't be shown again.</strong>
          <div className="webhook-url">
            <input readOnly value={fresh.url} onFocus={(e) => e.target.select()} aria-label="Webhook address" />
            <button className="primary small-button" onClick={() => void copy(fresh.url)}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="muted small">
            For LootDen: Settings, Scanning &amp; alerts, add <code>{fresh.url.replace(/^http(s?):\/\//, "json$1://")}</code> as an Apprise target. Anything that can send
            JSON like <code>{`{"content": "Hello"}`}</code> or <code>{`{"title": "...", "message": "..."}`}</code> works too.
          </p>
          <button className="ghost small" onClick={() => setFresh(null)}>
            Done
          </button>
        </div>
      )}

      <form className="webhook-new" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={WEBHOOK_LIMITS.name} placeholder="Name" aria-label="Webhook name" required />
        <select value={channelId} onChange={(e) => setChannelId(Number(e.target.value))} aria-label="Channel">
          {server.channels.map((c) => (
            <option key={c.id} value={c.id}>
              {channelMark({ ...c, locked: false })} {c.name}
            </option>
          ))}
        </select>
        <button className="primary small-button" disabled={!name.trim() || !channelId}>
          Make webhook
        </button>
      </form>

      {hooks?.length === 0 && <p className="muted">No webhooks yet.</p>}
      {hooks?.map((h) => (
        <div key={h.id} className="member-row">
          <span className="nav-text">
            <span className="ellipsis">
              {h.name} <span className="muted small">→ #{channels.get(h.channelId)?.name ?? "?"}</span>
            </span>
            <span className="muted small">
              by {h.createdBy?.displayName ?? "someone"} · {h.lastUsedAt ? `last posted ${when(h.lastUsedAt)}` : "hasn't posted yet"}
            </span>
          </span>
          <button
            className="ghost small"
            title="Make a new address; the old one stops working"
            onClick={() => {
              if (confirm(`Give ${h.name} a new address? Whatever uses the old one will need the new one.`)) {
                void run(async () => show(await api<NewWebhook>(`/api/servers/${server.id}/webhooks/${h.id}/reset`, { body: {} })));
              }
            }}
          >
            New address
          </button>
          <button
            className="ghost small danger"
            onClick={() => {
              if (confirm(`Delete ${h.name}? Its messages stay.`)) void run(() => api(`/api/servers/${server.id}/webhooks/${h.id}`, { method: "DELETE" }));
            }}
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
