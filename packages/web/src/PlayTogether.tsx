import type { ChatServer, Me, PlayTogether } from "@dendrop/shared";

/** "Bob", "Bob and Ann", "Bob, Ann and Kiddo" */
const names = (list: string[]) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

/**
 * You and others in a server are playing the same game, and a voice channel opened for it:
 * join it, or not now. Sits where incoming calls do, without the ringing.
 */
export function PlayTogetherCard({
  me,
  invite,
  server,
  onJoin,
  onClose,
}: {
  me: Me;
  invite: PlayTogether;
  server: ChatServer;
  onJoin: () => void;
  onClose: () => void;
}) {
  const channel = server.channels.find((c) => c.id === invite.channelId);
  if (!channel) return null;
  const others = invite.userIds
    .filter((id) => id !== me.id)
    .map((id) => {
      const m = server.members.find((x) => x.user.id === id);
      return m ? (m.nickname ?? m.user.displayName) : null;
    })
    .filter((n): n is string => !!n);
  return (
    <div className="incoming play-together" role="dialog" aria-label={`Play ${invite.game} together`}>
      <div className="play-together-icon" aria-hidden>
        🎮
      </div>
      <h2>{invite.game}</h2>
      <p className="muted">
        {others.length ? `${names(others)} ${others.length === 1 ? "is" : "are"} playing too.` : "Others are playing too."} Talk while you play in 🔊{" "}
        {channel.name} on {server.name}.
      </p>
      <div className="row">
        <button onClick={onClose}>Not now</button>
        <button className="accept" onClick={onJoin}>
          Join voice
        </button>
      </div>
    </div>
  );
}
