import { BlockedSection, YourDataSection } from "./Safety.tsx";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { previewsInEncrypted, setPreviewsInEncrypted } from "./LinkPreview.tsx";
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
import { SignInSection } from "./SignIns.tsx";
import { ProfileEditor } from "./Profile.tsx";
import { AudioSettings } from "./AudioSettings.tsx";
import { useColors } from "./colors.ts";
import { securityCode } from "./e2ee.ts";
import { HTTPS_GUIDE, isSecure } from "./secure.ts";
import type { EncryptionMode } from "./EncryptionDialog.tsx";
import { disableWebPush, enableWebPush, webPushState, type WebPushState } from "./webpush.ts";
import "./settings.css";

/** The gear button and the full-page settings screen it opens: a menu of pages on the left (your account, then the app), one page on the right. */
type KeyState = "loading" | "off" | "locked" | "on";

export function SettingsButton({
  me,
  onSaved,
  keyState,
  onEncryption,
  onFamily,
  onDeleted,
  picturesAllowed = true,
}: {
  me: Me;
  onSaved: (me: Me) => void;
  keyState: KeyState;
  onEncryption: (mode: EncryptionMode) => void;
  onFamily: () => void;
  /** After the account is deleted: back to the sign-in page. */
  onDeleted: () => void;
  /** Kids need a parent's OK for a profile picture and banner. */
  picturesAllowed?: boolean;
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
            picturesAllowed={picturesAllowed}
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
            onDeleted={onDeleted}
          />
        )}
      </dialog>
    </>
  );
}

type PageId = "account" | "profile" | "signin" | "encryption" | "blocked" | "family" | "notifications" | "voice" | "theme" | "icon" | "data";

/** The left-hand menu, in groups. The names match what other screens call them ("Settings → Sign-in"). */
const MENU: { group: string; pages: { id: PageId; label: string; icon: string }[] }[] = [
  {
    group: "Your account",
    pages: [
      { id: "account", label: "Account", icon: "🦝" },
      { id: "profile", label: "Profile", icon: "🪪" },
      { id: "signin", label: "Sign-in", icon: "🔑" },
      { id: "encryption", label: "Encryption", icon: "🔒" },
      { id: "blocked", label: "Blocked", icon: "🚫" },
      { id: "family", label: "Family", icon: "👪" },
    ],
  },
  {
    group: "App",
    pages: [
      { id: "notifications", label: "Notifications", icon: "🔔" },
      { id: "voice", label: "Voice and audio", icon: "🎙️" },
      { id: "theme", label: "Theme", icon: "🎨" },
      { id: "icon", label: "App icon", icon: "🖼️" },
    ],
  },
  { group: "Data", pages: [{ id: "data", label: "Your data", icon: "📦" }] },
];
const LABEL = Object.fromEntries(MENU.flatMap((g) => g.pages.map((p) => [p.id, p.label]))) as Record<PageId, string>;

/** Phones: the menu and a page take turns filling the screen. Matches the 720px breakpoint in settings.css. */
const NARROW = "(max-width: 720px)";
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** The full-page settings screen: a menu on the left, one page at a time on the right. On a phone, the menu first, then the page with a Back button. */
function SettingsPane({
  me,
  onSaved,
  onDone,
  keyState,
  onEncryption,
  onFamily,
  onDeleted,
  picturesAllowed,
}: {
  me: Me;
  onSaved: (me: Me) => void;
  onDeleted: () => void;
  picturesAllowed: boolean;
  onDone: () => void;
  keyState: KeyState;
  onEncryption: (mode: EncryptionMode) => void;
  onFamily: () => void;
}) {
  const narrow = useNarrow();
  const [picked, setPicked] = useState<PageId | null>(null);
  // On a wide screen there's always a page showing; on a phone, nothing picked means the menu.
  const page: PageId | null = picked ?? (narrow ? null : "account");
  const content = useRef<HTMLDivElement>(null);

  const go = (id: PageId) => {
    setPicked(id);
    content.current?.scrollTo(0, 0);
  };

  return (
    <div className={`settings-body ${narrow ? (page ? "show-page" : "show-menu") : ""}`}>
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-inner">
          <header className="settings-nav-header">
            <h2>Settings</h2>
            <button className="ghost settings-close narrow-only" onClick={onDone} aria-label="Close settings">
              Done
            </button>
          </header>
          <div className="settings-me">
            <strong>{me.displayName}</strong>
            <span className="muted small">@{me.username}</span>
          </div>
          {MENU.map((g) => (
            <div key={g.group} className="settings-nav-group">
              <h3>{g.group}</h3>
              {g.pages.map((p) => (
                <button
                  key={p.id}
                  className={`settings-nav-item ${page === p.id ? "on" : ""}`}
                  aria-current={page === p.id ? "page" : undefined}
                  onClick={() => go(p.id)}
                >
                  <span className="settings-nav-icon" aria-hidden>
                    {p.icon}
                  </span>
                  <span className="settings-nav-label">{p.label}</span>
                  <span className="settings-nav-chevron narrow-only" aria-hidden>
                    ›
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>

      <div className="settings-content" ref={content}>
        {page && (
          <div className="settings-page">
            <header className="settings-header">
              <button className="ghost settings-back narrow-only" onClick={() => setPicked(null)} aria-label="Back to settings">
                ‹ Settings
              </button>
              <h2>{LABEL[page]}</h2>
              <button className="ghost settings-close wide-only" onClick={onDone} aria-label="Close settings" title="Close (Esc)">
                <span aria-hidden>✕</span>
                <span className="settings-esc">Esc</span>
              </button>
            </header>
            <SettingsPage
              page={page}
              me={me}
              onSaved={onSaved}
              keyState={keyState}
              onEncryption={onEncryption}
              onFamily={onFamily}
              onDeleted={onDeleted}
              picturesAllowed={picturesAllowed}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** One page of settings. Each section's own title is hidden in CSS, since the page header already says it. */
function SettingsPage({
  page,
  me,
  onSaved,
  keyState,
  onEncryption,
  onFamily,
  onDeleted,
  picturesAllowed,
}: {
  page: PageId;
  me: Me;
  onSaved: (me: Me) => void;
  onDeleted: () => void;
  picturesAllowed: boolean;
  keyState: KeyState;
  onEncryption: (mode: EncryptionMode) => void;
  onFamily: () => void;
}) {
  switch (page) {
    case "account":
      return <AccountSection me={me} onSaved={onSaved} />;
    case "profile":
      return (
        <section>
          <p className="muted small">What friends and the people in your chats and servers see when they click your name.</p>
          <ProfileEditor me={me} onSaved={onSaved} picturesAllowed={picturesAllowed} />
        </section>
      );
    case "signin":
      return <SignInSection />;
    case "encryption":
      return <EncryptionSection me={me} keyState={keyState} onEncryption={onEncryption} />;
    case "blocked":
      return <BlockedSection />;
    case "family":
      return (
        <section>
          <p className="muted small">
            {me.isKid
              ? "Your account is linked to your parents. See what they can see, your rules, and when they looked."
              : "Link a kid's account to yours: you set their rules and get alerts, and their chats stay end-to-end encrypted. Got a code from a parent? Type it here."}
          </p>
          <button onClick={onFamily}>{me.isKid ? "Your family" : "Family and kid accounts"}</button>
        </section>
      );
    case "notifications":
      return <DeviceNotificationsSection />;
    case "voice":
      return <AudioSettings />;
    case "theme":
      return <ThemeSection />;
    case "icon":
      return <AppIconSection />;
    case "data":
      return <YourDataSection me={me} onDeleted={onDeleted} />;
  }
}

/** Appearance is saved on this device; the theme and app icon pages share it. */
function useAppearance(): [Appearance, (next: Partial<Appearance>) => void] {
  const [appearance, set] = useState<Appearance>(loadAppearance);
  const choose = (next: Partial<Appearance>) => {
    const a = { ...loadAppearance(), ...next };
    setAppearance(a);
    set(a);
  };
  return [appearance, choose];
}

function ThemeSection() {
  const [appearance, choose] = useAppearance();
  const [family, setFamily] = useState<ThemeFamily | "all">(() => getTheme(loadAppearance().theme).family);
  const current = getTheme(appearance.theme);
  const shown = useMemo(() => (family === "all" ? THEMES : THEMES.filter((t) => t.family === family)), [family]);
  return (
    <section>
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
  );
}

function AppIconSection() {
  const [appearance, choose] = useAppearance();
  const current = getTheme(appearance.theme);
  return (
    <section>
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
  );
}

/** Quick picks for name and text colors. Any color works; these are just a start. */
const COLOR_PICKS = ["#9b59ff", "#4d6bff", "#3fb6ff", "#2bd9a0", "#7ed957", "#ffd23f", "#ff9f43", "#ff4d4d", "#ff4fa3", "#c9a7ff"];

/** One color setting: swatches, a free picker, and "Theme default" to clear it. */
export function ColorPicker({ label, value, onChange }: { label: string; value: string | null; onChange: (c: string | null) => void }) {
  return (
    <div className="color-setting">
      <span className="color-setting-label">{label}</span>
      <div className="color-swatches" role="radiogroup" aria-label={label}>
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          className={`swatch swatch-default ${value === null ? "on" : ""}`}
          onClick={() => onChange(null)}
          title="Theme default"
        >
          Aa
        </button>
        {COLOR_PICKS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={value === c}
            aria-label={c}
            className={`swatch ${value === c ? "on" : ""}`}
            style={{ background: c }}
            onClick={() => onChange(c)}
          />
        ))}
        <label className={`swatch swatch-custom ${value && !COLOR_PICKS.includes(value) ? "on" : ""}`} title="Pick any color">
          <input type="color" value={value ?? "#9b59ff"} onChange={(e) => onChange(e.target.value.toLowerCase())} aria-label={`${label}: any color`} />
          <span aria-hidden="true">+</span>
        </label>
      </div>
    </div>
  );
}

/** Display name, read receipts and sharing what you play. These are saved to your account, so they follow you to every device. */
function AccountSection({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [readReceipts, setReadReceipts] = useState(me.readReceipts);
  const [shareActivity, setShareActivity] = useState(me.shareActivity);
  const [nameColor, setNameColor] = useState(me.nameColor);
  const [textColor, setTextColor] = useState(me.textColor);
  const colorsOf = useColors();
  const preview = colorsOf({ nameColor, textColor });
  const adjusted = (!!nameColor && preview.name?.color !== nameColor) || (!!textColor && preview.text?.color !== textColor);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed =
    displayName.trim() !== me.displayName ||
    readReceipts !== me.readReceipts ||
    shareActivity !== me.shareActivity ||
    nameColor !== me.nameColor ||
    textColor !== me.textColor;

  const save = async () => {
    setError(null);
    try {
      onSaved(await api<Me>("/api/me", { method: "PATCH", body: { displayName, readReceipts, shareActivity, nameColor, textColor } }));
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
      <h3>Colors</h3>
      <p className="muted small">Everyone sees your name and messages in these colors. On themes where a color would be hard to read, it's lightened or darkened just enough.</p>
      <ColorPicker
        label="Name color"
        value={nameColor}
        onChange={(c) => {
          setNameColor(c);
          setStatus(null);
        }}
      />
      <ColorPicker
        label="Text color"
        value={textColor}
        onChange={(c) => {
          setTextColor(c);
          setStatus(null);
        }}
      />
      <div className="color-preview" aria-label="Preview">
        <strong style={preview.name}>{displayName.trim() || me.displayName}</strong>
        <span className="muted small"> Today at 7:44 PM</span>
        <p style={preview.text}>This is how your messages look in this theme.</p>
      </div>
      {adjusted && <p className="muted small">Adjusted a little so it reads well on this theme.</p>}
      <h3>Privacy</h3>
      <EncryptedPreviewsToggle />
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

/** Phone and browser notifications for Dendrop opened in a browser (the apps have their own). */
function DeviceNotificationsSection() {
  const [state, setState] = useState<WebPushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void webPushState().then(setState, () => setState("unsupported"));
  }, []);
  if (!state) return null;
  if (state === "app")
    return (
      <section>
        <p className="muted small">The Dendrop app sends its own notifications. Turn them on or off for Dendrop in your phone's or computer's settings.</p>
      </section>
    );

  const flip = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = on ? await enableWebPush() : await disableWebPush();
      setState(next);
      if (on && next === "off") setError("Notifications weren't allowed. Try again and pick Allow.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't turn notifications on");
    } finally {
      setBusy(false);
    }
  };

  const note: Partial<Record<WebPushState, string>> = {
    "needs-install": "On iPhone and iPad, Apple only sends notifications to Dendrop once it's on your Home Screen: tap Share, then Add to Home Screen, and open Dendrop from there. Or use the iPhone app.",
    insecure: "Browsers only allow notifications on a secure https:// address, and this page was opened over plain http://.",
    unsupported: "This browser can't get notifications from Dendrop. Try Chrome, Firefox, Edge or Safari, or the phone app.",
    denied: "Notifications are blocked for this site. Allow them in your browser's site settings, then come back here.",
  };

  return (
    <section>
      <h3>Notifications on this device</h3>
      {state === "on" || state === "off" ? (
        <label className="toggle">
          <input type="checkbox" checked={state === "on"} disabled={busy} onChange={(e) => void flip(e.target.checked)} />
          <span>
            <strong>Notify me about new messages and mentions</strong>
            <span className="muted small">
              Even with Dendrop closed. A notification only says that something came in, never who sent it or what it says. Nothing shows while you're
              using Dendrop on another device.
            </span>
          </span>
        </label>
      ) : (
        <p className="muted small">{note[state]}</p>
      )}
      {error && <p className="error small">{error}</p>}
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

/** Link previews in encrypted chats: kept on this device, since asking shows the server the link. */
function EncryptedPreviewsToggle() {
  const [on, setOn] = useState(previewsInEncrypted);
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setPreviewsInEncrypted(e.target.checked);
          setOn(e.target.checked);
        }}
      />
      <span>
        <strong>Link previews in encrypted chats</strong>
        <span className="muted small">
          Off by default: to fetch a preview, this device has to send the link to your Dendrop server, which otherwise can't read encrypted chats. Only applies on this
          device.
        </span>
      </span>
    </label>
  );
}
