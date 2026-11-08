import { useEffect, useRef, useState, type ReactNode } from "react";
import { FUN_LIMITS, NUDGES, parseDice, RPS_PICKS, type Game, type GameKind, type Message, type NudgeKind, type Reminder, type RpsPick } from "@dendrop/shared";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";
import type { ChatMessage } from "./e2ee.ts";

/**
 * Polls, quick games, raccoon nudges, reminders and voice messages: the cards shown in chats and
 * the menus that start them. Chat.tsx wires them into the message list and the composer.
 */

const RPS_EMOJI: Record<RpsPick, string> = { rock: "🪨", paper: "📄", scissors: "✂️" };
const NUDGE_SENT: Record<NudgeKind, string> = {
  poke: "a poke",
  wave: "a wave",
  snack: "a snack",
  hug: "a raccoon hug",
  zoomies: "the zoomies",
  trash: "some trash treasure",
};

/** Closes a popover on a click outside it or Escape. */
export function useDismiss(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (ref.current && !ref.current.contains(t) && !t.closest("[data-fun-toggle]")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      removeEventListener("keydown", key);
    };
  }, [onClose]);
  return ref;
}

const until = (iso: string) => {
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} days`;
};

// ---- Polls ---------------------------------------------------------------------------------

export function PollCard({
  m,
  meId,
  nameOf,
  mask,
  disabled,
  onChanged,
  onError,
}: {
  m: ChatMessage;
  meId: number;
  nameOf: (id: number) => string;
  /** The kid family filter, if on. */
  mask: (s: string) => string;
  disabled: boolean;
  onChanged: (m: Message) => void;
  onError: (msg: string) => void;
}) {
  const poll = m.poll!;
  const [busy, setBusy] = useState(false);
  const question = poll.question ?? m.text;
  const options = poll.options ?? m.pollOptions ?? Array.from({ length: poll.optionCount }, (_, i) => `Option ${i + 1}`);
  const voters = new Set(poll.votes.flat());
  const mine = poll.votes.flatMap((ids, i) => (ids.includes(meId) ? [i] : []));
  const top = Math.max(...poll.votes.map((v) => v.length));
  const canVote = !poll.closed && !disabled && !busy;

  const act = async (url: string, body?: object) => {
    setBusy(true);
    try {
      onChanged(await api<Message>(url, { body: body ?? {} }));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = (i: number) => {
    const next = poll.multi ? (mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i]) : mine.includes(i) ? [] : [i];
    void act(`/api/messages/${m.id}/votes`, { options: next });
  };

  return (
    <div className="fun-card poll-card">
      <div className="fun-card-title">
        <span aria-hidden>📊</span> <strong>{mask(question)}</strong>
      </div>
      <div className="poll-options" role={poll.multi ? "group" : "radiogroup"} aria-label={question}>
        {options.map((o, i) => {
          const count = poll.votes[i]?.length ?? 0;
          const pct = voters.size ? Math.round((count / voters.size) * 100) : 0;
          const picked = mine.includes(i);
          return (
            <button
              key={i}
              className={`poll-option ${picked ? "picked" : ""} ${poll.closed && count === top && count > 0 ? "winner" : ""}`}
              role={poll.multi ? "checkbox" : "radio"}
              aria-checked={picked}
              disabled={!canVote}
              onClick={() => pick(i)}
              title={count ? (poll.votes[i] ?? []).map(nameOf).join(", ") : "No votes yet"}
            >
              <span className="poll-bar" style={{ width: `${pct}%` }} aria-hidden />
              <span className="poll-check" aria-hidden>
                {picked ? "✓" : ""}
              </span>
              <span className="poll-label">{mask(o)}</span>
              <span className="poll-count">{voters.size ? `${count} · ${pct}%` : ""}</span>
            </button>
          );
        })}
      </div>
      <div className="fun-card-foot small muted">
        {voters.size === 1 ? "1 vote" : `${voters.size} votes`} · {poll.multi ? "Pick any" : "Pick one"} ·{" "}
        {poll.closed ? "Closed" : poll.closesAt ? `Closes in ${until(poll.closesAt)}` : "Open"}
        {!poll.closed && m.authorId === meId && !disabled && (
          <>
            {" · "}
            <button className="link" disabled={busy} onClick={() => void act(`/api/messages/${m.id}/close-poll`)}>
              Close poll
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export interface NewPoll {
  question: string;
  options: string[];
  multi: boolean;
  closesInMinutes: number | null;
}

const CLOSE_AFTER: [string, number | null][] = [
  ["Never", null],
  ["1 hour", 60],
  ["1 day", 1440],
  ["3 days", 3 * 1440],
  ["1 week", 7 * 1440],
];

/** Making a poll: a question, 2 to 10 options, one or many answers, and when voting ends. */
export function PollDialog({ encrypted, onCreate, onClose, initial }: { encrypted: boolean; onCreate: (p: NewPoll) => Promise<void>; onClose: () => void; initial?: Partial<NewPoll> }) {
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [options, setOptions] = useState<string[]>(initial?.options ?? ["", ""]);
  const [multi, setMulti] = useState(initial?.multi ?? false);
  const [closeAfter, setCloseAfter] = useState<number | null>(initial?.closesInMinutes ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const dupes = new Set(filled.map((o) => o.toLowerCase())).size !== filled.length;
  const ok = question.trim() && filled.length >= 2 && !dupes;

  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ question: question.trim(), options: filled, multi, closesInMinutes: closeAfter });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Make a poll" onClose={onClose}>
      <form
        className="stack poll-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          Question
          <input autoFocus value={question} maxLength={FUN_LIMITS.pollQuestion} placeholder="Where should we raid for snacks?" onChange={(e) => setQuestion(e.target.value)} />
        </label>
        <fieldset className="poll-form-options">
          <legend>Options</legend>
          {options.map((o, i) => (
            <div className="row" key={i}>
              <input
                value={o}
                maxLength={FUN_LIMITS.pollOption}
                placeholder={`Option ${i + 1}`}
                aria-label={`Option ${i + 1}`}
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {options.length > 2 && (
                <button type="button" className="ghost" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                  ✕
                </button>
              )}
            </div>
          ))}
          {options.length < FUN_LIMITS.pollOptions && (
            <button type="button" className="ghost small-button" onClick={() => setOptions([...options, ""])}>
              + Add an option
            </button>
          )}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Let people pick more than one
        </label>
        <label>
          Close voting after
          <select value={String(closeAfter)} onChange={(e) => setCloseAfter(e.target.value === "null" ? null : Number(e.target.value))}>
            {CLOSE_AFTER.map(([label, mins]) => (
              <option key={label} value={String(mins)}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {encrypted && <p className="small muted">🔒 The question and options are end-to-end encrypted. The server only sees how many options there are and the votes.</p>}
        {dupes && <p className="error small">Each option has to be different.</p>}
        {error && <p className="error small">{error}</p>}
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!ok || busy}>
            {busy ? "Posting…" : "Post poll"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Games ---------------------------------------------------------------------------------

export function GameCard({
  m,
  meId,
  nameOf,
  disabled,
  onChanged,
  onError,
  onRematch,
}: {
  m: ChatMessage;
  meId: number;
  nameOf: (id: number) => string;
  disabled: boolean;
  onChanged: (m: Message) => void;
  onError: (msg: string) => void;
  /** Starts a new game of the same kind. */
  onRematch: (kind: GameKind, dice?: string) => void;
}) {
  const g = m.game!;
  const [busy, setBusy] = useState(false);
  const playing = g.players.includes(meId);
  const open = g.kind !== "dice" && g.players.length < 2 && !g.done;
  const can = !disabled && !busy;
  const play = async (body: object) => {
    setBusy(true);
    try {
      onChanged(await api<Message>(`/api/messages/${m.id}/game`, { body }));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const who = (id: number | undefined) => (id === undefined ? "?" : id === meId ? "You" : nameOf(id));
  const join = open && !playing && (
    <button className="primary small-button" disabled={!can} onClick={() => void play({ action: "join" })}>
      Play
    </button>
  );
  const again = g.done && (playing || g.kind === "dice") && (
    <button className="ghost small-button" disabled={disabled} onClick={() => onRematch(g.kind, g.dice?.spec)}>
      {g.kind === "dice" ? "Roll again" : "Rematch"}
    </button>
  );
  const result = (draw: string) => (g.draw ? draw : g.winner === meId ? "🦝 You win the trash can!" : `🦝 ${who(g.winner ?? undefined)} wins the trash can!`);

  if (g.kind === "dice") {
    const d = g.dice!;
    return (
      <div className="fun-card play-card">
        <div className="fun-card-title">
          <span aria-hidden>🎲</span> {who(m.authorId)} rolled <strong>{d.spec}</strong>
        </div>
        <div className="dice-row" aria-label={`Rolled ${d.rolls.join(", ")}, total ${d.total}`}>
          {d.rolls.map((r, i) => (
            <span className="die" key={i}>
              {r}
            </span>
          ))}
          {d.rolls.length > 1 && <span className="dice-total">= {d.total}</span>}
        </div>
        <div className="fun-card-foot">{again}</div>
      </div>
    );
  }

  if (g.kind === "rps") {
    const myPicked = g.picked.includes(meId);
    return (
      <div className="fun-card play-card">
        <div className="fun-card-title">
          <span aria-hidden>✊</span> Rock paper scissors: <strong>{who(g.players[0])}</strong> vs <strong>{g.players[1] ? who(g.players[1]) : "an open seat"}</strong>
        </div>
        {g.done ? (
          <div className="rps-reveal">
            {g.players.map((p, i) => (
              <span key={p} className={g.winner === p ? "winner" : ""}>
                <span className="rps-big" aria-hidden>
                  {RPS_EMOJI[g.picks![i]!]}
                </span>
                {who(p)}: {g.picks![i]}
              </span>
            ))}
          </div>
        ) : playing && !myPicked ? (
          <div className="rps-picks" role="group" aria-label="Pick one">
            {RPS_PICKS.map((p) => (
              <button key={p} className="rps-pick" disabled={!can} onClick={() => void play({ action: "pick", pick: p })} title={p}>
                <span aria-hidden>{RPS_EMOJI[p]}</span>
                <span className="small">{p}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="fun-card-foot small muted">
          {g.done
            ? result("🤝 It's a draw!")
            : g.players
                .map((p) => `${who(p)} ${g.picked.includes(p) ? "picked ✓" : "is thinking…"}`)
                .join(" · ") + (open ? " · waiting for someone to play" : "")}{" "}
          {join} {again}
        </div>
      </div>
    );
  }

  const myTurn = g.turn === meId;
  const mark = (v: number) => (v === 1 ? "❌" : v === 2 ? "⭕" : "");
  return (
    <div className="fun-card play-card">
      <div className="fun-card-title">
        <span aria-hidden>❌⭕</span> Tic-tac-toe: <strong>{who(g.players[0])}</strong> ❌ vs <strong>{g.players[1] ? who(g.players[1]) : "an open seat"}</strong> ⭕
      </div>
      <div className="ttt-board" role="grid" aria-label="Tic-tac-toe board">
        {g.board!.map((v, i) => (
          <button
            key={i}
            className={`ttt-cell ${g.line?.includes(i) ? "win" : ""}`}
            disabled={!can || !myTurn || v !== 0}
            aria-label={`Square ${i + 1}${v ? `: ${v === 1 ? "X" : "O"}` : ""}`}
            onClick={() => void play({ action: "move", cell: i })}
          >
            {mark(v)}
          </button>
        ))}
      </div>
      <div className="fun-card-foot small muted">
        {g.done ? result("🤝 It's a draw!") : open ? "Waiting for someone to play" : myTurn ? <strong className="your-turn">Your move</strong> : `${who(g.turn ?? undefined)}'s move`} {join} {again}
      </div>
    </div>
  );
}

// ---- Nudges --------------------------------------------------------------------------------

export function NudgeCard({ kind, mine, name }: { kind: NudgeKind; mine: boolean; name: string }) {
  const n = NUDGES[kind];
  return (
    <div className="nudge-card">
      <span className="nudge-emoji" aria-hidden>
        {n.emoji}
      </span>
      <span>{mine ? `You sent ${NUDGE_SENT[kind]}` : `${name} ${n.text}`}</span>
    </div>
  );
}

// ---- The composer's fun menu ---------------------------------------------------------------

export function FunMenu({
  onPoll,
  onGame,
  onNudge,
  onClose,
}: {
  onPoll: () => void;
  onGame: (kind: GameKind, dice?: string) => void;
  /** Unset where nudges aren't allowed (server channels). */
  onNudge?: (kind: NudgeKind) => void;
  onClose: () => void;
}) {
  const ref = useDismiss(onClose);
  const [dice, setDice] = useState("2d6");
  const diceOk = !!parseDice(dice);
  const item = (icon: string, label: string, hint: string, go: () => void): ReactNode => (
    <button
      className="fun-item"
      onClick={() => {
        go();
        onClose();
      }}
    >
      <span className="fun-item-icon" aria-hidden>
        {icon}
      </span>
      <span>
        <strong>{label}</strong>
        <span className="small muted">{hint}</span>
      </span>
    </button>
  );
  return (
    <div className="fun-menu" ref={ref} role="menu" aria-label="Polls and games">
      {item("📊", "Poll", "Ask everyone a question", onPoll)}
      {item("❌", "Tic-tac-toe", "Three in a row wins", () => onGame("tictactoe"))}
      {item("✊", "Rock paper scissors", "Picks stay secret until both are in", () => onGame("rps"))}
      <form
        className="fun-dice"
        onSubmit={(e) => {
          e.preventDefault();
          if (!diceOk) return;
          onGame("dice", dice);
          onClose();
        }}
      >
        <span className="fun-item-icon" aria-hidden>
          🎲
        </span>
        <label className="grow">
          <strong>Roll dice</strong>
          <input value={dice} onChange={(e) => setDice(e.target.value)} aria-label="Dice to roll, like 2d6" aria-invalid={!diceOk} />
        </label>
        <button className="primary small-button" disabled={!diceOk}>
          Roll
        </button>
      </form>
      <div className="fun-quick-dice">
        {["d6", "2d6", "d20", "d100"].map((d) => (
          <button
            key={d}
            className="ghost small-button"
            onClick={() => {
              onGame("dice", d);
              onClose();
            }}
          >
            {d}
          </button>
        ))}
      </div>
      {onNudge && (
        <>
          <div className="fun-sep small muted">Raccoon nudges</div>
          <div className="fun-nudges">
            {(Object.keys(NUDGES) as NudgeKind[]).map((k) => (
              <button
                key={k}
                className="ghost"
                title={`Send ${NUDGE_SENT[k]}`}
                aria-label={`Send ${NUDGE_SENT[k]}`}
                onClick={() => {
                  onNudge(k);
                  onClose();
                }}
              >
                {NUDGES[k].emoji}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** "/roll 2d6", "/ttt", "/rps", "/poll", "/nudge": quick ways to start things from the composer. */
export function slashCommand(text: string): { kind: "game"; game: GameKind; dice?: string } | { kind: "poll"; question?: string } | { kind: "nudge"; nudge: NudgeKind } | null {
  const m = /^\/(\w+)(?:\s+(.*))?$/s.exec(text.trim());
  if (!m) return null;
  const arg = m[2]?.trim() ?? "";
  switch (m[1]!.toLowerCase()) {
    case "roll":
    case "dice":
      return { kind: "game", game: "dice", dice: arg || "1d6" };
    case "ttt":
    case "tictactoe":
      return { kind: "game", game: "tictactoe" };
    case "rps":
      return { kind: "game", game: "rps" };
    case "poll":
      return { kind: "poll", question: arg || undefined };
    case "nudge":
    case "poke":
      return { kind: "nudge", nudge: arg && Object.hasOwn(NUDGES, arg) ? (arg as NudgeKind) : "poke" };
    default:
      return null;
  }
}

// ---- Reminders -----------------------------------------------------------------------------

const at = (d: Date, h: number) => {
  const x = new Date(d);
  x.setHours(h, 0, 0, 0);
  return x;
};

/** The quick picks for "ping me about this", worked out from now. */
export function reminderChoices(now = new Date()): [string, Date][] {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + 7);
  const list: [string, Date][] = [
    ["In 20 minutes", new Date(now.getTime() + 20 * 60_000)],
    ["In 1 hour", new Date(now.getTime() + 60 * 60_000)],
    ["In 3 hours", new Date(now.getTime() + 3 * 60 * 60_000)],
  ];
  if (now.getHours() < 19) list.push(["This evening (8 pm)", at(now, 20)]);
  list.push(["Tomorrow morning (9 am)", at(tomorrow, 9)], ["Next week", at(nextWeek, 9)]);
  return list;
}

export function RemindMenu({ messageId, onDone, onClose }: { messageId: number; onDone: (text: string) => void; onClose: () => void }) {
  const ref = useDismiss(onClose);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const set = async (when: Date) => {
    try {
      await api(`/api/messages/${messageId}/reminders`, { body: { at: when.toISOString() } });
      // So the reminder can pop up even when Dendrop is in the background.
      if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission().catch(() => {});
      onDone(`⏰ I'll remind you ${when.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="fun-menu remind-menu" ref={ref} role="menu" aria-label="Remind me about this">
      <div className="fun-sep small muted">Ping me about this…</div>
      {reminderChoices().map(([label, when]) => (
        <button key={label} className="fun-item compact" role="menuitem" onClick={() => void set(when)}>
          {label}
        </button>
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (custom) void set(new Date(custom));
        }}
      >
        <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Pick a time" />
        <button className="small-button" disabled={!custom}>
          Set
        </button>
      </form>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

// ---- Voice messages ------------------------------------------------------------------------

/** Voice messages are audio files named voice-message-<seconds>s.<ext>. */
export const voiceSeconds = (name: string): number | null => {
  const m = /^voice-message-(\d+)s\.\w+$/.exec(name);
  return m ? Number(m[1]) : null;
};
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function recorderType(): string {
  for (const t of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return "";
}

/** Records a voice message from the microphone. Hands back the file to send, or nothing if cancelled. */
export function VoiceRecorder({ onDone, onError }: { onDone: (file: File | null) => void; onError: (msg: string) => void }) {
  const [secs, setSecs] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const keep = useRef(true);
  const started = useRef(0);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let tick: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const chunks: Blob[] = [];
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const type = recorderType();
        const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
        rec.current = r;
        r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        r.onstop = () => {
          stream?.getTracks().forEach((t) => t.stop());
          const length = Math.max(1, Math.round((Date.now() - started.current) / 1000));
          if (!keep.current || !chunks.length) return onDone(null);
          const mime = (r.mimeType || "audio/webm").split(";")[0]!;
          const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm";
          onDone(new File(chunks, `voice-message-${length}s.${ext}`, { type: mime }));
        };
        started.current = Date.now();
        r.start(250);
        tick = setInterval(() => {
          const s = (Date.now() - started.current) / 1000;
          setSecs(s);
          if (s >= FUN_LIMITS.voiceSeconds) r.stop();
        }, 250);
      } catch {
        onError("Couldn't use the microphone. Check that Dendrop is allowed to use it.");
        onDone(null);
      }
    })();
    return () => {
      stopped = true;
      clearInterval(tick);
      if (rec.current?.state === "recording") {
        keep.current = false;
        rec.current.stop();
      }
      stream?.getTracks().forEach((t) => t.stop());
    };
    // Runs once per recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (send: boolean) => {
    keep.current = send;
    if (rec.current?.state === "recording") rec.current.stop();
    else onDone(null);
  };

  return (
    <div className="voice-recorder" role="status">
      <span className="rec-dot" aria-hidden />
      <span>Recording {clock(secs)}</span>
      <span className="muted small">up to {clock(FUN_LIMITS.voiceSeconds)}</span>
      <span className="grow" />
      <button className="ghost" onClick={() => finish(false)}>
        Cancel
      </button>
      <button className="primary small-button" onClick={() => finish(true)}>
        Send
      </button>
    </div>
  );
}

/**
 * A voice message or other audio file, played inline. `load` fetches the bytes (and decrypts
 * them in an encrypted chat), so playback works whatever the download headers say.
 */
export function AudioPlayer({ name, load }: { name: string; load: () => Promise<Blob> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const voice = voiceSeconds(name);
  useEffect(() => {
    let made: string | null = null;
    let cancelled = false;
    load()
      .then((b) => {
        if (cancelled) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
    // The loader changes identity each render; the file doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  return (
    <div className="audio-attachment">
      <span className="small">
        {voice !== null ? "🎤 Voice message" : `🎵 ${name}`}
        {voice !== null && <span className="muted"> · {clock(voice)}</span>}
      </span>
      {failed ? <span className="muted small">Couldn't load it.</span> : url ? <audio controls preload="metadata" src={url} /> : <span className="muted small">Loading…</span>}
    </div>
  );
}

// ---- Reminders that went off ---------------------------------------------------------------

export interface FiredReminder {
  reminder: Reminder;
  /** A bit of the message, when it could be read. */
  excerpt: string | null;
}

/** A short line about a message, for a reminder. */
export function excerptOf(m: ChatMessage): string | null {
  if (m.deleted || m.locked) return null;
  const text = m.poll ? `📊 ${m.poll.question ?? m.text}` : m.game ? "a game" : m.nudge ? "a nudge" : m.text || (m.attachments.length ? "a file" : "");
  if (!text) return null;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

export function ReminderTray({
  items,
  titleOf,
  onOpen,
  onDismiss,
}: {
  items: FiredReminder[];
  titleOf: (conversationId: number) => string;
  onOpen: (r: Reminder) => void;
  onDismiss: (r: Reminder) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="reminder-tray" role="status" aria-live="polite">
      {items.map(({ reminder: r, excerpt }) => (
        <div className="reminder" key={r.id}>
          <span aria-hidden>⏰</span>
          <span className="grow">
            <strong>Reminder</strong> <span className="muted">in {titleOf(r.conversationId)}:</span> {excerpt ? `“${excerpt}”` : "a message you wanted to come back to"}
          </span>
          <button className="link" onClick={() => onOpen(r)}>
            Open
          </button>
          <button className="link" onClick={() => onDismiss(r)}>
            Done
          </button>
        </div>
      ))}
    </div>
  );
}
