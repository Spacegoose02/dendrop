import { useEffect, useState, type FormEvent } from "react";
import type { Conversation, FamilyAlert, FamilyChat, FamilyInfo, FamilyKid, FamilyLinkCode, Friend, KidRules, LootdenKidLimits, Me, PublicUser } from "@dendrop/shared";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { AttachmentView, EncryptedAttachment } from "./Chat.tsx";
import { openForParent, revealWith, type ChatMessage } from "./e2ee.ts";
import { Modal } from "./Modal.tsx";
import { conversationTitle } from "./util.ts";

const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** What an alert says. Never any message content: the parent opens the chat for that. */
export function alertText(a: FamilyAlert): string {
  const kid = a.kid.displayName;
  switch (a.type) {
    case "deleted":
      return `${kid} deleted a message.`;
    case "profanity":
      return `${kid}'s app caught a filtered word in a chat.`;
    case "contact":
      return `${kid} and ${a.other?.displayName ?? "someone"} are friends now, or want to be.`;
    case "time_limit":
      return `${kid} used today's chat time.`;
    case "help":
      return `${kid} asked you to look at a chat.`;
    case "profile":
      return `${kid} changed their profile.`;
  }
}

/**
 * Kid-safe chat. Parents see their kids, their rules, alerts and link codes. Kids see who their
 * parents are, what those parents can see, their rules, and every time a parent looked.
 */
export function FamilyDialog({
  me,
  family,
  alerts,
  conversations,
  encryptionOn,
  onClose,
  onChanged,
}: {
  me: Me;
  family: FamilyInfo | null;
  alerts: FamilyAlert[];
  conversations: Conversation[];
  encryptionOn: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [viewing, setViewing] = useState<FamilyAlert | null>(null);
  if (!family) return null;
  if (viewing) return <ParentChat alert={viewing} onBack={() => setViewing(null)} onDone={() => (setViewing(null), onChanged())} />;
  return (
    <Modal title="Family" onClose={onClose}>
      <div className="family">
        {me.isKid ? (
          <KidView family={family} conversations={conversations} me={me} />
        ) : (
          <>
            {alerts.length > 0 && <Alerts alerts={alerts} onView={setViewing} onChanged={onChanged} />}
            {family.kids.map((k) => (
              <KidCard key={k.user.id} kid={k} onChanged={onChanged} />
            ))}
            <LinkCode encryptionOn={encryptionOn} hasKids={family.kids.length > 0} />
            <MakeKidAccount encryptionOn={encryptionOn} onChanged={onChanged} />
            {family.kids.length > 0 && <Webhook url={family.webhookUrl} onChanged={onChanged} />}
            {family.kids.length === 0 && <JoinAsKid onChanged={onChanged} />}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---- The kid's side ------------------------------------------------------------------------

function WhatParentsSee({ names }: { names: string }) {
  return (
    <ul className="family-list small">
      <li>
        {names} <strong>can't</strong> read your chats normally. Your chats are still end-to-end encrypted, and the server can't read them.
      </li>
      <li>
        When there's an <strong>alert</strong> about a chat (you delete a message, the filter catches a word, or you ask them to look),
        they can read that chat until they're done with it. They can't send anything.
      </li>
      <li>Messages you delete are kept for them until they've looked.</li>
      <li>Every time they look, it shows up here for you.</li>
      <li>Everyone you chat with can see that your parents have this.</li>
      <li>They set your chat hours, daily time, word filter, and whether new friends need a yes. Den Duty time-outs can pause chat too.</li>
    </ul>
  );
}

function KidView({ me, family, conversations }: { me: Me; family: FamilyInfo; conversations: Conversation[] }) {
  const names = family.parents.map((p) => p.displayName).join(" and ");
  const rules = family.rules!;
  const status = family.status!;
  const chatName = (id: number | null) => {
    const c = conversations.find((x) => x.id === id);
    return c ? `your chat with ${conversationTitle(c, me.id)}` : "one of your chats";
  };
  return (
    <>
      <section>
        <h3>Your family</h3>
        <p className="muted small">Your account is linked to {names}. Here's what that means:</p>
        <WhatParentsSee names={names} />
      </section>
      <section>
        <h3>Your rules</h3>
        <ul className="family-list small">
          <li>{status.allowedNow ? "You can chat right now." : `⏰ ${status.reason}`}</li>
          {rules.choresFirst && <li>Chores first: chat opens once today's Den Duty chores are done</li>}
          <li>{rules.gifs ? "GIFs are on (rated G only)" : "GIFs are off: ask a parent if you'd like them"}</li>
          <li>
            {rules.profilePictures ? "You can set a profile picture and banner" : "Profile pictures are off: ask a parent if you'd like one"}. Your parents
            hear when you change your profile.
          </li>
          {rules.allowedFrom && rules.allowedUntil && (
            <li>
              Chat hours: {rules.allowedFrom} to {rules.allowedUntil}
            </li>
          )}
          {rules.lootdenBedtime && status.lootden?.bedtime && (
            <li>
              Bedtime (same as LootDen): {status.lootden.bedtime.from} to {status.lootden.bedtime.to}
            </li>
          )}
          {status.limitMinutes !== null && (
            <li>
              Today: {status.minutesToday + status.gameMinutesToday} of {status.limitMinutes} minutes
              {status.gameMinutesToday > 0 && ` (${status.minutesToday} chatting, ${status.gameMinutesToday} playing games)`}
            </li>
          )}
          <li>Word filter: {rules.profanityFilter ? "on" : "off"}</li>
          <li>New friends: {rules.approveFriends ? "a parent says yes first" : "no approval needed"}</li>
          <li>Chat servers: {rules.canJoinServers ? "allowed" : "ask a parent"}</li>
        </ul>
      </section>
      <section>
        <h3>When they looked</h3>
        {family.audit.length === 0 ? (
          <p className="muted small">They haven't looked at any of your chats.</p>
        ) : (
          <ul className="family-list small">
            {family.audit.map((a, i) => (
              <li key={i}>
                {a.parent.displayName} read {chatName(a.conversationId)} · {when(a.createdAt)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** For someone who isn't linked yet: type the code a parent gave you, after reading what it means. */
function JoinAsKid({ onChanged }: { onChanged: () => void }) {
  const [code, setCode] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = async () => {
    setError(null);
    try {
      await api<FamilyInfo>("/api/family/link", { body: { code, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section>
      <h3>Got a code from a parent?</h3>
      <p className="muted small">Typing it makes this a kid account linked to them. Only a parent can undo that.</p>
      {code.trim().length >= 8 && <WhatParentsSee names="Your parents" />}
      <div className="family-row">
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD 2345" maxLength={12} aria-label="Link code" />
      </div>
      {code.trim().length >= 8 && (
        <label className="toggle">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I understand what my parents will be able to see</span>
        </label>
      )}
      {error && <p className="error small">{error}</p>}
      <button className="primary" disabled={!agreed || code.trim().length < 8} onClick={() => void join()}>
        Link my account
      </button>
    </section>
  );
}

// ---- The parent's side ---------------------------------------------------------------------

/** A kid account under the parent's: they pick its username and password and look after it. */
function MakeKidAccount({ encryptionOn, onChanged }: { encryptionOn: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const make = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api<FamilyKid>("/api/family/kids", {
        body: { username, displayName, password, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      });
      setOpen(false);
      setUsername("");
      setDisplayName("");
      setPassword("");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h3>Make a kid account</h3>
      <p className="muted small">
        Or skip the code: make an account for your kid under yours. You pick the username and password and can reset it; your rules
        apply straight away. You can hand it over to them later. Kids with their own account link with a code instead.
      </p>
      {open ? (
        <form className="family-form" onSubmit={(e) => void make(e)}>
          <label className="family-field">
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
          </label>
          <label className="family-field">
            Name friends see
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={username} />
          </label>
          <label className="family-field">
            Password
            <input type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <p className="error small">{error}</p>}
          <div className="family-row">
            <button className="primary" disabled={busy}>
              Make account
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button disabled={!encryptionOn} onClick={() => setOpen(true)}>
          Make a kid account
        </button>
      )}
    </section>
  );
}

function LinkCode({ encryptionOn, hasKids }: { encryptionOn: boolean; hasKids: boolean }) {
  const [code, setCode] = useState<FamilyLinkCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setError(null);
    try {
      setCode(await api<FamilyLinkCode>("/api/family/codes", { body: {} }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section>
      <h3>{hasKids ? "Link another kid" : "Link a kid's account"}</h3>
      <p className="muted small">
        Make a code, then sign in as your kid and type it under Settings → Family. They'll see what you can see before they link.
        {!encryptionOn && " Turn on end-to-end encryption first, so your kid's chats can be encrypted to you too."}
      </p>
      {code ? (
        <p>
          <code className="family-code">{code.code.replace(/(.{4})/, "$1 ")}</code> <span className="muted small">works once, until {when(code.expiresAt)}</span>
        </p>
      ) : (
        <button className="primary" disabled={!encryptionOn} onClick={() => void make()}>
          Make a link code
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

function Alerts({ alerts, onView, onChanged }: { alerts: FamilyAlert[]; onView: (a: FamilyAlert) => void; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const open = alerts.filter((a) => !a.resolvedAt);
  const done = alerts.filter((a) => a.resolvedAt).slice(0, 10);
  return (
    <section>
      <h3>Alerts {open.length > 0 && <span className="badge">{open.length}</span>}</h3>
      {open.length === 0 && <p className="muted small">Nothing new.</p>}
      <ul className="family-alerts">
        {[...open, ...done].map((a) => (
          <li key={a.id} className={a.resolvedAt ? "done" : ""}>
            <span>
              {alertText(a)}
              <span className="muted small"> · {when(a.createdAt)}</span>
            </span>
            {!a.resolvedAt && (
              <span className="family-actions">
                {a.conversationId !== null && (
                  <button className="primary small-button" onClick={() => onView(a)}>
                    Read the chat
                  </button>
                )}
                {a.type === "contact" && a.other ? (
                  <>
                    <button className="accept small-button" onClick={() => void act(() => api(`/api/family/kids/${a.kid.id}/friends/${a.other!.id}/approve`, { body: {} }))}>
                      Approve
                    </button>
                    <button className="ghost danger small-button" onClick={() => void act(() => api(`/api/family/kids/${a.kid.id}/friends/${a.other!.id}`, { method: "DELETE" }))}>
                      Decline
                    </button>
                  </>
                ) : null}
                <button
                  className="ghost small-button"
                  title={a.type === "deleted" ? "Erases the kept copy and closes the chat again" : "Closes the chat again"}
                  onClick={() => void act(() => api(`/api/family/alerts/${a.id}/resolve`, { body: {} }))}
                >
                  Done
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

function KidCard({ kid, onChanged }: { kid: FamilyKid; onChanged: () => void }) {
  const [rules, setRules] = useState<KidRules>(kid.rules);
  const [words, setWords] = useState(kid.rules.blockedWords.join(", "));
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setRules(kid.rules);
    setWords(kid.rules.blockedWords.join(", "));
  }, [kid.rules]);
  const loadFriends = () => void api<Friend[]>(`/api/family/kids/${kid.user.id}/friends`).then(setFriends);
  useEffect(loadFriends, [kid.user.id]);

  const hours = rules.allowedFrom !== null && rules.allowedUntil !== null;
  const save = async () => {
    setError(null);
    try {
      const blockedWords = words
        .split(/[,\n]/)
        .map((w) => w.trim())
        .filter(Boolean);
      await api<FamilyKid>(`/api/family/kids/${kid.user.id}`, { method: "PATCH", body: { ...rules, blockedWords } });
      setSaved(true);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const set = (patch: Partial<KidRules>) => {
    setSaved(false);
    setRules((r) => ({ ...r, ...patch }));
  };
  const unlink = async () => {
    if (!confirm(`Unlink ${kid.user.displayName}? If you're their last parent it becomes a normal account, and its alerts and kept messages are erased.`)) return;
    try {
      await api(`/api/family/kids/${kid.user.id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const resetPassword = async () => {
    const password = prompt(`New password for ${kid.user.displayName} (at least 10 characters). They'll be signed out and use this one.`);
    if (!password) return;
    try {
      await api(`/api/family/kids/${kid.user.id}/password`, { method: "PUT", body: { password } });
      alert(`${kid.user.displayName}'s password is changed.`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const handOver = async () => {
    if (!confirm(`Hand ${kid.user.displayName}'s account over to them? It stays linked with the same rules, but they'll look after their own password and can link Google.`)) return;
    try {
      await api(`/api/family/kids/${kid.user.id}/release`, { body: {} });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const clearProfile = async () => {
    if (!confirm(`Clear ${kid.user.displayName}'s picture, banner, about me, pronouns and status?`)) return;
    try {
      await api(`/api/family/kids/${kid.user.id}/profile`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const removeFriend = async (f: Friend) => {
    if (f.state === "friends" && !confirm(`Remove ${f.user.displayName} from ${kid.user.displayName}'s friends?`)) return;
    await api(`/api/family/kids/${kid.user.id}/friends/${f.user.id}`, { method: "DELETE" });
    loadFriends();
    onChanged();
  };

  return (
    <section className="kid-card">
      <header className="family-row">
        <Avatar name={kid.user.displayName} src={kid.user.avatar} size={32} />
        <span>
          <strong>{kid.user.displayName}</strong>
          {kid.managed && <span className="muted small"> · under your account</span>}
          <span className="muted small">
            {" "}
            · <span title={kid.status.reason ?? undefined}>{kid.status.allowedNow ? "can chat now" : "can't chat right now"}</span> · {kid.status.minutesToday} min today
            {kid.status.gameMinutesToday > 0 && ` + ${kid.status.gameMinutesToday} min games`}
            {kid.parents.length > 1 && ` · with ${kid.parents.map((p) => p.displayName).join(", ")}`}
          </span>
        </span>
      </header>

      <label className="toggle">
        <input type="checkbox" checked={rules.profanityFilter} onChange={(e) => set({ profanityFilter: e.target.checked })} />
        <span>
          <strong>Word filter</strong>
          <span className="muted small">Hides swear words in what they read and stops them sending them. You get an alert (never the word).</span>
        </span>
      </label>
      {rules.profanityFilter && (
        <label className="family-field">
          Extra words to filter (commas between)
          <input value={words} onChange={(e) => (setSaved(false), setWords(e.target.value))} placeholder="doofus, …" />
        </label>
      )}
      <label className="toggle">
        <input type="checkbox" checked={rules.approveFriends} onChange={(e) => set({ approveFriends: e.target.checked })} />
        <span>
          <strong>Approve new friends</strong>
          <span className="muted small">New friends wait for a yes from you before they can chat.</span>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={rules.canJoinServers} onChange={(e) => set({ canJoinServers: e.target.checked })} />
        <span>
          <strong>Chat servers</strong>
          <span className="muted small">Let them join or make chat servers.</span>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={rules.gifs} onChange={(e) => set({ gifs: e.target.checked })} />
        <span>
          <strong>GIFs</strong>
          <span className="muted small">
            Let them search for GIFs and see the ones friends send. They only ever get GIFs rated G, and searches with a filtered word find nothing. Off: GIFs
            show as plain links.
          </span>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={rules.profilePictures} onChange={(e) => set({ profilePictures: e.target.checked })} />
        <span>
          <strong>Profile picture and banner</strong>
          <span className="muted small">
            Let them put up their own pictures. Their about me, pronouns and status always go through the word filter, and you get an alert when their
            profile changes. Turning this off takes their pictures down.
          </span>
        </span>
      </label>
      <p className="muted small">
        <button className="ghost danger" onClick={() => void clearProfile()}>
          Clear {kid.user.displayName}'s profile
        </button>{" "}
        Removes their picture, banner, about me, pronouns and status.
      </p>
      <label className="toggle">
        <input type="checkbox" checked={hours} onChange={(e) => set(e.target.checked ? { allowedFrom: "07:00", allowedUntil: "20:00" } : { allowedFrom: null, allowedUntil: null })} />
        <span>
          <strong>Chat hours</strong>
          <span className="muted small">Outside these they can read but not send, call or add friends.</span>
        </span>
      </label>
      {hours && (
        <div className="family-row">
          <input type="time" value={rules.allowedFrom!} onChange={(e) => set({ allowedFrom: e.target.value })} aria-label="From" />
          <span className="muted small">to</span>
          <input type="time" value={rules.allowedUntil!} onChange={(e) => set({ allowedUntil: e.target.value })} aria-label="Until" />
        </div>
      )}
      <label className="toggle">
        <input type="checkbox" checked={rules.choresFirst} onChange={(e) => set({ choresFirst: e.target.checked })} />
        <span>
          <strong>Chores first</strong>
          <span className="muted small">No chat until today's Den Duty chores are done. Needs Den Duty linked by the server admin. Time-outs in Den Duty can also pause chat.</span>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={rules.dailyMinutes !== null} onChange={(e) => set({ dailyMinutes: e.target.checked ? 60 : null })} />
        <span>
          <strong>Daily time</strong>
          <span className="muted small">Minutes a day with the app open.</span>
        </span>
      </label>
      {rules.dailyMinutes !== null && (
        <div className="family-row">
          <input type="number" min={5} max={1440} step={5} value={rules.dailyMinutes} onChange={(e) => set({ dailyMinutes: Number(e.target.value) })} aria-label="Minutes a day" />
          <span className="muted small">minutes</span>
        </div>
      )}
      {(kid.status.lootden || rules.lootdenBedtime || rules.lootdenPlayTime) && <LootdenTime lootden={kid.status.lootden} rules={rules} set={set} />}
      {(hours || rules.dailyMinutes !== null) && (
        <label className="family-field">
          Time zone
          <input value={rules.timezone} onChange={(e) => set({ timezone: e.target.value })} placeholder="America/Chicago" />
        </label>
      )}
      {error && <p className="error small">{error}</p>}
      <div className="family-row">
        <button className="primary" onClick={() => void save()}>
          Save rules
        </button>
        {saved && <span className="muted small">Saved</span>}
        <span className="spacer" />
        {kid.managed && (
          <>
            <button className="ghost" onClick={() => void resetPassword()}>
              Set password
            </button>
            <button className="ghost" onClick={() => void handOver()}>
              Hand over
            </button>
          </>
        )}
        <button className="ghost danger" onClick={() => void unlink()}>
          Unlink
        </button>
      </div>

      <h4>Friends</h4>
      {friends === null ? (
        <p className="muted small">Loading…</p>
      ) : friends.length === 0 ? (
        <p className="muted small">No friends yet.</p>
      ) : (
        <ul className="family-alerts">
          {friends.map((f) => (
            <li key={f.user.id}>
              <span>
                {f.user.displayName} <span className="muted small">@{f.user.username} · {friendState(f)}</span>
              </span>
              <span className="family-actions">
                {f.state === "held" && (
                  <button
                    className="accept small-button"
                    onClick={() => void api(`/api/family/kids/${kid.user.id}/friends/${f.user.id}/approve`, { body: {} }).then(() => (loadFriends(), onChanged()))}
                  >
                    Approve
                  </button>
                )}
                <button className="ghost danger small-button" onClick={() => void removeFriend(f)}>
                  {f.state === "friends" ? "Remove" : "Decline"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const friendState = (f: Friend) =>
  ({ friends: "friends", held: "waiting for your yes", incoming: "asked to be friends", outgoing: "request sent" })[f.state];

function Webhook({ url, onChanged }: { url: string | null; onChanged: () => void }) {
  const [value, setValue] = useState(url ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const save = async () => {
    try {
      await api("/api/family/webhook", { method: "PUT", body: { url: value.trim() || null } });
      setStatus("Saved");
      onChanged();
    } catch (err) {
      setStatus((err as Error).message);
    }
  };
  return (
    <section>
      <h3>Alerts somewhere else</h3>
      <p className="muted small">A webhook address (ntfy, Apprise, Home Assistant…) that gets each alert too. It never includes message text.</p>
      <div className="family-row">
        <input value={value} onChange={(e) => (setStatus(null), setValue(e.target.value))} placeholder="https://ntfy.example.com/family" aria-label="Webhook address" />
        <button onClick={() => void save()}>Save</button>
      </div>
      {status && <p className="muted small">{status}</p>}
    </section>
  );
}

/** A kid's chat, read only, while an alert about it is open. What the kid deleted is shown and marked. */
function ParentChat({ alert, onBack, onDone }: { alert: FamilyAlert; onBack: () => void; onDone: () => void }) {
  const [chat, setChat] = useState<FamilyChat | null>(null);
  const [messages, setMessages] = useState<(ChatMessage & { deletedByKid?: boolean })[]>([]);
  const [keys, setKeys] = useState<Map<number, CryptoKey>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const c = await api<FamilyChat>(`/api/family/alerts/${alert.id}/chat`);
        const k = await openForParent(alert.id, c.conversation.id);
        const shown = await Promise.all(
          c.messages.map(async (m) => ({ ...(await revealWith(m.deletedByKid ? { ...m, deleted: false } : m, k)), deletedByKid: m.deletedByKid })),
        );
        if (cancelled) return;
        setChat(c);
        setKeys(k);
        setMessages(shown);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [alert.id]);

  const who = new Map<number, PublicUser>((chat?.conversation.members ?? []).map((m) => [m.id, m]));
  const finish = async () => {
    await api(`/api/family/alerts/${alert.id}/resolve`, { body: {} });
    onDone();
  };

  return (
    <Modal title={`${alert.kid.displayName}'s chat`} onClose={onBack}>
      <p className="muted small">
        {alertText(alert)} You can read this chat until you mark the alert done. {alert.kid.displayName} sees that you looked. Read only.
      </p>
      {error && <p className="error small">{error}</p>}
      {!chat && !error && <p className="muted">Loading…</p>}
      {chat && (
        <>
          <p className="small">
            <strong>{chat.conversation.name ?? chat.conversation.members.map((m) => m.displayName).join(", ")}</strong>
          </p>
          <div className="family-chat">
            {messages.map((m) => (
              <div key={m.id} className={`family-msg ${m.id === alert.messageId ? "flagged" : ""}`}>
                <span className="small">
                  <strong>{who.get(m.authorId)?.displayName ?? "Someone who left"}</strong> <span className="muted">{when(m.createdAt)}</span>
                  {m.deletedByKid && <span className="badge">deleted by {alert.kid.displayName}</span>}
                </span>
                {m.deleted ? (
                  <p className="msg-body deleted">Message deleted</p>
                ) : m.locked ? (
                  <p className="msg-body deleted">🔒 {m.locked}</p>
                ) : (
                  <>
                    {m.text && <p className="msg-body">{m.text}</p>}
                    {m.attachments.length > 0 && (
                      <div className="attachments">
                        {m.attachments.map((a, j) =>
                          m.keyVersion ? (
                            <EncryptedAttachment key={a.id} m={m} a={a} meta={m.files?.[j]} keyOverride={keys.get(m.keyVersion)} />
                          ) : (
                            <AttachmentView key={a.id} a={a} />
                          ),
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="family-row">
        <button onClick={onBack}>Back</button>
        <span className="spacer" />
        <button className="primary" onClick={() => void finish()}>
          {alert.type === "deleted" ? "Done (erase the kept copy)" : "Done"}
        </button>
      </div>
    </Modal>
  );
}

/** Time rules that follow LootDen's play limits, for a kid whose LootDen profile is matched. */
function LootdenTime({ lootden, rules, set }: { lootden: LootdenKidLimits | null; rules: KidRules; set: (patch: Partial<KidRules>) => void }) {
  const daily = rules.dailyMinutes !== null ? `the ${rules.dailyMinutes} minutes above` : lootden?.dailyMinutes != null ? `LootDen's ${lootden.dailyMinutes} minutes today` : "LootDen's daily play time (none set today)";
  return (
    <>
      <label className="toggle">
        <input type="checkbox" checked={rules.lootdenBedtime} onChange={(e) => set({ lootdenBedtime: e.target.checked })} />
        <span>
          <strong>LootDen bedtime</strong>
          <span className="muted small">
            {lootden?.bedtime
              ? `Chat closes at LootDen's bedtime too: ${lootden.bedtime.from} to ${lootden.bedtime.to} (${lootden.timezone}).`
              : "Chat closes at LootDen's bedtime too. Their LootDen profile has no bedtime yet."}
          </span>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={rules.lootdenPlayTime} onChange={(e) => set({ lootdenPlayTime: e.target.checked })} />
        <span>
          <strong>Games count as screen time</strong>
          <span className="muted small">
            Time playing in LootDen counts toward {daily}, so chat and games share one budget
            {lootden ? ` (${lootden.playedMinutes} min played today)` : ""}.
          </span>
        </span>
      </label>
      {!lootden && <p className="muted small">LootDen isn't linked, or their LootDen profile isn't matched, so these do nothing until it is.</p>}
    </>
  );
}
