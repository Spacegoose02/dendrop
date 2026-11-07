import { useEffect, useState, type ReactNode } from "react";
import type { AutomodAction, AutomodEvent, AutomodRuleBase, AutomodRuleKind, AutomodSettings, ChatServer, ServerRole, ServerTimeout } from "@dendrop/shared";
import { api } from "./api.ts";
import { RoleChip } from "./Roles.tsx";

const RULE_INFO: Record<AutomodRuleKind, { title: string; icon: string; about: string }> = {
  words: { title: "Blocked words", icon: "🤐", about: "Catches swears and any words you add, even disguised (f*ck, sh1t, fuuuck). Same filter as kid-safe chat." },
  spam: { title: "Spam and flooding", icon: "🌊", about: "Too many messages too fast, the same message over and over, or a pile of @mentions." },
  links: { title: "Links", icon: "🔗", about: "Links to anywhere except the sites you allow. Links to this Dendrop are always fine." },
  newAccounts: { title: "New accounts", icon: "🐣", about: "Brand new accounts, and people who only just joined, have to wait before posting." },
};
export const ruleTitle = (k: AutomodRuleKind) => RULE_INFO[k].title;

const ACTION_LABEL: Record<AutomodAction, string> = { block: "Block the message", alert: "Alert moderators", timeout: "Time them out" };
const ROLE_LABEL: Record<ServerRole, string> = { owner: "Owner", admin: "Admins", member: "Members" };
const RULES: AutomodRuleKind[] = ["words", "spam", "links", "newAccounts"];

/** Words and sites are typed one per line (commas work too). */
const toList = (text: string) =>
  text
    .split(/[\n,]+/)
    .map((w) => w.trim())
    .filter(Boolean);

function NumberField({ value, onChange, min, max, label }: { value: number; onChange: (n: number) => void; min: number; max: number; label: string }) {
  return (
    <input
      type="number"
      className="automod-number"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Math.max(min, Math.min(max, Math.round(Number(e.target.value) || 0))))}
    />
  );
}

/** The owner and admins set up automod: one card per rule, each with its own actions and exemptions. */
export function AutomodTab({ server }: { server: ChatServer }) {
  const [settings, setSettings] = useState<AutomodSettings | null>(null);
  const [words, setWords] = useState("");
  const [domains, setDomains] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = (a: AutomodSettings) => {
    setSettings(a);
    setWords(a.words.words.join("\n"));
    setDomains(a.links.allowedDomains.join("\n"));
  };
  useEffect(() => {
    void api<AutomodSettings>(`/api/servers/${server.id}/automod`).then(load, (err: Error) => setError(err.message));
  }, [server.id]);

  if (!settings) return <div className="server-settings">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</div>;

  const set = <K extends AutomodRuleKind>(k: K, patch: Partial<AutomodSettings[K]>) => {
    setStatus(null);
    setSettings({ ...settings, [k]: { ...settings[k], ...patch } });
  };
  const toggleIn = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const body = { ...settings, words: { ...settings.words, words: toList(words) }, links: { ...settings.links, allowedDomains: toList(domains) } };
      load(await api<AutomodSettings>(`/api/servers/${server.id}/automod`, { method: "PATCH", body }));
      setStatus("Automod saved");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const textChannels = server.channels;
  const fields: Record<AutomodRuleKind, ReactNode> = {
    words: (
      <>
        <label className="toggle inline">
          <input type="checkbox" checked={settings.words.useBuiltinList} onChange={(e) => set("words", { useBuiltinList: e.target.checked })} />
          <span>Use the built-in swear list</span>
        </label>
        <label>
          Your blocked words
          <textarea rows={3} value={words} onChange={(e) => (setWords(e.target.value), setStatus(null))} placeholder={"one per line\nheck* (a * catches heckin, hecking…)"} />
        </label>
      </>
    ),
    spam: (
      <>
        <p className="automod-line">
          More than <NumberField label="Messages" value={settings.spam.maxMessages} min={0} max={100} onChange={(n) => set("spam", { maxMessages: n })} /> messages in{" "}
          <NumberField label="Seconds" value={settings.spam.perSeconds} min={1} max={600} onChange={(n) => set("spam", { perSeconds: n })} /> seconds
        </p>
        <p className="automod-line">
          The same message more than <NumberField label="Repeats" value={settings.spam.maxDuplicates} min={0} max={50} onChange={(n) => set("spam", { maxDuplicates: n })} />{" "}
          times in 5 minutes
        </p>
        <p className="automod-line">
          More than <NumberField label="Mentions" value={settings.spam.maxMentions} min={0} max={100} onChange={(n) => set("spam", { maxMentions: n })} /> @mentions in
          one message
        </p>
        <p className="muted small">0 turns a check off.</p>
      </>
    ),
    links: (
      <label>
        Allowed sites
        <textarea rows={3} value={domains} onChange={(e) => (setDomains(e.target.value), setStatus(null))} placeholder={"youtube.com\nlootden.example.net"} />
        <span className="muted small">Subdomains count too: youtube.com also allows m.youtube.com.</span>
      </label>
    ),
    newAccounts: (
      <>
        <p className="automod-line">
          Accounts younger than{" "}
          <NumberField label="Account age in hours" value={settings.newAccounts.minAccountAgeHours} min={0} max={24 * 365} onChange={(n) => set("newAccounts", { minAccountAgeHours: n })} />{" "}
          hours
        </p>
        <p className="automod-line">
          People who joined less than{" "}
          <NumberField label="Minutes since joining" value={settings.newAccounts.minMemberMinutes} min={0} max={60 * 24 * 30} onChange={(n) => set("newAccounts", { minMemberMinutes: n })} />{" "}
          minutes ago
        </p>
        <p className="muted small">0 turns a check off.</p>
      </>
    ),
  };

  return (
    <div className="server-settings automod">
      <p className="muted small">
        Automod checks messages in this server's channels before they're posted. It never sees DMs or group chats: those are end-to-end encrypted. Everything it catches goes
        in the Mod log.
      </p>
      {RULES.map((k) => {
        const rule: AutomodRuleBase = settings[k];
        const info = RULE_INFO[k];
        return (
          <section key={k} className={`automod-rule ${rule.enabled ? "on" : ""}`} aria-label={info.title}>
            <label className="toggle automod-head">
              <input type="checkbox" checked={rule.enabled} onChange={(e) => set(k, { enabled: e.target.checked } as Partial<AutomodSettings[typeof k]>)} />
              <span>
                <strong>
                  <span aria-hidden>{info.icon}</span> {info.title}
                </strong>
                <span className="muted small">{info.about}</span>
              </span>
            </label>
            {rule.enabled && (
              <div className="automod-body">
                {fields[k]}
                <div className="automod-sub">When it's caught</div>
                <div className="chips">
                  {(["block", "alert", "timeout"] as const).map((a) => (
                    <button key={a} className={`chip ${rule.actions.includes(a) ? "on" : ""}`} aria-pressed={rule.actions.includes(a)} onClick={() => set(k, { actions: toggleIn(rule.actions, a) } as never)}>
                      {ACTION_LABEL[a]}
                    </button>
                  ))}
                </div>
                {rule.actions.includes("timeout") && (
                  <p className="automod-line">
                    Timeout for <NumberField label="Timeout minutes" value={rule.timeoutMinutes} min={1} max={7 * 24 * 60} onChange={(n) => set(k, { timeoutMinutes: n } as never)} /> minutes
                  </p>
                )}
                {rule.actions.length === 0 && <p className="muted small">With nothing picked, it's only written to the Mod log.</p>}
                <div className="automod-sub">Leave these alone</div>
                <div className="chips">
                  {(["owner", "admin", "member"] as const).map((r) => (
                    <button key={r} className={`chip ${rule.exemptRoles.includes(r) ? "on" : ""}`} aria-pressed={rule.exemptRoles.includes(r)} onClick={() => set(k, { exemptRoles: toggleIn(rule.exemptRoles, r) } as never)}>
                      {ROLE_LABEL[r]}
                    </button>
                  ))}
                  {server.roles.map((r) => (
                    <button
                      key={`role-${r.id}`}
                      className={`chip ${rule.exemptRoleIds.includes(r.id) ? "on" : ""}`}
                      aria-pressed={rule.exemptRoleIds.includes(r.id)}
                      onClick={() => set(k, { exemptRoleIds: toggleIn(rule.exemptRoleIds, r.id) } as never)}
                    >
                      <RoleChip role={r} plain />
                    </button>
                  ))}
                  {textChannels.map((c) => (
                    <button
                      key={c.id}
                      className={`chip ${rule.exemptChannelIds.includes(c.id) ? "on" : ""}`}
                      aria-pressed={rule.exemptChannelIds.includes(c.id)}
                      onClick={() => set(k, { exemptChannelIds: toggleIn(rule.exemptChannelIds, c.id) } as never)}
                    >
                      {c.kind === "voice" ? "🔊" : "#"}
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}
      <button className="primary wide" onClick={() => void save()} disabled={saving}>
        {saving ? "Saving…" : "Save automod"}
      </button>
      {status && <p className="small">{status}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** What automod caught, and who is timed out right now. */
export function ModLogTab({ server }: { server: ChatServer }) {
  const [events, setEvents] = useState<AutomodEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const [timeouts, setTimeouts] = useState<ServerTimeout[]>([]);
  const [error, setError] = useState<string | null>(null);
  const channelName = new Map(server.channels.map((c) => [c.id, c.name]));
  const nick = new Map(server.members.map((m) => [m.user.id, m.nickname ?? m.user.displayName]));

  const loadTimeouts = () => void api<ServerTimeout[]>(`/api/servers/${server.id}/timeouts`).then(setTimeouts, (e: Error) => setError(e.message));
  useEffect(() => {
    loadTimeouts();
    void api<AutomodEvent[]>(`/api/servers/${server.id}/automod/events`).then((list) => {
      setEvents(list);
      setMore(list.length === 50);
    }, (e: Error) => setError(e.message));
  }, [server.id]);

  const older = async () => {
    const last = events?.at(-1);
    if (!last) return;
    const list = await api<AutomodEvent[]>(`/api/servers/${server.id}/automod/events?before=${last.id}`);
    setEvents([...(events ?? []), ...list]);
    setMore(list.length === 50);
  };

  return (
    <div className="server-settings">
      {error && <p className="error">{error}</p>}
      <div className="section-label">Timed out now</div>
      {timeouts.length === 0 && <p className="muted small">Nobody is timed out.</p>}
      {timeouts.map((t) => (
        <div key={t.user.id} className="member-row">
          <span className="nav-text">
            <span className="ellipsis">{nick.get(t.user.id) ?? t.user.displayName}</span>
            <span className="muted small">
              until {when(t.until)} · {t.by ? `by ${t.by.displayName}` : "by automod"}
              {t.reason ? ` · ${t.reason}` : ""}
            </span>
          </span>
          <button className="ghost small" onClick={() => void api(`/api/servers/${server.id}/timeouts/${t.user.id}`, { method: "DELETE" }).then(loadTimeouts)}>
            End timeout
          </button>
        </div>
      ))}
      <div className="section-label">Caught by automod</div>
      {events?.length === 0 && <p className="muted small">Nothing yet. Turn rules on in the Automod tab.</p>}
      {events?.map((e) => (
        <div key={e.id} className="automod-event">
          <div className="automod-event-head">
            <strong className="ellipsis">{e.user ? (nick.get(e.user.id) ?? e.user.displayName) : "Someone who left"}</strong>
            <span className="muted small">
              {e.channelId && channelName.has(e.channelId) ? `#${channelName.get(e.channelId)} · ` : ""}
              {when(e.createdAt)}
            </span>
          </div>
          <div className="small">
            <span className="role-tag">{ruleTitle(e.rule)}</span> {e.reason}
          </div>
          {e.excerpt && <blockquote className="automod-excerpt">{e.excerpt}</blockquote>}
          <div className="muted small">{e.actions.length ? e.actions.map((a) => ({ block: "Blocked", alert: "Alerted", timeout: "Timed out" })[a]).join(" · ") : "Logged only"}</div>
        </div>
      ))}
      {more && (
        <button className="ghost wide" onClick={() => void older()}>
          Load older
        </button>
      )}
    </div>
  );
}
