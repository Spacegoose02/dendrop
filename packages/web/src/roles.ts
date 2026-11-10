import type { ChatServer, CustomRole, PublicUser, ServerMember, ServerPermission } from "@dendrop/shared";

/** Whether you can do something in a server (the owner and admins can do everything). */
export const can = (s: ChatServer, p: ServerPermission): boolean => s.myPermissions.includes(p);

/** What each permission is called and what it lets someone do. */
export const PERMISSION_INFO: Record<ServerPermission, { label: string; detail: string; moderates: boolean }> = {
  manageServer: { label: "Manage server", detail: "Change the name, pictures, and who can join or invite.", moderates: true },
  manageChannels: { label: "Manage channels", detail: "Make, edit, lock and delete channels. Sees every locked channel.", moderates: true },
  manageRoles: { label: "Manage roles", detail: "Make and change roles ranked below their own, and give them out.", moderates: true },
  manageAutomod: { label: "Manage automod", detail: "Change automod, read the mod log, and get automod alerts.", moderates: true },
  kickMembers: { label: "Remove members", detail: "Remove people ranked below them. They can come back with an invite.", moderates: true },
  banMembers: { label: "Ban", detail: "Ban people ranked below them, so they can't come back, and see and lift bans.", moderates: true },
  timeoutMembers: { label: "Time out", detail: "Stop people ranked below them posting for a while.", moderates: true },
  deleteMessages: { label: "Delete messages", detail: "Delete anyone's message in the channels, review reports, and skip slowmode.", moderates: true },
  manageNicknames: { label: "Manage nicknames", detail: "Change the nicknames of people ranked below them.", moderates: true },
  muteMembers: { label: "Mute in voice", detail: "Mute or deafen people ranked below them in voice channels until they lift it.", moderates: true },
  moveMembers: { label: "Move and disconnect", detail: "Move people ranked below them to another voice channel, or take them out of voice.", moderates: true },
  manageWebhooks: { label: "Manage webhooks & bots", detail: "Make and change webhooks, and add or remove bots.", moderates: true },
  viewAuditLog: { label: "View audit log", detail: "Read the server's audit log: who changed what.", moderates: true },
  createInvites: { label: "Make invites", detail: "Make invite links, even when members can't.", moderates: false },
  manageExpressions: { label: "Manage emoji & stickers", detail: "Upload, rename and delete the server's custom emoji and stickers.", moderates: false },
  pinMessages: { label: "Pin messages", detail: "Pin and unpin messages on the pinned board.", moderates: false },
  manageEvents: { label: "Manage events", detail: "Plan, change, start and cancel events, and run stage channels (who gets to speak).", moderates: false },
  mentionEveryone: { label: "Mention @everyone", detail: "Ping everyone who can see a channel with @everyone.", moderates: false },
};

/** A member's custom roles, highest first. */
export const rolesOf = (s: ChatServer, m: ServerMember | undefined): CustomRole[] => (m ? s.roles.filter((r) => m.roleIds.includes(r.id)) : []);

/** Owner, then admins, then highest custom role. Smaller is higher. */
export function rank(s: ChatServer, m: ServerMember | undefined): number {
  if (!m) return Infinity;
  if (m.role === "owner") return -2;
  if (m.role === "admin") return -1;
  return rolesOf(s, m)[0]?.position ?? Infinity;
}

/** Same rule as the server: who you can remove, time out or change roles for. */
export function outranks(s: ChatServer, meId: number, target: ServerMember): boolean {
  if (target.user.id === meId || target.role === "owner") return false;
  const me = s.members.find((m) => m.user.id === meId);
  if (!me) return false;
  if (me.role === "owner") return true;
  if (target.role === "admin") return false;
  if (me.role === "admin") return true;
  return rank(s, me) < rank(s, target);
}

/** Whether you can change, give out or take away a role: one ranked below your own highest. */
export function canManageRole(s: ChatServer, meId: number, r: CustomRole): boolean {
  if (!can(s, "manageRoles")) return false;
  return rank(s, s.members.find((m) => m.user.id === meId)) < r.position;
}

/**
 * The colors to show a member with in a server: their highest colored role wins over their own
 * name color, so roles are easy to spot. Their own text color stays. Pass it to useColors(),
 * which keeps it readable on the current theme.
 */
export function memberColors(m: ServerMember | undefined): Pick<PublicUser, "nameColor" | "textColor"> | undefined {
  return m && { nameColor: m.color ?? m.user.nameColor, textColor: m.user.textColor };
}

/** Members ranked like the server does: owner, admins, then by highest role, then by when they joined. */
export function byRank(s: ChatServer): ServerMember[] {
  return s.members.map((m, i) => ({ m, i, r: rank(s, m) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.m);
}
