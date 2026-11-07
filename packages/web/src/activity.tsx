import { createContext, useContext } from "react";
import type { Activity, ChoresToday } from "@dendrop/shared";

/** What people are playing (from LootDen), by user id. Filled in by the Shell. */
export const ActivityContext = createContext<Record<number, Activity>>({});

/** Kids' chores today (from Den Duty), for the kid and their parents, by user id. Filled in by the Shell. */
export const ChoresContext = createContext<Record<number, ChoresToday>>({});

/** "2 of 5 chores left" or "All 5 chores done today" */
export function choresText(c: ChoresToday): string {
  if (c.left <= 0) return `All ${c.due === 1 ? "chores" : `${c.due} chores`} done today`;
  return `${c.left} of ${c.due} chore${c.due === 1 ? "" : "s"} left`;
}

/** A small "🧹 2 of 5 chores left" line from Den Duty. Only the kid and their parents have one to show. */
export function ChoresLine({ userId, className = "muted small ellipsis activity" }: { userId: number; className?: string }) {
  const c = useContext(ChoresContext)[userId];
  if (!c) return null;
  return (
    <span className={className} title="Today's chores, from Den Duty">
      {c.left <= 0 ? "⭐" : "🧹"} {choresText(c)}
    </span>
  );
}

export function useActivity(userId: number | undefined): Activity | undefined {
  const all = useContext(ActivityContext);
  return userId === undefined ? undefined : all[userId];
}

/** "Playing Stardew Valley on Den-PC" */
export function activityText(a: Activity): string {
  return `Playing ${a.title}${a.device ? ` on ${a.device}` : ""}`;
}

/** A small "🎮 Playing ..." line, linking to the game in LootDen when there's a page for it. */
export function ActivityLine({ userId, className = "muted small ellipsis activity" }: { userId: number; className?: string }) {
  return (
    <>
      <PlayingLine userId={userId} className={className} />
      <ChoresLine userId={userId} className={className} />
    </>
  );
}

function PlayingLine({ userId, className }: { userId: number; className: string }) {
  const a = useActivity(userId);
  if (!a) return null;
  const since = new Date(a.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <span className={className} title={`${activityText(a)}, since ${since}`}>
      🎮{" "}
      {a.url ? (
        <a href={a.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
          {activityText(a)}
        </a>
      ) : (
        activityText(a)
      )}
    </span>
  );
}
