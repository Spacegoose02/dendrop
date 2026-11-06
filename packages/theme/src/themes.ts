import { alpha, mix, readableOn } from "./color.ts";

/**
 * Dendrop's theme set. Each theme is a handful of seed colors; the full token ladder
 * (rail, sidebar, raised, hover, border, muted and faint text...) is derived from them, so
 * every theme keeps the same raccoon structure: a dark "mask" rail, a "fur" body, and
 * lantern-bright eyes as the accent.
 */

export type ThemeFamily = "den" | "dark" | "nuclear" | "gaming" | "laser";
export type Scheme = "dark" | "light";
export type Shape = "round" | "sharp" | "pixel";

export const FAMILIES: { id: ThemeFamily; name: string; blurb: string }[] = [
  { id: "den", name: "Den", blurb: "The house raccoon, by lamplight or daylight." },
  { id: "dark", name: "Dark", blurb: "Quiet, low-glare nights for long chats." },
  { id: "nuclear", name: "Nuclear", blurb: "Glowing, irradiated, slightly unsafe." },
  { id: "gaming", name: "Gaming", blurb: "Loud colors and hard edges for game night." },
  { id: "laser", name: "Laser", blurb: "Neon beams on pure black, with glow." },
];

/** The CSS variables every client styles with. Names match tokens.css without the --dd- prefix. */
export const TOKEN_NAMES = [
  "bg-rail",
  "bg-sidebar",
  "bg-main",
  "bg-raised",
  "bg-hover",
  "bg-input",
  "border",
  "text",
  "text-muted",
  "text-faint",
  "accent",
  "accent-strong",
  "accent-text",
  "accent-2",
  "ring",
  "online",
  "danger",
  "warning",
  "glow",
  "radius-sm",
  "radius",
  "radius-lg",
  "font",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];
export type Tokens = Record<TokenName, string>;

export interface ThemeSeed {
  id: string;
  name: string;
  family: ThemeFamily;
  blurb: string;
  scheme?: Scheme;
  /** Main pane background; the other surfaces are derived from it. */
  base: string;
  text: string;
  /** The raccoon's eyes: buttons, links, focus, the active rail item. */
  accent: string;
  accent2: string;
  /** Neon glow around accent elements (laser and some nuclear themes). */
  glow?: boolean;
  shape?: Shape;
  mono?: boolean;
  /** Exact values that win over derived ones (the default Den theme uses this). */
  tokens?: Partial<Tokens>;
}

export interface Theme {
  id: string;
  name: string;
  family: ThemeFamily;
  blurb: string;
  scheme: Scheme;
  tokens: Tokens;
}

const FONT = '"Nunito", "Segoe UI", system-ui, -apple-system, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, "Cascadia Mono", monospace';
const RADII: Record<Shape, [string, string, string]> = {
  round: ["6px", "10px", "16px"],
  sharp: ["3px", "4px", "6px"],
  pixel: ["0px", "2px", "2px"],
};

function derive(seed: ThemeSeed): Theme {
  const scheme = seed.scheme ?? "dark";
  const { base, text, accent } = seed;
  const dark = scheme === "dark";
  const deep = dark ? "#000000" : text;
  const [rSm, r, rLg] = RADII[seed.shape ?? "round"];
  const derived: Tokens = {
    "bg-rail": mix(base, deep, dark ? 0.38 : 0.1),
    "bg-sidebar": mix(base, deep, dark ? 0.2 : 0.05),
    "bg-main": base,
    "bg-raised": mix(base, text, 0.08),
    "bg-hover": mix(base, text, 0.14),
    "bg-input": dark ? mix(base, "#000000", 0.3) : mix(base, "#ffffff", 0.6),
    border: mix(base, text, 0.17),
    text,
    "text-muted": mix(text, base, 0.3),
    "text-faint": mix(text, base, dark ? 0.5 : 0.45),
    accent,
    "accent-strong": dark ? mix(accent, "#ffffff", 0.2) : mix(accent, "#000000", 0.15),
    "accent-text": readableOn(accent),
    "accent-2": seed.accent2,
    ring: mix(text, base, 0.42),
    online: dark ? "#5cc98a" : "#23804c",
    danger: dark ? "#e5605a" : "#b8322b",
    warning: dark ? "#e9c46a" : "#946b00",
    glow: seed.glow ? `0 0 14px ${alpha(accent, 0.55)}` : "none",
    "radius-sm": rSm,
    radius: r,
    "radius-lg": rLg,
    font: seed.mono ? MONO : FONT,
  };
  return {
    id: seed.id,
    name: seed.name,
    family: seed.family,
    blurb: seed.blurb,
    scheme,
    tokens: { ...derived, ...seed.tokens },
  };
}

const SEEDS: ThemeSeed[] = [
  // Den: the house style.
  {
    id: "den",
    name: "Den",
    family: "den",
    blurb: "Lantern-amber eyes in a charcoal mask. The default.",
    base: "#20242a",
    text: "#e9e6e1",
    accent: "#f2a541",
    accent2: "#8c929c",
    tokens: {
      "bg-rail": "#121418",
      "bg-sidebar": "#1a1d22",
      "bg-raised": "#2a2f37",
      "bg-hover": "#323843",
      "bg-input": "#16181c",
      border: "#343a44",
      "text-muted": "#a3a8b1",
      "text-faint": "#6e7480",
      "accent-strong": "#ffb85c",
      "accent-text": "#1a1206",
      ring: "#8c929c",
    },
  },
  {
    id: "porch-light",
    name: "Porch Light",
    family: "den",
    blurb: "Daytime den: warm paper, ink-dark mask, amber trim.",
    scheme: "light",
    base: "#f6f1ea",
    text: "#2a2620",
    accent: "#a85a12",
    accent2: "#5f6670",
  },

  // Dark
  { id: "midnight-bin", name: "Midnight Bin", family: "dark", blurb: "Navy night and moonlit blue.", base: "#1b2030", text: "#e6e8f0", accent: "#8fb3ff", accent2: "#c9a7ff" },
  { id: "coal-mask", name: "Coal Mask", family: "dark", blurb: "True black for OLED screens.", base: "#0b0b0c", text: "#ececec", accent: "#f2a541", accent2: "#8c929c" },
  { id: "velvet-burrow", name: "Velvet Burrow", family: "dark", blurb: "Soft plum shadows and rose.", base: "#231a26", text: "#efe6f0", accent: "#e48fb8", accent2: "#9f86d8" },
  { id: "moss-hollow", name: "Moss Hollow", family: "dark", blurb: "Forest floor after dusk.", base: "#1a221d", text: "#e4ece4", accent: "#9ccf7a", accent2: "#d8c27a" },
  { id: "storm-drain", name: "Storm Drain", family: "dark", blurb: "Wet slate and rain-light teal.", base: "#1e2427", text: "#e3e9ec", accent: "#6fc3d6", accent2: "#a7b4bb" },
  { id: "plum-night", name: "Plum Night", family: "dark", blurb: "Deep violet with a pink edge.", base: "#1f1a2e", text: "#ece8f6", accent: "#b58cff", accent2: "#ff9ec7" },
  { id: "ember-den", name: "Ember Den", family: "dark", blurb: "Campfire coals and orange sparks.", base: "#241b17", text: "#f1e7df", accent: "#ff8a4c", accent2: "#ffc46b" },
  { id: "inkwell", name: "Inkwell", family: "dark", blurb: "Blue-black ink and brass.", base: "#151a24", text: "#dfe6f2", accent: "#5aa9e6", accent2: "#e6c35a" },
  { id: "fog-alley", name: "Fog Alley", family: "dark", blurb: "Muted greys, easy on the eyes.", base: "#2a2c30", text: "#eeeeee", accent: "#c8b8a0", accent2: "#9fb0c0" },
  { id: "deep-creek", name: "Deep Creek", family: "dark", blurb: "Still water and green-teal.", base: "#12201f", text: "#def0ec", accent: "#4fd1b5", accent2: "#7fa7e8" },

  // Nuclear
  { id: "cherenkov", name: "Cherenkov", family: "nuclear", blurb: "The blue glow of a reactor pool.", base: "#0a1422", text: "#dcecff", accent: "#3fb6ff", accent2: "#7df9ff", glow: true },
  { id: "uranium-glass", name: "Uranium Glass", family: "nuclear", blurb: "Vaseline-glass yellow-green.", base: "#10160a", text: "#eaffd0", accent: "#b6ff3b", accent2: "#f4ff8a", glow: true },
  { id: "hazmat", name: "Hazmat", family: "nuclear", blurb: "Warning-tape yellow on soot.", base: "#17150c", text: "#f5f0d8", accent: "#ffd400", accent2: "#1fbf8f", shape: "sharp" },
  { id: "meltdown", name: "Meltdown", family: "nuclear", blurb: "Molten orange, rising heat.", base: "#1c100a", text: "#ffe9dc", accent: "#ff6a1f", accent2: "#ffd23f", glow: true },
  { id: "isotope", name: "Isotope", family: "nuclear", blurb: "Glow-stick green in the dark.", base: "#0d1a15", text: "#d9fbe9", accent: "#2bff9a", accent2: "#a3ff4f", glow: true },
  { id: "rad-moss", name: "Rad Moss", family: "nuclear", blurb: "Something grew in the bins.", base: "#141a10", text: "#e5f0d6", accent: "#8fd14f", accent2: "#d6e35a" },
  { id: "control-rod", name: "Control Rod", family: "nuclear", blurb: "Plant-floor steel and lime.", base: "#1a1d20", text: "#e8ecef", accent: "#c6ff00", accent2: "#ff9f1c", shape: "sharp" },
  { id: "core-breach", name: "Core Breach", family: "nuclear", blurb: "Red alarms. Evacuate the den.", base: "#1d0c0e", text: "#ffe3e3", accent: "#ff4d4d", accent2: "#ffb000", glow: true },
  { id: "fission-lime", name: "Fission Lime", family: "nuclear", blurb: "Split atoms, sharp citrus.", base: "#0f1210", text: "#f0ffe8", accent: "#d4ff4a", accent2: "#4affd0" },
  { id: "decay-violet", name: "Decay Violet", family: "nuclear", blurb: "Half-lives in ultraviolet.", base: "#140f1f", text: "#efe5ff", accent: "#b06bff", accent2: "#63ff8f", glow: true },

  // Gaming
  { id: "arcade-night", name: "Arcade Night", family: "gaming", blurb: "Coin-op yellow and cabinet pink.", base: "#120f24", text: "#f2edff", accent: "#ffcc00", accent2: "#ff4fa3", shape: "sharp" },
  { id: "pixel-bandit", name: "Pixel Bandit", family: "gaming", blurb: "Eight-bit raccoon, square corners.", base: "#1e1e2a", text: "#f4f4f4", accent: "#ff6b6b", accent2: "#4fd1ff", shape: "pixel", mono: true },
  { id: "respawn", name: "Respawn", family: "gaming", blurb: "Back in the fight, full health.", base: "#10201a", text: "#e6fff3", accent: "#36e27e", accent2: "#e2e236" },
  { id: "loot-goblin", name: "Loot Goblin", family: "gaming", blurb: "Gold drops and epic purples.", base: "#1c1810", text: "#f6edd8", accent: "#e8b931", accent2: "#b07dff" },
  { id: "speedrun", name: "Speedrun", family: "gaming", blurb: "Split timers and clean lines.", base: "#101418", text: "#eef3f7", accent: "#00d0ff", accent2: "#ff3d6e", shape: "sharp" },
  { id: "boss-room", name: "Boss Room", family: "gaming", blurb: "Crimson arena, last checkpoint.", base: "#1a0f14", text: "#f6e6ea", accent: "#ef4a63", accent2: "#ff9f43" },
  { id: "couch-coop", name: "Couch Co-op", family: "gaming", blurb: "Player one orange, player two blue.", base: "#1d2230", text: "#f1f3f8", accent: "#ff8f5a", accent2: "#5ac8ff" },
  { id: "critical-hit", name: "Critical Hit", family: "gaming", blurb: "Big pink damage numbers.", base: "#181218", text: "#fbeaf3", accent: "#ff2e88", accent2: "#ffd23f" },
  { id: "high-score", name: "High Score", family: "gaming", blurb: "Blue CRT and a mono scoreboard.", base: "#0e1a2b", text: "#e8f1ff", accent: "#4d94ff", accent2: "#ffd23f", shape: "pixel", mono: true },
  { id: "save-point", name: "Save Point", family: "gaming", blurb: "A cozy campfire between levels.", base: "#1c1f1a", text: "#eef2e8", accent: "#7fd4ff", accent2: "#ffe066" },

  // Laser
  { id: "laser-lime", name: "Laser Lime", family: "laser", blurb: "A green beam through smoke.", base: "#070a07", text: "#eaffea", accent: "#39ff14", accent2: "#00e5ff", glow: true },
  { id: "hot-pink-beam", name: "Hot Pink Beam", family: "laser", blurb: "Magenta lasers, gold sparks.", base: "#0d070c", text: "#ffe8f6", accent: "#ff2fb3", accent2: "#ffe14d", glow: true },
  { id: "ultraviolet", name: "Ultraviolet", family: "laser", blurb: "Blacklight purple everything.", base: "#0a0614", text: "#f0e8ff", accent: "#a855ff", accent2: "#ff4fd8", glow: true },
  { id: "ruby-laser", name: "Ruby Laser", family: "laser", blurb: "The first laser was red.", base: "#0e0607", text: "#ffe9ea", accent: "#ff3550", accent2: "#ff8a3d", glow: true },
  { id: "cyan-grid", name: "Cyan Grid", family: "laser", blurb: "Wireframe horizon, cyan lines.", base: "#050b10", text: "#e5fbff", accent: "#00f0ff", accent2: "#ff3df2", glow: true, shape: "sharp" },
  { id: "laser-tag", name: "Laser Tag", family: "laser", blurb: "Team green versus team red.", base: "#0a0a10", text: "#f2f2ff", accent: "#00ff9c", accent2: "#ff3860", glow: true },
  { id: "prism", name: "Prism", family: "laser", blurb: "White light split into ice and pink.", base: "#0b0b12", text: "#f5f5ff", accent: "#7cf4ff", accent2: "#ff7ce5", glow: true },
  { id: "synth-sunset", name: "Synth Sunset", family: "laser", blurb: "Pink sky, orange sun, purple road.", base: "#160b1e", text: "#ffeefa", accent: "#ff6ec7", accent2: "#ffb347", glow: true },
  { id: "neon-alley", name: "Neon Alley", family: "laser", blurb: "Yellow signs over a wet street.", base: "#0a0d12", text: "#eef6ff", accent: "#ffe600", accent2: "#00c8ff", glow: true },
  { id: "photon", name: "Photon", family: "laser", blurb: "Electric blue, pure and cold.", base: "#06080f", text: "#eaf2ff", accent: "#5c8aff", accent2: "#9be7ff", glow: true },
];

export const THEMES: readonly Theme[] = SEEDS.map(derive);
export const DEFAULT_THEME = "den";

const byId = new Map(THEMES.map((t) => [t.id, t]));

/** The theme with this id, or the default Den theme for an unknown id. */
export function getTheme(id: string | null | undefined): Theme {
  return byId.get(id ?? "") ?? byId.get(DEFAULT_THEME)!;
}

/** A theme's tokens as CSS custom properties, ready for a style attribute or `setProperty`. */
export function themeVars(theme: Theme): Record<`--dd-${TokenName}`, string> {
  return Object.fromEntries(TOKEN_NAMES.map((n) => [`--dd-${n}`, theme.tokens[n]])) as Record<`--dd-${TokenName}`, string>;
}
