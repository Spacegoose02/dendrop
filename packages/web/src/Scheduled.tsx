import { useEffect, useState } from "react";
import type { Conversation, Message, ScheduledMessage } from "@dendrop/shared";
import { api } from "./api.ts";
import { reveal } from "./e2ee.ts";
import { reminderChoices, useDismiss } from "./Fun.tsx";
import { Modal } from "./Modal.tsx";
import { scheduledWords } from "./send.ts";

/**
 * Send later: the "schedule it" menu by the Send button, and the list of a chat's scheduled
 * messages (see, edit, send now, cancel). Shell passes the gateway's scheduled.* events on as
 * a window event, so every open chat stays in step.
 */

export const SCHEDULED_EVENT = "dendrop:scheduled";
export type ScheduledEventDetail = { kind: "updated"; scheduled: ScheduledMessage } | { kind: "removed"; id: number; conversationId: number };

/** A scheduled message with its words readable (decrypted, for encrypted chats). */
export type ShownScheduled = ScheduledMessage & { text: string; locked?: string };

const show = async (s: ScheduledMessage, meId: number): Promise<ShownScheduled> => {
  if (!s.keyVersion) return { ...s, text: s.body };
  // Decrypts like a message of yours in that chat.
  const shown = await reveal({ id: -s.id, conversationId: s.conversationId, authorId: meId, body: s.body, keyVersion: s.keyVersion, deleted: false } as unknown as Message);
  return { ...s, text: shown.text, ...(shown.locked ? { locked: shown.locked } : {}) };
};

const byTime = (a: ScheduledMessage, b: ScheduledMessage) => a.sendAt.localeCompare(b.sendAt) || a.id - b.id;

export const whenText = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A date as a datetime-local input's value, in local time. */
const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** This chat's scheduled messages, kept up to date. */
export function useScheduled(conversationId: number, meId: number): ShownScheduled[] {
  const [list, setList] = useState<ShownScheduled[]>([]);
  useEffect(() => {
    let live = true;
    setList([]);
    api<ScheduledMessage[]>(`/api/scheduled?conversationId=${conversationId}`)
      .then((raw) => Promise.all(raw.map((s) => show(s, meId))))
      .then((shown) => live && setList(shown))
      .catch(() => {});
    const on = (e: Event) => {
      const d = (e as CustomEvent<ScheduledEventDetail>).detail;
      if (d.kind === "removed") {
        if (d.conversationId === conversationId) setList((l) => l.filter((x) => x.id !== d.id));
        return;
      }
      if (d.scheduled.conversationId !== conversationId) return;
      void show(d.scheduled, meId).then((s) => live && setList((l) => [...l.filter((x) => x.id !== s.id), s].sort(byTime)));
    };
    window.addEventListener(SCHEDULED_EVENT, on);
    return () => {
      live = false;
      window.removeEventListener(SCHEDULED_EVENT, on);
    };
  }, [conversationId, meId]);
  return list;
}

/** The quick picks for when to send, plus any date and time. */
export function ScheduleMenu({ onPick, onClose }: { onPick: (when: Date) => void; onClose: () => void }) {
  const ref = useDismiss(onClose);
  const [custom, setCustom] = useState("");
  return (
    <div className="fun-menu schedule-menu" ref={ref} role="menu" aria-label="Send later">
      <div className="fun-sep small muted">Send later…</div>
      {reminderChoices().map(([label, when]) => (
        <button key={label} className="fun-item compact" role="menuitem" onClick={() => onPick(when)}>
          {label}
        </button>
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (custom) onPick(new Date(custom));
        }}
      >
        <input type="datetime-local" value={custom} min={localInput(new Date())} onChange={(e) => setCustom(e.target.value)} aria-label="Pick a date and time" />
        <button className="small-button" disabled={!custom}>
          Schedule
        </button>
      </form>
    </div>
  );
}

/** The line above the composer: how many are waiting here, and whether any couldn't go out. */
export function ScheduledBar({ list, onOpen }: { list: ShownScheduled[]; onOpen: () => void }) {
  if (!list.length) return null;
  const failed = list.filter((s) => s.error).length;
  return (
    <p className={`small scheduled-bar ${failed ? "error" : "muted"}`} role="status">
      🕒 {failed ? `${failed} scheduled ${failed === 1 ? "message" : "messages"} couldn't be sent.` : list.length === 1 ? `1 message scheduled for ${whenText(list[0]!.sendAt)}.` : `${list.length} messages scheduled.`}{" "}
      <button className="link" onClick={onOpen}>
        {failed ? "Fix it" : "See scheduled"}
      </button>
    </p>
  );
}

/** Every scheduled message in this chat: edit the words or time, send now, or cancel. */
export function ScheduledDialog({
  list,
  conversation,
  meId,
  plain,
  toDraft,
  fromDraft,
  onSent,
  onClose,
}: {
  list: ShownScheduled[];
  conversation: Conversation;
  meId: number;
  plain: boolean;
  /** Stored words (with emoji and mention tokens) to what you'd type, and back. */
  toDraft: (body: string) => string;
  fromDraft: (text: string) => string;
  onSent: (m: Message) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<{ id: number; text: string; when: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (id: number, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = (s: ShownScheduled) =>
    run(s.id, async () => {
      if (!editing) return;
      const text = fromDraft(editing.text.trim());
      if (!text) throw new Error("A message needs text");
      const fresh = await api<Conversation>(`/api/conversations/${conversation.id}`);
      // Re-encrypted every time, so a key that changed since scheduling is picked up.
      const words = text !== s.text || s.locked || (fresh.e2ee && !s.keyVersion) ? await scheduledWords(fresh, meId, plain, text) : {};
      await api(`/api/scheduled/${s.id}`, { method: "PATCH", body: { ...words, sendAt: new Date(editing.when).toISOString() } });
      setEditing(null);
    });
  return (
    <Modal title="Scheduled messages" onClose={onClose}>
      {list.length === 0 && <p className="muted">Nothing scheduled here.</p>}
      <ul className="scheduled-list">
        {list.map((s) => (
          <li key={s.id} className="scheduled-item">
            {editing?.id === s.id ? (
              <form
                className="scheduled-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(s);
                }}
              >
                <textarea value={editing.text} rows={3} onChange={(e) => setEditing({ ...editing, text: e.target.value })} aria-label="Message" autoFocus />
                <input type="datetime-local" value={editing.when} min={localInput(new Date())} onChange={(e) => setEditing({ ...editing, when: e.target.value })} aria-label="When to send" required />
                <div className="row">
                  <button className="primary small-button" disabled={busy === s.id}>
                    Save
                  </button>
                  <button type="button" className="small-button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <>
                <div className="small muted">
                  🕒 {whenText(s.sendAt)}
                  {s.replyToId ? " · a reply" : ""}
                </div>
                <div className="scheduled-text">{s.locked ? <em className="muted">{s.locked}</em> : toDraft(s.text)}</div>
                {s.error && <p className="error small">Couldn't send: {s.error}</p>}
                <div className="row">
                  <button
                    className="link"
                    disabled={busy === s.id}
                    onClick={() => {
                      // A time that already passed gets bumped ahead, so saving just works.
                      const when = Date.parse(s.sendAt) > Date.now() ? new Date(s.sendAt) : new Date(Date.now() + 10 * 60_000);
                      setEditing({ id: s.id, text: s.locked ? "" : toDraft(s.text), when: localInput(when) });
                    }}
                  >
                    Edit
                  </button>
                  <button className="link" disabled={busy === s.id || !!s.locked} onClick={() => void run(s.id, async () => onSent(await api<Message>(`/api/scheduled/${s.id}/send`, { method: "POST" })))}>
                    Send now
                  </button>
                  <button className="link danger" disabled={busy === s.id} onClick={() => void run(s.id, () => api(`/api/scheduled/${s.id}`, { method: "DELETE" }).then(() => {}))}>
                    Cancel it
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="error small">{error}</p>}
    </Modal>
  );
}
