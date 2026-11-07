import { useState, type FormEvent } from "react";
import type { Friend, PublicUser } from "@dendrop/shared";
import { api } from "./api.ts";
import { ActivityLine } from "./activity.tsx";
import { Avatar } from "./Avatar.tsx";
import { useColors } from "./colors.ts";

export function Friends({
  friends,
  online,
  onMessage,
  onBack,
}: {
  friends: Friend[];
  online: Set<number>;
  onMessage: (u: PublicUser) => void;
  onBack: () => void;
}) {
  const [username, setUsername] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim().replace(/^@/, "");
    if (!name) return;
    try {
      const f = await api<Friend>("/api/friends", { body: { username: name } });
      setNote({ ok: true, text: f.state === "friends" ? `You and ${f.user.displayName} are friends now.` : `Friend request sent to ${f.user.displayName}.` });
      setUsername("");
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };

  const act = (f: Friend, action: "accept" | "remove") =>
    void api(`/api/friends/${f.user.id}${action === "accept" ? "/accept" : ""}`, { method: action === "accept" ? "POST" : "DELETE", body: action === "accept" ? {} : undefined }).catch(
      (err: Error) => setNote({ ok: false, text: err.message }),
    );

  const byName = (a: Friend, b: Friend) => a.user.displayName.localeCompare(b.user.displayName);
  const incoming = friends.filter((f) => f.state === "incoming").sort(byName);
  const outgoing = friends.filter((f) => f.state === "outgoing").sort(byName);
  /** Both said yes, but a kid's parent still has to approve. */
  const held = friends.filter((f) => f.state === "held").sort(byName);
  const accepted = friends
    .filter((f) => f.state === "friends")
    .sort((a, b) => Number(online.has(b.user.id)) - Number(online.has(a.user.id)) || byName(a, b));

  return (
    <section className="pane">
      <header className="pane-header">
        <button className="ghost back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <h2>Friends</h2>
      </header>
      <div className="pane-body">
        <form className="add-friend" onSubmit={add}>
          <label>
            Add a friend by username
            <div className="row">
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="their_username" autoCapitalize="off" autoCorrect="off" />
              <button className="primary">Send request</button>
            </div>
          </label>
          {note && <p className={note.ok ? "muted" : "error"}>{note.text}</p>}
        </form>

        {incoming.length > 0 && (
          <>
            <div className="section-label">Requests · {incoming.length}</div>
            {incoming.map((f) => (
              <div className="person" key={f.user.id}>
                <Avatar name={f.user.displayName} />
                <PersonName u={f.user} />
                <button className="primary" onClick={() => act(f, "accept")}>
                  Accept
                </button>
                <button className="ghost" onClick={() => act(f, "remove")}>
                  Decline
                </button>
              </div>
            ))}
          </>
        )}

        <div className="section-label">Friends · {accepted.length}</div>
        {accepted.length === 0 && <p className="muted">No friends yet. Send a request to someone on this server by their username.</p>}
        {accepted.map((f) => (
          <div className="person" key={f.user.id}>
            <Avatar name={f.user.displayName} online={online.has(f.user.id)} />
            <PersonName u={f.user} sub={online.has(f.user.id) ? "Online" : "Offline"} activity />
            <button className="primary" onClick={() => onMessage(f.user)}>
              Message
            </button>
            <button
              className="ghost"
              onClick={() => {
                if (confirm(`Remove ${f.user.displayName} as a friend? Your conversation stays.`)) act(f, "remove");
              }}
            >
              Remove
            </button>
          </div>
        ))}

        {held.length > 0 && (
          <>
            <div className="section-label">Waiting for a parent · {held.length}</div>
            {held.map((f) => (
              <div className="person" key={f.user.id}>
                <Avatar name={f.user.displayName} />
                <PersonName u={f.user} sub="A parent has to say yes before you can chat" />
                <button className="ghost" onClick={() => act(f, "remove")}>
                  Cancel
                </button>
              </div>
            ))}
          </>
        )}
        {outgoing.length > 0 && (
          <>
            <div className="section-label">Sent · {outgoing.length}</div>
            {outgoing.map((f) => (
              <div className="person" key={f.user.id}>
                <Avatar name={f.user.displayName} />
                <PersonName u={f.user} sub="Waiting for them to accept" />
                <button className="ghost" onClick={() => act(f, "remove")}>
                  Cancel
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function PersonName({ u, sub, activity }: { u: PublicUser; sub?: string; activity?: boolean }) {
  const colorsOf = useColors();
  return (
    <span className="person-name">
      <strong className="ellipsis" style={colorsOf(u).name}>
        {u.displayName}
      </strong>
      <span className="muted small ellipsis">
        @{u.username}
        {sub ? ` · ${sub}` : ""}
      </span>
      {activity && <ActivityLine userId={u.id} />}
    </span>
  );
}
