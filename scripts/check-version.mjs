// The Chrome extension and the mobile web app share one version number
// (package.json). Fails the build when another copy disagrees.
import { readFileSync } from "node:fs";
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const pkg = json("package.json").version;
const lock = json("package-lock.json");
const found = {
  "public/manifest.json": json("public/manifest.json").version,
  "package-lock.json": lock.version,
  'package-lock.json packages[""]': lock.packages?.[""]?.version,
};
const wrong = Object.entries(found).filter(([, v]) => v !== pkg);
for (const [f, v] of wrong) console.error(`${f} is ${v}, package.json is ${pkg}`);
if (wrong.length) process.exit(1);
console.log(`version ${pkg} (extension and mobile web)`);
