import { test } from "node:test";
import assert from "node:assert/strict";
import {
  derive,
  encrypt,
  decrypt,
  b64,
  random,
  merge,
  safeUrl,
  validateEnvelope,
  type Vault,
  type Entry,
} from "../src/crypto";
const entry = (
  id = "one",
  updated = 1,
  deleted = false,
  revision = "a",
): Entry => ({
  id,
  title: "私人測試",
  url: "https://example.com/private",
  folder: "研究",
  tags: ["私密"],
  notes: "secret note",
  updated,
  deleted,
  revision,
});
const vault: Vault = { version: 1, id: "test-vault", entries: [entry()] };
test("AES-GCM roundtrip, random IV, no plaintext, wrong password and tampering rejected", async () => {
  const salt = b64(random(16));
  const key = await derive("a-long-test-password", salt);
  const a = await encrypt(vault, key, salt),
    b = await encrypt(vault, key, salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert(!JSON.stringify(a).includes("secret note"));
  assert.deepEqual(await decrypt(a, key), vault);
  await assert.rejects(decrypt(a, await derive("wrong-password", salt)));
  await assert.rejects(decrypt({ ...a, id: "tampered" }, key));
  await assert.rejects(
    decrypt({ ...a, ciphertext: a.ciphertext.slice(0, -8) + "AAAAAAAA" }, key),
  );
});
test("malformed and expensive envelopes rejected before decrypt", () => {
  assert.throws(() => validateEnvelope({}));
  assert.throws(() =>
    validateEnvelope({
      version: 1,
      id: "x",
      kdf: "PBKDF2-SHA256",
      iterations: 999999999,
      salt: "",
      iv: "",
      ciphertext: "",
    }),
  );
});
test("merge is commutative, idempotent; tombstone wins; deterministic ties", () => {
  const a: Vault = { ...vault, entries: [entry(), entry("other")] };
  const b: Vault = {
    ...vault,
    entries: [entry("one", 2, true), entry("new", 3)],
  };
  assert.deepEqual(merge(a, b), merge(b, a));
  assert.deepEqual(merge(a, a), merge(merge(a, a), a));
  assert.equal(merge(a, b).entries.find((x) => x.id === "one")?.deleted, true);
  assert.equal(
    merge(vault, { ...vault, entries: [entry("one", 1, true, "z")] }).entries[0]
      .deleted,
    true,
  );
  assert.throws(() => merge(a, { ...b, id: "different" }));
});
test("block script, local file, data URLs and embedded credentials", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///secret",
    "https://name:pass@example.com",
    "chrome://settings",
    "invalid",
  ])
    assert.throws(() => safeUrl(url));
  assert.equal(safeUrl("https://example.com"), "https://example.com/");
});
