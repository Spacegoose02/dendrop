/**
 * End-to-end encryption for direct messages, with the browser's own WebCrypto.
 *
 * - Each account has one P-256 key pair. The public key is on the server. The private key is
 *   kept on each device in IndexedDB as a key that can't be exported, and on the server only
 *   encrypted with a key made from the person's chat passphrase (PBKDF2), which the server
 *   never sees. That's how a new phone or PC gets the key: type the passphrase once.
 * - Each conversation has an AES-256-GCM key, made by whoever sends first once everyone has
 *   set up. It's wrapped for each member with ECIES (an ephemeral ECDH key, HKDF, AES-GCM),
 *   and for the parents of any kid accounts in it (who can read it only while an alert is open).
 *   A new version is made when a member resets their keys; older versions stay readable for
 *   everyone who still has them.
 * - Messages and files are AES-GCM with a fresh IV. The additional data ties a message to its
 *   conversation and author, so the server can't move or reattribute it without it failing.
 */
import type { Attachment, Conversation, E2eeSetup, KeyBackup, Message, PublicUser, WrappedKey } from "@dendrop/shared";
import { api } from "./api.ts";
import { INSECURE_ENCRYPTION, isSecure } from "./secure.ts";

const PBKDF2_ROUNDS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = (data: ArrayBuffer | Uint8Array): string => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const random = (n: number) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

// ---- Keeping the private key on this device --------------------------------------

interface StoredIdentity {
  publicKey: string;
  privateKey: CryptoKey;
}

function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("dendrop-keys", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("identities");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = fn(db.transaction("identities", mode).objectStore("identities"));
      req.onsuccess = () => {
        resolve(req.result);
        db.close();
      };
      req.onerror = () => {
        reject(req.error);
        db.close();
      };
    };
  });
}

export interface Identity {
  userId: number;
  publicKey: string;
  privateKey: CryptoKey;
}

/** This device's copy of the private key, if it's been unlocked here and is still current. */
export async function loadIdentity(userId: number, serverPublicKey: string | null): Promise<Identity | null> {
  try {
    const stored = await idb<StoredIdentity | undefined>("readonly", (s) => s.get(`user:${userId}`));
    if (!stored) return null;
    if (stored.publicKey !== serverPublicKey) {
      // Reset on another device: this key can't read anything new.
      await forgetIdentity(userId);
      return null;
    }
    return { userId, ...stored };
  } catch {
    return null;
  }
}

export async function forgetIdentity(userId: number): Promise<void> {
  await idb("readwrite", (s) => s.delete(`user:${userId}`)).catch(() => {});
}

async function keep(userId: number, publicKey: string, pkcs8: ArrayBuffer): Promise<Identity> {
  // Re-imported so it can't be exported from this device again.
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, ECDH, false, ["deriveBits"]);
  await idb("readwrite", (s) => s.put({ publicKey, privateKey } satisfies StoredIdentity, `user:${userId}`));
  return { userId, publicKey, privateKey };
}

// ---- The passphrase backup ------------------------------------------------------

async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function makeBackup(pkcs8: ArrayBuffer, passphrase: string): Promise<KeyBackup> {
  const salt = random(16);
  const iv = random(12);
  const key = await passphraseKey(passphrase, salt, PBKDF2_ROUNDS);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("dendrop:backup") }, key, pkcs8);
  return { salt: b64(salt), iterations: PBKDF2_ROUNDS, iv: b64(iv), ciphertext: b64(ciphertext) };
}

async function openBackup(backup: KeyBackup, passphrase: string): Promise<ArrayBuffer> {
  const key = await passphraseKey(passphrase, unb64(backup.salt), backup.iterations);
  try {
    return await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(backup.iv), additionalData: enc.encode("dendrop:backup") }, key, unb64(backup.ciphertext));
  } catch {
    throw new Error("That passphrase doesn't match");
  }
}

/** Stops with a clear reason, not "crypto.subtle is undefined", on a plain http:// page. */
function requireSecure(): void {
  if (!isSecure()) throw new Error(INSECURE_ENCRYPTION);
}

/** Makes a new key pair, saves it on the server (encrypted) and on this device. */
export async function createIdentity(userId: number, passphrase: string, reset = false): Promise<Identity> {
  requireSecure();
  const pair = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = b64(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  await api<E2eeSetup>("/api/e2ee", { method: "PUT", body: { publicKey, backup: await makeBackup(pkcs8, passphrase), reset } });
  keyring.clear();
  return keep(userId, publicKey, pkcs8);
}

/** Opens the key saved on the server with the passphrase, for a new device. */
export async function unlockIdentity(userId: number, passphrase: string): Promise<Identity> {
  requireSecure();
  const setup = await api<E2eeSetup>("/api/e2ee");
  if (!setup.publicKey || !setup.backup) throw new Error("Encryption isn't set up for this account yet");
  return keep(userId, setup.publicKey, await openBackup(setup.backup, passphrase));
}

export async function changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
  requireSecure();
  const setup = await api<E2eeSetup>("/api/e2ee");
  if (!setup.publicKey || !setup.backup) throw new Error("Encryption isn't set up for this account yet");
  const pkcs8 = await openBackup(setup.backup, oldPassphrase);
  await api<E2eeSetup>("/api/e2ee", { method: "PUT", body: { publicKey: setup.publicKey, backup: await makeBackup(pkcs8, newPassphrase) } });
}

/**
 * A short code for a public key. Two people compare the codes they see for each other in
 * person; if they match, no one (the server included) has swapped a key.
 */
export async function securityCode(publicKey: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64(publicKey)));
  const view = new DataView(hash.buffer);
  return Array.from({ length: 6 }, (_, i) => String(view.getUint32(i * 4) % 100_000).padStart(5, "0")).join(" ");
}

// ---- Conversation keys ----------------------------------------------------------

async function wrapKeyFor(raw: Uint8Array<ArrayBuffer>, recipient: string, aad: string): Promise<string> {
  const eph = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const them = await crypto.subtle.importKey("raw", unb64(recipient), ECDH, false, []);
  const kek = await wrapKey(eph.privateKey, them, epk);
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, kek, raw);
  return `${b64(epk)}.${b64(iv)}.${b64(ct)}`;
}

async function wrapKey(priv: CryptoKey, pub: CryptoKey, epk: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: epk, info: enc.encode("dendrop:wrap:v1") },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function unwrapKey(wrapped: string, me: Identity, aad: string): Promise<ConversationKey> {
  const [epk, iv, ct] = wrapped.split(".").map(unb64) as [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>];
  const them = await crypto.subtle.importKey("raw", epk, ECDH, false, []);
  const kek = await wrapKey(me.privateKey, them, epk);
  return importConversationKey(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, kek, ct));
}

/**
 * A conversation key, imported twice from the same secret: for AES-GCM on messages and files,
 * and for HKDF to make call keys. Neither can be exported.
 */
interface ConversationKey {
  aes: CryptoKey;
  hkdf: CryptoKey;
}

async function importConversationKey(raw: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<ConversationKey> {
  return {
    aes: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]),
    hkdf: await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]),
  };
}

const wrapAad = (cid: number, version: number) => `dendrop:key:${cid}:${version}`;

/** Conversation keys this device has opened, by conversation and version. */
class KeyRing {
  identity: Identity | null = null;
  private keys = new Map<number, Map<number, ConversationKey>>();
  private loading = new Map<number, Promise<void>>();

  clear() {
    this.keys.clear();
    this.loading.clear();
  }

  private load(cid: number): Promise<void> {
    let p = this.loading.get(cid);
    if (!p) {
      p = (async () => {
        const me = this.identity;
        if (!me) return;
        const wrapped = await api<WrappedKey[]>(`/api/conversations/${cid}/keys`);
        const found = this.keys.get(cid) ?? new Map<number, ConversationKey>();
        for (const w of wrapped) {
          if (found.has(w.version)) continue;
          try {
            found.set(w.version, await unwrapKey(w.wrapped, me, wrapAad(cid, w.version)));
          } catch {
            /* a copy that doesn't open is skipped; its messages show as unreadable */
          }
        }
        this.keys.set(cid, found);
      })().finally(() => this.loading.delete(cid));
      this.loading.set(cid, p);
    }
    return p;
  }

  async key(cid: number, version: number): Promise<CryptoKey | undefined> {
    return (await this.both(cid, version))?.aes;
  }

  private async both(cid: number, version: number): Promise<ConversationKey | undefined> {
    if (!this.keys.get(cid)?.has(version)) await this.load(cid);
    return this.keys.get(cid)?.get(version);
  }

  /**
   * The media key for one call: HKDF of the conversation key, salted with when the call
   * started, so each call gets its own key and everyone in it works out the same one.
   */
  async callKey(cid: number, version: number, startedAt: string): Promise<ArrayBuffer | undefined> {
    const k = await this.both(cid, version);
    if (!k) return undefined;
    return crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode(startedAt), info: enc.encode(`dendrop:call:v1:${cid}:${version}`) },
      k.hkdf,
      256,
    );
  }

  /**
   * The key version to send with, making one if needed: the first key once everyone has set
   * up, or a new version when a member has reset. Null means send in the clear (someone hasn't
   * set up yet).
   */
  async forSending(conversation: Conversation): Promise<number | null> {
    const { e2ee } = conversation;
    // Kids' parents get a copy of the key too (the server insists); see docs/KIDS.md.
    const members = [...conversation.members, ...(conversation.guardians ?? [])];
    const everyoneReady = members.every((m) => m.publicKey);
    if (!this.identity) {
      if (e2ee) throw new Error("Unlock encryption on this device to send here");
      return null;
    }
    if (!e2ee && !everyoneReady) return null;
    if (e2ee && (e2ee.missing.length === 0 || !e2ee.missing.every((id) => members.find((m) => m.id === id)?.publicKey))) {
      return e2ee.version;
    }
    return this.create(conversation.id, (e2ee?.version ?? 0) + 1, members);
  }

  private async create(cid: number, version: number, members: PublicUser[]): Promise<number> {
    const raw = random(32);
    const keys: Record<number, { publicKey: string; wrapped: string }> = {};
    for (const m of members) keys[m.id] = { publicKey: m.publicKey!, wrapped: await wrapKeyFor(raw, m.publicKey!, wrapAad(cid, version)) };
    await api<Conversation>(`/api/conversations/${cid}/keys`, { body: { version, keys } });
    const found = this.keys.get(cid) ?? new Map<number, ConversationKey>();
    found.set(version, await importConversationKey(raw));
    this.keys.set(cid, found);
    return version;
  }
}

export const keyring = new KeyRing();

// ---- Messages and files -----------------------------------------------------------

/** What an encrypted message holds: its text, and the real details of its files in order. */
interface Payload {
  t: string;
  f?: FileMeta[];
}

export interface FileMeta {
  /** Name, type, size and the IV the bytes were encrypted with. */
  n: string;
  ty: string;
  s: number;
  iv: string;
}

/** A message as the app shows it: decrypted if it can be. */
export type ChatMessage = Message & {
  /** The text to show (the body, or the decrypted text). */
  text: string;
  /** For encrypted messages: each attachment's real details, matched by position. */
  files?: FileMeta[];
  /** Why an encrypted message can't be shown. */
  locked?: string;
};

const msgAad = (cid: number, authorId: number) => enc.encode(`dendrop:msg:${cid}:${authorId}`);
const fileAad = (cid: number) => enc.encode(`dendrop:file:${cid}`);

export async function reveal(m: Message): Promise<ChatMessage> {
  if (!m.keyVersion || m.deleted) return { ...m, text: m.body };
  if (!keyring.identity) return { ...m, text: "", locked: "Encrypted. Unlock encryption on this device to read it." };
  try {
    return await openWith(m, await keyring.key(m.conversationId, m.keyVersion));
  } catch {
    return { ...m, text: "", locked: "This message couldn't be decrypted." };
  }
}

async function openWith(m: Message, key: CryptoKey | undefined): Promise<ChatMessage> {
  if (!key) return { ...m, text: "", locked: "Encrypted before your keys were reset, so it can't be read on this account." };
  try {
    const [iv, ct] = m.body.split(".").map(unb64) as [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>];
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: msgAad(m.conversationId, m.authorId) }, key, ct);
    const p = JSON.parse(dec.decode(plain)) as Payload;
    return { ...m, text: String(p.t ?? ""), files: Array.isArray(p.f) ? p.f : [] };
  } catch {
    return { ...m, text: "", locked: "This message couldn't be decrypted." };
  }
}

/**
 * For a parent looking at a kid's chat through an open alert: opens the parent's own copies of
 * the conversation's keys (fetched through the alert, not as a member) and decrypts with them.
 * Messages sent before the parent was linked have no copy for them and stay locked.
 */
export async function openForParent(alertId: number, conversationId: number): Promise<Map<number, CryptoKey>> {
  const me = keyring.identity;
  const keys = new Map<number, CryptoKey>();
  if (!me) return keys;
  for (const w of await api<WrappedKey[]>(`/api/family/alerts/${alertId}/keys`)) {
    try {
      keys.set(w.version, (await unwrapKey(w.wrapped, me, wrapAad(conversationId, w.version))).aes);
    } catch {
      /* skipped, like in the keyring */
    }
  }
  return keys;
}

export async function revealWith(m: Message, keys: Map<number, CryptoKey>): Promise<ChatMessage> {
  if (!m.keyVersion) return { ...m, text: m.body };
  if (!keyring.identity) return { ...m, text: "", locked: "Encrypted. Unlock encryption on this device to read it." };
  const key = keys.get(m.keyVersion);
  if (!key) return { ...m, text: "", locked: "Sent before you were linked as a parent, so it can't be opened." };
  return openWith(m, key);
}

export async function encryptMessage(cid: number, authorId: number, version: number, text: string, files: FileMeta[] = []): Promise<string> {
  const key = await keyring.key(cid, version);
  if (!key) throw new Error("This device doesn't have the conversation key");
  const iv = random(12);
  const body: Payload = files.length ? { t: text, f: files } : { t: text };
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: msgAad(cid, authorId) }, key, enc.encode(JSON.stringify(body)));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function encryptFile(cid: number, version: number, file: File): Promise<{ blob: Blob; meta: FileMeta }> {
  const key = await keyring.key(cid, version);
  if (!key) throw new Error("This device doesn't have the conversation key");
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: fileAad(cid) }, key, await file.arrayBuffer());
  return { blob: new Blob([ct], { type: "application/octet-stream" }), meta: { n: file.name, ty: file.type || "application/octet-stream", s: file.size, iv: b64(iv) } };
}

/** Downloads and decrypts an attachment, as a Blob of its real type. */
export async function decryptFile(m: ChatMessage, a: Attachment, meta: FileMeta, keyOverride?: CryptoKey): Promise<Blob> {
  const key = keyOverride ?? (await keyring.key(m.conversationId, m.keyVersion!));
  if (!key) throw new Error("No key for this file");
  const res = await fetch(a.url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(meta.iv), additionalData: fileAad(m.conversationId) }, key, await res.arrayBuffer());
  return new Blob([plain], { type: meta.ty });
}

// ---- Couples kit ------------------------------------------------------------------

/**
 * Couples kit items use the conversation key too, bound to the kit, its conversation, the
 * author and the kind, so the server can't pass one off as a message or as another kind.
 */
const kitAad = (cid: number, authorId: number, kind: string) => enc.encode(`dendrop:couples:${cid}:${authorId}:${kind}`);
const kitPhotoAad = (cid: number) => enc.encode(`dendrop:couples-photo:${cid}`);

export async function encryptKitItem(cid: number, authorId: number, kind: string, version: number, data: unknown): Promise<string> {
  const key = await keyring.key(cid, version);
  if (!key) throw new Error("This device doesn't have the conversation key");
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: kitAad(cid, authorId, kind) }, key, enc.encode(JSON.stringify(data)));
  return `${b64(iv)}.${b64(ct)}`;
}

/** Opens a kit item's body. Throws if it can't be opened on this device. */
export async function decryptKitItem<T>(item: { conversationId: number; authorId: number; kind: string; keyVersion: number; body: string }): Promise<T> {
  if (!keyring.identity) throw new Error("Unlock encryption on this device to see it");
  const key = await keyring.key(item.conversationId, item.keyVersion);
  if (!key) throw new Error("Made before your keys were reset, so it can't be opened");
  const [iv, ct] = item.body.split(".").map(unb64) as [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>];
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: kitAad(item.conversationId, item.authorId, item.kind) }, key, ct);
  return JSON.parse(dec.decode(plain)) as T;
}

/** Encrypts a view-once photo. Its type, size and IV go inside the item's encrypted body. */
export async function encryptKitPhoto(cid: number, version: number, file: File): Promise<{ blob: Blob; meta: FileMeta }> {
  const key = await keyring.key(cid, version);
  if (!key) throw new Error("This device doesn't have the conversation key");
  const iv = random(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: kitPhotoAad(cid) }, key, await file.arrayBuffer());
  return { blob: new Blob([ct], { type: "application/octet-stream" }), meta: { n: "photo", ty: file.type || "image/jpeg", s: file.size, iv: b64(iv) } };
}

export async function decryptKitPhoto(cid: number, version: number, meta: FileMeta, data: ArrayBuffer): Promise<Blob> {
  const key = await keyring.key(cid, version);
  if (!key) throw new Error("No key for this photo");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(meta.iv), additionalData: kitPhotoAad(cid) }, key, data);
  return new Blob([plain], { type: meta.ty });
}
