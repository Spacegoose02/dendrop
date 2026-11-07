import { useEffect, useState } from "react";
import type { Conversation, Me } from "@dendrop/shared";
import { securityCode } from "./e2ee.ts";
import { Modal } from "./Modal.tsx";

/**
 * Everyone's security code in an encrypted conversation. If the code you see for someone
 * matches the one they see for themselves (in Settings), nobody has swapped their key.
 */
export function EncryptionInfo({ me, conversation, onClose }: { me: Me; conversation: Conversation; onClose: () => void }) {
  const [codes, setCodes] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    void Promise.all([...conversation.members, ...conversation.guardians].map(async (m) => [m.id, m.publicKey ? await securityCode(m.publicKey) : ""] as const)).then(
      (list) => !cancelled && setCodes(Object.fromEntries(list)),
    );
    return () => {
      cancelled = true;
    };
  }, [conversation.members, conversation.guardians]);

  return (
    <Modal title="End-to-end encrypted" onClose={onClose}>
      <p>
        Messages and files here are encrypted on your device and only opened on the devices of the people in this conversation. The
        Dendrop server stores them but can't read them.
      </p>
      <p className="muted small">
        To be sure, compare security codes in person or on a call: the code you see here for someone should match the one they see
        for themselves in Settings.
      </p>
      <ul className="security-codes">
        {conversation.members.map((m) => (
          <li key={m.id}>
            <strong>
              {m.displayName}
              {m.id === me.id ? " (you)" : ""}
            </strong>
            <code>{m.publicKey ? (codes[m.id] ?? "…") : "Not set up"}</code>
          </li>
        ))}
      </ul>
      {conversation.guardians.length > 0 && (
        <>
          <p className="small">
            <strong>Parents of a kid in this chat</strong> also get the key, so they can read it, read only, when they get an alert
            about it (the kid sees each time they look):
          </p>
          <ul className="security-codes">
            {conversation.guardians.map((g) => (
              <li key={g.id}>
                <strong>{g.displayName}</strong>
                <code>{g.publicKey ? (codes[g.id] ?? "…") : "Not set up"}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {conversation.e2ee && conversation.e2ee.missing.length > 0 && (
        <p className="muted small">Someone reset their keys. A new conversation key is made the next time anyone sends a message.</p>
      )}
    </Modal>
  );
}
