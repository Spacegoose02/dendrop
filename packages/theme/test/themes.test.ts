import assert from "node:assert/strict";
import { test } from "node:test";
import { contrast, personColors, readableColor } from "../src/color.ts";
import { APP_ICONS, appIconSvg, PIXEL_ART, THEME_ICON } from "../src/icons.ts";
import { FAMILIES, getTheme, THEMES, TOKEN_NAMES } from "../src/themes.ts";

test("the board's theme packs: 10 dark, 10 nuclear, 10 gaming, 10 laser", () => {
  for (const family of ["dark", "nuclear", "gaming", "laser"]) {
    assert.equal(THEMES.filter((t) => t.family === family).length, 10, family);
  }
  for (const t of THEMES) assert.ok(FAMILIES.some((f) => f.id === t.family), t.id);
});

test("theme ids are unique and unknown ids fall back to Den", () => {
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
  assert.equal(getTheme("nope").id, "den");
  assert.equal(getTheme(undefined).id, "den");
});

test("every theme sets every token", () => {
  for (const t of THEMES) for (const n of TOKEN_NAMES) assert.ok(t.tokens[n], `${t.id} ${n}`);
});

test("every theme is readable", () => {
  for (const t of THEMES) {
    const k = t.tokens;
    for (const bg of ["bg-main", "bg-sidebar", "bg-raised"] as const) {
      assert.ok(contrast(k.text, k[bg]) >= 7, `${t.id}: text on ${bg}`);
      assert.ok(contrast(k["text-muted"], k[bg]) >= 4.5, `${t.id}: muted text on ${bg}`);
    }
    assert.ok(contrast(k["text-faint"], k["bg-main"]) >= 2.5, `${t.id}: faint text`);
    assert.ok(contrast(k["accent-text"], k.accent) >= 4.5, `${t.id}: button text on accent`);
    assert.ok(contrast(k["accent-text"], k["accent-strong"]) >= 4.5, `${t.id}: button text on hover`);
    assert.ok(contrast(k.accent, k["bg-main"]) >= 3, `${t.id}: accent links and focus rings`);
  }
});

test("app icons render, including the theme-matched one", () => {
  for (const row of PIXEL_ART) assert.equal(row.length, 16);
  for (const id of [...APP_ICONS.map((i) => i.id), THEME_ICON]) {
    for (const t of THEMES) assert.match(appIconSvg(id, t), /^<svg [^>]+>.+<\/svg>$/);
  }
});

test("custom name and text colors stay readable in every theme", () => {
  const picks = ["#000000", "#ffffff", "#9b59ff", "#3b3bff", "#ff2e88", "#ffe600", "#14110c", "#808080", "#1b2030", "#f6f1ea"];
  for (const t of THEMES) {
    const k = t.tokens;
    for (const pick of [...picks, k["bg-main"], k["bg-sidebar"], k.accent]) {
      const { name, text } = personColors(k, { nameColor: pick, textColor: pick });
      for (const bg of ["bg-main", "bg-hover", "bg-sidebar"] as const) {
        assert.ok(contrast(name!, k[bg]) >= 4.5, `${t.id}: name ${pick} on ${bg} became ${name}`);
        assert.ok(contrast(text!, k[bg]) >= 4.5, `${t.id}: text ${pick} on ${bg} became ${text}`);
      }
    }
  }
});

test("a readable color is kept as picked; no color means the theme's own", () => {
  assert.equal(readableColor("#9B59FF", ["#0b0b0c"], "#eeeeee"), "#9b59ff");
  assert.notEqual(readableColor("#3b0a6b", ["#0b0b0c"], "#eeeeee"), "#eeeeee", "a dark purple is lightened, not dropped");
  assert.equal(readableColor("not a color", ["#0b0b0c"], "#eeeeee"), "#eeeeee");
  assert.deepEqual(personColors(THEMES[0]!.tokens, { nameColor: null, textColor: null }), { name: undefined, text: undefined });
});
