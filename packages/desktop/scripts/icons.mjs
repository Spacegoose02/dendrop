// Renders build/*.svg to the PNGs Electron and electron-builder use (icon.png 512px, tray icons 64px).
// Run after changing an SVG: node scripts/icons.mjs (needs Playwright's Chromium).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Playwright is not a dependency: use a global install (NODE_PATH=$(npm root -g)).
const { chromium } = createRequire(import.meta.url)("playwright");

const dir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "build");
const browser = await chromium.launch();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".svg"))) {
  const svg = readFileSync(path.join(dir, file), "utf8");
  const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/) ?? [];
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg}`);
  await page.screenshot({ path: path.join(dir, file.replace(/\.svg$/, ".png")), omitBackground: true });
  await page.close();
}
await browser.close();
console.log("Rendered build/*.png");
