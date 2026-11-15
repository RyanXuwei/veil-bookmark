import { readFile, writeFile } from "node:fs/promises";
const file = new URL("../dist/manifest.json", import.meta.url);
const manifest = JSON.parse(await readFile(file, "utf8"));
if (process.env.VEILMARK_OAUTH_CLIENT_ID) {
  if (
    !/^[\w-]+\.apps\.googleusercontent\.com$/.test(
      process.env.VEILMARK_OAUTH_CLIENT_ID,
    )
  )
    throw Error("Invalid OAuth client ID");
  manifest.oauth2 = {
    client_id: process.env.VEILMARK_OAUTH_CLIENT_ID,
    scopes: ["https://www.googleapis.com/auth/drive.appdata"],
  };
}
if (process.env.VEILMARK_EXTENSION_KEY)
  manifest.key = process.env.VEILMARK_EXTENSION_KEY;
await writeFile(file, JSON.stringify(manifest, null, 2));
console.log(
  manifest.oauth2
    ? "Drive OAuth configured."
    : "Local build ready. Drive requires VEILMARK_OAUTH_CLIENT_ID; see README.",
);
