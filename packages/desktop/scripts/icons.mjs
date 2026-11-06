// Draws the app and tray icons from the theme's raccoon mark (packages/theme/src/icons.ts),
// writes them to build/*.svg, and renders the PNGs Electron and electron-builder use
// (icon.png 512px, tray icons 64px, the Windows taskbar badge 32px).
// Run after the mark changes: NODE_PATH=$(npm root -g) node scripts/icons.mjs (needs Playwright's Chromium).
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ICONS, DEFAULT_ICON, raccoonSvg } from "../../theme/src/icons.ts";

// Playwright is not a dependency: use a global install.
const { chromium } = createRequire(import.meta.url)("playwright");

const dir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "build");
const icon = APP_ICONS.find((i) => i.id === DEFAULT_ICON);
const mark = raccoonSvg(icon.colors, icon.style);
const inner = mark.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
const svg = (size, body, viewBox = "0 0 64 64") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${size}" height="${size}">${body}</svg>\n`;
/** The unread dot: Den's danger red with a dark ring, so it reads on light and dark taskbars. */
const dot = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#e5605a" stroke="#121418" stroke-width="3"/>`;

const files = {
  "icon.svg": svg(512, inner),
  "tray.svg": svg(64, inner),
  "tray-unread.svg": svg(64, inner + dot(51, 51, 12)),
  "badge.svg": svg(32, dot(16, 16, 13.5), "0 0 32 32"),
};

const browser = await chromium.launch();
for (const [file, text] of Object.entries(files)) {
  writeFileSync(path.join(dir, file), text);
  const size = Number(text.match(/width="(\d+)"/)[1]);
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${text}`);
  await page.screenshot({ path: path.join(dir, file.replace(/\.svg$/, ".png")), omitBackground: true });
  await page.close();
}
await browser.close();
console.log("Drew build/*.svg from the theme's raccoon and rendered the PNGs");
