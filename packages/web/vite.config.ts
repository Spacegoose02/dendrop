import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// In development the API runs on :8080 (npm run dev:server) and Vite proxies to it.
export default defineConfig({
  plugins: [react()],
  // The call chunk (LiveKit) is about 580 kB and loads only when a call starts.
  build: { chunkSizeWarningLimit: 700 },
  resolve: {
    alias: { "@dendrop/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8080", ws: true } },
  },
});
