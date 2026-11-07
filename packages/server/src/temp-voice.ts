import { rmSync } from "node:fs";
import path from "node:path";
import type { Context } from "./app.js";
import type { ServerRepo } from "./servers.js";

/**
 * Takes away a voice channel Dendrop opened by itself (for a game night, or for people playing
 * together), but only once nobody's in it. True when it's gone (or already was), false while
 * people are still talking.
 */
export function removeVoiceWhenEmpty(ctx: Context, servers: ServerRepo, uploads: string, channelId: number | null): boolean {
  const voice = channelId ? servers.channelById(channelId) : undefined;
  if (!voice) return true;
  if ((ctx.voiceCount?.(voice.id) ?? 0) > 0) return false;
  for (const f of servers.deleteChannel(voice.serverId, voice.id)) rmSync(path.join(uploads, f), { force: true });
  ctx.serverChanged?.(voice.serverId);
  return true;
}
