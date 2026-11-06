import { useState } from "react";
import { LIMITS, type Conversation, type Friend } from "@dendrop/shared";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { Modal } from "./Modal.tsx";

/** Picks friends (and an optional name) for a group chat. */
export function NewGroup({ friends, onClose, onCreated }: { friends: Friend[]; onClose: () => void; onCreated: (c: Conversation) => void }) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const accepted = friends.filter((f) => f.state === "friends").sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
  const max = LIMITS.groupMembers - 1;

  const toggle = (id: number) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else if (n.size < max) n.add(id);
      return n;
    });

  const create = async () => {
    try {
      onCreated(await api<Conversation>("/api/conversations", { body: { userIds: [...picked], name: name.trim() || null } }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title="New group chat" onClose={onClose}>
      <label>
        Name (optional)
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="The family den" maxLength={64} />
      </label>
      <div className="section-label">
        Friends · {picked.size}/{max}
      </div>
      <div className="pick-list">
        {accepted.length === 0 && <p className="muted">Add some friends first.</p>}
        {accepted.map((f) => (
          <label key={f.user.id} className="pick">
            <input type="checkbox" checked={picked.has(f.user.id)} onChange={() => toggle(f.user.id)} />
            <Avatar name={f.user.displayName} size={28} />
            <span className="ellipsis">{f.user.displayName}</span>
            <span className="muted small">@{f.user.username}</span>
          </label>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <button className="primary wide" disabled={picked.size === 0} onClick={() => void create()}>
        Start group chat
      </button>
    </Modal>
  );
}
