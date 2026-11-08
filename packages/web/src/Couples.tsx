import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COUPLES_LIMITS, type Conversation, type CouplesItem, type CouplesKind, type CouplesKit, type Me, type Message } from "@dendrop/shared";
import { api, apiForm, ApiError } from "./api.ts";
import { BUILTIN_DECKS, STARTER_IDEAS, STARTER_SPINNER, WOULD_YOU_RATHER } from "./couplesContent.ts";
import { decryptKitItem, decryptKitPhoto, encryptKitItem, encryptKitPhoto, encryptMessage, keyring, type FileMeta } from "./e2ee.ts";
import { Modal } from "./Modal.tsx";
import "./couples.css";

/**
 * The couples kit: private extras in a 1:1 chat between two adults, once both say yes. Everything
 * in it is end-to-end encrypted, kept out of the message history, and never offered to kid
 * accounts. See docs/COUPLES.md.
 */

/** Fired by the shell when the server says a kit changed. */
export const COUPLES_EVENT = "dendrop:couples";
export interface CouplesEventDetail {
  conversationId: number;
  noteFrom?: number;
}

// What each kind of item holds, inside its encryption.
interface IdeaData {
  t: string;
}
interface QuestionData {
  q: string;
  o: string[];
}
interface CardData {
  deck: string;
  t: string;
}
interface SpinnerData {
  name: string;
  o: string[];
}
interface PhotoData {
  meta: FileMeta;
  caption: string;
}
interface NoteData {
  t: string;
}
interface CountdownData {
  t: string;
  /** YYYY-MM-DD */
  at: string;
  e: string;
}

type Shown<T = unknown> = CouplesItem & { data?: T; locked?: string };

/** Fetches a conversation's kit and keeps it fresh. */
export function useCouplesKit(conversationId: number, enabled: boolean): { kit: CouplesKit | null; reload: () => void } {
  const [kit, setKit] = useState<CouplesKit | null>(null);
  const reload = useCallback(() => {
    if (!enabled) return;
    api<CouplesKit>(`/api/couples/${conversationId}`)
      .then(setKit)
      .catch(() => setKit(null));
  }, [conversationId, enabled]);
  useEffect(() => {
    reload();
    const on = (e: Event) => (e as CustomEvent<CouplesEventDetail>).detail.conversationId === conversationId && reload();
    window.addEventListener(COUPLES_EVENT, on);
    return () => window.removeEventListener(COUPLES_EVENT, on);
  }, [conversationId, reload]);
  return { kit, reload };
}

async function reveal(items: CouplesItem[]): Promise<Shown[]> {
  return Promise.all(
    items.map(async (i) => {
      if (!i.body) return { ...i };
      try {
        return { ...i, data: await decryptKitItem(i) };
      } catch (err) {
        return { ...i, locked: (err as Error).message || "This couldn't be opened" };
      }
    }),
  );
}

const random = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0]! % n;
const daysUntil = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const today = new Date();
  const a = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.UTC(y, m - 1, d) - a) / 86_400_000);
};

type Tab = "ideas" | "questions" | "prompts" | "spinner" | "photos" | "notes" | "countdowns" | "settings";
const TABS: [Tab, string, string][] = [
  ["ideas", "💡", "Yes / No / Maybe"],
  ["questions", "❓", "Questions"],
  ["prompts", "🃏", "Prompts"],
  ["spinner", "🎡", "Spinner"],
  ["photos", "📸", "View once"],
  ["notes", "💌", "Love notes"],
  ["countdowns", "⏳", "Countdowns"],
  ["settings", "⚙️", "Settings"],
];

export function CouplesKitDialog({ me, conversation, onClose }: { me: Me; conversation: Conversation; onClose: () => void }) {
  const cid = conversation.id;
  const partner = conversation.members.find((m) => m.id !== me.id);
  const name = partner?.displayName ?? "them";
  const { kit, reload } = useCouplesKit(cid, true);
  const [items, setItems] = useState<Shown[]>([]);
  const [tab, setTab] = useState<Tab>("ideas");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void reveal(kit?.items ?? []).then((x) => live && setItems(x));
    return () => {
      live = false;
    };
  }, [kit]);

  /** Runs something that needs the conversation key, getting a fresh conversation once on a key change. */
  const withKey = async <T,>(fn: (version: number) => Promise<T>): Promise<T> => {
    const attempt = async (c: Conversation) => {
      const version = await keyring.forSending(c);
      if (!version) throw new Error("This chat isn't end-to-end encrypted yet");
      return fn(version);
    };
    try {
      return await attempt(conversation);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) throw err;
      return attempt(await api<Conversation>(`/api/conversations/${cid}`));
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = (kind: CouplesKind, data: unknown, extra: { deliverAt?: string } = {}) =>
    withKey(async (version) =>
      api<CouplesItem>(`/api/couples/${cid}/items`, { body: { kind, body: await encryptKitItem(cid, me.id, kind, version, data), keyVersion: version, ...extra } }),
    );
  const edit = (item: CouplesItem, data: unknown) =>
    withKey(async (version) =>
      api<CouplesItem>(`/api/couples/${cid}/items/${item.id}`, {
        method: "PATCH",
        body: { body: await encryptKitItem(cid, me.id, item.kind, version, data), keyVersion: version },
      }),
    );
  const remove = (item: CouplesItem) => api(`/api/couples/${cid}/items/${item.id}`, { method: "DELETE" });
  const vote = (item: CouplesItem, v: string | number | null) => api<CouplesItem>(`/api/couples/${cid}/items/${item.id}/vote`, { method: "PUT", body: { vote: v } });
  /** Posts something into the chat itself (an ordinary encrypted message). */
  const share = (text: string) =>
    withKey(async (version) =>
      api<Message>(`/api/conversations/${cid}/messages`, { body: { body: await encryptMessage(cid, me.id, version, text), keyVersion: version } }),
    );

  const ctx: Ctx = { me, name, items, busy, run, add, edit, remove, vote, share, cid, withKey };

  let body;
  if (!kit) body = <p className="muted">Loading…</p>;
  else if (kit.state !== "on" || kit.unavailable) body = <Invite me={me} kit={kit} name={name} run={run} busy={busy} cid={cid} />;
  else
    body = (
      <>
        <nav className="couples-tabs" aria-label="Couples kit">
          {TABS.map(([t, icon, label]) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} title={label} aria-label={label}>
              <span aria-hidden>{icon}</span>
              <span className="couples-tab-label">{label}</span>
            </button>
          ))}
        </nav>
        <div className="couples-body">
          {tab === "ideas" && <Ideas {...ctx} />}
          {tab === "questions" && <Questions {...ctx} />}
          {tab === "prompts" && <Prompts {...ctx} />}
          {tab === "spinner" && <Spinner {...ctx} />}
          {tab === "photos" && <Photos {...ctx} />}
          {tab === "notes" && <Notes {...ctx} />}
          {tab === "countdowns" && <Countdowns {...ctx} />}
          {tab === "settings" && <KitSettings {...ctx} onOff={onClose} />}
        </div>
      </>
    );

  return (
    <Modal title={`💞 Couples kit with ${name}`} onClose={onClose} wide>
      <div className="couples-kit">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {body}
        <p className="muted small couples-footer">🔒 End-to-end encrypted, only for the two of you. Never shown to kid accounts or parents.</p>
      </div>
    </Modal>
  );
}

interface Ctx {
  me: Me;
  cid: number;
  name: string;
  items: Shown[];
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  add: (kind: CouplesKind, data: unknown, extra?: { deliverAt?: string }) => Promise<CouplesItem>;
  edit: (item: CouplesItem, data: unknown) => Promise<CouplesItem>;
  remove: (item: CouplesItem) => Promise<unknown>;
  vote: (item: CouplesItem, v: string | number | null) => Promise<CouplesItem>;
  share: (text: string) => Promise<Message>;
  withKey: <T>(fn: (version: number) => Promise<T>) => Promise<T>;
}

const of = <T,>(items: Shown[], kind: CouplesKind) => items.filter((i) => i.kind === kind) as Shown<T>[];

function Locked({ item }: { item: Shown }) {
  return <span className="muted small">🔒 {item.locked}</span>;
}

// ---- Turning it on ------------------------------------------------------------------

function Invite({ me, kit, name, run, busy, cid }: { me: Me; kit: CouplesKit; name: string; run: Ctx["run"]; busy: boolean; cid: number }) {
  const intro = (
    <>
      <p>
        A private corner of this chat for the two of you: a Yes / No / Maybe list that only shows what you <em>both</em> said yes to, your own
        questions and "would you rather", prompt cards, a date night spinner, view-once photos, love notes that arrive later, and countdowns.
      </p>
      <p className="muted small">
        It's end-to-end encrypted like your messages, kept apart from the chat history, and only works between two adult accounts. Either
        of you can turn it off at any time, which deletes everything in it.
      </p>
    </>
  );
  if (kit.unavailable)
    return (
      <>
        {intro}
        <p className="notice">{kit.unavailable}</p>
      </>
    );
  if (kit.state === "invited" && kit.invitedBy === me.id)
    return (
      <>
        {intro}
        <p className="notice">Waiting for {name} to say yes.</p>
        <button disabled={busy} onClick={() => void run(() => api(`/api/couples/${cid}`, { method: "DELETE" }))}>
          Cancel
        </button>
      </>
    );
  if (kit.state === "invited")
    return (
      <>
        <p className="notice">💞 {name} would like to turn on the couples kit with you.</p>
        {intro}
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void run(() => api(`/api/couples/${cid}/accept`, { body: {} }))}>
            Yes, turn it on
          </button>
          <button disabled={busy} onClick={() => void run(() => api(`/api/couples/${cid}`, { method: "DELETE" }))}>
            No thanks
          </button>
        </div>
      </>
    );
  return (
    <>
      {intro}
      <button className="primary" disabled={busy} onClick={() => void run(() => api(`/api/couples/${cid}/invite`, { body: {} }))}>
        Ask {name} to turn it on
      </button>
    </>
  );
}

// ---- Yes / No / Maybe ---------------------------------------------------------------

function Ideas({ items, add, vote, remove, run, busy, name }: Ctx) {
  const [text, setText] = useState("");
  const ideas = of<IdeaData>(items, "idea");
  const matches = ideas.filter((i) => i.match === "yes");
  const curious = ideas.filter((i) => i.match === "maybe");
  const todo = ideas.filter((i) => !i.myVote);
  const voted = ideas.filter((i) => i.myVote && !i.match);
  const have = new Set(ideas.map((i) => i.data?.t));

  const row = (i: Shown<IdeaData>) => (
    <li key={i.id} className="couples-row">
      <span className="couples-text">{i.data ? i.data.t : <Locked item={i} />}</span>
      <span className="vote-buttons">
        {(["yes", "maybe", "no"] as const).map((v) => (
          <button key={v} className={`chip ${i.myVote === v ? "on" : ""}`} disabled={busy} onClick={() => void run(() => vote(i, i.myVote === v ? null : v))}>
            {v === "yes" ? "Yes" : v === "maybe" ? "Maybe" : "No"}
          </button>
        ))}
        <button className="ghost" title="Delete" aria-label="Delete" disabled={busy} onClick={() => confirm("Delete this idea for both of you?") && void run(() => remove(i))}>
          ✕
        </button>
      </span>
    </li>
  );

  return (
    <>
      <p className="muted small">
        Add ideas and vote on each one privately. {name} never sees how you voted: only ideas you <strong>both</strong> said yes to show up as
        matches. "Maybe" means you'd talk about it: if you both lean in, it shows under "Both curious".
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (t) void run(async () => (await add("idea", { t }), setText("")));
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add an idea, anything you like…" maxLength={500} />
        <button className="primary" disabled={busy || !text.trim()}>
          Add
        </button>
      </form>
      {ideas.length === 0 && (
        <button className="link" disabled={busy} onClick={() => void run(async () => { for (const t of STARTER_IDEAS) if (!have.has(t)) await add("idea", { t }); })}>
          Add some starter ideas
        </button>
      )}
      {matches.length > 0 && (
        <>
          <h3 className="section-label">💞 You both said yes</h3>
          <ul className="couples-list">{matches.map(row)}</ul>
        </>
      )}
      {curious.length > 0 && (
        <>
          <h3 className="section-label">🤔 Both curious</h3>
          <ul className="couples-list">{curious.map(row)}</ul>
        </>
      )}
      {todo.length > 0 && (
        <>
          <h3 className="section-label">To vote on</h3>
          <ul className="couples-list">{todo.map(row)}</ul>
        </>
      )}
      {voted.length > 0 && (
        <>
          <h3 className="section-label">Your votes (no match yet)</h3>
          <ul className="couples-list">{voted.map(row)}</ul>
        </>
      )}
    </>
  );
}

// ---- Questions and would you rather -------------------------------------------------

function Questions({ me, items, add, vote, remove, run, busy, name }: Ctx) {
  const [q, setQ] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const questions = of<QuestionData>(items, "question").reverse();
  const clean = options.map((o) => o.trim()).filter(Boolean);

  return (
    <>
      <p className="muted small">Ask anything. Answers stay hidden until you've both answered, then you see each other's.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!q.trim() || clean.length < 2) return;
          void run(async () => {
            await add("question", { q: q.trim(), o: clean });
            setQ("");
            setOptions(["", ""]);
          });
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Your question, or &quot;Would you rather…&quot;" maxLength={500} />
        {options.map((o, n) => (
          <input
            key={n}
            value={o}
            onChange={(e) => setOptions(options.map((x, k) => (k === n ? e.target.value : x)))}
            placeholder={`Answer ${n + 1}`}
            maxLength={200}
          />
        ))}
        <div className="row">
          {options.length < COUPLES_LIMITS.questionOptions && (
            <button type="button" onClick={() => setOptions([...options, ""])}>
              + Answer
            </button>
          )}
          <button className="primary" disabled={busy || !q.trim() || clean.length < 2}>
            Ask {name}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const [wq, a, b] = WOULD_YOU_RATHER[random(WOULD_YOU_RATHER.length)]!;
              void run(() => add("question", { q: wq, o: [a, b] }));
            }}
          >
            🎲 Random would you rather
          </button>
        </div>
      </form>
      <ul className="couples-list">
        {questions.map((i) => {
          const mine = i.myVote === null ? null : Number(i.myVote);
          const theirs = i.answers ? Object.entries(i.answers).find(([u]) => Number(u) !== me.id)?.[1] : undefined;
          return (
            <li key={i.id} className="couples-card">
              {!i.data ? (
                <Locked item={i} />
              ) : (
                <>
                  <div className="couples-card-head">
                    <strong>{i.data.q}</strong>
                    <button className="ghost" title="Delete" aria-label="Delete" disabled={busy} onClick={() => confirm("Delete this question?") && void run(() => remove(i))}>
                      ✕
                    </button>
                  </div>
                  <div className="chips">
                    {i.data.o.map((o, n) => (
                      <button
                        key={n}
                        className={`chip ${mine === n ? "on" : ""} ${theirs === n ? "theirs" : ""}`}
                        disabled={busy || !!i.answers}
                        onClick={() => void run(() => vote(i, mine === n ? null : n))}
                      >
                        {o}
                        {i.answers && mine === n && " (you)"}
                        {i.answers && theirs === n && ` (${name})`}
                      </button>
                    ))}
                  </div>
                  <span className="muted small">
                    {i.answers
                      ? mine === theirs
                        ? "💞 Same answer!"
                        : "Different answers. Talk about it?"
                      : mine === null
                        ? i.partnerAnswered
                          ? `${name} answered. Your turn.`
                          : "Nobody has answered yet."
                        : `Waiting for ${name}.`}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---- Prompt decks -------------------------------------------------------------------

function Prompts({ items, add, remove, edit, share, run, busy, me }: Ctx) {
  const custom = of<CardData>(items, "card").filter((c) => c.data);
  const deckNames = useMemo(() => {
    const names = BUILTIN_DECKS.map((d) => d.name);
    for (const c of custom) if (!names.includes(c.data!.deck)) names.push(c.data!.deck);
    return names;
  }, [custom]);
  const [deck, setDeck] = useState(deckNames[0]!);
  const [card, setCard] = useState<string | null>(null);
  const [newDeck, setNewDeck] = useState("Ours");
  const [newCard, setNewCard] = useState("");
  const [editing, setEditing] = useState<{ id: number; t: string } | null>(null);
  const cards = [...(BUILTIN_DECKS.find((d) => d.name === deck)?.cards ?? []), ...custom.filter((c) => c.data!.deck === deck).map((c) => c.data!.t)];

  return (
    <>
      <div className="chips">
        {deckNames.map((d) => {
          const b = BUILTIN_DECKS.find((x) => x.name === d);
          return (
            <button key={d} className={`chip ${deck === d ? "on" : ""}`} onClick={() => (setDeck(d), setCard(null))}>
              {b?.emoji ?? "✍️"} {d}
            </button>
          );
        })}
      </div>
      <div className="prompt-card" aria-live="polite">
        {card ?? <span className="muted">Draw a card from "{deck}"</span>}
      </div>
      <div className="row">
        <button className="primary" disabled={!cards.length} onClick={() => setCard(cards[random(cards.length)]!)}>
          🃏 Draw a card
        </button>
        {card && (
          <button disabled={busy} onClick={() => void run(() => share(`🃏 ${card}`))}>
            Share in chat
          </button>
        )}
      </div>

      <h3 className="section-label">Your own cards</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const t = newCard.trim();
          const d = newDeck.trim() || "Ours";
          if (t) void run(async () => (await add("card", { deck: d, t }), setNewCard(""), setDeck(d), setCard(null)));
        }}
      >
        <input className="deck-input" value={newDeck} onChange={(e) => setNewDeck(e.target.value)} placeholder="Deck" maxLength={40} aria-label="Deck" />
        <input value={newCard} onChange={(e) => setNewCard(e.target.value)} placeholder="Write a card, as spicy as you two like" maxLength={500} />
        <button className="primary" disabled={busy || !newCard.trim()}>
          Add
        </button>
      </form>
      <ul className="couples-list">
        {custom.map((c) => (
          <li key={c.id} className="couples-row">
            {editing?.id === c.id ? (
              <form
                className="row grow"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (editing.t.trim()) void run(async () => (await edit(c, { ...c.data!, t: editing.t.trim() }), setEditing(null)));
                }}
              >
                <input value={editing.t} onChange={(e) => setEditing({ id: c.id, t: e.target.value })} maxLength={500} autoFocus />
                <button className="primary" disabled={busy}>
                  Save
                </button>
              </form>
            ) : (
              <span className="couples-text">
                <span className="muted small">{c.data!.deck} · </span>
                {c.data!.t}
              </span>
            )}
            <span>
              {c.authorId === me.id && editing?.id !== c.id && (
                <button className="ghost" title="Edit" aria-label="Edit" onClick={() => setEditing({ id: c.id, t: c.data!.t })}>
                  ✎
                </button>
              )}
              <button className="ghost" title="Delete" aria-label="Delete" disabled={busy} onClick={() => void run(() => remove(c))}>
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---- Date night spinner --------------------------------------------------------------

function Spinner({ me, items, add, edit, remove, share, run, busy }: Ctx) {
  const lists = of<SpinnerData>(items, "spinner").filter((l) => l.data);
  const [listId, setListId] = useState<number | null>(null);
  const list = lists.find((l) => l.id === listId) ?? lists[0];
  const [shown, setShown] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [option, setOption] = useState("");
  const [newName, setNewName] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const spin = () => {
    const o = list?.data?.o ?? [];
    if (o.length < 2) return;
    const landing = random(o.length);
    setResult(null);
    setSpinning(true);
    // Ticks through the options, slowing down, and lands on the one picked up front.
    let n = 0;
    const steps = 18 + random(o.length);
    const tick = () => {
      n++;
      if (n >= steps) {
        setShown(o[landing]!);
        setResult(o[landing]!);
        setSpinning(false);
        return;
      }
      setShown(o[(landing + n) % o.length]!);
      timer.current = setTimeout(tick, 30 + n * n * 0.4);
    };
    tick();
  };

  return (
    <>
      {lists.length === 0 ? (
        <>
          <p className="muted small">Make a list of options and let the spinner decide.</p>
          <button className="primary" disabled={busy} onClick={() => void run(() => add("spinner", { name: STARTER_SPINNER.name, o: STARTER_SPINNER.options }))}>
            Start with date night ideas
          </button>
        </>
      ) : (
        <>
          <div className="chips">
            {lists.map((l) => (
              <button key={l.id} className={`chip ${list?.id === l.id ? "on" : ""}`} onClick={() => (setListId(l.id), setShown(null), setResult(null))}>
                {l.data!.name}
              </button>
            ))}
          </div>
          {list && (
            <>
              <div className={`spinner-face ${spinning ? "spinning" : ""} ${result ? "landed" : ""}`} aria-live="polite">
                {shown ?? <span className="muted">🎡 Spin "{list.data!.name}"</span>}
              </div>
              <div className="row">
                <button className="primary" disabled={spinning || list.data!.o.length < 2} onClick={spin}>
                  🎡 Spin
                </button>
                {result && (
                  <button disabled={busy} onClick={() => void run(() => share(`🎡 The ${list.data!.name} spinner picked: ${result}`))}>
                    Share in chat
                  </button>
                )}
              </div>
              <ul className="couples-list">
                {list.data!.o.map((o, n) => (
                  <li key={`${n}-${o}`} className="couples-row">
                    <span className="couples-text">{o}</span>
                    {list.authorId === me.id && (
                      <button className="ghost" aria-label={`Remove ${o}`} disabled={busy} onClick={() => void run(() => edit(list, { ...list.data!, o: list.data!.o.filter((_, k) => k !== n) }))}>
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {list.authorId === me.id ? (
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const t = option.trim();
                    if (t) void run(async () => (await edit(list, { ...list.data!, o: [...list.data!.o, t] }), setOption("")));
                  }}
                >
                  <input value={option} onChange={(e) => setOption(e.target.value)} placeholder="Add an option" maxLength={200} />
                  <button disabled={busy || !option.trim()}>Add</button>
                </form>
              ) : (
                <p className="muted small">Only whoever made a list can change it. Make your own below.</p>
              )}
              <button className="link danger" disabled={busy} onClick={() => confirm(`Delete the "${list.data!.name}" list?`) && void run(() => remove(list))}>
                Delete this list
              </button>
            </>
          )}
        </>
      )}
      <h3 className="section-label">New list</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const t = newName.trim();
          if (t) void run(async () => (setListId((await add("spinner", { name: t, o: [] })).id), setNewName("")));
        }}
      >
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name it (Dinner, Who plans the date…)" maxLength={60} />
        <button disabled={busy || !newName.trim()}>Make</button>
      </form>
    </>
  );
}

// ---- View-once photos -------------------------------------------------------------------

function Photos({ me, cid, items, remove, run, busy, name, withKey }: Ctx) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");
  const [viewing, setViewing] = useState<{ url: string; caption: string } | null>(null);
  const photos = of<PhotoData>(items, "photo").reverse();
  const toMe = photos.filter((p) => p.authorId !== me.id);
  const fromMe = photos.filter((p) => p.authorId === me.id);

  const send = (file: File) =>
    void run(() =>
      withKey(async (version) => {
        if (!file.type.startsWith("image/")) throw new Error("Pick a picture");
        const { blob, meta } = await encryptKitPhoto(cid, version, file);
        const body = await encryptKitItem(cid, me.id, "photo", version, { meta, caption: caption.trim() } satisfies PhotoData);
        const form = new FormData();
        form.append("kind", "photo");
        form.append("body", body);
        form.append("keyVersion", String(version));
        form.append("file", blob, "photo");
        await apiForm<CouplesItem>(`/api/couples/${cid}/items`, form);
        setCaption("");
      }),
    );

  const open = (p: Shown<PhotoData>) =>
    void run(async () => {
      if (!p.data) throw new Error(p.locked ?? "This photo can't be opened on this device");
      // Fetching it deletes it from the server, so it's opened here and never saved.
      const res = await fetch(`/api/couples/${cid}/items/${p.id}/photo`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(res.status === 410 ? "This photo was already opened" : `Couldn't open it (${res.status})`);
      const blob = await decryptKitPhoto(cid, p.keyVersion, p.data.meta, await res.arrayBuffer());
      setViewing({ url: URL.createObjectURL(blob), caption: p.data.caption });
    });

  const close = () => {
    if (viewing) URL.revokeObjectURL(viewing.url);
    setViewing(null);
  };

  return (
    <>
      <p className="muted small">
        A view-once photo can be opened one time by {name}, then it's deleted from the server for good. Dendrop can't stop screenshots or a
        second camera, so only send what you're comfortable with.
      </p>
      <div className="row">
        <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Caption (optional)" maxLength={300} />
        <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          📸 Send a photo
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) send(f);
          }}
        />
      </div>
      {toMe.length > 0 && <h3 className="section-label">From {name}</h3>}
      <ul className="couples-list">
        {toMe.map((p) => (
          <li key={p.id} className="couples-row">
            {p.opened ? (
              <span className="muted couples-status">📸 Opened {new Date(p.updatedAt).toLocaleDateString()}</span>
            ) : (
              <span className="couples-status">
                <button className="primary" disabled={busy} onClick={() => open(p)}>
                  📸 Tap to view once
                </button>
              </span>
            )}
            <button className="ghost" aria-label="Delete" title="Delete" disabled={busy} onClick={() => void run(() => remove(p))}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      {fromMe.length > 0 && <h3 className="section-label">You sent</h3>}
      <ul className="couples-list">
        {fromMe.map((p) => (
          <li key={p.id} className="couples-row">
            <span className="couples-text">
              📸 {p.data?.caption || "Photo"} <span className="muted small">· {p.opened ? "Opened" : "Not opened yet"}</span>
            </span>
            <button className="ghost" aria-label={p.opened ? "Delete" : "Unsend"} title={p.opened ? "Delete" : "Unsend"} disabled={busy} onClick={() => void run(() => remove(p))}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      {viewing && (
        <div className="view-once" role="dialog" aria-label="View-once photo" onClick={close} onContextMenu={(e) => e.preventDefault()}>
          <img src={viewing.url} alt={viewing.caption || "View-once photo"} draggable={false} />
          {viewing.caption && <p>{viewing.caption}</p>}
          <span className="muted small">Tap anywhere to close. It won't open again.</span>
        </div>
      )}
    </>
  );
}

// ---- Love notes ----------------------------------------------------------------------

/** "2026-11-08T21:30" for a datetime-local input, in local time. */
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function Notes({ me, items, add, remove, run, busy, name }: Ctx) {
  const [text, setText] = useState("");
  const [later, setLater] = useState(false);
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + 3600_000)));
  const notes = of<NoteData>(items, "note").reverse();
  const now = Date.now();
  const waiting = notes.filter((n) => n.authorId === me.id && n.deliverAt && Date.parse(n.deliverAt) > now);
  const delivered = notes.filter((n) => !waiting.includes(n));

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          const when = later ? new Date(at) : null;
          void run(async () => {
            if (when && !(when.getTime() > Date.now())) throw new Error("Pick a time in the future");
            await add("note", { t }, when ? { deliverAt: when.toISOString() } : {});
            setText("");
          });
        }}
      >
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Write ${name} a love note…`} maxLength={4000} />
        <div className="row note-when">
          <label className="toggle">
            <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} /> Deliver later
          </label>
          {later && <input type="datetime-local" value={at} min={localInput(new Date())} onChange={(e) => setAt(e.target.value)} aria-label="Deliver at" />}
          <button className="primary" disabled={busy || !text.trim()}>
            {later ? "Schedule 💌" : "Send 💌"}
          </button>
        </div>
      </form>
      {waiting.length > 0 && (
        <>
          <h3 className="section-label">Waiting to be delivered</h3>
          <ul className="couples-list">
            {waiting.map((n) => (
              <li key={n.id} className="couples-card">
                <div className="couples-card-head">
                  <span className="muted small">Arrives {new Date(n.deliverAt!).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
                  <button className="ghost" aria-label="Cancel" title="Cancel" disabled={busy} onClick={() => void run(() => remove(n))}>
                    ✕
                  </button>
                </div>
                {n.data ? <p className="note-text">{n.data.t}</p> : <Locked item={n} />}
              </li>
            ))}
          </ul>
        </>
      )}
      {delivered.length > 0 && <h3 className="section-label">Notes</h3>}
      <ul className="couples-list">
        {delivered.map((n) => (
          <li key={n.id} className={`couples-card ${n.authorId === me.id ? "" : "from-them"}`}>
            <div className="couples-card-head">
              <span className="muted small">
                {n.authorId === me.id ? `To ${name}` : `From ${name}`} · {new Date(n.deliverAt ?? n.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
              </span>
              <button className="ghost" aria-label="Delete" title="Delete" disabled={busy} onClick={() => confirm("Delete this note for both of you?") && void run(() => remove(n))}>
                ✕
              </button>
            </div>
            {n.data ? <p className="note-text">{n.data.t}</p> : <Locked item={n} />}
          </li>
        ))}
      </ul>
    </>
  );
}

// ---- Countdowns ------------------------------------------------------------------------

function Countdowns({ me, items, add, edit, remove, run, busy }: Ctx) {
  const [t, setT] = useState("");
  const [at, setAt] = useState("");
  const [e, setE] = useState("💞");
  const list = of<CountdownData>(items, "countdown").sort((a, b) => (a.data?.at ?? "").localeCompare(b.data?.at ?? ""));

  return (
    <>
      <form
        className="row countdown-form"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (t.trim() && /^\d{4}-\d{2}-\d{2}$/.test(at)) void run(async () => (await add("countdown", { t: t.trim(), at, e: e.trim() || "💞" }), setT(""), setAt("")));
        }}
      >
        <input className="emoji-input" value={e} onChange={(ev) => setE(ev.target.value)} maxLength={8} aria-label="Emoji" />
        <input value={t} onChange={(ev) => setT(ev.target.value)} placeholder="Anniversary, trip, next date…" maxLength={100} />
        <input type="date" value={at} onChange={(ev) => setAt(ev.target.value)} aria-label="Date" />
        <button className="primary" disabled={busy || !t.trim() || !at}>
          Add
        </button>
      </form>
      <ul className="couples-list">
        {list.map((c) => {
          if (!c.data) return <li key={c.id}><Locked item={c} /></li>;
          const d = daysUntil(c.data.at);
          return (
            <li key={c.id} className="countdown">
              <span className="countdown-emoji" aria-hidden>
                {c.data.e}
              </span>
              <span className="couples-text">
                <strong>{c.data.t}</strong>
                <span className="muted small">{new Date(`${c.data.at}T00:00`).toLocaleDateString([], { dateStyle: "long" })}</span>
              </span>
              <span className="countdown-days">{d > 1 ? `${d} days` : d === 1 ? "Tomorrow" : d === 0 ? "Today! 🎉" : `${-d} days ago`}</span>
              {c.authorId === me.id && d < 0 && (
                <button
                  className="ghost"
                  title="Same date next year"
                  aria-label="Same date next year"
                  disabled={busy}
                  onClick={() => {
                    const [y, rest] = [Number(c.data!.at.slice(0, 4)), c.data!.at.slice(4)];
                    void run(() => edit(c, { ...c.data!, at: `${y + Math.max(1, Math.ceil(-d / 365))}${rest}` }));
                  }}
                >
                  ↻
                </button>
              )}
              <button className="ghost" aria-label="Delete" title="Delete" disabled={busy} onClick={() => void run(() => remove(c))}>
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---- Settings ------------------------------------------------------------------------------

function KitSettings({ cid, run, busy, name, onOff }: Ctx & { onOff: () => void }) {
  return (
    <>
      <p>Turning the couples kit off deletes everything in it for both of you: ideas and votes, questions, cards, lists, photos, notes and countdowns. It can't be undone.</p>
      <p className="muted small">Things you shared into the chat stay in the chat, like any message.</p>
      <button
        className="danger-button"
        disabled={busy}
        onClick={() =>
          confirm(`Turn off the couples kit with ${name} and delete everything in it?`) &&
          void run(async () => {
            await api(`/api/couples/${cid}`, { method: "DELETE" });
            onOff();
          })
        }
      >
        Turn off and delete everything
      </button>
    </>
  );
}

// ---- Love note pop-up ---------------------------------------------------------------------

/**
 * Shows a love note the moment it arrives, wherever you are in the app. Mounted once by the
 * shell, which forwards the server's couples events.
 */
export function LoveNotePopup({ me, conversations }: { me: Me; conversations: Conversation[] }) {
  const [note, setNote] = useState<{ from: string; text: string } | null>(null);
  const convos = useRef(conversations);
  convos.current = conversations;

  useEffect(() => {
    if (me.isKid) return;
    const on = (ev: Event) => {
      const { conversationId, noteFrom } = (ev as CustomEvent<CouplesEventDetail>).detail;
      if (!noteFrom) return;
      void (async () => {
        const kit = await api<CouplesKit>(`/api/couples/${conversationId}`);
        const newest = kit.items.filter((i) => i.kind === "note" && i.authorId === noteFrom).at(-1);
        if (!newest) return;
        const data = await decryptKitItem<NoteData>(newest);
        const from = convos.current.find((c) => c.id === conversationId)?.members.find((m) => m.id === noteFrom)?.displayName ?? "Someone";
        setNote({ from, text: data.t });
      })().catch(() => {
        /* it's still in the kit's Love notes */
      });
    };
    window.addEventListener(COUPLES_EVENT, on);
    return () => window.removeEventListener(COUPLES_EVENT, on);
  }, [me.isKid]);

  if (!note) return null;
  return (
    <Modal title={`💌 A love note from ${note.from}`} onClose={() => setNote(null)}>
      <p className="note-text love-note">{note.text}</p>
      <button className="primary wide" onClick={() => setNote(null)}>
        💞
      </button>
    </Modal>
  );
}
