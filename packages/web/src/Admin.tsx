import { useEffect, useState, type FormEvent } from "react";
import type { AdminServer, ChannelRef, ChatServer, DendutyStatus, LootdenStatus, ServerCreatorRequest } from "@dendrop/shared";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { ServerIcon } from "./Servers.tsx";

/**
 * The super admin's view of the whole instance: who may make servers, and every server.
 * Super admins see server names and counts here, never messages.
 */
export function AdminDialog({ onClose, version }: { onClose: () => void; version: number }) {
  const [requests, setRequests] = useState<ServerCreatorRequest[] | null>(null);
  const [servers, setServers] = useState<AdminServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    void api<ServerCreatorRequest[]>("/api/admin/server-requests").then(setRequests, (err: Error) => setError(err.message));
    void api<AdminServer[]>("/api/admin/servers").then(setServers, (err: Error) => setError(err.message));
  };
  // version goes up when a request arrives over the gateway.
  useEffect(load, [version]);

  const decide = async (userId: number, allowed: boolean) => {
    setError(null);
    try {
      await api(`/api/admin/server-creators/${userId}`, { method: "PUT", body: { allowed } });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (s: AdminServer) => {
    if (prompt(`Delete ${s.name} for everyone, with all its messages? Type the server's name to confirm.`) !== s.name) return;
    try {
      await api(`/api/servers/${s.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title="Instance admin" onClose={onClose}>
      {error && <p className="error">{error}</p>}
      <div className="section-label">Who can make servers</div>
      {requests?.length === 0 && <p className="muted small">No requests yet.</p>}
      {requests?.map((r) => (
        <div key={r.user.id} className="member-row">
          <span className="nav-text">
            <span className="ellipsis">
              {r.user.displayName} <span className="muted small">@{r.user.username}</span>
            </span>
            {r.reason && <span className="small">“{r.reason}”</span>}
            <span className={`muted small status-${r.status}`}>{r.status === "pending" ? "Waiting" : r.status === "approved" ? "Allowed" : "Not allowed"}</span>
          </span>
          {r.status !== "approved" && (
            <button className="primary small-button" onClick={() => void decide(r.user.id, true)}>
              Allow
            </button>
          )}
          {r.status !== "denied" && (
            <button className="ghost small" onClick={() => void decide(r.user.id, false)}>
              {r.status === "pending" ? "Deny" : "Revoke"}
            </button>
          )}
        </div>
      ))}

      <div className="section-label">Every server</div>
      <p className="muted small">Names and counts only. You can't read a server's messages unless you're a member.</p>
      {servers?.length === 0 && <p className="muted small">No servers yet.</p>}
      {servers?.map((s) => (
        <div key={s.id} className="member-row">
          <ServerIcon server={s} size={32} />
          <span className="nav-text">
            <span className="ellipsis">{s.name}</span>
            <span className="muted small">
              {s.isPublic ? "Public" : "Private"} · {s.memberCount} members · {s.channelCount} channels · owner {s.owner?.displayName ?? "unknown"}
            </span>
          </span>
          <button className="ghost small danger" onClick={() => void remove(s)}>
            Delete
          </button>
        </div>
      ))}

      <LootdenSection />
      <DendutySection />
    </Modal>
  );
}

const ago = (iso: string) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleString();
};

/**
 * The link to LootDen, the family's game library: its address and a LootDen admin's API token.
 * With it, what people play shows in Dendrop as their activity.
 */
function LootdenSection() {
  const [status, setStatus] = useState<LootdenStatus | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<LootdenStatus>("/api/admin/lootden").then((st) => {
      setStatus(st);
      setUrl(st.settings.url);
    }, (err: Error) => setError(err.message));
  }, []);

  const send = async (fn: () => Promise<LootdenStatus>) => {
    setBusy(true);
    setError(null);
    try {
      const st = await fn();
      setStatus(st);
      setUrl(st.settings.url);
      setToken("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void send(() => api<LootdenStatus>("/api/admin/lootden", { method: "PUT", body: { url, token } }));
  };
  const linked = !!status?.settings.url;

  return (
    <>
      <div className="section-label">LootDen</div>
      <p className="muted small">
        Link LootDen, the family's game library, to show what people are playing (“Playing Stardew Valley on Den-PC”) to their friends and the people in their
        servers. Everyone can turn that off in Settings. Make the token in LootDen while signed in as an admin: Profile, Devices and tokens, Create token.
      </p>
      <form className="lootden-form" onSubmit={save}>
        <label>
          LootDen's address
          <input type="url" placeholder="https://games.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          API token
          <input
            type="password"
            autoComplete="off"
            placeholder={status?.settings.hasToken ? "Saved (leave empty to keep it)" : "From a LootDen admin's profile"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <div className="account-save">
          <button className="primary" disabled={busy || !url.trim()}>
            {linked ? "Save" : "Link LootDen"}
          </button>
          {linked && (
            <>
              <button type="button" className="ghost" disabled={busy} onClick={() => void send(() => api<LootdenStatus>("/api/admin/lootden/check", { body: {} }))}>
                Check now
              </button>
              <button
                type="button"
                className="ghost danger"
                disabled={busy}
                onClick={() => confirm("Unlink LootDen? Nobody's activity will show any more.") && void send(() => api<LootdenStatus>("/api/admin/lootden", { method: "PUT", body: { url: "" } }))}
              >
                Unlink
              </button>
            </>
          )}
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      {linked && status && (
        <>
          {status.error ? (
            <p className="error">{status.error}</p>
          ) : (
            <p className="muted small">
              {status.lastOkAt ? `Connected, checked ${ago(status.lastOkAt)}.` : "Not checked yet."} {status.playing} playing right now.
            </p>
          )}
          <LootdenChannels status={status} onSaved={setStatus} />
          <div className="section-label">Accounts</div>
          {status.accounts.map((a) => (
            <div key={a.lootden.id} className="member-row">
              <span className="nav-text">
                <span className="ellipsis">
                  {a.lootden.displayName}{" "}
                  <span className="muted small">
                    @{a.lootden.username} in LootDen{a.lootden.kid ? " · kid" : ""}
                    {a.lootden.admin ? " · admin" : ""}
                  </span>
                </span>
                <span className="muted small">
                  {a.user ? `↔ ${a.user.displayName} (@${a.user.username}), same ${a.matchedBy === "sign-in" ? "TinyAuth sign-in" : a.matchedBy}` : "No Dendrop account with the same email or username"}
                  {a.user && a.userIsKid ? " · kid account" : ""}
                </span>
              </span>
              {a.lootden.kid && a.user && !a.userIsKid && <MakeKid status={status} kid={a.user} onDone={() => void send(() => api<LootdenStatus>("/api/admin/lootden"))} />}
            </div>
          ))}
        </>
      )}
    </>
  );
}

/** Where game nights and new screenshots go: a text channel in a server you run, or off. */
function LootdenChannels({ status, onSaved }: { status: LootdenStatus; onSaved: (s: LootdenStatus) => void }) {
  const [servers, setServers] = useState<ChatServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api<ChatServer[]>("/api/servers").then((list) => setServers(list.filter((s) => s.myRole !== "member")), () => {}), []);
  const options = servers.flatMap((sv) => sv.channels.filter((c) => c.kind === "text").map((c) => ({ value: `${sv.id}:${c.id}`, label: `${sv.name} › #${c.name}` })));
  const value = (ref: ChannelRef | null) => (ref ? `${ref.serverId}:${ref.channelId}` : "");
  const save = async (key: "gameNights" | "screenshots", v: string) => {
    setError(null);
    const [serverId, channelId] = v.split(":").map(Number);
    try {
      onSaved(await api<LootdenStatus>("/api/admin/lootden/channels", { method: "PUT", body: { [key]: v ? { serverId, channelId } : null } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const picker = (key: "gameNights" | "screenshots", label: string, hint: string) => (
    <div className="lootden-pick">
      <span>
        <strong>{label}</strong>
        <span className="muted small">{hint}</span>
      </span>
      <select value={value(status.settings[key])} onChange={(e) => void save(key, e.target.value)} aria-label={label}>
        <option value="">Off</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <div className="lootden-picks">
      {picker("gameNights", "Game nights", "Announced here, each with its own voice channel in that server until the night is over.")}
      {picker("screenshots", "Family wall", "New screenshots from LootDen are shared here. If a kid can read the channel, only screenshots of kid-safe games are.")}
      {options.length === 0 && <p className="muted small">Make a server (or be an admin of one) to pick a channel.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Links a LootDen kid profile's Dendrop account to a parent, as a kid account. */
function MakeKid({ status, kid, onDone }: { status: LootdenStatus; kid: { username: string; displayName: string }; onDone: () => void }) {
  // LootDen's admins are the grown-ups; offer their Dendrop accounts as parents.
  const parents = status.accounts.filter((a) => a.lootden.admin && a.user && !a.userIsKid).map((a) => a.user!);
  const [parent, setParent] = useState(parents[0]?.username ?? "");
  const [error, setError] = useState<string | null>(null);
  if (!parents.length) return <span className="muted small">No LootDen admin has a Dendrop account to be the parent</span>;
  const link = async () => {
    setError(null);
    try {
      await api("/api/admin/family", { body: { parent, kid: kid.username, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <span className="make-kid">
      <select value={parent} onChange={(e) => setParent(e.target.value)} aria-label={`Parent for ${kid.displayName}`}>
        {parents.map((p) => (
          <option key={p.username} value={p.username}>
            Parent: {p.displayName}
          </option>
        ))}
      </select>
      <button className="primary small-button" onClick={() => void link()}>
        Make kid account
      </button>
      {error && <span className="small error-text">{error}</span>}
    </span>
  );
}

/**
 * The link to Den Duty, the family's chore tracker: its address, the home id and an API token.
 * With it, kids' chores today show under their name for them and their parents, and Den Duty's
 * events are posted into channels.
 */
function DendutySection() {
  const [status, setStatus] = useState<DendutyStatus | null>(null);
  const [url, setUrl] = useState("");
  const [homeId, setHomeId] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [servers, setServers] = useState<ChatServer[]>([]);

  const show = (st: DendutyStatus) => {
    setStatus(st);
    setUrl(st.settings.url);
    setHomeId(st.settings.homeId);
    setToken("");
  };
  useEffect(() => {
    void api<DendutyStatus>("/api/admin/denduty").then(show, (err: Error) => setError(err.message));
    void api<ChatServer[]>("/api/servers").then((list) => setServers(list.filter((x) => x.myRole !== "member")), () => {});
  }, []);

  const send = async (fn: () => Promise<DendutyStatus>) => {
    setBusy(true);
    setError(null);
    try {
      show(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void send(() => api<DendutyStatus>("/api/admin/denduty", { method: "PUT", body: { url, homeId, token } }));
  };
  const linked = !!status?.settings.url;
  const options = servers.flatMap((sv) => sv.channels.filter((c) => c.kind === "text").map((c) => ({ value: `${sv.id}:${c.id}`, label: `${sv.name} › #${c.name}` })));
  const value = (ref: ChannelRef | null) => (ref ? `${ref.serverId}:${ref.channelId}` : "");
  const pickChannel = (key: "family" | "parents", v: string) => {
    const [serverId, channelId] = v.split(":").map(Number);
    void send(() => api<DendutyStatus>("/api/admin/denduty/channels", { method: "PUT", body: { [key]: v ? { serverId, channelId } : null } }));
  };
  const picker = (key: "family" | "parents", label: string, hint: string) => (
    <div className="lootden-pick">
      <span>
        <strong>{label}</strong>
        <span className="muted small">{hint}</span>
      </span>
      <select value={value(status!.settings[key])} disabled={busy} onChange={(e) => pickChannel(key, e.target.value)} aria-label={label}>
        <option value="">Off</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
  const pickKid = (kidId: string, v: string) =>
    void send(() => api<DendutyStatus>("/api/admin/denduty/kids", { method: "PUT", body: { kidId, userId: v === "auto" ? "auto" : v === "" ? null : Number(v) } }));

  return (
    <>
      <div className="section-label">Den Duty</div>
      <p className="muted small">
        Link Den Duty, the family's chore tracker. Kids' chores today show under their name (“🧹 2 of 5 chores left”) for them and their parents, and what happens in
        Den Duty is posted into the channels you pick. Make a read token in Den Duty: Settings, Home Assistant and the API. The home id is on the same page.
      </p>
      <form className="lootden-form" onSubmit={save}>
        <label>
          Den Duty's address
          <input type="url" placeholder="https://chores.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          Home id
          <input autoComplete="off" placeholder="From Den Duty's Settings" value={homeId} onChange={(e) => setHomeId(e.target.value)} />
        </label>
        <label>
          API token
          <input
            type="password"
            autoComplete="off"
            placeholder={status?.settings.hasToken ? "Saved (leave empty to keep it)" : "dnk_…"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <div className="account-save">
          <button className="primary" disabled={busy || !url.trim()}>
            {linked ? "Save" : "Link Den Duty"}
          </button>
          {linked && (
            <>
              <button type="button" className="ghost" disabled={busy} onClick={() => void send(() => api<DendutyStatus>("/api/admin/denduty/check", { body: {} }))}>
                Check now
              </button>
              <button
                type="button"
                className="ghost danger"
                disabled={busy}
                onClick={() => confirm("Unlink Den Duty? Chores lines and posts stop.") && void send(() => api<DendutyStatus>("/api/admin/denduty", { method: "PUT", body: { url: "" } }))}
              >
                Unlink
              </button>
            </>
          )}
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      {linked && status && (
        <>
          {status.error ? (
            <p className="error">{status.error}</p>
          ) : (
            <p className="muted small">{status.lastOkAt ? `Connected, checked ${ago(status.lastOkAt)}.` : "Not checked yet."}</p>
          )}
          <div className="lootden-picks">
            {picker("family", "Family channel", "Chores approved, bonus points, goals and family goals reached, rewards handed over. Fine for kids to read.")}
            {picker("parents", "Parents channel", "Chores waiting for a check, shop orders, time-outs, help asks and reminders. Has to be a channel no kid account can read.")}
            {options.length === 0 && <p className="muted small">Make a server (or be an admin of one) to pick a channel.</p>}
          </div>
          <div className="section-label">Kids</div>
          {status.kids.length === 0 && <p className="muted small">No kids in that Den Duty home yet.</p>}
          {status.kids.map((k) => (
            <div key={k.denduty.id} className="member-row">
              <span className="nav-text">
                <span className="ellipsis">
                  {k.denduty.name} <span className="muted small">in Den Duty</span>
                </span>
                <span className="muted small">
                  {k.user ? `↔ ${k.user.displayName} (@${k.user.username})${k.matchedBy === "name" ? ", same name" : ""}` : k.matchedBy === "picked" ? "Not shown in Dendrop" : "No Dendrop kid account with that name"}
                  {k.chores ? ` · ${k.chores.left} of ${k.chores.due} chores left today` : ""}
                </span>
              </span>
              <select
                aria-label={`Dendrop account for ${k.denduty.name}`}
                disabled={busy}
                value={k.matchedBy === "picked" ? String(k.user?.id ?? "") : "auto"}
                onChange={(e) => pickKid(k.denduty.id, e.target.value)}
              >
                <option value="auto">Match by name</option>
                <option value="">Nobody</option>
                {status.kidAccounts.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} (@{u.username})
                  </option>
                ))}
              </select>
            </div>
          ))}
        </>
      )}
    </>
  );
}
