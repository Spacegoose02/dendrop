// Draws the icons for installing Dendrop from the browser (Add to Home Screen) and for its
// notifications, from the raccoon in public/favicon.svg. Run again (node scripts/make-icons.mjs)
// when that mark changes. Needs Playwright's Chromium.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const svg = readFileSync(here("../public/favicon.svg"), "utf8").replace("<svg ", '<svg width="100%" height="100%" ');
const out = here("../public/");

const browser = await chromium.launch();
const draw = async (file, size, { bg = "#121418", mark = 1, css = "", source = svg } = {}) => {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(
    `<html><body style="margin:0;background:${bg};display:grid;place-items:center;width:${size}px;height:${size}px">` +
      `<div style="width:${size * mark}px;height:${size * mark}px;${css}">${source}</div></body></html>`,
  );
  await p.screenshot({ path: out + file, omitBackground: bg === "transparent" });
  await p.close();
};
// Home Screen icons: the mark's dark tile fills the square (phones round the corners).
await draw("icon-192.png", 192);
await draw("icon-512.png", 512);
await draw("apple-touch-icon.png", 180);
// Android masks icons to a circle or squircle: keep the raccoon inside the safe middle.
await draw("icon-maskable-512.png", 512, { mark: 0.72 });
// The small status-bar badge: one colour on transparent, as Android wants.
await draw("badge-96.png", 96, { bg: "transparent", mark: 0.9, css: "filter:brightness(0) invert(1)", source: svg.replace(/<rect[^>]*\/>/, "") });
await browser.close();
