import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CUSTOM_EMOJI_RE, gifIdFromLink, isUnicodeEmoji, STICKER_RE, type ChatServer, type CustomEmoji, type Gif, type GifPage, type Reaction, type Sticker } from "@dendrop/shared";
import { api } from "./api.ts";
import { ALL_EMOJI, builtinByName, EMOJI_SECTIONS, QUICK_REACTIONS } from "./emoji.ts";

/** What the picker and message rendering need from the app: your servers (their emoji and stickers), and whether GIFs are on. */
export interface Expressions {
  servers: ChatServer[];
  /** GIF search is on here and you may use it (for kids, a parent allowed it). */
  gifs: boolean;
}

export const ExpressionsContext = createContext<Expressions>({ servers: [], gifs: false });
export const useExpressions = () => useContext(ExpressionsContext);

const tokenOf = (e: Pick<CustomEmoji, "name" | "id" | "animated">) => `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`;
const tokenRe = () => new RegExp(CUSTOM_EMOJI_RE.source, "g");

// ---- Showing messages ---------------------------------------------------------------------

/** A message that is only a sticker. */
export function stickerIn(text: string): { name: string; id: number } | null {
  const m = STICKER_RE.exec(text.trim());
  return m ? { name: m[1]!, id: Number(m[2]) } : null;
}

/** A message that is only a GIF link: the GIF's id. */
export function gifIn(text: string): string | null {
  const t = text.trim();
  return /\s/.test(t) ? null : gifIdFromLink(t);
}

/** Only emoji (up to 27), so they show big. */
function onlyEmoji(text: string): boolean {
  const rest = text.replace(tokenRe(), " ").trim();
  const customCount = (text.match(tokenRe()) ?? []).length;
  if (!rest) return customCount > 0 && customCount <= 27;
  const parts = rest.split(/\s+/);
  const seg = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  let count = customCount;
  for (const p of parts) {
    const graphemes = seg ? [...seg.segment(p)].map((x) => x.segment) : [...p];
    for (const g of graphemes) {
      if (!isUnicodeEmoji(g)) return false;
      count++;
    }
  }
  return count <= 27;
}

/** A custom emoji's picture, or its :name: when it can't load (deleted). */
export function CustomEmojiImg({ name, id, animated, big }: { name: string; id: number; animated?: boolean; big?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="muted">:{name}:</span>;
  return (
    <img
      className={`custom-emoji ${big ? "big" : ""}`}
      src={`/api/emojis/${id}`}
      alt={`:${name}:`}
      title={`:${name}:${animated ? " (animated)" : ""}`}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** Text with custom emoji drawn as pictures. Messages that are only emoji show them big. */
export function RichText({ text, inline }: { text: string; inline?: boolean }): ReactNode {
  const big = !inline && onlyEmoji(text);
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(tokenRe())) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<CustomEmojiImg key={m.index} name={m[2]!} id={Number(m[3])} animated={m[1] === "a"} big={big} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return big ? <span className="jumbo">{out}</span> : <>{out}</>;
}

export function StickerView({ name, id }: { name: string; id: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <p className="msg-body muted">A sticker that was deleted (:{name}:)</p>;
  return <img className="sticker" src={`/api/stickers/${id}`} alt={`Sticker: ${name}`} title={name} onError={() => setFailed(true)} />;
}

/** A GIF sent as a link: shown through Dendrop when GIFs are on and allowed, else as the link. */
export function GifView({ id, link }: { id: string; link: string }) {
  const { gifs } = useExpressions();
  const [failed, setFailed] = useState(false);
  if (!gifs || failed) {
    return (
      <p className="msg-body">
        <a href={link} target="_blank" rel="noreferrer noopener">
          {link}
        </a>
      </p>
    );
  }
  return (
    <span className="gif-embed">
      <img src={`/api/gifs/media/${id}/full`} alt="GIF" loading="lazy" onError={() => setFailed(true)} />
      <span className="gif-badge">GIF</span>
    </span>
  );
}

/** Reactions under a message: click one to add yours or take it back. */
export function Reactions({
  reactions,
  meId,
  nameOf,
  onToggle,
  onAdd,
  disabled,
}: {
  reactions: Reaction[];
  meId: number;
  nameOf: (userId: number) => string;
  onToggle: (emoji: string, mine: boolean) => void;
  onAdd: (from: Element) => void;
  disabled?: boolean;
}) {
  if (!reactions.length) return null;
  return (
    <div className="reactions">
      {reactions.map((r) => {
        const mine = r.userIds.includes(meId);
        const who = r.userIds.map(nameOf);
        const label = r.emoji.startsWith("<") ? r.emoji.replace(tokenRe(), ":$2:") : r.emoji;
        return (
          <button
            key={r.emoji}
            className={`reaction ${mine ? "mine" : ""}`}
            onClick={() => onToggle(r.emoji, mine)}
            disabled={disabled}
            title={`${who.slice(0, 10).join(", ")}${who.length > 10 ? ` and ${who.length - 10} more` : ""} reacted with ${label}`}
            aria-pressed={mine}
          >
            <RichText text={r.emoji} inline />
            <span className="reaction-count">{r.count}</span>
          </button>
        );
      })}
      <button className="reaction add" data-picker-toggle onClick={(e) => onAdd(e.currentTarget)} disabled={disabled} title="Add a reaction" aria-label="Add a reaction">
        ☺+
      </button>
    </div>
  );
}

// ---- Writing messages ------------------------------------------------------------------------

/** Every custom emoji you can use: your current server's first. */
export function usableEmoji(servers: ChatServer[], currentServerId?: number): CustomEmoji[] {
  const sorted = [...servers].sort((a, b) => Number(b.id === currentServerId) - Number(a.id === currentServerId));
  return sorted.flatMap((s) => s.emojis ?? []);
}

/**
 * Turns :name: into emoji before sending: custom emoji (your current server's first) become
 * their token, built-in names their emoji. Tokens already there are left alone.
 */
export function toTokens(text: string, emojis: CustomEmoji[]): string {
  const parts = text.split(tokenRe());
  // split with groups gives [text, a, name, id, text, ...]: rebuild the tokens as they were.
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 4) {
    out.push(
      parts[i]!.replace(/(?<!\w):([A-Za-z0-9_]{2,32}):/g, (whole, name: string) => {
        const custom = emojis.find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (custom) return tokenOf(custom);
        return builtinByName(name) ?? whole;
      }),
    );
    if (i + 3 < parts.length) out.push(`<${parts[i + 1]}:${parts[i + 2]}:${parts[i + 3]}>`);
  }
  return out.join("");
}

/** Turns tokens back into :name:, for editing a message. Names used by two of your servers keep their token. */
export function fromTokens(text: string, emojis: CustomEmoji[]): string {
  return text.replace(tokenRe(), (whole, _a: string, name: string, id: string) => {
    const same = emojis.filter((e) => e.name.toLowerCase() === name.toLowerCase());
    return same.length === 1 && same[0]!.id === Number(id) ? `:${name}:` : whole;
  });
}

/** Suggestions while typing ":rac": custom emoji first, then built-in ones. */
export function suggest(query: string, emojis: CustomEmoji[]): { label: string; insert: string; custom?: CustomEmoji; emoji?: string }[] {
  const q = query.toLowerCase();
  const custom = emojis.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 6);
  const builtin = ALL_EMOJI.filter((x) => x.n.some((n) => n.startsWith(q))).slice(0, 8 - custom.length);
  return [
    ...custom.map((e) => ({ label: `:${e.name}:`, insert: needsToken(e, emojis) ? tokenOf(e) : `:${e.name}:`, custom: e })),
    ...builtin.map((x) => ({ label: `:${x.n[0]}:`, insert: x.e, emoji: x.e })),
  ];
}

/** Two of your servers have an emoji with this name, so text alone can't say which. */
const needsToken = (e: CustomEmoji, all: CustomEmoji[]) => all.filter((x) => x.name.toLowerCase() === e.name.toLowerCase()).length > 1;

// ---- The picker -------------------------------------------------------------------------------

export type PickerTab = "emoji" | "gifs" | "stickers";

/**
 * The emoji, GIF and sticker picker. For reactions it shows emoji only.
 * onEmoji gets what to insert or react with (an emoji, ":name:" or a token), onSticker the
 * sticker's token, onGif the GIF's link.
 */
export function ExpressionPicker({
  mode,
  initialTab = "emoji",
  currentServerId,
  onEmoji,
  onSticker,
  onGif,
  onClose,
}: {
  mode: "composer" | "reaction";
  initialTab?: PickerTab;
  currentServerId?: number;
  onEmoji: (insert: string) => void;
  onSticker?: (token: string) => void;
  onGif?: (link: string) => void;
  onClose: () => void;
}) {
  const { servers, gifs } = useExpressions();
  const [tab, setTab] = useState<PickerTab>(initialTab);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const ordered = useMemo(() => [...servers].sort((a, b) => Number(b.id === currentServerId) - Number(a.id === currentServerId)), [servers, currentServerId]);
  const allCustom = useMemo(() => ordered.flatMap((s) => s.emojis ?? []), [ordered]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      // The buttons that open a picker toggle it themselves.
      if ((e.target as Element).closest?.("[data-picker-toggle]")) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Wait a tick so the click that opened the picker doesn't close it.
    const t = setTimeout(() => document.addEventListener("mousedown", down));
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const pickCustom = (e: CustomEmoji) => onEmoji(mode === "reaction" || needsToken(e, allCustom) ? tokenOf(e) : `:${e.name}:`);
  const needle = q.trim().toLowerCase();
  const stickerServers = ordered.filter((s) => s.stickers?.length);

  return (
    <div className={`expression-picker picker-${mode}`} ref={ref} role="dialog" aria-label={mode === "reaction" ? "Pick a reaction" : "Emoji, GIFs and stickers"}>
      {mode === "composer" && (
        <div className="picker-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "emoji"} className={tab === "emoji" ? "active" : ""} onClick={() => setTab("emoji")}>
            Emoji
          </button>
          {gifs && onGif && (
            <button role="tab" aria-selected={tab === "gifs"} className={tab === "gifs" ? "active" : ""} onClick={() => setTab("gifs")}>
              GIFs
            </button>
          )}
          {onSticker && (
            <button role="tab" aria-selected={tab === "stickers"} className={tab === "stickers" ? "active" : ""} onClick={() => setTab("stickers")}>
              Stickers
            </button>
          )}
        </div>
      )}
      {tab === "gifs" && onGif ? (
        <GifTab onGif={onGif} />
      ) : (
        <>
          <input
            className="picker-search"
            autoFocus
            placeholder={tab === "stickers" ? "Find a sticker" : "Find an emoji"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search"
          />
          <div className="picker-body">
            {tab === "emoji" && (
              <>
                {mode === "reaction" && !needle && (
                  <div className="picker-grid quick">
                    {QUICK_REACTIONS.map((e) => (
                      <button key={e} className="ghost" onClick={() => onEmoji(e)} aria-label={e}>
                        {e}
                      </button>
                    ))}
                  </div>
                )}
                {ordered.map((s) => {
                  const list = (s.emojis ?? []).filter((e) => !needle || e.name.toLowerCase().includes(needle));
                  if (!list.length) return null;
                  return (
                    <section key={`s${s.id}`}>
                      <h4 className="picker-section">{s.name}</h4>
                      <div className="picker-grid">
                        {list.map((e) => (
                          <button key={e.id} className="ghost" onClick={() => pickCustom(e)} title={`:${e.name}:`} aria-label={e.name}>
                            <CustomEmojiImg name={e.name} id={e.id} animated={e.animated} />
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                })}
                {EMOJI_SECTIONS.map((sec) => {
                  const list = sec.emoji.filter((x) => !needle || x.n.some((n) => n.includes(needle)));
                  if (!list.length) return null;
                  return (
                    <section key={sec.name}>
                      <h4 className="picker-section">{sec.name}</h4>
                      <div className="picker-grid">
                        {list.map((x) => (
                          <button key={x.e} className="ghost" onClick={() => onEmoji(x.e)} title={`:${x.n[0]}:`} aria-label={x.n[0]}>
                            {x.e}
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </>
            )}
            {tab === "stickers" && onSticker && (
              <>
                {stickerServers.length === 0 && <p className="muted small picker-empty">None of your servers have stickers yet. People who can manage emoji and stickers add them in Server settings.</p>}
                {stickerServers.map((s) => {
                  const list = s.stickers.filter((x) => !needle || x.name.toLowerCase().includes(needle) || x.description.toLowerCase().includes(needle) || x.emoji === needle);
                  if (!list.length) return null;
                  return (
                    <section key={s.id}>
                      <h4 className="picker-section">{s.name}</h4>
                      <div className="sticker-grid">
                        {list.map((x: Sticker) => (
                          <button key={x.id} className="ghost" onClick={() => onSticker(`<sticker:${x.name}:${x.id}>`)} title={x.description || x.name}>
                            <img src={x.url} alt={x.name} loading="lazy" />
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function GifTab({ onGif }: { onGif: (link: string) => void }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState<GifPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const t = setTimeout(
      () =>
        void api<GifPage>(`/api/gifs?q=${encodeURIComponent(q.trim())}`)
          .then((p) => !cancelled && setPage(p))
          .catch((err: Error) => !cancelled && setError(err.message)),
      q ? 350 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const more = async () => {
    if (!page?.next) return;
    setLoadingMore(true);
    try {
      const next = await api<GifPage>(`/api/gifs?q=${encodeURIComponent(q.trim())}&offset=${page.next}`);
      setPage({ gifs: [...page.gifs, ...next.gifs.filter((g) => !page.gifs.some((x) => x.id === g.id))], next: next.next });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <input className="picker-search" autoFocus placeholder="Search GIPHY" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search GIFs" />
      <div className="picker-body">
        {!q && <h4 className="picker-section">Trending</h4>}
        {error && <p className="error small picker-empty">{error}</p>}
        {!page && !error && <p className="muted small picker-empty">Loading…</p>}
        {page && page.gifs.length === 0 && <p className="muted small picker-empty">No GIFs found.</p>}
        <div className="gif-grid">
          {page?.gifs.map((g: Gif) => (
            <button key={g.id} className="ghost" onClick={() => onGif(g.url)} title={g.title}>
              <img src={g.previewUrl} alt={g.title || "GIF"} loading="lazy" style={{ aspectRatio: `${g.width} / ${g.height}` }} />
            </button>
          ))}
        </div>
        {page?.next && (
          <button className="link picker-more" onClick={() => void more()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "More GIFs"}
          </button>
        )}
        <p className="muted tiny picker-credit">Powered by GIPHY, through this server</p>
      </div>
    </>
  );
}
