# End-to-end encryption

Direct messages and group DMs are end-to-end encrypted: text, file names and file contents are
encrypted on your device, and the server only ever stores ciphertext. It's built on the
browser's WebCrypto, so the web, desktop (Electron) and Android (Capacitor) apps share it.
The code is in `packages/web/src/e2ee.ts`.

## How it works

**Your account key.** Turning encryption on makes a P-256 key pair. The public key goes to
the server so others can encrypt to you. The private key is:

- kept on each of your devices in IndexedDB, as a key that can't be exported, and
- stored on the server encrypted with your **chat passphrase** (PBKDF2-SHA256, 600,000 rounds,
  then AES-256-GCM). The server never sees the passphrase, so it can't open it.

On a new phone or PC you type the passphrase once and that device has your key.

**Conversation keys.** Once everyone in a conversation has turned encryption on, the next
person to send makes a random AES-256 key and wraps a copy for each member (ECIES: an ephemeral
ECDH key, HKDF-SHA256, AES-GCM). From then on the server refuses plain messages in that
conversation, so an old or tampered client can't quietly fall back. Until everyone has set up,
the chat says who it's waiting for and messages stay plain.

**Messages and files.** Each message is AES-GCM with a fresh IV. The additional data binds it
to its conversation and author, so the server can't move it to another chat or change who sent
it without decryption failing. Files are encrypted separately; their real name, type and size
travel inside the encrypted message, and the server stores them as `file` /
`application/octet-stream`.

**Checking keys.** The 🔒 in a chat's header lists everyone's security code (from a hash of
their public key). If the code you see for someone matches the one they see for themselves in
Settings, nobody, the server included, has swapped their key.

## Resetting

If you forget your passphrase you can reset: that makes a new key pair. Messages encrypted to
your old key can't be read on your account any more. The next message anyone sends in each
conversation makes a new key version that includes your new key, and the older versions stay
readable for everyone else.

## What it doesn't cover yet

- **Call media.** Calls go through your own LiveKit server; LiveKit's E2EE for media is next.
- **Forward secrecy.** A conversation key is used until someone resets. Someone who gets your
  private key *and* the server's database could read past messages. A ratchet (Signal-style or
  MLS) would fix that; it's on the roadmap.
- **Metadata.** The server still knows who talks to whom and when, file sizes, and presence and
  typing signals, because it has to route them.
