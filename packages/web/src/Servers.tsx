import { useEffect, useState } from "react";
import {
  LIMITS,
  type Channel,
  type ChannelKind,
  type ChatServer,
  type ChatServerSummary,
  type Friend,
  type InvitePreview,
  type Me,
  type ServerCreatorRequest,
  type ServerInvite,
  type ServerTimeout,
  type VoiceChannelState,
} from "@dendrop/shared";
import { api, ApiError } from "./api.ts";
import { AutomodTab, ModLogTab } from "./Automod.tsx";
import { Avatar } from "./Avatar.tsx";
import { Modal } from "./Modal.tsx";
import { WebhooksTab } from "./Webhooks.tsx";
import { BotsTab } from "./Bots.tsx";
import { ActivityLine } from "./activity.tsx";
import { useColors } from "./colors.ts";
import { MemberRoles, RoleChip, RolesTab } from "./Roles.tsx";
import { byRank, can, memberColors, outranks, rolesOf } from "./roles.ts";
import { EmojiTab, StickersTab } from "./ServerExpressions.tsx";
import "./servers.css";

/** A server's picture, or its initials on a rounded square. */
export function ServerIcon({ server, size = 48 }: { server: Pick<ChatServerSummary, "name" | "iconUrl">; size?: number }) {
  const initials =
    server.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => [...w][0])
      .join("")
      .toUpperCase() || "?";
  return server.iconUrl ? (
    <img className="server-icon" src={server.iconUrl} alt="" width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <span className="server-icon" style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {initials}
    </span>
  );
}

export const isMod = (s: ChatServer) => s.myRole === "owner" || s.myRole === "admin";
export const canInvite = (s: ChatServer) => can(s, "createInvites") || s.memberInvites;
export const inviteUrl = (code: string) => `${location.origin}/invite/${code}`;

/** Reads an invite code from a pasted link or a bare code. */
export const inviteCode = (text: string): string | null => {
  const m = /(?:\/invite\/)?([A-Za-z0-9_-]{8,32})\/?$/.exec(text.trim());
  return m ? m[1]! : null;
};

/** The channel list for a server, with its banner and menu. */
export function ServerSidebar({
  server,
  activeChannel,
  unread,
  voice,
  speaking,
  inVoice,
  onOpen,
  onSettings,
  onInvite,
  onChannel,
  automodAlerts = 0,
  onModLog,
}: {
  server: ChatServer;
  activeChannel: number | null;
  unread: Set<number>;
  /** Who is in each voice channel, by channel id. */
  voice: Record<number, VoiceChannelState>;
  /** Who is talking in the voice channel you're in. */
  speaking: Set<number>;
  /** The voice channel you're in. */
  inVoice: number | null;
  onOpen: (c: Channel) => void;
  onSettings: () => void;
  onInvite: () => void;
  /** Make a channel (null, of this kind) or edit one. */
  onChannel: (c: Channel | null, kind?: ChannelKind) => void;
  /** Automod alerts the owner or an admin hasn't looked at yet. */
  automodAlerts?: number;
  onModLog?: () => void;
}) {
  const colorsOf = useColors();
  const mod = can(server, "manageChannels");
  return (
    <>
      <header className={`server-header ${server.bannerUrl ? "with-banner" : ""}`}>
        {server.bannerUrl && <img className="server-banner" src={server.bannerUrl} alt="" />}
        <div className="server-title">
          <strong className="ellipsis">{server.name}</strong>
          <button className="ghost" onClick={onSettings} title="Server settings" aria-label="Server settings">
            ⚙
          </button>
        </div>
      </header>
      <div className="sidebar-body">
        {can(server, "manageAutomod") && automodAlerts > 0 && onModLog && (
          <button className="nav-item automod-alerts" onClick={onModLog}>
            <span className="nav-icon" aria-hidden>
              🛡
            </span>
            Automod alerts
            <span className="badge">{automodAlerts}</span>
          </button>
        )}
        {canInvite(server) && (
          <button className="nav-item invite-people" onClick={onInvite}>
            <span className="nav-icon" aria-hidden>
              ✉
            </span>
            Invite people
          </button>
        )}
        {(["text", "voice"] as const).map((kind) => {
          // Forums sit with the text channels.
          const list = server.channels.filter((c) => c.kind === kind || (kind === "text" && c.kind === "forum"));
          if (kind === "voice" && list.length === 0 && !mod) return null;
          return (
            <div key={kind}>
              <div className="section-label with-action">
                {kind === "text" ? "Text channels" : "Voice channels"}
                {mod && (
                  <button
                    className="ghost"
                    onClick={() => onChannel(null, kind)}
                    title={kind === "text" ? "New text channel" : "New voice channel"}
                    aria-label={kind === "text" ? "New text channel" : "New voice channel"}
                  >
                    ＋
                  </button>
                )}
              </div>
              {list.length === 0 && <p className="muted small">{kind === "text" ? "No text channels yet." : "No voice channels yet."}</p>}
              {list.map((c) => (
                <div key={c.id}>
                  <div className="channel-row">
                    <button
                      className={`nav-item channel ${activeChannel === c.id ? "active" : ""} ${unread.has(c.conversationId) ? "unread" : ""} ${inVoice === c.id ? "in-voice" : ""}`}
                      onClick={() => onOpen(c)}
                      title={c.kind === "voice" ? (inVoice === c.id ? `You're in ${c.name}` : `Join ${c.name}`) : undefined}
                    >
                      <span className="channel-mark" aria-hidden>
                        {c.kind === "voice" ? "🔊" : c.locked ? "🔒" : c.kind === "forum" ? "💬" : "#"}
                      </span>
                      <span className="ellipsis">{c.name}</span>
                      {c.kind !== "text" && c.locked && (
                        <span className="channel-lock" aria-label="Locked">
                          🔒
                        </span>
                      )}
                      {unread.has(c.conversationId) && <span className="dot" aria-label="Unread" />}
                    </button>
                    {mod && (
                      <button className="ghost channel-edit" onClick={() => onChannel(c)} title={`Edit ${c.name}`} aria-label={`Edit ${c.name}`}>
                        ✎
                      </button>
                    )}
                  </div>
                  {c.kind === "voice" && voice[c.id] && (
                    <ul className="voice-members" aria-label={`In ${c.name}`}>
                      {voice[c.id]!.members.map((v) => {
                        const m = server.members.find((x) => x.user.id === v.userId);
                        const name = m ? (m.nickname ?? m.user.displayName) : "Someone";
                        const talking = inVoice === c.id && speaking.has(v.userId);
                        return (
                          <li key={v.userId} className={`voice-member ${talking ? "speaking" : ""}`}>
                            <Avatar name={name} size={22} />
                            <span className="ellipsis" style={colorsOf(memberColors(m)).name}>
                              {name}
                            </span>
                            <span className="voice-icons" aria-label={[v.screen && "sharing screen", v.video && "camera on", v.deafened ? "deafened" : v.muted && "muted"].filter(Boolean).join(", ")}>
                              {v.screen && "🖥️"}
                              {v.video && "📷"}
                              {v.deafened ? "🙉" : v.muted ? "🔇" : ""}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          );
        })}
        <div className="section-label">Members · {server.memberCount}</div>
        {byRank(server).map((m) => {
          const top = rolesOf(server, m)[0];
          return (
            <div key={m.user.id} className="server-member">
              <span className="server-member-name">
                <span className="ellipsis" style={colorsOf(memberColors(m)).name}>
                  {m.nickname ?? m.user.displayName}
                </span>
                <ActivityLine userId={m.user.id} />
              </span>
              {m.role !== "member" ? <span className={`role-tag ${m.role}`}>{m.role}</span> : top && <RoleChip role={top} />}
              {m.user.isBot && <span className="bot-tag">bot</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Find public servers, answer invites, join by link, or make a server. */
export function Directory({
  me,
  mine,
  invites,
  onJoined,
  onDeclined,
  onCreate,
  onAdmin,
  onBack,
}: {
  me: Me;
  mine: ChatServer[];
  invites: InvitePreview[];
  onJoined: (s: ChatServer) => void;
  onDeclined: (code: string) => void;
  onCreate: () => void;
  onAdmin: () => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ChatServerSummary[] | null>(null);
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const joined = new Set(mine.map((s) => s.id));

  useEffect(() => {
    const t = setTimeout(() => {
      api<ChatServerSummary[]>(`/api/servers/directory?q=${encodeURIComponent(q)}`)
        .then(setResults)
        .catch((err: Error) => setError(err.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const join = async (id: number) => {
    setError(null);
    try {
      onJoined(await api<ChatServer>(`/api/servers/${id}/join`, { body: {} }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const lookUp = async () => {
    setError(null);
    const code = inviteCode(link);
    if (!code) return setError("That doesn't look like an invite link");
    try {
      setPreview(await api<InvitePreview>(`/api/invites/${code}`));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="pane">
      <header className="pane-header">
        <button className="ghost back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <h2>Find a server</h2>
        <span className="header-actions">
          {me.isSuperAdmin && (
            <button className="small-button" onClick={onAdmin}>
              Instance admin
            </button>
          )}
          <button className="primary small-button" onClick={onCreate}>
            Create a server
          </button>
        </span>
      </header>
      <div className="pane-body directory">
        {error && <p className="error">{error}</p>}

        {invites.length > 0 && (
          <>
            <div className="section-label">Invites for you</div>
            {invites.map((i) => (
              <InviteCard key={i.code} invite={i} onJoined={onJoined} onDeclined={() => onDeclined(i.code)} />
            ))}
          </>
        )}

        <div className="section-label">Have an invite link?</div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void lookUp();
          }}
        >
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder={`${location.origin}/invite/…`} aria-label="Invite link" />
          <button type="submit" disabled={!link.trim()}>
            Open
          </button>
        </form>
        {preview && <InviteCard invite={preview} onJoined={onJoined} />}

        <div className="section-label">Public servers</div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or description" aria-label="Search servers" />
        <p className="muted small">Private servers are never listed here. You need an invite to join one.</p>
        {results?.length === 0 && <p className="muted">{q ? "No public servers match." : "No public servers yet."}</p>}
        <div className="server-cards">
          {results?.map((s) => (
            <div key={s.id} className="server-card">
              {s.bannerUrl ? <img className="server-card-banner" src={s.bannerUrl} alt="" /> : <div className="server-card-banner blank" />}
              <div className="server-card-body">
                <ServerIcon server={s} size={44} />
                <div className="server-card-text">
                  <strong className="ellipsis">{s.name}</strong>
                  <span className="muted small">
                    {s.memberCount} {s.memberCount === 1 ? "member" : "members"}
                  </span>
                </div>
              </div>
              {s.description && <p className="small server-card-desc">{s.description}</p>}
              {joined.has(s.id) ? (
                <button onClick={() => onJoined(mine.find((m) => m.id === s.id)!)}>Open</button>
              ) : (
                <button className="primary" onClick={() => void join(s.id)}>
                  Join
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** An invite to look at before joining. */
export function InviteCard({ invite, onJoined, onDeclined }: { invite: InvitePreview; onJoined: (s: ChatServer) => void; onDeclined?: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const accept = async () => {
    try {
      onJoined(await api<ChatServer>(`/api/invites/${invite.code}/accept`, { body: {} }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const decline = async () => {
    await api(`/api/invites/${invite.code}`, { method: "DELETE" }).catch(() => {});
    onDeclined?.();
  };
  return (
    <div className="invite-card">
      <ServerIcon server={invite.server} size={44} />
      <div className="server-card-text">
        <strong className="ellipsis">{invite.server.name}</strong>
        <span className="muted small">
          {invite.invitedBy ? `${invite.invitedBy.displayName} invited you · ` : ""}
          {invite.server.memberCount} {invite.server.memberCount === 1 ? "member" : "members"}
        </span>
        {error && <span className="error small">{error}</span>}
      </div>
      <span className="invite-actions">
        {onDeclined && (
          <button className="ghost" onClick={() => void decline()}>
            Decline
          </button>
        )}
        <button className="primary" onClick={() => void accept()}>
          {invite.joined ? "Open" : "Join"}
        </button>
      </span>
    </div>
  );
}

/** Opens an invite link (…/invite/CODE) the app was started with. */
export function InviteLinkDialog({ code, onClose, onJoined }: { code: string; onClose: () => void; onJoined: (s: ChatServer) => void }) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<InvitePreview>(`/api/invites/${code}`)
      .then(setPreview)
      .catch((err: Error) => setError(err.message));
  }, [code]);
  return (
    <Modal title="You've been invited" onClose={onClose}>
      {error && <p className="error">{error}</p>}
      {!preview && !error && <p className="muted">Looking up the invite…</p>}
      {preview && (
        <>
          {preview.server.description && <p>{preview.server.description}</p>}
          <InviteCard invite={preview} onJoined={onJoined} />
        </>
      )}
    </Modal>
  );
}

/** Makes a server, or asks a super admin for permission first. */
export function CreateServer({ me, onClose, onCreated }: { me: Me; onClose: () => void; onCreated: (s: ChatServer) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [reason, setReason] = useState("");
  const [request, setRequest] = useState<ServerCreatorRequest | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me.canCreateServers) void api<ServerCreatorRequest | null>("/api/server-requests/me").then(setRequest);
  }, [me.canCreateServers]);

  const create = async () => {
    setError(null);
    try {
      onCreated(await api<ChatServer>("/api/servers", { body: { name, description, isPublic } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const ask = async () => {
    setError(null);
    try {
      setRequest(await api<ServerCreatorRequest>("/api/server-requests", { body: { reason } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!me.canCreateServers) {
    return (
      <Modal title="Create a server" onClose={onClose}>
        <p className="muted">On this Dendrop, a super admin approves who can make servers.</p>
        {request?.status === "pending" && <p>Your request is waiting for a super admin. You'll be able to make servers as soon as they approve it.</p>}
        {request?.status === "denied" && <p className="warning">Your last request wasn't approved. You can ask again.</p>}
        {request !== undefined && request?.status !== "pending" && (
          <>
            <label>
              What's it for? (optional)
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="A server for our game nights" />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="primary wide" onClick={() => void ask()}>
              Ask for permission
            </button>
          </>
        )}
      </Modal>
    );
  }

  return (
    <Modal title="Create a server" onClose={onClose}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.serverName} placeholder="The den" autoFocus />
      </label>
      <label>
        Description (optional)
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={LIMITS.serverDescription} />
      </label>
      <label className="toggle">
        <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
        <span>
          <strong>Public</strong>
          <span className="muted small">Listed in Find a server, and anyone on this Dendrop can join. Off means invite only, and hidden from everyone else.</span>
        </span>
      </label>
      {error && <p className="error">{error}</p>}
      <button className="primary wide" disabled={!name.trim()} onClick={() => void create()}>
        Create server
      </button>
    </Modal>
  );
}

const EXPIRY = [
  { label: "1 hour", hours: 1 },
  { label: "1 day", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
  { label: "Never", hours: null },
];

/** Makes an invite link, or invites friends directly. */
export function InviteDialog({ server, friends, onClose }: { server: ChatServer; friends: Friend[]; onClose: () => void }) {
  const [expiry, setExpiry] = useState(2);
  const [maxUses, setMaxUses] = useState("");
  const [invite, setInvite] = useState<ServerInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const inServer = new Set(server.members.map((m) => m.user.id));
  const invitable = friends.filter((f) => f.state === "friends" && !inServer.has(f.user.id));

  const make = async () => {
    setError(null);
    setCopied(false);
    try {
      setInvite(
        await api<ServerInvite>(`/api/servers/${server.id}/invites`, {
          body: { expiresInHours: EXPIRY[expiry]!.hours, maxUses: maxUses ? Number(maxUses) : null },
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copy = async () => {
    if (!invite) return;
    await navigator.clipboard?.writeText(inviteUrl(invite.code)).catch(() => {});
    setCopied(true);
  };

  const inviteFriend = async (userId: number) => {
    setError(null);
    try {
      await api(`/api/servers/${server.id}/invites/friend`, { body: { userId } });
      setSent((s) => new Set(s).add(userId));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={`Invite people to ${server.name}`} onClose={onClose}>
      {error && <p className="error">{error}</p>}
      <div className="section-label">Friends</div>
      <div className="pick-list">
        {invitable.length === 0 && <p className="muted small">All your friends are here already, or you haven't added any yet.</p>}
        {invitable.map((f) => (
          <div key={f.user.id} className="pick">
            <span className="ellipsis">{f.user.displayName}</span>
            <span className="muted small">@{f.user.username}</span>
            <button className="small-button invite-friend" disabled={sent.has(f.user.id)} onClick={() => void inviteFriend(f.user.id)}>
              {sent.has(f.user.id) ? "Invited" : "Invite"}
            </button>
          </div>
        ))}
      </div>
      <div className="section-label">Invite link</div>
      <div className="row">
        <label className="inline-label">
          Expires
          <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
            {EXPIRY.map((x, i) => (
              <option key={x.label} value={i}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-label">
          Max uses
          <input type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="No limit" />
        </label>
      </div>
      {invite ? (
        <div className="row">
          <input readOnly value={inviteUrl(invite.code)} onFocus={(e) => e.target.select()} aria-label="Invite link" />
          <button className="primary" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
      <button className="wide" onClick={() => void make()}>
        {invite ? "Make another link" : "Make a link"}
      </button>
      <p className="muted small">Anyone with the link can join while it lasts. {server.isPublic ? "" : "It's the only way into a private server."}</p>
    </Modal>
  );
}

/** Makes or edits a channel, including who can see a locked one. */
export function ChannelDialog({
  server,
  channel,
  kind: initialKind = "text",
  onClose,
  onDone,
}: {
  server: ChatServer;
  channel: Channel | null;
  /** For a new channel, the kind to start with. */
  kind?: ChannelKind;
  onClose: () => void;
  onDone: (opened: Channel | null) => void;
}) {
  const [name, setName] = useState(channel?.name ?? "");
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? initialKind);
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [locked, setLocked] = useState(channel?.locked ?? false);
  const [picked, setPicked] = useState<Set<number>>(new Set(channel?.memberIds ?? []));
  const [pickedRoles, setPickedRoles] = useState<Set<number>>(new Set(channel?.roleIds ?? []));
  /** A forum's tags, as typed: comma separated. */
  const [tags, setTags] = useState((channel?.tags ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  // Owners and admins always see locked channels, so only members are picked.
  const pickable = server.members.filter((m) => m.role === "member");

  const save = async () => {
    setError(null);
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const body = { name, topic, locked, memberIds: [...picked], roleIds: [...pickedRoles], ...(kind === "forum" ? { tags: tagList } : {}) };
    try {
      if (channel) {
        await api(`/api/servers/${server.id}/channels/${channel.id}`, { method: "PATCH", body });
        onDone(null);
      } else onDone(await api<Channel>(`/api/servers/${server.id}/channels`, { body: { ...body, kind } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async () => {
    if (!channel || !confirm(`Delete ${channel.kind === "voice" ? "" : "#"}${channel.name} and all its ${channel.kind === "forum" ? "posts" : "messages and threads"}? This can't be undone.`)) return;
    try {
      await api(`/api/servers/${server.id}/channels/${channel.id}`, { method: "DELETE" });
      onDone(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title={channel ? `Edit ${channel.kind === "voice" ? "" : "#"}${channel.name}` : kind === "voice" ? "New voice channel" : kind === "forum" ? "New forum" : "New channel"} onClose={onClose}>
      {!channel && (
        <div className="kind-picker" role="radiogroup" aria-label="Channel type">
          {(["text", "forum", "voice"] as const).map((k) => (
            <label key={k} className={`kind-option ${kind === k ? "picked" : ""}`}>
              <input type="radio" name="channel-kind" checked={kind === k} onChange={() => setKind(k)} />
              <span className="channel-mark" aria-hidden>
                {k === "voice" ? "🔊" : k === "forum" ? "💬" : "#"}
              </span>
              <span>
                <strong>{k === "voice" ? "Voice" : k === "forum" ? "Forum" : "Text"}</strong>
                <span className="muted small">
                  {k === "voice" ? "Drop in to talk, share your camera or screen." : k === "forum" ? "Organized posts, each with a title, tags and its own replies." : "Messages, pictures and files."}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={LIMITS.channelName}
          placeholder={kind === "voice" ? "the-den" : "game-night"}
          autoFocus
        />
      </label>
      <label>
        {kind === "forum" ? "Guidelines (optional)" : "Topic (optional)"}
        <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={LIMITS.channelTopic} />
      </label>
      {kind === "forum" && (
        <label>
          Tags (optional, separated by commas)
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Question, Bug, Idea" />
          <span className="muted small">Posts can carry up to {LIMITS.tagsPerPost} of these, and people can filter by them.</span>
        </label>
      )}
      <label className="toggle">
        <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
        <span>
          <strong>Lock this channel</strong>
          <span className="muted small">Only the roles and people you pick, plus the owner, admins and people who can manage channels, can see it. Everyone else won't know it's there.</span>
        </span>
      </label>
      {locked && server.roles.length > 0 && (
        <>
          <div className="section-label">Roles that can see it · {pickedRoles.size}</div>
          <div className="chips">
            {server.roles.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`chip ${pickedRoles.has(r.id) ? "on" : ""}`}
                aria-pressed={pickedRoles.has(r.id)}
                onClick={() =>
                  setPickedRoles((p) => {
                    const n = new Set(p);
                    if (n.has(r.id)) n.delete(r.id);
                    else n.add(r.id);
                    return n;
                  })
                }
              >
                <RoleChip role={r} plain />
              </button>
            ))}
          </div>
        </>
      )}
      {locked && (
        <>
          <div className="section-label">People who can see it · {picked.size}</div>
          <div className="pick-list">
            {pickable.length === 0 && <p className="muted small">Everyone here is an owner or admin, so they can all see it.</p>}
            {pickable.map((m) => (
              <label key={m.user.id} className="pick">
                <input
                  type="checkbox"
                  checked={picked.has(m.user.id)}
                  onChange={() =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (n.has(m.user.id)) n.delete(m.user.id);
                      else n.add(m.user.id);
                      return n;
                    })
                  }
                />
                <span className="ellipsis">{m.nickname ?? m.user.displayName}</span>
                <span className="muted small">@{m.user.username}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary wide" disabled={!name.trim()} onClick={() => void save()}>
        {channel ? "Save" : "Create channel"}
      </button>
      {channel && (
        <button className="danger-button wide spaced" onClick={() => void remove()}>
          Delete channel
        </button>
      )}
    </Modal>
  );
}

export type SettingsTab = "profile" | "members" | "roles" | "emoji" | "stickers" | "invites" | "bans" | "automod" | "modlog" | "webhooks" | "bots";

/** Server settings: profile and pictures, members and roles, invites, bans, automod, and leaving. */
export function ServerSettings({
  me,
  server,
  initialTab,
  onClose,
  onGone,
}: {
  me: Me;
  server: ChatServer;
  initialTab?: SettingsTab;
  onClose: () => void;
  onGone: () => void;
}) {
  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "profile", label: "Profile" },
    { id: "members", label: "Members" },
    ...(can(server, "manageRoles") || server.roles.length ? [{ id: "roles" as const, label: "Roles" }] : []),
    ...(can(server, "manageExpressions") || server.emojis.length ? [{ id: "emoji" as const, label: "Emoji" }] : []),
    ...(can(server, "manageExpressions") || server.stickers.length ? [{ id: "stickers" as const, label: "Stickers" }] : []),
    ...(canInvite(server) ? [{ id: "invites" as const, label: "Invites" }] : []),
    ...(can(server, "kickMembers") ? [{ id: "bans" as const, label: "Bans" }] : []),
    ...(can(server, "manageAutomod")
      ? [
          { id: "automod" as const, label: "Automod" },
          { id: "modlog" as const, label: "Mod log" },
        ]
      : []),
    ...(isMod(server) ? [{ id: "webhooks" as const, label: "Webhooks" }, { id: "bots" as const, label: "Bots" }] : []),
  ];
  const [tab, setTab] = useState<SettingsTab>(initialTab && tabs.some((t) => t.id === initialTab) ? initialTab : "profile");
  return (
    <Modal title={server.name} onClose={onClose} wide>
      <div className="chips server-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`chip ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "profile" && <ProfileTab me={me} server={server} onGone={onGone} />}
      {tab === "members" && <MembersTab me={me} server={server} />}
      {tab === "roles" && <RolesTab me={me} server={server} />}
      {tab === "emoji" && <EmojiTab server={server} />}
      {tab === "stickers" && <StickersTab server={server} />}
      {tab === "invites" && <InvitesTab server={server} />}
      {tab === "bans" && <BansTab server={server} />}
      {tab === "automod" && <AutomodTab server={server} />}
      {tab === "modlog" && <ModLogTab server={server} />}
      {tab === "webhooks" && <WebhooksTab server={server} />}
      {tab === "bots" && <BotsTab server={server} />}
    </Modal>
  );
}

function ProfileTab({ me, server, onGone }: { me: Me; server: ChatServer; onGone: () => void }) {
  const mod = can(server, "manageServer");
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description);
  const [isPublic, setIsPublic] = useState(server.isPublic);
  const [memberInvites, setMemberInvites] = useState(server.memberInvites);
  const [playTogether, setPlayTogether] = useState(server.playTogether);
  const [nickname, setNickname] = useState(server.nickname ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, done = "Saved") => {
    setError(null);
    setStatus(null);
    try {
      await fn();
      setStatus(done);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const upload = (kind: "icon" | "banner", file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file, file.name);
    void run(async () => {
      const res = await fetch(`/api/servers/${server.id}/${kind}`, { method: "PUT", credentials: "same-origin", body: form });
      if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? res.statusText);
    }, "Picture updated");
  };

  const leave = () => {
    if (!confirm(`Leave ${server.name}?`)) return;
    void run(async () => {
      await api(`/api/servers/${server.id}/leave`, { body: {} });
      onGone();
    });
  };

  const remove = () => {
    if (prompt(`This deletes ${server.name}, every channel and every message, for everyone. Type the server's name to confirm.`) !== server.name) return;
    void run(async () => {
      await api(`/api/servers/${server.id}`, { method: "DELETE" });
      onGone();
    });
  };

  return (
    <div className="server-settings">
      {mod && (
        <>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.serverName} />
          </label>
          <label>
            Description
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={LIMITS.serverDescription} />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            <span>
              <strong>Public</strong>
              <span className="muted small">Listed in Find a server, and anyone on this Dendrop can join.</span>
            </span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={memberInvites} onChange={(e) => setMemberInvites(e.target.checked)} />
            <span>
              <strong>Members can invite people</strong>
              <span className="muted small">Off means only the owner and admins can make invites.</span>
            </span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={playTogether} onChange={(e) => setPlayTogether(e.target.checked)} />
            <span>
              <strong>Voice channels for playing together</strong>
              <span className="muted small">
                When two or more members are playing the same game (from LootDen), a voice channel opens for it and goes away once they stop.
              </span>
            </span>
          </label>
          <button
            className="primary wide"
            onClick={() => void run(() => api(`/api/servers/${server.id}`, { method: "PATCH", body: { name, description, isPublic, memberInvites, playTogether } }))}
          >
            Save server profile
          </button>
          <div className="section-label">Pictures</div>
          <div className="picture-row">
            <ServerIcon server={server} size={56} />
            <label className="button">
              Icon
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => upload("icon", e.target.files?.[0])} />
            </label>
            {server.iconUrl && (
              <button className="ghost" onClick={() => void run(() => api(`/api/servers/${server.id}/icon`, { method: "DELETE" }), "Picture removed")}>
                Remove
              </button>
            )}
          </div>
          <div className="picture-row">
            {server.bannerUrl ? <img className="banner-preview" src={server.bannerUrl} alt="Banner" /> : <span className="banner-preview blank" />}
            <label className="button">
              Banner
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => upload("banner", e.target.files?.[0])} />
            </label>
            {server.bannerUrl && (
              <button className="ghost" onClick={() => void run(() => api(`/api/servers/${server.id}/banner`, { method: "DELETE" }), "Picture removed")}>
                Remove
              </button>
            )}
          </div>
        </>
      )}
      {!mod && server.description && <p>{server.description}</p>}

      <div className="section-label">Your nickname here</div>
      <div className="row">
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={LIMITS.displayNameLength} placeholder={me.displayName} />
        <button onClick={() => void run(() => api(`/api/servers/${server.id}/me`, { method: "PATCH", body: { nickname: nickname.trim() || null } }))}>
          Save
        </button>
      </div>

      {status && <p className="small">{status}</p>}
      {error && <p className="error">{error}</p>}

      <div className="section-label">Leave</div>
      {server.myRole === "owner" ? (
        <>
          <p className="muted small">You own this server. Make someone else the owner in Members to leave it, or delete it.</p>
          <button className="danger-button wide" onClick={remove}>
            Delete server
          </button>
        </>
      ) : (
        <button className="danger-button wide" onClick={leave}>
          Leave server
        </button>
      )}
    </div>
  );
}

const TIMEOUTS: [number, string][] = [
  [5, "5 minutes"],
  [60, "1 hour"],
  [24 * 60, "1 day"],
  [7 * 24 * 60, "1 week"],
];

function MembersTab({ me, server }: { me: Me; server: ChatServer }) {
  const [error, setError] = useState<string | null>(null);
  const owner = server.myRole === "owner";
  const mod = can(server, "timeoutMembers") || can(server, "manageAutomod");
  const colorsOf = useColors();
  const [timeouts, setTimeouts] = useState<Map<number, string>>(new Map());
  const loadTimeouts = () =>
    mod
      ? api<ServerTimeout[]>(`/api/servers/${server.id}/timeouts`).then((list) => setTimeouts(new Map(list.map((t) => [t.user.id, t.until]))))
      : Promise.resolve();
  useEffect(() => void loadTimeouts().catch(() => {}), [server.id]);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="server-settings">
      {error && <p className="error">{error}</p>}
      {byRank(server).map((m) => {
        const below = outranks(server, me.id, m);
        const canTimeout = below && can(server, "timeoutMembers");
        const canKick = below && can(server, "kickMembers");
        return (
          <div key={m.user.id} className="member-row">
            <span className="nav-text">
              <span className="ellipsis" style={colorsOf(memberColors(m)).name}>
                {m.nickname ?? m.user.displayName}
                {m.user.id === me.id ? " (you)" : ""}
              </span>
              <span className="muted small">
                @{m.user.username}
                {timeouts.has(m.user.id) && ` · ⏳ timed out until ${new Date(timeouts.get(m.user.id)!).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`}
              </span>
              <ActivityLine userId={m.user.id} />
            </span>
            {m.user.isBot ? (
              <span className="bot-tag">bot</span>
            ) : owner && m.role !== "owner" ? (
              <select
                value={m.role}
                aria-label={`Role for ${m.user.displayName}`}
                onChange={(e) => void run(() => api(`/api/servers/${server.id}/members/${m.user.id}`, { method: "PATCH", body: { role: e.target.value } }))}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            ) : (
              <span className={`role-tag ${m.role}`}>{m.role}</span>
            )}
            {(canTimeout || canKick) && (
              <span className="member-actions">
                {!canTimeout ? null : timeouts.has(m.user.id) ? (
                  <button className="ghost small" onClick={() => void run(() => api(`/api/servers/${server.id}/timeouts/${m.user.id}`, { method: "DELETE" }).then(loadTimeouts))}>
                    End timeout
                  </button>
                ) : (
                  <select
                    className="timeout-select"
                    value=""
                    aria-label={`Time out ${m.user.displayName}`}
                    onChange={(e) => {
                      const minutes = Number(e.target.value);
                      if (minutes) void run(() => api(`/api/servers/${server.id}/timeouts/${m.user.id}`, { method: "PUT", body: { minutes } }).then(loadTimeouts));
                    }}
                  >
                    <option value="">Time out…</option>
                    {TIMEOUTS.map(([n, label]) => (
                      <option key={n} value={n}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                {owner && (
                  <button
                    className="ghost small"
                    onClick={() =>
                      confirm(`Make ${m.user.displayName} the owner? You'll become an admin.`) &&
                      void run(() => api(`/api/servers/${server.id}/transfer`, { body: { userId: m.user.id } }))
                    }
                  >
                    Make owner
                  </button>
                )}
                {canKick && (
                  <>
                    <button
                      className="ghost small"
                      onClick={() => confirm(`Remove ${m.user.displayName}?`) && void run(() => api(`/api/servers/${server.id}/members/${m.user.id}`, { method: "DELETE" }))}
                    >
                      Remove
                    </button>
                    <button
                      className="ghost small danger"
                      onClick={() =>
                        confirm(`Ban ${m.user.displayName}? They'll be removed and can't come back until unbanned.`) &&
                        void run(() => api(`/api/servers/${server.id}/members/${m.user.id}?ban=true`, { method: "DELETE" }))
                      }
                    >
                      Ban
                    </button>
                  </>
                )}
              </span>
            )}
            <MemberRoles me={me} server={server} member={m} onError={setError} />
          </div>
        );
      })}
    </div>
  );
}

function InvitesTab({ server }: { server: ChatServer }) {
  const [invites, setInvites] = useState<ServerInvite[] | null>(null);
  const load = () => void api<ServerInvite[]>(`/api/servers/${server.id}/invites`).then(setInvites);
  useEffect(load, [server.id]);
  const names = new Map(server.members.map((m) => [m.user.id, m.nickname ?? m.user.displayName]));
  return (
    <div className="server-settings">
      <p className="muted small">{can(server, "manageServer") ? "Every invite link for this server." : "Invite links you made."}</p>
      {invites?.length === 0 && <p className="muted">No invite links right now.</p>}
      {invites?.map((i) => (
        <div key={i.code} className="member-row">
          <span className="nav-text">
            <code className="ellipsis">{i.code}</code>
            <span className="muted small">
              by {names.get(i.createdBy) ?? "someone"} · {i.uses}
              {i.maxUses ? `/${i.maxUses}` : ""} used · {i.expiresAt ? `until ${new Date(i.expiresAt).toLocaleString()}` : "never expires"}
            </span>
          </span>
          <button className="ghost small" onClick={() => void navigator.clipboard?.writeText(inviteUrl(i.code))}>
            Copy
          </button>
          <button className="ghost small danger" onClick={() => void api(`/api/invites/${i.code}`, { method: "DELETE" }).then(load)}>
            Revoke
          </button>
        </div>
      ))}
    </div>
  );
}

function BansTab({ server }: { server: ChatServer }) {
  const [bans, setBans] = useState<{ user: { id: number; displayName: string; username: string }; createdAt: string }[] | null>(null);
  const load = () => void api<typeof bans>(`/api/servers/${server.id}/bans`).then(setBans);
  useEffect(load, [server.id]);
  return (
    <div className="server-settings">
      {bans?.length === 0 && <p className="muted">Nobody is banned.</p>}
      {bans?.map((b) => (
        <div key={b.user.id} className="member-row">
          <span className="nav-text">
            <span className="ellipsis">{b.user.displayName}</span>
            <span className="muted small">@{b.user.username}</span>
          </span>
          <button className="ghost small" onClick={() => void api(`/api/servers/${server.id}/bans/${b.user.id}`, { method: "DELETE" }).then(load)}>
            Unban
          </button>
        </div>
      ))}
    </div>
  );
}
