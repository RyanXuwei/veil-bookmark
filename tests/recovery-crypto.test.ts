import { test } from "node:test";
import assert from "node:assert/strict";
import * as c from "../src/crypto";

const vault: c.Vault = {
  version: 2,
  id: "test-vault",
  entries: [
    {
      id: "one",
      title: "私人測試",
      url: "https://example.com/private",
      folder: "研究",
      tags: [],
      notes: "secret note",
      updated: 1,
      revision: "a",
      deleted: false,
    },
  ],
  memos: [],
};

test("recovery code format, normalisation and rejection", () => {
  const { code, bytes } = c.newRecoveryCode();
  assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual(c.parseRecoveryCode(code), bytes);
  const sloppy = code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o");
  assert.deepEqual(c.parseRecoveryCode(sloppy), bytes);
  assert.throws(() => c.parseRecoveryCode("ABCD-EFGH"), /格式不正確/);
  assert.throws(
    () => c.parseRecoveryCode(code.slice(0, -1) + "U"),
    /格式不正確/,
  );
  assert.notEqual(c.newRecoveryCode().code, code);
});

test("key slots: password and recovery open the same data key; forgery and wrong secrets rejected", async () => {
  const dek = await c.newDataKey();
  const code = c.newRecoveryCode();
  let keys = await c.setPassword(dek, vault.id, "1234");
  keys = await c.setRecovery(dek, vault.id, code.bytes, keys);
  const e = await c.seal(vault, dek, keys);
  assert(!JSON.stringify(e).includes("secret note"));
  const byPw = await c.openWithPassword(e, "1234");
  assert.deepEqual(await c.decrypt(e, byPw.dek), { ...vault, folders: [] });
  const byRk = await c.openWithRecovery(e, code.bytes);
  assert.deepEqual(await c.decrypt(e, byRk), { ...vault, folders: [] });
  await assert.rejects(c.openWithPassword(e, "wrong"), /密碼不正確/);
  await assert.rejects(
    c.openWithRecovery(e, c.newRecoveryCode().bytes),
    /救援金鑰不正確/,
  );
  // Password change keeps the recovery slot; the old password stops working.
  const changed = await c.setPassword(dek, vault.id, "5678", keys);
  assert(changed.updated > keys.updated);
  const e2 = await c.seal(vault, dek, changed);
  await assert.rejects(c.openWithPassword(e2, "1234"), /密碼不正確/);
  await c.openWithPassword(e2, "5678");
  await c.openWithRecovery(e2, code.bytes);
  // Slots cannot be altered without the data key.
  await assert.rejects(
    c.verifySlots(dek, vault.id, { ...keys, updated: keys.updated + 99 }),
    /竄改/,
  );
  await assert.rejects(
    c.verifySlots(await c.newDataKey(), vault.id, keys),
    /竄改/,
  );
  // A vault without a recovery slot says so.
  const noRk = await c.seal(
    vault,
    dek,
    await c.setPassword(dek, vault.id, "1234"),
  );
  await assert.rejects(
    c.openWithRecovery(noRk, code.bytes),
    /尚未建立救援金鑰/,
  );
  assert.throws(() =>
    c.validateEnvelope({ ...e, keys: { ...keys, auth: "" } }),
  );
});
