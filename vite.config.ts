import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
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
