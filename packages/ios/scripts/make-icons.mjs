// Draws the app icon and launch image from the raccoon in packages/web/public/favicon.svg.
// Run again (node scripts/make-icons.mjs) when that mark changes. Needs Playwright's Chromium.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const svg = readFileSync(here("../../web/public/favicon.svg"), "utf8");
const assets = here("../ios/App/App/Assets.xcassets/");

const page = async (browser, size, bg, markSize) => {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(
    `<html><body style="margin:0;background:${bg};display:grid;place-items:center;width:${size}px;height:${size}px">` +
      `<div style="width:${markSize}px;height:${markSize}px">${svg.replace("<svg ", '<svg width="100%" height="100%" ')}</div></body></html>`,
  );
  return p;
};

const browser = await chromium.launch();
// App icon: iOS rounds the corners itself, so the mark's own dark tile fills the square.
let p = await page(browser, 1024, "#121418", 1024 * 0.92);
await p.screenshot({ path: assets + "AppIcon.appiconset/AppIcon-512@2x.png", omitBackground: false });
// Launch image: the raccoon on the den background, like the Android splash.
p = await page(browser, 2732, "#20242a", 560);
for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
  await p.screenshot({ path: assets + "Splash.imageset/" + name });
}
await browser.close();
console.log("Drew AppIcon and Splash");
