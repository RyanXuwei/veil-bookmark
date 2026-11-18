import { test } from "node:test";
import assert from "node:assert/strict";
import { decrypt, emptyVault, newDataKey, newRecoveryCode, seal, setPassword, setRecovery } from "../src/crypto";
import { upsertEntry } from "../src/entry-ops";

test("incognito bookmarks: set, kept by editors that leave it out, cleared, validated", async () => {
  const v = emptyVault("v");
  const a = upsertEntry(v, { title: "私密", url: "https://example.com/", incognito: true });
  assert.equal(a.incognito, true);
  // The phone's editor does not send the field: it stays.
  const b = upsertEntry(v, { id: a.id, title: "改名", url: "https://example.com/" });
  assert.equal(b.incognito, true);
  const c = upsertEntry(v, { id: a.id, title: "改名", url: "https://example.com/", incognito: false });
  assert.equal("incognito" in c, false);
  const n = upsertEntry(v, { title: "一般", url: "https://example.org/" });
  assert.equal("incognito" in n, false);
  // Anything but `true` read from storage is dropped.
  const dek = await newDataKey();
  let keys = await setPassword(dek, "v", "1234");
  keys = await setRecovery(dek, "v", newRecoveryCode().bytes, keys);
  upsertEntry(v, { id: a.id, title: "x", url: "https://example.com/", incognito: true });
  (v.entries.find((x) => x.id === n.id) as any).incognito = "yes";
  const back = await decrypt(await seal(v, dek, keys), dek);
  assert.equal(back.entries.find((x) => x.id === a.id)!.incognito, true);
  assert.equal("incognito" in back.entries.find((x) => x.id === n.id)!, false);
});
