import { useRef, useState } from "react";
import { EXPRESSION_LIMITS, isEmojiName, type ChatServer, type CustomEmoji, type ServerSound, type Sticker } from "@dendrop/shared";
import { api, ApiError } from "./api.ts";
import { can } from "./roles.ts";
import { playServerSound, soundLength } from "./soundboard.ts";
import { loadAudio } from "./audio.ts";

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

/** A name for an emoji from its file name: "Happy Raccoon!.png" → "Happy_Raccoon". */
const nameFromFile = (file: string) =>
  file
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, EXPRESSION_LIMITS.nameLength) || "emoji";

async function postForm<T>(url: string, form: FormData): Promise<T> {
  const res = await fetch(url, { method: "POST", credentials: "same-origin", body: form });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

/** Server settings → Emoji: everyone sees them; people with Manage emoji & stickers upload, rename and delete. */
export function EmojiTab({ server }: { server: ChatServer }) {
  const manage = can(server, "manageExpressions");
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const still = server.emojis.filter((e) => !e.animated);
  const moving = server.emojis.filter((e) => e.animated);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setBusy(true);
    const problems: string[] = [];
    for (const f of [...files]) {
      if (f.size > EXPRESSION_LIMITS.emojiBytes) {
        problems.push(`${f.name}: emoji can be up to ${kb(EXPRESSION_LIMITS.emojiBytes)}`);
        continue;
      }
      const form = new FormData();
      form.append("name", nameFromFile(f.name));
      form.append("file", f, f.name);
      try {
        await postForm<CustomEmoji>(`/api/servers/${server.id}/emojis`, form);
      } catch (err) {
        problems.push(`${f.name}: ${(err as Error).message}`);
      }
    }
    setBusy(false);
    if (problems.length) setError(problems.join(" · "));
  };

  return (
    <div className="server-settings">
      <p className="muted small">
        Everyone in {server.name} can use these anywhere on Dendrop, in other servers and in DMs, by picking them or typing <code>:name:</code>. Up to{" "}
        {EXPRESSION_LIMITS.emojis} still and {EXPRESSION_LIMITS.animatedEmojis} animated emoji, {kb(EXPRESSION_LIMITS.emojiBytes)} each. PNG, GIF, WebP or JPEG;
        animated GIFs, PNGs and WebPs move. Square pictures of 128×128 look best.
      </p>
      {manage && (
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Uploading…" : "Upload emoji"}
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            accept="image/png,image/gif,image/webp,image/jpeg"
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = "";
            }}
          />
          <span className="muted small">You can pick several; each is named after its file, and you can rename them after.</span>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      {server.emojis.length === 0 && <p className="muted">No custom emoji yet.</p>}
      {still.length > 0 && (
        <>
          <h4>
            Emoji <span className="muted small">({still.length}/{EXPRESSION_LIMITS.emojis})</span>
          </h4>
          <ul className="expression-list">
            {still.map((e) => (
              <EmojiRow key={e.id} server={server} emoji={e} manage={manage} />
            ))}
          </ul>
        </>
      )}
      {moving.length > 0 && (
        <>
          <h4>
            Animated <span className="muted small">({moving.length}/{EXPRESSION_LIMITS.animatedEmojis})</span>
          </h4>
          <ul className="expression-list">
            {moving.map((e) => (
              <EmojiRow key={e.id} server={server} emoji={e} manage={manage} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function EmojiRow({ server, emoji, manage }: { server: ChatServer; emoji: CustomEmoji; manage: boolean }) {
  const [name, setName] = useState(emoji.name);
  const [error, setError] = useState<string | null>(null);
  const uploader = server.members.find((m) => m.user.id === emoji.createdBy)?.user.displayName;

  const save = async () => {
    if (name === emoji.name) return;
    setError(null);
    try {
      await api(`/api/servers/${server.id}/emojis/${emoji.id}`, { method: "PATCH", body: { name } });
    } catch (err) {
      setError((err as Error).message);
      setName(emoji.name);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete :${emoji.name}:? Messages that used it show its name instead.`)) return;
    try {
      await api(`/api/servers/${server.id}/emojis/${emoji.id}`, { method: "DELETE" });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <li className="expression-row">
      <img className="custom-emoji big" src={emoji.url} alt={`:${emoji.name}:`} />
      {manage ? (
        <label className="grow">
          <span className="sr-only">Name</span>
          <input
            value={name}
            maxLength={EXPRESSION_LIMITS.nameLength}
            onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, "_"))}
            onBlur={() => isEmojiName(name) && void save()}
            onKeyDown={(e) => e.key === "Enter" && isEmojiName(name) && void save()}
            aria-invalid={!isEmojiName(name)}
          />
        </label>
      ) : (
        <code className="grow">:{emoji.name}:</code>
      )}
      <span className="muted small">{uploader ? `by ${uploader}` : ""}</span>
      {manage && (
        <button className="ghost danger" onClick={() => void remove()} aria-label={`Delete ${emoji.name}`}>
          Delete
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </li>
  );
}

/** Server settings → Stickers. */
export function StickersTab({ server }: { server: ChatServer }) {
  const manage = can(server, "manageExpressions");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [emoji, setEmoji] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const full = server.stickers.length >= EXPRESSION_LIMITS.stickers;

  const add = async () => {
    if (!file) return;
    setError(null);
    setBusy(true);
    const form = new FormData();
    form.append("name", name);
    form.append("description", description);
    form.append("emoji", emoji.trim());
    form.append("file", file, file.name);
    try {
      await postForm<Sticker>(`/api/servers/${server.id}/stickers`, form);
      setFile(null);
      setName("");
      setDescription("");
      setEmoji("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: Sticker) => {
    if (!confirm(`Delete the ${s.name} sticker?`)) return;
    try {
      await api(`/api/servers/${server.id}/stickers/${s.id}`, { method: "DELETE" });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="server-settings">
      <p className="muted small">
        Stickers are bigger pictures sent on their own, from the sticker tab in the 🙂 picker. Everyone in {server.name} can send them anywhere. Up to{" "}
        {EXPRESSION_LIMITS.stickers}, {kb(EXPRESSION_LIMITS.stickerBytes)} each: PNG, GIF or WebP (animated ones move), ideally 320×320 with a see-through background.
      </p>
      {manage && !full && (
        <fieldset className="sticker-form">
          <legend>Add a sticker</legend>
          <label>
            Picture
            <input
              type="file"
              accept="image/png,image/gif,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !name) setName(nameFromFile(f.name));
              }}
            />
          </label>
          <label>
            Name
            <input value={name} maxLength={EXPRESSION_LIMITS.nameLength} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, "_"))} placeholder="trash_panda" />
          </label>
          <label>
            Description <span className="muted small">(optional, read out by screen readers)</span>
            <input value={description} maxLength={EXPRESSION_LIMITS.stickerDescription} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label>
            Emoji that goes with it <span className="muted small">(optional, helps search)</span>
            <input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🦝" className="short" />
          </label>
          <button className="primary" disabled={!file || !isEmojiName(name) || busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add sticker"}
          </button>
        </fieldset>
      )}
      {error && <p className="error small">{error}</p>}
      {server.stickers.length === 0 ? (
        <p className="muted">No stickers yet.</p>
      ) : (
        <>
          <h4>
            Stickers <span className="muted small">({server.stickers.length}/{EXPRESSION_LIMITS.stickers})</span>
          </h4>
          <ul className="sticker-admin">
            {server.stickers.map((s) => (
              <li key={s.id}>
                <img src={s.url} alt={s.description || s.name} />
                <span className="small">
                  {s.emoji} {s.name}
                </span>
                {manage && (
                  <button className="ghost danger small" onClick={() => void remove(s)}>
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Server settings → Sounds: the server's soundboard. */
export function SoundsTab({ server }: { server: ChatServer }) {
  const manage = can(server, "manageExpressions");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [volume, setVolume] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const full = server.sounds.length >= EXPRESSION_LIMITS.sounds;

  const pick = async (f: File | null) => {
    setError(null);
    setFile(null);
    if (!f) return;
    if (f.size > EXPRESSION_LIMITS.soundBytes) return setError(`Sounds can be up to ${kb(EXPRESSION_LIMITS.soundBytes)}`);
    try {
      const secs = await soundLength(f);
      // A little slack for silence at the end.
      if (secs > EXPRESSION_LIMITS.soundSeconds + 0.5) return setError(`Sounds can be up to ${EXPRESSION_LIMITS.soundSeconds} seconds; that one is ${secs.toFixed(1)}`);
    } catch {
      return setError("That file doesn't play as a sound here. Try an MP3 or Ogg.");
    }
    setFile(f);
    if (!name) setName(nameFromFile(f.name));
  };

  const preview = () => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const a = new Audio(url);
    a.volume = (volume / 100) * (loadAudio().soundboardVolume / 100 || 0.6);
    a.onended = () => URL.revokeObjectURL(url);
    void a.play().catch(() => {});
  };

  const add = async () => {
    if (!file) return;
    setError(null);
    setBusy(true);
    const form = new FormData();
    form.append("name", name);
    form.append("emoji", emoji.trim());
    form.append("volume", String(volume));
    form.append("file", file, file.name);
    try {
      await postForm<ServerSound>(`/api/servers/${server.id}/sounds`, form);
      setFile(null);
      setName("");
      setEmoji("");
      setVolume(100);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: ServerSound) => {
    if (!confirm(`Delete the ${s.name} sound?`)) return;
    try {
      await api(`/api/servers/${server.id}/sounds/${s.id}`, { method: "DELETE" });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="server-settings">
      <p className="muted small">
        Sounds for the soundboard in {server.name}'s voice channels, next to the built-in ones. Anyone in a voice channel can play them for everyone there.
        Up to {EXPRESSION_LIMITS.sounds}, {EXPRESSION_LIMITS.soundSeconds} seconds and {kb(EXPRESSION_LIMITS.soundBytes)} each: MP3, Ogg or WAV.
      </p>
      {manage && !full && (
        <fieldset className="sticker-form">
          <legend>Add a sound</legend>
          <label>
            Sound
            <input type="file" accept="audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.opus,.wav" onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
          </label>
          <label>
            Name
            <input value={name} maxLength={EXPRESSION_LIMITS.nameLength} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, "_"))} placeholder="goose_honk" />
          </label>
          <label>
            Emoji for its button <span className="muted small">(optional)</span>
            <input value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🦢" className="short" />
          </label>
          <label className="range-row">
            <span>Volume</span>
            <input type="range" min={1} max={100} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
            <span className="range-value">{volume}%</span>
            <button type="button" disabled={!file} onClick={preview}>
              Preview
            </button>
          </label>
          <button className="primary" disabled={!file || !isEmojiName(name) || busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Add sound"}
          </button>
        </fieldset>
      )}
      {error && <p className="error small">{error}</p>}
      {server.sounds.length === 0 ? (
        <p className="muted">No sounds of its own yet.</p>
      ) : (
        <>
          <h4>
            Sounds <span className="muted small">({server.sounds.length}/{EXPRESSION_LIMITS.sounds})</span>
          </h4>
          <ul className="expression-list">
            {server.sounds.map((s) => (
              <li key={s.id} className="expression-row">
                <button className="ghost" onClick={() => void playServerSound(s, { ...loadAudio(), soundboardVolume: loadAudio().soundboardVolume || 60 })} aria-label={`Play ${s.name}`}>
                  ▶️
                </button>
                <span className="grow">
                  {s.emoji} {s.name}
                </span>
                <span className="muted small">{s.volume}%</span>
                {manage && (
                  <button className="ghost danger small" onClick={() => void remove(s)}>
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
