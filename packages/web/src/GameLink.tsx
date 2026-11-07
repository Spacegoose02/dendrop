import { createContext, useContext, useEffect, useState } from "react";
import type { LootdenGame, LootdenPc } from "@dendrop/shared";
import { api } from "./api.ts";

/** LootDen's address when it's linked (from /api/server), so links to its games get a card. */
export const LootdenUrlContext = createContext<string | null>(null);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The LootDen game ids linked in a message, in order, at most three. */
export function lootdenGameIds(text: string, base: string | null): string[] {
  if (!base || !text) return [];
  const re = new RegExp(`${escape(base.replace(/\/+$/, ""))}/games/([^\\s/?#<>"']+)`, "g");
  const ids: string[] = [];
  for (const m of text.matchAll(re)) {
    let id = m[1]!.replace(/[).,!?;:]+$/, "");
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep it as written */
    }
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 3);
}

/** One request per game for the whole session; null when it can't be shown (gone, or not for kids). */
const cache = new Map<string, Promise<LootdenGame | null>>();
const load = (id: string) => {
  let p = cache.get(id);
  if (!p) {
    p = api<LootdenGame>(`/api/lootden/games/${encodeURIComponent(id)}`).catch(() => null);
    cache.set(id, p);
  }
  return p;
};

const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);

/** Cards for the LootDen games a message links to. */
export function GameLinks({ text }: { text: string }) {
  const base = useContext(LootdenUrlContext);
  const ids = lootdenGameIds(text, base);
  if (!ids.length) return null;
  return (
    <div className="game-cards">
      {ids.map((id) => (
        <GameCard key={id} id={id} />
      ))}
    </div>
  );
}

function GameCard({ id }: { id: string }) {
  const [game, setGame] = useState<LootdenGame | null | undefined>(undefined);
  const [pcs, setPcs] = useState<LootdenPc[] | null>(null);
  const [pc, setPc] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void load(id).then((g) => live && setGame(g));
    return () => {
      live = false;
    };
  }, [id]);
  if (!game) return null;

  const openSend = async () => {
    setError(null);
    try {
      const list = await api<LootdenPc[]>("/api/lootden/pcs");
      setPcs(list);
      setPc(list.find((p) => p.online)?.name ?? list[0]?.name ?? "");
      if (!list.length) setError("There are no PCs you use with LootDen's app yet.");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const send = async () => {
    setError(null);
    try {
      await api(`/api/lootden/games/${encodeURIComponent(game.id)}/send`, { body: { device: pc } });
      const target = pcs?.find((p) => p.name === pc);
      setStatus(target?.online ? `Sent. It'll start installing on ${pc} in a moment.` : `Sent. ${pc} will install it next time it's on.`);
      setPcs(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const facts = [game.releaseYear, ...game.genres.slice(0, 2), game.platform !== "pc" ? game.platform.toUpperCase() : null, game.sizeBytes ? size(game.sizeBytes) : null].filter(Boolean);
  return (
    <div className="game-card">
      {game.coverUrl ? <img className="game-cover" src={game.coverUrl} alt="" loading="lazy" /> : <div className="game-cover none">🎮</div>}
      <div className="game-info">
        <a className="game-title" href={game.url} target="_blank" rel="noreferrer noopener">
          {game.title}
        </a>
        {facts.length > 0 && <span className="muted small">{facts.join(" · ")}</span>}
        <span className="muted small">In LootDen</span>
        {status && <span className="small ok-text">{status}</span>}
        {error && <span className="small error-text">{error}</span>}
        {game.canSend && !status && (
          <div className="game-actions">
            {pcs === null ? (
              <button className="primary small-button" onClick={() => void openSend()}>
                Send to PC
              </button>
            ) : (
              pcs.length > 0 && (
                <>
                  <select value={pc} onChange={(e) => setPc(e.target.value)} aria-label="PC">
                    {pcs.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                        {p.online ? "" : " (off)"}
                      </option>
                    ))}
                  </select>
                  <button className="primary small-button" disabled={!pc} onClick={() => void send()}>
                    Send
                  </button>
                  <button className="ghost small" onClick={() => setPcs(null)}>
                    Cancel
                  </button>
                </>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
