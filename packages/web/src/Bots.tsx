import { useEffect, useState, type FormEvent } from "react";
import { BOT_LIMITS, LIMITS, type Bot, type ChatServer, type Message, type MessageButton, type NewBotToken } from "@dendrop/shared";
import { api } from "./api.ts";

interface ServerBots {
  bots: Bot[];
  addable: Bot[];
  canMake: boolean;
}

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Server settings, Bots (owner and admins): make a bot, add one to this server, and manage the
 * ones you own. A bot posts through the bot API with its token, which is shown once.
 */
export function BotsTab({ server }: { server: ChatServer }) {
  const [data, setData] = useState<ServerBots | null>(null);
  const [fresh, setFresh] = useState<NewBotToken | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () => void api<ServerBots>(`/api/servers/${server.id}/bots`).then(setData, (err: Error) => setError(err.message));
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

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const made = await api<NewBotToken>("/api/bots", { body: { username: username.trim(), displayName: displayName.trim() || undefined } });
      await api(`/api/servers/${server.id}/bots`, { body: { botId: made.bot.id } });
      setFresh(made);
      setCopied(null);
      setUsername("");
      setDisplayName("");
    });
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
    } catch {
      /* select it by hand */
    }
  };

  return (
    <div className="server-settings">
      <p className="muted small">
        A bot is an account a program uses to post here, with buttons people can click (approve a chore, answer a question). Bots only live in server
        channels: they can't be friends, so they never see DMs or encrypted chats. Unless its owner turns on <em>reads messages</em>, a bot only hears
        about clicks on its own buttons.
      </p>
      {error && <p className="error">{error}</p>}

      {fresh && (
        <div className="webhook-fresh">
          <strong>Copy {fresh.bot.displayName}'s token now. It won't be shown again.</strong>
          <div className="webhook-url">
            <input readOnly value={fresh.token} onFocus={(e) => e.target.select()} aria-label="Bot token" />
            <button className="primary small-button" onClick={() => void copy(fresh.token)}>
              {copied === fresh.token ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="muted small">
            The bot sends it as <code>Authorization: Bot &lt;token&gt;</code> to <code>{location.origin}/api/bot/v1</code>. See docs/BOTS.md for the API.
          </p>
          <button className="ghost small" onClick={() => setFresh(null)}>
            Done
          </button>
        </div>
      )}

      {data && data.bots.length === 0 && <p className="muted">No bots in this server yet.</p>}
      {data?.bots.map((b) => <BotRow key={b.id} bot={b} server={server} run={run} onToken={setFresh} />)}

      {data && data.addable.length > 0 && (
        <>
          <h4>Add a bot</h4>
          {data.addable.map((b) => (
            <div key={b.id} className="member-row">
              <span className="nav-text">
                <span className="ellipsis">
                  {b.displayName} <span className="bot-tag">bot</span>
                </span>
                <span className="muted small">
                  @{b.username} · by {b.owner?.displayName ?? "someone"}
                  {b.description ? ` · ${b.description}` : ""}
                </span>
              </span>
              <button className="primary small-button" onClick={() => void run(() => api(`/api/servers/${server.id}/bots`, { body: { botId: b.id } }))}>
                Add
              </button>
            </div>
          ))}
        </>
      )}

      {data?.canMake && (
        <>
          <h4>Make a bot</h4>
          <form className="webhook-new" onSubmit={create}>
            <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={LIMITS.usernameLength} placeholder="username" aria-label="Bot username" required />
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={LIMITS.displayNameLength} placeholder="Display name" aria-label="Bot name" />
            <button className="primary small-button" disabled={username.trim().length < 2}>
              Make bot
            </button>
          </form>
        </>
      )}
    </div>
  );
}

function BotRow({ bot, server, run, onToken }: { bot: Bot; server: ChatServer; run: (fn: () => Promise<unknown>) => Promise<void>; onToken: (t: NewBotToken) => void }) {
  const [open, setOpen] = useState(false);
  const [eventsUrl, setEventsUrl] = useState(bot.eventsUrl ?? "");
  const [description, setDescription] = useState(bot.description);
  const mine = bot.signingSecret !== undefined;
  const patch = (body: object) => run(() => api(`/api/bots/${bot.id}`, { method: "PATCH", body }));

  return (
    <div className="bot-row">
      <div className="member-row">
        <span className="nav-text">
          <span className="ellipsis">
            {bot.displayName} <span className="bot-tag">bot</span> {bot.readsMessages && <span className="muted small">· reads messages</span>}
          </span>
          <span className="muted small">
            @{bot.username} · by {bot.owner?.displayName ?? "someone"} · {bot.online ? "running" : "not connected"}
            {bot.lastSeenAt ? ` · last seen ${when(bot.lastSeenAt)}` : ""}
          </span>
        </span>
        {mine && (
          <button className="ghost small" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Close" : "Settings"}
          </button>
        )}
        <button
          className="ghost small danger"
          onClick={() => {
            if (confirm(`Take ${bot.displayName} out of ${server.name}? Its messages stay.`)) void run(() => api(`/api/servers/${server.id}/bots/${bot.id}`, { method: "DELETE" }));
          }}
        >
          Remove
        </button>
      </div>
      {open && mine && (
        <div className="bot-settings">
          <label>
            Description
            <input value={description} maxLength={BOT_LIMITS.description} onChange={(e) => setDescription(e.target.value)} onBlur={() => description !== bot.description && void patch({ description })} />
          </label>
          <label>
            Events address <span className="muted small">(optional: events and clicks are POSTed here, signed)</span>
            <input
              value={eventsUrl}
              placeholder="https://…"
              onChange={(e) => setEventsUrl(e.target.value)}
              onBlur={() => eventsUrl !== (bot.eventsUrl ?? "") && void patch({ eventsUrl: eventsUrl.trim() || null })}
            />
          </label>
          {bot.signingSecret && (
            <label>
              Signing secret
              <input readOnly value={bot.signingSecret} onFocus={(e) => e.target.select()} />
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={bot.readsMessages} onChange={(e) => void patch({ readsMessages: e.target.checked })} />
            Reads messages: gets the text of everything said in channels it can see
          </label>
          <label className="check">
            <input type="checkbox" checked={bot.isPublic} onChange={(e) => void patch({ isPublic: e.target.checked })} />
            Anyone who runs a server here can add it
          </label>
          <div className="row-actions">
            <button
              className="ghost small"
              onClick={() => {
                if (confirm(`Give ${bot.displayName} a new token? The old one stops working right away.`)) {
                  void run(async () => onToken(await api<NewBotToken>(`/api/bots/${bot.id}/token`, { body: {} })));
                }
              }}
            >
              New token
            </button>
            <button
              className="ghost small danger"
              onClick={() => {
                if (confirm(`Delete ${bot.displayName}? It leaves every server; its messages stay.`)) void run(() => api(`/api/bots/${bot.id}`, { method: "DELETE" }));
              }}
            >
              Delete bot
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The window event Shell fires when a bot replies to one of your clicks later. */
export const BOT_REPLY_EVENT = "dendrop:bot-reply";
export interface BotReplyDetail {
  messageId: number;
  content: string;
}

/** A bot message's buttons. A click tells the bot; its reply shows here, only to you. */
export function MessageButtons({ m }: { m: Message }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [reply, setReply] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<BotReplyDetail>).detail;
      if (d.messageId === m.id) setReply({ text: d.content });
    };
    window.addEventListener(BOT_REPLY_EVENT, on);
    return () => window.removeEventListener(BOT_REPLY_EVENT, on);
  }, [m.id]);

  if (!m.buttons?.length && !reply) return null;
  const click = async (b: MessageButton) => {
    if (!b.id) return;
    setBusy(b.id);
    setReply(null);
    try {
      const r = await api<{ reply: string | null }>(`/api/messages/${m.id}/buttons/${encodeURIComponent(b.id)}`, { body: {} });
      if (r.reply) setReply({ text: r.reply });
    } catch (err) {
      setReply({ text: (err as Error).message, error: true });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {!!m.buttons?.length && (
      <div className="msg-buttons">
        {m.buttons.map((b, i) =>
          b.url ? (
            <a key={i} className={`msg-button ${b.style}`} href={b.url} target="_blank" rel="noopener noreferrer">
              {b.label} ↗
            </a>
          ) : (
            <button key={b.id} className={`msg-button ${b.style}`} disabled={b.disabled || busy !== null} onClick={() => void click(b)}>
              {busy === b.id ? "…" : b.label}
            </button>
          ),
        )}
      </div>
      )}
      {reply && (
        <p className={`msg-bot-reply small ${reply.error ? "error" : ""}`}>
          {reply.text} <span className="muted">· only you can see this</span>
        </p>
      )}
    </>
  );
}
