import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  isUnicodeEmoji,
  liveStatus,
  maskBlockedWords,
  PROFILE_LIMITS,
  type ChatServer,
  type CustomStatus,
  type Me,
  type PublicUser,
  type UserProfile,
} from "@dendrop/shared";
import { api, ApiError } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { ActivityLine } from "./activity.tsx";
import { useColors } from "./colors.ts";
import { LevelBadge, LevelBar } from "./Levels.tsx";
import { Modal } from "./Modal.tsx";
import { RoleChip } from "./Roles.tsx";
import { block, ReportDialog, unblock, useBlockedIds } from "./Safety.tsx";
import { memberColors, rolesOf } from "./roles.ts";
import "./profile.css";

// ---- Opening profile cards from anywhere --------------------------------------------------

/** Where a profile card was opened: in a server it also shows the server nickname, roles and rank. */
export interface ProfileTarget {
  userId: number;
  serverId?: number;
}

/** Opens someone's profile card. Filled in by the Shell; a no-op elsewhere. */
export const ProfileContext = createContext<(target: ProfileTarget) => void>(() => {});
export const useOpenProfile = () => useContext(ProfileContext);

/**
 * Makes a name or avatar open its person's profile card. Renders a plain button that looks like
 * what's inside it.
 */
export function ProfileLink({ userId, serverId, children, className = "" }: { userId: number | undefined; serverId?: number; children: ReactNode; className?: string }) {
  const openProfile = useOpenProfile();
  if (userId === undefined) return <>{children}</>;
  return (
    <button
      type="button"
      className={`profile-link ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        openProfile({ userId, serverId });
      }}
    >
      {children}
    </button>
  );
}

/** Re-renders when the soonest of these statuses clears itself. */
function useStatusTick(statuses: (CustomStatus | null | undefined)[]): void {
  const [, setTick] = useState(0);
  const next = Math.min(...statuses.map((s) => (s?.expiresAt ? Date.parse(s.expiresAt) : Infinity)).filter((t) => t > Date.now()));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(next - Date.now() + 250, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [next]);
}

/** "🦝 Digging through the bins": someone's custom status, small, for lists. */
export function StatusLine({ user, filter, className = "muted small ellipsis custom-status" }: { user: Pick<PublicUser, "status">; filter?: readonly string[] | null; className?: string }) {
  useStatusTick([user.status]);
  const s = liveStatus(user.status);
  if (!s) return null;
  const text = filter ? maskBlockedWords(s.text, filter) : s.text;
  return (
    <span className={className} title={text}>
      {s.emoji && <span aria-hidden>{s.emoji} </span>}
      {text}
    </span>
  );
}

// ---- Keeping everyone's copy of a person up to date ---------------------------------------

/** Swaps in a person's new look wherever they appear. Returns the same object when nothing changed. */
export const patchUser = {
  list<T extends PublicUser>(list: T[], u: PublicUser): T[] {
    return list.some((x) => x.id === u.id) ? list.map((x) => (x.id === u.id ? { ...x, ...u } : x)) : list;
  },
  conversations<C extends { members: PublicUser[]; guardians: PublicUser[] }>(cs: C[], u: PublicUser): C[] {
    return cs.map((c) => {
      const members = patchUser.list(c.members, u);
      const guardians = patchUser.list(c.guardians, u);
      return members === c.members && guardians === c.guardians ? c : { ...c, members, guardians };
    });
  },
  servers(list: ChatServer[], u: PublicUser): ChatServer[] {
    return list.map((sv) =>
      sv.members.some((m) => m.user.id === u.id) ? { ...sv, members: sv.members.map((m) => (m.user.id === u.id ? { ...m, user: { ...m.user, ...u } } : m)) } : sv,
    );
  },
};

// ---- The profile card ---------------------------------------------------------------------

const longDate = (iso: string) => new Date(iso).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });

/** A banner: their picture, their color, or the theme's accent. */
function Banner({ banner, color, children }: { banner: string | null; color: string | null; children?: ReactNode }) {
  const style: CSSProperties = banner ? { backgroundImage: `url("${banner}")` } : color ? { background: color } : {};
  return (
    <div className={`profile-banner ${banner ? "picture" : ""}`} style={style}>
      {children}
    </div>
  );
}

/**
 * Someone's profile card: banner, picture, name, pronouns, custom status, what they're playing,
 * their about me, and in a server their nickname, roles and raccoon rank.
 */
export function ProfileCard({
  target,
  me,
  known,
  servers,
  online,
  filter,
  onClose,
  onMessage,
  onEdit,
  onOpenServer,
}: {
  target: ProfileTarget;
  me: Me;
  /** The person as the app already knows them, shown while the full profile loads. */
  known: PublicUser | undefined;
  servers: ChatServer[];
  online: Set<number>;
  /** Kids' word filter: masks the about me and status of others. */
  filter: readonly string[] | null;
  onClose: () => void;
  onMessage: (u: PublicUser) => void;
  onEdit: () => void;
  onOpenServer: (serverId: number) => void;
}) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const blockedIds = useBlockedIds();
  const colorsOf = useColors();
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<UserProfile>(`/api/users/${target.userId}/profile`).then(
      (p) => !cancelled && setProfile(p),
      (err) => !cancelled && setError(err instanceof ApiError && err.status === 404 ? "You can't see this profile." : (err as Error).message),
    );
    return () => {
      cancelled = true;
    };
  }, [target.userId]);

  const isMe = target.userId === me.id;
  // The live copy wins over the fetched one, so a new picture or status shows straight away.
  const user: PublicUser | undefined = isMe ? me : known ? { ...profile?.user, ...known } : profile?.user;
  const server = target.serverId !== undefined ? servers.find((s) => s.id === target.serverId) : undefined;
  const member = server?.members.find((m) => m.user.id === target.userId);
  const roles = server ? rolesOf(server, member) : [];
  const mask = (t: string) => (filter && !isMe ? maskBlockedWords(t, filter) : t);
  useStatusTick([user?.status]);
  const status = liveStatus(user?.status);
  const name = member?.nickname ?? user?.displayName ?? "…";
  const nameStyle = colorsOf(server ? memberColors(member) : user).name;

  return (
    <Modal title={user ? `${user.displayName}'s profile` : "Profile"} onClose={onClose}>
      <div className="profile-card">
        <Banner banner={profile?.banner ?? null} color={profile?.bannerColor ?? null}>
          <span className="profile-avatar">
            <Avatar name={user?.displayName ?? "?"} src={user?.avatar} size={84} online={user && !user.isBot ? online.has(user.id) || isMe : undefined} />
          </span>
        </Banner>
        <div className="profile-body">
          <h3 className="profile-name" style={nameStyle}>
            {name}
            {user?.isBot && <span className="bot-tag">bot</span>}
          </h3>
          <p className="muted small profile-handle">
            {member?.nickname && user && <>{user.displayName} · </>}@{user?.username ?? "…"}
            {profile?.pronouns && <> · {mask(profile.pronouns)}</>}
          </p>
          {status && (
            <p className="profile-status">
              {status.emoji && <span aria-hidden>{status.emoji} </span>}
              {mask(status.text)}
              {status.expiresAt && isMe && <span className="muted small"> · clears {new Date(status.expiresAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>}
            </p>
          )}
          {user && <ActivityLine userId={user.id} className="small activity profile-activity" />}

          {error && <p className="error small">{error}</p>}

          {server && member && (
            <section className="profile-section">
              <h4>In {server.name}</h4>
              {member.xp !== null && (
                <div className="profile-rank">
                  <LevelBadge xp={member.xp} full />
                  <LevelBar xp={member.xp} />
                  <span className="muted small">{member.xp.toLocaleString()} XP</span>
                </div>
              )}
              {(member.role !== "member" || roles.length > 0) && (
                <div className="profile-roles">
                  {member.role !== "member" && <span className={`role-tag ${member.role}`}>{member.role}</span>}
                  {roles.map((r) => (
                    <RoleChip key={r.id} role={r} />
                  ))}
                </div>
              )}
              <p className="muted small">Joined {longDate(member.joinedAt)}</p>
            </section>
          )}

          {profile?.bio && (
            <section className="profile-section">
              <h4>About me</h4>
              <p className="profile-bio">{mask(profile.bio)}</p>
            </section>
          )}

          {profile && (
            <section className="profile-section">
              <h4>{profile.isKid ? "Family account" : "Dendrop member since"}</h4>
              <p className="muted small">
                {profile.isKid ? <>Parents look after this profile. </> : null}
                {profile.isKid ? `Here since ${longDate(profile.createdAt)}` : longDate(profile.createdAt)}
                {profile.friendsSince && <> · Friends since {longDate(profile.friendsSince)}</>}
              </p>
              {profile.mutualServers.length > 0 && (
                <div className="profile-mutual">
                  {profile.mutualServers.map((s) => (
                    <button key={s.id} className="chip" onClick={() => onOpenServer(s.id)} title={`Open ${s.name}`}>
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          <div className="profile-actions">
            {isMe ? (
              <button onClick={onEdit}>Edit profile</button>
            ) : (
              user &&
              !user.isBot && (
                <>
                  {profile?.friendsSince && !blockedIds.has(user.id) && <button onClick={() => onMessage(user)}>Message</button>}
                  {blockedIds.has(user.id) ? (
                    <button className="ghost" onClick={() => void unblock(user.id).catch((err: Error) => setError(err.message))}>
                      Unblock
                    </button>
                  ) : (
                    <button className="ghost" onClick={() => void block(user).catch((err: Error) => setError(err.message))}>
                      Block
                    </button>
                  )}
                  <button className="ghost danger" onClick={() => setReporting(true)}>
                    Report
                  </button>
                </>
              )
            )}
          </div>
          {reporting && user && <ReportDialog target={{ kind: "user", user }} onClose={() => setReporting(false)} />}
        </div>
      </div>
    </Modal>
  );
}

// ---- Editing your profile -----------------------------------------------------------------

const CLEAR_AFTER: { label: string; minutes: number | "today" | null }[] = [
  { label: "Don't clear", minutes: null },
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "Today", minutes: "today" },
  { label: "This week", minutes: 7 * 24 * 60 },
];

const STATUS_EMOJI = ["🦝", "🎮", "😴", "🍕", "📚", "🎉", "🤒", "🏖️", "🎧", "🚗"];

const clearAt = (choice: (typeof CLEAR_AFTER)[number]["minutes"]): string | null => {
  if (choice === null) return null;
  if (choice === "today") {
    const d = new Date();
    d.setHours(23, 59, 59, 0);
    return d.toISOString();
  }
  return new Date(Date.now() + choice * 60_000).toISOString();
};

/** Picture upload: returns your updated account and profile. */
async function uploadPicture(kind: "avatar" | "banner", file: File): Promise<{ me: Me; profile: UserProfile }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/me/${kind}`, { method: "PUT", credentials: "same-origin", body: form });
  const data = (await res.json().catch(() => null)) as { error?: string } | { me: Me; profile: UserProfile } | null;
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? res.statusText);
  return data as { me: Me; profile: UserProfile };
}

/**
 * Your profile: picture, banner, about me, pronouns and custom status, with a preview. Kids
 * see what their parents allow; their text goes through the family filter on the server.
 */
export function ProfileEditor({ me, onSaved, picturesAllowed = true }: { me: Me; onSaved: (me: Me) => void; picturesAllowed?: boolean }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [bio, setBio] = useState("");
  const [pronouns, setPronouns] = useState("");
  const [bannerColor, setBannerColor] = useState<string | null>(null);
  const [statusEmoji, setStatusEmoji] = useState("");
  const [statusText, setStatusText] = useState("");
  const [clearChoice, setClearChoice] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const bannerInput = useRef<HTMLInputElement>(null);
  const colorsOf = useColors();

  useEffect(() => {
    void api<UserProfile>(`/api/users/${me.id}/profile`).then((p) => {
      setProfile(p);
      setBio(p.bio);
      setPronouns(p.pronouns);
      setBannerColor(p.bannerColor);
      const s = liveStatus(p.user.status);
      setStatusEmoji(s?.emoji ?? "");
      setStatusText(s?.text ?? "");
    });
  }, [me.id]);

  const status = liveStatus(me.status);
  const dirty =
    !!profile &&
    (bio !== profile.bio ||
      pronouns !== profile.pronouns ||
      bannerColor !== profile.bannerColor ||
      statusEmoji !== (status?.emoji ?? "") ||
      statusText !== (status?.text ?? "") ||
      clearChoice !== 0);

  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const emoji = statusEmoji.trim();
      if (emoji && !isUnicodeEmoji(emoji)) throw new Error("The status emoji has to be one emoji");
      const nextStatus = statusText.trim() || emoji ? { emoji: emoji || null, text: statusText.trim(), expiresAt: clearAt(CLEAR_AFTER[clearChoice]!.minutes) } : null;
      const statusChanged = statusEmoji !== (status?.emoji ?? "") || statusText !== (status?.text ?? "") || clearChoice !== 0;
      const p = await api<UserProfile>("/api/me/profile", {
        method: "PATCH",
        body: { bio, pronouns, bannerColor, ...(statusChanged ? { status: nextStatus } : {}) },
      });
      setProfile(p);
      setBio(p.bio);
      setPronouns(p.pronouns);
      setClearChoice(0);
      onSaved({ ...me, status: p.user.status });
      setNote({ ok: true, text: "Saved." });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const picture = async (kind: "avatar" | "banner", file: File | null) => {
    setNote(null);
    try {
      const r = file
        ? await uploadPicture(kind, file)
        : await api<{ me: Me; profile: UserProfile }>(`/api/me/${kind}`, { method: "DELETE" });
      setProfile(r.profile);
      onSaved({ ...me, avatar: r.me.avatar });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };

  const previewStatus = statusText.trim() || statusEmoji.trim() ? { emoji: statusEmoji.trim() || null, text: statusText.trim() } : null;

  return (
    <div className="profile-editor">
      <div className="profile-card preview" aria-label="Preview">
        <Banner banner={profile?.banner ?? null} color={bannerColor}>
          <span className="profile-avatar">
            <Avatar name={me.displayName} src={me.avatar} size={72} online />
          </span>
        </Banner>
        <div className="profile-body">
          <h3 className="profile-name" style={colorsOf(me).name}>
            {me.displayName}
          </h3>
          <p className="muted small profile-handle">
            @{me.username}
            {pronouns.trim() && <> · {pronouns.trim()}</>}
          </p>
          {previewStatus && (
            <p className="profile-status">
              {previewStatus.emoji && <span aria-hidden>{previewStatus.emoji} </span>}
              {previewStatus.text}
            </p>
          )}
          {bio.trim() && <p className="profile-bio small">{bio.trim()}</p>}
        </div>
      </div>

      <div className="profile-fields">
        <div className="profile-pictures">
          <span className="field-label">Picture and banner</span>
          {picturesAllowed ? (
            <div className="row-wrap">
              <button type="button" onClick={() => avatarInput.current?.click()}>
                {me.avatar ? "Change picture" : "Add a picture"}
              </button>
              {me.avatar && (
                <button type="button" className="ghost" onClick={() => void picture("avatar", null)}>
                  Remove picture
                </button>
              )}
              <button type="button" onClick={() => bannerInput.current?.click()}>
                {profile?.banner ? "Change banner" : "Add a banner"}
              </button>
              {profile?.banner && (
                <button type="button" className="ghost" onClick={() => void picture("banner", null)}>
                  Remove banner
                </button>
              )}
              <input ref={avatarInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => void picture("avatar", e.target.files?.[0] ?? null).then(() => (e.target.value = ""))} />
              <input ref={bannerInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => void picture("banner", e.target.files?.[0] ?? null).then(() => (e.target.value = ""))} />
            </div>
          ) : (
            <p className="muted small">Ask a parent if you'd like a profile picture and banner.</p>
          )}
          <span className="muted small">PNG, JPEG, GIF or WebP, up to {PROFILE_LIMITS.imageBytes / 1024 / 1024} MB. GIFs move.</span>
        </div>

        {!profile?.banner && (
          <label className="profile-color">
            <span className="field-label">Banner color</span>
            <span className="row-wrap">
              <input type="color" value={bannerColor ?? "#f2a541"} onChange={(e) => setBannerColor(e.target.value)} aria-label="Banner color" />
              {bannerColor && (
                <button type="button" className="ghost" onClick={() => setBannerColor(null)}>
                  Use the theme's color
                </button>
              )}
            </span>
          </label>
        )}

        <div className="profile-status-edit">
          <span className="field-label">Custom status</span>
          <div className="row-wrap">
            <input
              className="status-emoji-input"
              value={statusEmoji}
              onChange={(e) => setStatusEmoji(e.target.value)}
              placeholder="🙂"
              aria-label="Status emoji"
              maxLength={16}
            />
            <input
              className="grow"
              value={statusText}
              onChange={(e) => setStatusText(e.target.value)}
              placeholder="What's up?"
              maxLength={PROFILE_LIMITS.statusText}
              aria-label="Status text"
            />
          </div>
          <div className="status-emoji-picks" role="group" aria-label="Pick an emoji">
            {STATUS_EMOJI.map((e) => (
              <button key={e} type="button" className={`ghost ${statusEmoji === e ? "active" : ""}`} onClick={() => setStatusEmoji(statusEmoji === e ? "" : e)}>
                {e}
              </button>
            ))}
          </div>
          <label className="row-wrap small">
            Clear after
            <select value={clearChoice} onChange={(e) => setClearChoice(Number(e.target.value))}>
              {CLEAR_AFTER.map((c, i) => (
                <option key={c.label} value={i}>
                  {c.label}
                </option>
              ))}
            </select>
            {status?.expiresAt && clearChoice === 0 && <span className="muted">now clears {new Date(status.expiresAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>}
          </label>
          {(statusText || statusEmoji) && (
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                setStatusEmoji("");
                setStatusText("");
              }}
            >
              Clear status
            </button>
          )}
        </div>

        <label>
          <span className="field-label">Pronouns</span>
          <input value={pronouns} onChange={(e) => setPronouns(e.target.value)} maxLength={PROFILE_LIMITS.pronouns} placeholder="they/them" />
        </label>

        <label>
          <span className="field-label">
            About me <span className="muted small">{[...bio].length}/{PROFILE_LIMITS.bio}</span>
          </span>
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={PROFILE_LIMITS.bio} rows={3} placeholder="A little about you" />
        </label>

        {me.isKid && <p className="muted small">Your parents hear when you change your profile, and the word filter checks it.</p>}
        <div className="row-wrap">
          <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save profile"}
          </button>
          {note && <span className={note.ok ? "muted small" : "error small"}>{note.text}</span>}
        </div>
      </div>
    </div>
  );
}

/** The profile editor on its own, opened from your profile card. */
export function ProfileEditorDialog({ me, onSaved, picturesAllowed, onClose }: { me: Me; onSaved: (me: Me) => void; picturesAllowed: boolean; onClose: () => void }) {
  return (
    <Modal title="Edit profile" onClose={onClose} wide>
      <ProfileEditor me={me} onSaved={onSaved} picturesAllowed={picturesAllowed} />
    </Modal>
  );
}
