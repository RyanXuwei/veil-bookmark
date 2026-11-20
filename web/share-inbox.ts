// Pages shared to the app while it is locked. Every share reloads the app,
// which starts locked (the data key lives only in memory), so a shared link
// is sealed right away with this phone's share key and kept in IndexedDB;
// the next unlock opens the inbox and adds the bookmarks. The user can share
// one page after another without unlocking each time.
//
// The share key is an ECDH P-256 key pair made on this phone at unlock. The
// public half is stored as is (it can only seal); the private half is stored
// encrypted with the vault's data key, so only an unlocked vault can read
// the inbox. Each share uses a fresh ephemeral key (ECDH → HKDF → AES-GCM).
import { b64, random, unb64 } from "../src/crypto";
import { kv, workspaceKey } from "./accounts";

const DB = "veil-bookmark-web";
const text = (s: string) => new TextEncoder().encode(s);
const MAX_ITEMS = 200;
export type SharedLink = { title: string; url: string; at: number };
type Sealed = { iv: string; data: string };
type KeyRecord = { vault: string; pub: JsonWebKey; priv: Sealed };
type Item = { id: string; epk: JsonWebKey; iv: string; data: string };

const keyName = () => workspaceKey("shareKey");
const inboxName = () => workspaceKey("shareInbox");
const PRIV_LABEL = (vault: string) => `Veil|share-key|1|${vault}`;
const ITEM_LABEL = (vault: string) => `Veil|share-item|1|${vault}`;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

// Read-modify-write of the inbox: two shares can arrive close together.
const inboxLock = <T>(fn: () => Promise<T>) =>
  navigator.locks
    ? navigator.locks.request("veil-share-inbox:" + inboxName(), fn)
    : fn();

async function itemKey(priv: CryptoKey, pub: CryptoKey, vault: string) {
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: pub },
    priv,
    256,
  );
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: text(ITEM_LABEL(vault)),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function openPrivate(r: KeyRecord, dek: CryptoKey, vault: string) {
  if (r.vault !== vault) throw Error("other vault");
  const raw = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unb64(r.priv.iv),
      additionalData: text(PRIV_LABEL(vault)),
    },
    dek,
    unb64(r.priv.data),
  );
  return crypto.subtle.importKey(
    "jwk",
    JSON.parse(new TextDecoder().decode(raw)),
    ECDH,
    false,
    ["deriveBits"],
  );
}

/** Makes this phone's share key for the open vault, once. */
export async function prepare(dek: CryptoKey, vault: string) {
  const old = await kv<KeyRecord>(DB, keyName(), "readonly");
  if (old)
    try {
      await openPrivate(old, dek, vault);
      return;
    } catch {}
  const pair = (await crypto.subtle.generateKey(ECDH, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const iv = random(12);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: text(PRIV_LABEL(vault)) },
    dek,
    text(JSON.stringify(priv)),
  );
  await kv<KeyRecord>(DB, keyName(), "readwrite", {
    vault,
    pub,
    priv: { iv: b64(iv), data: b64(new Uint8Array(data)) },
  });
}

/** Seals a shared link into the inbox. False when this phone has no share
 *  key yet (never unlocked here): the caller keeps the link in memory. */
export async function stash(link: { title: string; url: string }) {
  const r = await kv<KeyRecord>(DB, keyName(), "readonly").catch(
    () => undefined,
  );
  if (!r?.pub) return false;
  const pub = await crypto.subtle.importKey("jwk", r.pub, ECDH, false, []);
  const eph = (await crypto.subtle.generateKey(ECDH, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const key = await itemKey(eph.privateKey, pub, r.vault);
  const iv = random(12);
  const body: SharedLink = { ...link, at: Date.now() };
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: text(ITEM_LABEL(r.vault)) },
    key,
    text(JSON.stringify(body)),
  );
  const item: Item = {
    id: crypto.randomUUID(),
    epk: await crypto.subtle.exportKey("jwk", eph.publicKey),
    iv: b64(iv),
    data: b64(new Uint8Array(data)),
  };
  await inboxLock(async () => {
    const list = (await kv<Item[]>(DB, inboxName(), "readonly")) || [];
    await kv(DB, inboxName(), "readwrite", [...list, item].slice(-MAX_ITEMS));
  });
  return true;
}

/** How many shared links wait for the next unlock. */
export async function count() {
  try {
    return ((await kv<Item[]>(DB, inboxName(), "readonly")) || []).length;
  } catch {
    return 0;
  }
}

/** Opens the inbox with the unlocked vault's data key. Items that cannot be
 *  opened (another vault, damaged) are reported as `unreadable`. */
export async function take(dek: CryptoKey, vault: string) {
  const list = (await kv<Item[]>(DB, inboxName(), "readonly")) || [];
  const links: SharedLink[] = [];
  let unreadable = 0;
  if (!list.length) return { links, ids: [], unreadable };
  let priv: CryptoKey | null = null;
  const r = await kv<KeyRecord>(DB, keyName(), "readonly");
  try {
    if (r) priv = await openPrivate(r, dek, vault);
  } catch {}
  for (const x of list)
    try {
      if (!priv) throw Error();
      const epk = await crypto.subtle.importKey("jwk", x.epk, ECDH, false, []);
      const key = await itemKey(priv, epk, vault);
      const raw = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(x.iv), additionalData: text(ITEM_LABEL(vault)) },
        key,
        unb64(x.data),
      );
      const v = JSON.parse(new TextDecoder().decode(raw));
      links.push({
        title: String(v.title || ""),
        url: String(v.url || ""),
        at: Number(v.at) || 0,
      });
    } catch {
      unreadable++;
    }
  return { links, ids: list.map((x) => x.id), unreadable };
}

/** Removes items once their bookmarks are saved. */
export function forget(ids: string[]) {
  if (!ids.length) return Promise.resolve();
  const gone = new Set(ids);
  return inboxLock(async () => {
    const list = (await kv<Item[]>(DB, inboxName(), "readonly")) || [];
    await kv(DB, inboxName(), "readwrite", list.filter((x) => !gone.has(x.id)));
  });
}

/** With the workspace removed from this phone. */
export async function clear() {
  await kv(DB, keyName(), "readwrite", undefined, true);
  await kv(DB, inboxName(), "readwrite", undefined, true);
}
