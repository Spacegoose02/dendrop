/** A round initial avatar with an optional online dot. Pictures come with Phase 7's profiles. */
export function Avatar({ name, online, size = 36, title }: { name: string; online?: boolean; size?: number; title?: string }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden title={title}>
      {name.trim().slice(0, 1).toUpperCase() || "?"}
      {online !== undefined && <span className={`status ${online ? "on" : ""}`} />}
    </span>
  );
}
