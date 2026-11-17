import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
// Shared version (see src/version.ts).
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
import { resolve } from "node:path";
// Mobile web app, published with GitHub Pages at /veil-bookmark/app/.
export default defineConfig({
  root: resolve(__dirname, "web"),
  base: "./",
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: resolve(__dirname, "docs/app"),
    emptyOutDir: true,
  },
});
