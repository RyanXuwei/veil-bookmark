// Merging Drive snapshots into a vault, shared by the extension's background
// service and the mobile web app so both write the same snapshots.
import {
  decrypt,
  emptyVault,
  merge,
  verifySlots,
  type Envelope,
  type KeySlots,
  type Vault,
} from "./crypto";

/** Drive holds a vault this key cannot open (a different vault). */
export class VaultMismatch extends Error {
  constructor() {
    super("vault mismatch");
  }
}

export async function mergeSnapshots(o: {
  v: Vault;
  dek: CryptoKey;
  keys: KeySlots;
  envelopes: Envelope[];
  // Password key for legacy v1 snapshots (from before key slots).
  legacy?: { salt: string; kek: CryptoKey };
}): Promise<{ v: Vault; keys: KeySlots; upload: boolean; damaged: number[] }> {
  let { v, keys } = o;
  const remoteVaults: Vault[] = [];
  // Snapshots of this vault that cannot be decrypted (e.g. cut short):
  // skipped and never deleted, instead of being mistaken for another vault.
  const damaged: number[] = [];
  let stale = false;
  for (const [index, remote] of o.envelopes.entries()) {
    if (remote.id !== v.id) throw new VaultMismatch();
    let rv: Vault;
    if (remote.version === 1) {
      if (!o.legacy || remote.salt !== o.legacy.salt) throw new VaultMismatch();
      rv = await decrypt(remote, o.legacy.kek);
      stale = true;
    } else {
      try {
        await verifySlots(o.dek, v.id, remote.keys);
      } catch {
        throw new VaultMismatch();
      }
      try {
        rv = await decrypt(remote, o.dek);
      } catch {
        damaged.push(index);
        continue;
      }
      // The newest key slots win, e.g. after a password reset on another device.
      if (remote.keys.updated > keys.updated) keys = remote.keys;
      if (remote.keys.updated !== keys.updated) stale = true;
    }
    remoteVaults.push(rv);
    v = merge(v, rv);
  }
  if (
    o.envelopes.some(
      (r, i) =>
        r.version === 3 && r.keys.updated < keys.updated && !damaged.includes(i),
    )
  )
    stale = true;
  const canonical = JSON.stringify(merge(v, v));
  let remoteUnion: Vault = emptyVault(v.id);
  for (const rv of remoteVaults) remoteUnion = merge(remoteUnion, rv);
  // Upload when Drive is missing changes or newer keys, or consolidate several
  // snapshots into one so Drive keeps a single current copy.
  const readable = o.envelopes.length - damaged.length;
  const upload =
    !readable ||
    readable > 1 ||
    stale ||
    JSON.stringify(remoteUnion) !== canonical;
  return { v, keys, upload, damaged };
}
