# @dendrop/theme

Design tokens, the theme set and the raccoon app icons. Clients style only with the `--dd-*`
variables, so every theme works everywhere without a stylesheet of its own.

- `src/tokens.css`: the Den defaults, loaded first so the page is styled before any script runs.
- `src/themes.ts`: 42 themes in five packs (Den, Dark, Nuclear, Gaming, Laser). Each theme is a
  few seed colors; the surface ladder, muted text, hover and button colors are derived from them.
- `src/icons.ts`: the raccoon mark drawn from code in three styles (flat, neon, pixel), the
  alternate app icons, and a "Match theme" icon that follows the active theme.
- `src/index.ts`: `applyTheme()`, `applyAppIcon()`, and `loadAppearance()` / `setAppearance()`,
  which save the choice on this device.

## Adding a theme

Add a seed to `SEEDS` in `src/themes.ts`: `base` (main background), `text`, `accent` (the
raccoon's eyes: buttons, links, focus) and `accent2`. Optional: `glow` for a neon halo, `shape`
(`round`, `sharp`, `pixel`), `mono`, and `tokens` to pin exact values. Then run `npm test`: it
checks that text, muted text and button labels stay readable in every theme.

## Identity rules

Every theme and icon is the same raccoon: a dark mask rail, a fur-colored body and bright
eyes as the accent. Names and art are Dendrop's own; don't borrow other apps' logos, names or
palettes.
