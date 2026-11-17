// One version for the Chrome extension and the mobile web app: package.json
// "version", injected by both Vite configs. public/manifest.json and
// package-lock.json must match it (scripts/check-version.mjs).
declare const __APP_VERSION__: string;
export const VERSION: string = __APP_VERSION__;
