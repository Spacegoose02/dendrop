import { useEffect, useRef, useState } from "react";
import { LEVEL_RULES, levelOf, RACCOON_RANKS, type ChatServer, type LeaderboardEntry, type Me, type RaccoonRank } from "@dendrop/shared";
import { api } from "./api.ts";
import { Avatar } from "./Avatar.tsx";
import { useColors } from "./colors.ts";
import { can, memberColors } from "./roles.ts";

/** A member's level and raccoon rank, small enough for the member list. */
export function LevelBadge({ xp, full = false }: { xp: number | null; full?: boolean }) {
  if (xp === null) return null;
  const p = levelOf(xp);
  return (
    <span className="level-badge" title={`Level ${p.level} · ${p.rank.name} · ${xp.toLocaleString()} XP`}>
      <span aria-hidden>{p.rank.emoji}</span>
      {full ? `${p.rank.name} · Lv ${p.level}` : p.level}
    </span>
  );
}

/** How far into the next level someone is. */
export function LevelBar({ xp }: { xp: number }) {
  const p = levelOf(xp);
  return (
    <span className="level-bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.needed} aria-valuenow={p.into} aria-label={`Level ${p.level + 1} progress`}>
      <span style={{ width: `${Math.round((p.into / p.needed) * 100)}%` }} />
    </span>
  );
}

/** Levels in server settings: the leaderboard, the ranks, and (for moderators) turning them off. */
export function LevelsTab({ me, server }: { me: Me; server: ChatServer }) {
  const mod = can(server, "manageServer");
  const colorsOf = useColors();
  const [board, setBoard] = useState<LeaderboardEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api<LeaderboardEntry[]>(`/api/servers/${server.id}/levels`)
      .then(setBoard)
      .catch((err: Error) => setError(err.message));
  useEffect(() => void load(), [server.id, server.levels]);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const mine = server.members.find((m) => m.user.id === me.id)?.xp ?? null;

  return (
    <div className="server-settings">
      {mod && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={server.levels}
            onChange={(e) => void run(() => api(`/api/servers/${server.id}`, { method: "PATCH", body: { levels: e.target.checked } }))}
          />
          <span>
            <strong>Levels and raccoon ranks</strong>
            <span className="muted small">
              Members earn {LEVEL_RULES.xpMin} to {LEVEL_RULES.xpMax} XP for chatting, at most once a minute, and climb the raccoon ranks. Bots don't earn XP.
            </span>
          </span>
        </label>
      )}
      {error && <p className="error">{error}</p>}
      {!server.levels ? (
        <p className="muted">Levels are off in this server.</p>
      ) : (
        <>
          {mine !== null && (
            <div className="level-me">
              <span className="level-me-emoji" aria-hidden>
                {levelOf(mine).rank.emoji}
              </span>
              <span className="nav-text">
                <strong>
                  You're a {levelOf(mine).rank.name}, level {levelOf(mine).level}
                </strong>
                <LevelBar xp={mine} />
                <span className="muted small">
                  {levelOf(mine).into.toLocaleString()} / {levelOf(mine).needed.toLocaleString()} XP to level {levelOf(mine).level + 1}
                </span>
              </span>
            </div>
          )}
          <div className="section-label">Leaderboard</div>
          {board === null ? (
            <p className="muted small">Loading…</p>
          ) : board.length === 0 ? (
            <p className="muted small">Nobody has earned XP yet. Say hi in a channel!</p>
          ) : (
            <ol className="leaderboard">
              {board.map((e, i) => {
                const m = server.members.find((x) => x.user.id === e.userId);
                if (!m) return null;
                const name = m.nickname ?? m.user.displayName;
                return (
                  <li key={e.userId} className={`member-row ${e.userId === me.id ? "is-me" : ""}`}>
                    <span className={`leaderboard-place place-${i + 1}`}>{i + 1}</span>
                    <Avatar name={name} src={m.user.avatar} size={28} />
                    <span className="nav-text">
                      <span className="ellipsis" style={colorsOf(memberColors(m)).name}>
                        {name}
                      </span>
                      <span className="muted small">{e.xp.toLocaleString()} XP</span>
                    </span>
                    <LevelBadge xp={e.xp} full />
                    {mod && (
                      <button
                        className="ghost small"
                        title={`Reset ${name}'s XP`}
                        aria-label={`Reset ${name}'s XP`}
                        onClick={() => confirm(`Set ${name}'s XP back to zero?`) && void run(() => api(`/api/servers/${server.id}/levels/${e.userId}`, { method: "DELETE" }))}
                      >
                        ↺
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          <div className="section-label">Raccoon ranks</div>
          <ul className="rank-ladder">
            {RACCOON_RANKS.map((r) => (
              <li key={r.name} className={mine !== null && levelOf(mine).rank.name === r.name ? "on" : ""}>
                <span aria-hidden>{r.emoji}</span>
                <strong>{r.name}</strong>
                <span className="muted small">level {r.level}+</span>
              </li>
            ))}
          </ul>
          {mod && (
            <button
              className="danger-button wide"
              onClick={() => confirm("Set everyone's XP in this server back to zero?") && void run(() => api(`/api/servers/${server.id}/levels`, { method: "DELETE" }))}
            >
              Reset everyone's XP
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Pops up in the corner when you reach a new level. */
export function LevelUpCard({ server, level, rank, rankUp, onClose }: { server: ChatServer; level: number; rank: RaccoonRank; rankUp: boolean; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const t = setTimeout(() => close.current(), 8000);
    return () => clearTimeout(t);
  }, [level, rank.name]);
  return (
    <div className="incoming level-up" role="status" aria-live="polite">
      <div className="play-together-icon" aria-hidden>
        {rank.emoji}
      </div>
      <h2>{rankUp ? `You're a ${rank.name} now!` : `Level ${level}!`}</h2>
      <p className="muted">
        {rankUp ? `You reached level ${level} in ${server.name}.` : `You're a level ${level} ${rank.name} in ${server.name}.`}
      </p>
      <div className="row">
        <button onClick={onClose}>Nice</button>
      </div>
    </div>
  );
}
