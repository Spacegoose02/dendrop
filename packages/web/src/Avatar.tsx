import { useState } from "react";

/**
 * A round avatar: the person's profile picture, or their initial when they have none (or it
 * won't load), with an optional online dot (red for Do Not Disturb).
 */
export function Avatar({
  name,
  src,
  online,
  dnd = false,
  size = 36,
  title,
}: {
  name: string;
  src?: string | null;
  online?: boolean;
  dnd?: boolean;
  size?: number;
  title?: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const picture = src && broken !== src ? src : null;
  return (
    <span className={`avatar ${picture ? "has-picture" : ""}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden title={title}>
      {picture ? <img src={picture} alt="" loading="lazy" draggable={false} onError={() => setBroken(picture)} /> : name.trim().slice(0, 1).toUpperCase() || "?"}
      {online !== undefined && <span className={`status ${online ? (dnd ? "dnd" : "on") : ""}`} />}
    </span>
  );
}
