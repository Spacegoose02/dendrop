// Bundles the main and preload scripts into dist/ as CommonJS, which Electron loads directly.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

for (const entry of ["main", "preload", "overlay-preload"]) {
  await build({
    entryPoints: [path.join(root, "src", `${entry}.ts`)],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: path.join(root, "dist", `${entry}.cjs`),
    // ws's optional native speedups: it works without them. uiohook-napi is a native module,
    // loaded from node_modules at run time (ptt.ts).
    external: ["electron", "bufferutil", "utf-8-validate", "uiohook-napi"],
    logLevel: "warning",
  });
}
console.log("Bundled desktop app into dist/");
