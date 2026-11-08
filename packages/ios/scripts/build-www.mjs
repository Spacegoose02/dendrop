// Builds www/, the page bundled inside the iPhone app: the same setup page as the Android app
// (packages/android/www-src, which handles both platforms), with the theme tokens, its CSS and
// JS and the raccoon mark inlined. It's also shown when the server can't be reached
// (server.errorPath), where nothing else could load. The chat itself is the web client served
// by your Dendrop server.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const out = fileURLToPath(new URL("../www/", import.meta.url));
const src = "../../android/www-src/";

const raccoon = `data:image/svg+xml;base64,${Buffer.from(read("../../web/public/favicon.svg")).toString("base64")}`;
const html = read(src + "index.html")
  .replace('<link rel="stylesheet" href="tokens.css" />', () => `<style>\n${read("../../theme/src/tokens.css")}</style>`)
  .replace('<link rel="stylesheet" href="setup.css" />', () => `<style>\n${read(src + "setup.css")}</style>`)
  .replace('<script src="setup.js"></script>', () => `<script>\n${read(src + "setup.js")}</script>`)
  .replace('src="raccoon.svg"', () => `src="${raccoon}"`);
for (const ref of ["tokens.css", "setup.css", "setup.js", "raccoon.svg"]) {
  if (html.includes(`"${ref}"`)) throw new Error(`build-www: ${ref} wasn't inlined`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(out + "index.html", html);
writeFileSync(out + "dendrop-offline.html", html);
console.log("Built www/ (index.html, dendrop-offline.html)");
