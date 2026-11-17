import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
// Shared version (see src/version.ts).
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    rollupOptions: {
      input: { app: "index.html", background: "src/background.ts" },
      output: {
        entryFileNames: (c) =>
          c.name === "background" ? "background.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
