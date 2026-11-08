import type { Channel, ChannelKind } from "@dendrop/shared";

/** How each kind of channel shows in lists and the new channel picker. */
export const CHANNEL_KINDS: Record<ChannelKind, { mark: string; label: string; section: string; detail: string; placeholder: string }> = {
  text: { mark: "#", label: "Text", section: "Text channels", detail: "Messages, pictures and files.", placeholder: "game-night" },
  voice: { mark: "🔊", label: "Voice", section: "Voice channels", detail: "Drop in to talk, share your camera or screen.", placeholder: "the-den" },
  stage: {
    mark: "🎙️",
    label: "Stage",
    section: "Stage channels",
    detail: "For game nights and movie nights: hosts talk and share their screen, everyone else listens and can raise a hand.",
    placeholder: "movie-night",
  },
  forum: {
    mark: "💬",
    label: "Forum",
    // Forums are listed with the text channels.
    section: "Text channels",
    detail: "Organized posts, each with a title, tags and its own replies.",
    placeholder: "help-desk",
  },
};

/** The mark before a channel's name: #, 🔊, 🎙️ or 💬 (a padlock for locked text channels). */
export const channelMark = (c: Pick<Channel, "kind" | "locked">): string => (c.kind === "text" && c.locked ? "🔒" : CHANNEL_KINDS[c.kind].mark);

/** "#general", or a voice, stage or forum channel's bare name. */
export const channelTitle = (c: Pick<Channel, "kind" | "name">): string => (c.kind === "text" ? `#${c.name}` : c.name);
