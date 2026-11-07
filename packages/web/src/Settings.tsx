import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  APP_ICONS,
  appIconSvg,
  FAMILIES,
  getTheme,
  loadAppearance,
  setAppearance,
  svgDataUri,
  THEME_ICON,
  THEMES,
  themeVars,
  type Appearance,
  type Theme,
  type ThemeFamily,
} from "@dendrop/theme";
import { LIMITS, type Me } from "@dendrop/shared";
import { api } from "./api.ts";
import { AudioSettings } from "./AudioSettings.tsx";
import { securityCode } from "./e2ee.ts";
import { HTTPS_GUIDE, isSecure } from "./secure.ts";
import type { EncryptionMode } from "./EncryptionDialog.tsx";
import "./settings.css";

/** The gear button and the settings dialog it opens: your account and privacy, voice and audio, then appearance. */
type KeyState = "loading" | "off" | "locked" | "on";

export function SettingsButton({
  me,
  onSaved,
  keyState,
  onEncryption,
  onFamily,
}: {
  me: Me;
  onSaved: (me: Me) => void;
  keyState: KeyState;
  onEncryption: (mode: EncryptionMode) => void;
  onFamily: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  return (
    <>
      <button className="ghost settings-gear" onClick={() => setOpen(true)} title="Settings" aria-label="Settings">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
          <path
            fill="currentColor"
            d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"
            transform="translate(-1 0)"
          />
        </svg>
      </button>
      <dialog
        ref={dialog}
        className="settings"
        aria-label="Settings"
        onClose={() => setOpen(false)}
        onClick={(e) => e.target === dialog.current && setOpen(false)}
      >
        {open && (
          <SettingsPane
            me={me}
            onSaved={onSaved}
            onDone={() => setOpen(false)}
            keyState={keyState}
            onEncryption={(mode) => {
              setOpen(false);
              onEncryption(mode);
            }}
            onFamily={() => {
              setOpen(false);
              onFamily();
            }}
          />
        )}
      </dialog>
    </>
  );
}

function SettingsPane({
  me,
  onSaved,
  onDone,
  keyState,
  onEncryption,
  onFamily,
}: {
  me: Me;
  onSaved: (me: Me) => void;
  onDone: () => void;
  keyState: KeyState;
  onEncryption: (mode: EncryptionMode) => void;
  onFamily: () => void;
}) {
  const [appearance, set] = useState<Appearance>(loadAppearance);
  const [family, setFamily] = useState<ThemeFamily | "all">(() => getTheme(loadAppearance().theme).family);
  const current = getTheme(appearance.theme);
  const shown = useMemo(() => (family === "all" ? THEMES : THEMES.filter((t) => t.family === family)), [family]);

  const choose = (next: Partial<Appearance>) => {
    const a = { ...appearance, ...next };
    setAppearance(a);
    set(a);
  };

  return (
    <div className="settings-body">
      <header className="settings-header">
        <h2>Settings</h2>
        <button className="ghost" onClick={onDone} aria-label="Close settings">
          Done
        </button>
      </header>

      <AccountSection me={me} onSaved={onSaved} />
      <EncryptionSection me={me} keyState={keyState} onEncryption={onEncryption} />
      <AudioSettings />

      <section>
        <h3>Family</h3>
        <p className="muted small">
          {me.isKid
            ? "Your account is linked to your parents. See what they can see, your rules, and when they looked."
            : "Link a kid's account to yours: you set their rules and get alerts, and their chats stay end-to-end encrypted. Got a code from a parent? Type it here."}
        </p>
        <button onClick={onFamily}>{me.isKid ? "Your family" : "Family and kid accounts"}</button>
      </section>

      <section>
        <h3>Theme</h3>
        <p className="muted small">
          {current.name}: {current.blurb} Saved on this device.
        </p>
        <div className="chips" role="tablist" aria-label="Theme packs">
          {[{ id: "all" as const, name: "All" }, ...FAMILIES].map((f) => (
            <button key={f.id} role="tab" aria-selected={family === f.id} className={`chip ${family === f.id ? "on" : ""}`} onClick={() => setFamily(f.id)}>
              {f.name}
            </button>
          ))}
        </div>
        <div className="theme-grid">
          {shown.map((t) => (
            <ThemeCard key={t.id} theme={t} selected={t.id === current.id} onPick={() => choose({ theme: t.id })} />
          ))}
        </div>
      </section>

      <section>
        <h3>App icon</h3>
        <p className="muted small">Shown in the browser tab, and on the desktop and Android apps.</p>
        <div className="icon-grid">
          {[{ id: THEME_ICON, name: "Match theme" }, ...APP_ICONS].map((icon) => (
            <button
              key={icon.id}
              className={`icon-choice ${appearance.icon === icon.id ? "on" : ""}`}
              aria-pressed={appearance.icon === icon.id}
              onClick={() => choose({ icon: icon.id })}
            >
              <img src={svgDataUri(appIconSvg(icon.id, current))} alt="" width={56} height={56} />
              <span>{icon.name}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/** Display name, read receipts and sharing what you play. These are saved to your account, so they follow you to every device. */
function AccountSection({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [readReceipts, setReadReceipts] = useState(me.readReceipts);
  const [shareActivity, setShareActivity] = useState(me.shareActivity);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = displayName.trim() !== me.displayName || readReceipts !== me.readReceipts || shareActivity !== me.shareActivity;

  const save = async () => {
    setError(null);
    try {
      onSaved(await api<Me>("/api/me", { method: "PATCH", body: { displayName, readReceipts, shareActivity } }));
      setStatus("Saved");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="account-settings">
      <h3>Account</h3>
      <label>
        Display name
        <input
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            setStatus(null);
          }}
          maxLength={LIMITS.displayNameLength}
        />
      </label>
      <h3>Privacy</h3>
      <label className="toggle">
        <input
          type="checkbox"
          checked={readReceipts}
          onChange={(e) => {
            setReadReceipts(e.target.checked);
            setStatus(null);
          }}
        />
        <span>
          <strong>Read receipts</strong>
          <span className="muted small">Let people see when you've read their messages. When this is off you won't see theirs either.</span>
        </span>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={shareActivity}
          onChange={(e) => {
            setShareActivity(e.target.checked);
            setStatus(null);
          }}
        />
        <span>
          <strong>Show what I'm playing</strong>
          <span className="muted small">When LootDen is linked, your friends and the people in your servers see the game you're playing and on which PC.</span>
        </span>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="account-save">
        <button className="primary" disabled={!changed} onClick={() => void save()}>
          Save
        </button>
        {status && !changed && <span className="muted small">{status}</span>}
      </div>
    </section>
  );
}

/** Encryption status, your security code, and passphrase changes. */
function EncryptionSection({ me, keyState, onEncryption }: { me: Me; keyState: KeyState; onEncryption: (mode: EncryptionMode) => void }) {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    if (me.publicKey && isSecure()) void securityCode(me.publicKey).then(setCode);
  }, [me.publicKey]);

  return (
    <section className="encryption-settings">
      <h3>End-to-end encryption</h3>
      {!isSecure() && (
        <p className="warning small">
          This page is on plain <code>http://</code>, and browsers only allow encryption on <code>https://</code>.{" "}
          <a href={HTTPS_GUIDE} target="_blank" rel="noreferrer">
            How to set up HTTPS
          </a>
        </p>
      )}
      {keyState === "off" && (
        <>
          <p className="muted small">Off. Turn it on so your direct messages can only be read by the people in them.</p>
          <button className="primary" onClick={() => onEncryption("setup")}>
            Turn on encryption
          </button>
        </>
      )}
      {keyState === "locked" && (
        <>
          <p className="muted small">On for your account, but locked on this device. Type your chat passphrase to read encrypted messages here.</p>
          <button className="primary" onClick={() => onEncryption("unlock")}>
            Unlock
          </button>
        </>
      )}
      {keyState === "on" && (
        <>
          <p className="muted small">On, and unlocked on this device.</p>
          {code && (
            <p className="small">
              Your security code: <code className="security-code">{code}</code>
            </p>
          )}
          <div className="account-save">
            <button onClick={() => onEncryption("change")}>Change passphrase</button>
            <button className="ghost danger" onClick={() => onEncryption("reset")}>
              Reset keys
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** A live miniature of the app, painted with the card's own theme tokens. */
function ThemeCard({ theme, selected, onPick }: { theme: Theme; selected: boolean; onPick: () => void }) {
  const icon = useMemo(() => svgDataUri(appIconSvg(THEME_ICON, theme)), [theme]);
  return (
    <button className={`theme-card ${selected ? "on" : ""}`} style={themeVars(theme) as CSSProperties} aria-pressed={selected} onClick={onPick}>
      <span className="mini" aria-hidden>
        <span className="mini-rail">
          <img src={icon} alt="" />
          <i />
          <i />
        </span>
        <span className="mini-side">
          <i className="w70" />
          <i className="w50 hi" />
          <i className="w60" />
        </span>
        <span className="mini-main">
          <i className="bubble w70" />
          <i className="bubble w40 mine" />
          <i className="input" />
        </span>
      </span>
      <span className="theme-name">
        <strong>{theme.name}</strong>
        {selected && <span className="tick">✓</span>}
      </span>
    </button>
  );
}
