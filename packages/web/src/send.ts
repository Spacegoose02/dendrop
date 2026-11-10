import type { Conversation, Message } from "@dendrop/shared";
import { api, apiForm } from "./api.ts";
import { encryptFile, encryptMessage, keyring } from "./e2ee.ts";
import { mentionsIn } from "./mentions.ts";

export interface SendExtras {
  reply?: { replyToId: number; replyPing: boolean };
  /** Forwarding: the original message's id (the server records who wrote it and when). */
  forwardOf?: number;
}

/**
 * Posts a message with its files to a conversation, encrypting both when the chat is
 * end-to-end encrypted. `plain` is for server channels and threads, which never make keys.
 */
export async function postMessage(c: Conversation, meId: number, plain: boolean, body: string, files: File[], extras: SendExtras = {}): Promise<Message> {
  const url = `/api/conversations/${c.id}/messages`;
  const version = plain ? null : await keyring.forSending(c);
  const fields: Record<string, string> = {};
  if (extras.reply) Object.assign(fields, { replyToId: String(extras.reply.replyToId), replyPing: String(extras.reply.replyPing) });
  if (extras.forwardOf) fields.forwardOf = String(extras.forwardOf);
  const json: Record<string, unknown> = { ...(extras.reply ?? {}), ...(extras.forwardOf ? { forwardOf: extras.forwardOf } : {}) };
  if (version) {
    // The server can't read an encrypted message, so it's told who it pings (only that).
    const pings = extras.forwardOf ? { ids: [], everyone: false } : mentionsIn(body);
    const encrypted = await Promise.all(files.map((f) => encryptFile(c.id, version, f)));
    const cipher = await encryptMessage(c.id, meId, version, body, encrypted.map((x) => x.meta));
    if (encrypted.length === 0) return api<Message>(url, { body: { body: cipher, keyVersion: version, ...json, mentions: pings.ids, mentionsEveryone: pings.everyone } });
    const form = new FormData();
    form.append("body", cipher);
    form.append("keyVersion", String(version));
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("mentions", JSON.stringify(pings.ids));
    form.append("mentionsEveryone", String(pings.everyone));
    for (const x of encrypted) form.append("file", x.blob, "file");
    return apiForm<Message>(url, form);
  }
  if (files.length === 0) return api<Message>(url, { body: { body, ...json } });
  const form = new FormData();
  form.append("body", body);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append("file", f, f.name);
  return apiForm<Message>(url, form);
}
