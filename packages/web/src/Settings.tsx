import { useState } from "react";
import { LIMITS, type Me } from "@dendrop/shared";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";

export function Settings({ me, onClose, onSaved }: { me: Me; onClose: () => void; onSaved: (me: Me) => void }) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [readReceipts, setReadReceipts] = useState(me.readReceipts);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      onSaved(await api<Me>("/api/me", { method: "PATCH", body: { displayName, readReceipts } }));
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      <label>
        Display name
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={LIMITS.displayNameLength} />
      </label>
      <div className="section-label">Privacy</div>
      <label className="toggle">
        <input type="checkbox" checked={readReceipts} onChange={(e) => setReadReceipts(e.target.checked)} />
        <span>
          <strong>Read receipts</strong>
          <span className="muted small">
            Let people see when you've read their messages. When this is off you won't see theirs either.
          </span>
        </span>
      </label>
      {error && <p className="error">{error}</p>}
      <button className="primary wide" onClick={() => void save()}>
        Save
      </button>
    </Modal>
  );
}
