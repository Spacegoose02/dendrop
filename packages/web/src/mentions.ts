import { EVERYONE_RE, MENTION_RE, type PublicUser } from "@dendrop/shared";

/** "@username" in a draft, as a word of its own. */
const AT_NAME = /(?<![\w@<])@([A-Za-z0-9_.-]{1,32})/g;

/** Turns @username into <@id> for people in the conversation, before sending. */
export function toMentionTokens(text: string, members: PublicUser[]): string {
  return text.replace(AT_NAME, (whole, name: string) => {
    if (name.toLowerCase() === "everyone") return whole;
    const u = members.find((m) => m.username.toLowerCase() === name.toLowerCase());
    return u ? `<@${u.id}>` : whole;
  });
}

/** Turns <@id> back into @username, for editing a message. */
export function fromMentionTokens(text: string, members: PublicUser[]): string {
  return text.replace(new RegExp(MENTION_RE.source, "g"), (whole, id: string) => {
    const u = members.find((m) => m.id === Number(id));
    return u ? `@${u.username}` : whole;
  });
}

/** Who a message's text pings, for encrypted messages (the server can't read them to find out). */
export function mentionsIn(text: string): { ids: number[]; everyone: boolean } {
  const ids = [...new Set([...text.matchAll(new RegExp(MENTION_RE.source, "g"))].map((m) => Number(m[1])))];
  return { ids, everyone: EVERYONE_RE.test(text) };
}

/** "@ka" right before the cursor: what's typed after the @, and where the @ is. */
export function typedMention(draft: string, caret: number): { query: string; start: number } | null {
  const m = /(?:^|\s)@([A-Za-z0-9_.-]{0,32})$/.exec(draft.slice(0, caret));
  if (!m) return null;
  return { query: m[1]!, start: caret - m[1]!.length - 1 };
}

/** People (and @everyone) matching what's typed after an @. */
export function mentionSuggestions(query: string, members: PublicUser[], meId: number, everyone: boolean): { label: string; insert: string; user?: PublicUser }[] {
  const q = query.toLowerCase();
  const people = members
    .filter((m) => m.id !== meId && (m.username.toLowerCase().startsWith(q) || m.displayName.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))))
    .slice(0, 7)
    .map((u) => ({ label: u.displayName, insert: `@${u.username}`, user: u }));
  return everyone && "everyone".startsWith(q) ? [...people, { label: "everyone", insert: "@everyone" }] : people;
}
