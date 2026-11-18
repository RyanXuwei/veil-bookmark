import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
// Shared version (see src/version.ts).
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
import { resolve } from "node:path";
// Mobile web app, built to web-dist/ and published by Cloudflare Pages at its
// own address (build command: npm ci && npm run build:web, output: web-dist).
export default defineConfig({
  root: resolve(__dirname, "web"),
  base: "./",
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: resolve(__dirname, "web-dist"),
    emptyOutDir: true,
  },
});
