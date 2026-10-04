import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Client root is client/ (index.html lives there); the production build
// lands in client/dist, which server/src/server.ts serves statically.
export default defineConfig({
  root: "client",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // `npm run dev:client` (vite dev) forwards RPC calls to the local
      // Stragis server started separately with `npm run build:server &&
      // npm start` (or `npm run dev`).
      "/actions": "http://127.0.0.1:4317",
      "/health": "http://127.0.0.1:4317",
    },
  },
});
