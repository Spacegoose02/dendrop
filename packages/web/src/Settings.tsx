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
import "./settings.css";

/** The gear button and the settings dialog it opens. Appearance is the only section so far. */
export function SettingsButton() {
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
        {open && <AppearancePane onDone={() => setOpen(false)} />}
      </dialog>
    </>
  );
}

function AppearancePane({ onDone }: { onDone: () => void }) {
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
        <h2>Appearance</h2>
        <button className="ghost" onClick={onDone} aria-label="Close settings">
          Done
        </button>
      </header>

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
