import { createContext, useContext } from "react";
import type { Activity } from "@dendrop/shared";

/** What people are playing (from LootDen), by user id. Filled in by the Shell. */
export const ActivityContext = createContext<Record<number, Activity>>({});

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
