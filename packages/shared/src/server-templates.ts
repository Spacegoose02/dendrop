/**
 * Ready-made server layouts: the channels, categories and roles a new server starts with.
 * POST /api/servers takes { template: id } to use one (servers.ts builds it), or
 * { copyFrom: serverId } to copy the layout of a server you manage instead.
 *
 * Roles and channels are named here; a channel points at roles by name.
 */
import type { ChannelKind, ServerPermission } from "./index.js";

export interface TemplateRole {
  name: string;
  /** #rrggbb, or null for none. */
  color: string | null;
  permissions: ServerPermission[];
}

export interface TemplateChannel {
  name: string;
  kind?: ChannelKind;
  topic?: string;
  /** Only the roles named in `roles` (and people who can manage channels) see it. */
  locked?: boolean;
  roles?: string[];
  /** Only people who can manage channels, and the roles named in `postRoles`, can post. */
  readOnly?: boolean;
  postRoles?: string[];
  /** Seconds between posts. */
  slowmode?: number;
  /** Forum tags. */
  tags?: string[];
}

export interface TemplateCategory {
  /** null for channels at the top, outside any category. */
  name: string | null;
  channels: TemplateChannel[];
}

export interface ServerTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** Highest first. */
  roles: TemplateRole[];
  categories: TemplateCategory[];
}

const MOD_PERMISSIONS: ServerPermission[] = ["kickMembers", "timeoutMembers", "deleteMessages", "manageNicknames", "muteMembers", "moveMembers", "pinMessages"];

export const SERVER_TEMPLATES: readonly ServerTemplate[] = [
  {
    id: "family",
    name: "Family",
    emoji: "🏡",
    description: "Announcements from parents, photos, plans and a voice room for the whole family.",
    roles: [
      { name: "Parents", color: "#e57373", permissions: ["pinMessages", "mentionEveryone", "manageEvents", "timeoutMembers", "deleteMessages"] },
      { name: "Grandparents", color: "#ba68c8", permissions: ["pinMessages"] },
      { name: "Kids", color: "#4fc3f7", permissions: [] },
    ],
    categories: [
      {
        name: "Home",
        channels: [
          { name: "announcements", topic: "News from the parents", readOnly: true, postRoles: ["Parents"] },
          { name: "general", topic: "Chat about anything" },
          { name: "photos", topic: "Pictures from home and trips" },
          { name: "plans", topic: "Dinners, trips and who's picking up whom" },
        ],
      },
      {
        name: "Grown-ups",
        channels: [{ name: "parents", topic: "Just for the parents", locked: true, roles: ["Parents"] }],
      },
      {
        name: "Voice",
        channels: [{ name: "living-room", kind: "voice" }],
      },
    ],
  },
  {
    id: "gaming",
    name: "Gaming",
    emoji: "🎮",
    description: "Rules, a looking-for-group forum, clips and squad voice rooms.",
    roles: [
      { name: "Mods", color: "#43a047", permissions: MOD_PERMISSIONS },
      { name: "Gamers", color: "#7e57c2", permissions: [] },
    ],
    categories: [
      {
        name: "Info",
        channels: [
          { name: "rules", topic: "Read these first", readOnly: true },
          { name: "announcements", topic: "Game nights and news", readOnly: true, postRoles: ["Mods"] },
        ],
      },
      {
        name: "Chat",
        channels: [
          { name: "general", topic: "Talk about anything" },
          { name: "clips", topic: "Your best plays", slowmode: 30 },
          { name: "looking-for-group", kind: "forum", topic: "Find people to play with", tags: ["Casual", "Ranked", "Co-op", "Tonight"] },
          { name: "mods", topic: "Just for the mods", locked: true, roles: ["Mods"] },
        ],
      },
      {
        name: "Voice",
        channels: [
          { name: "lobby", kind: "voice" },
          { name: "squad-1", kind: "voice" },
          { name: "squad-2", kind: "voice" },
        ],
      },
    ],
  },
  {
    id: "friends",
    name: "Friends",
    emoji: "🦝",
    description: "A place to hang out: chat, memes, plans and a voice room.",
    roles: [{ name: "Besties", color: "#ffb300", permissions: ["pinMessages"] }],
    categories: [
      {
        name: "Hangout",
        channels: [
          { name: "general", topic: "Chat about anything" },
          { name: "memes", topic: "Keep it funny" },
          { name: "plans", topic: "When and where" },
        ],
      },
      {
        name: "Voice",
        channels: [{ name: "hangout", kind: "voice" }],
      },
    ],
  },
];
