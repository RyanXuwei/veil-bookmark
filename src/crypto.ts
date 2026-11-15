export type Entry = {
  id: string;
  title: string;
  url: string;
  folder: string;
  tags: string[];
  notes: string;
  updated: number;
  revision: string;
  deleted: boolean;
};
export const MEMO_MAX = 500_000;
export type Memo = {
  id: string;
  title: string;
  body: string;
  // "html" for notebook documents (sanitized in the page); plain text otherwise.
  format?: "html" | "text";
  updated: number;
  revision: string;
  deleted: boolean;
};
// Vault v2 adds encrypted memos. Older releases reject v2 instead of silently
// dropping memos during a sync merge.
export type Vault = { version: 2; id: string; entries: Entry[]; memos: Memo[] };
export const emptyVault = (id: string): Vault => ({
  version: 2,
  id,
  entries: [],
  memos: [],
});
// Envelope v1 (legacy): the vault is encrypted directly with a password key.
export type LegacyEnvelope = {
  version: 1;
  id: string;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};
export type Wrap = { iv: string; data: string };
// Key slots: one random data key (DEK) encrypts the vault; the DEK is wrapped
// separately by the master password and, optionally, by a recovery key.
// The slots are authenticated with the DEK, so nobody without it can forge them.
export type KeySlots = {
  updated: number;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  password: Wrap;
  recovery?: Wrap & { salt: string };
  authIv: string;
  auth: string;
};
// Envelope v3: vault encrypted with the DEK, plus key slots.
export type SealedEnvelope = {
  version: 3;
  id: string;
  keys: KeySlots;
  iv: string;
  ciphertext: string;
};
export type Envelope = LegacyEnvelope | SealedEnvelope;
export const ITERATIONS = 600000;
export const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
};
export const unb64 = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const text = (s: string) => new TextEncoder().encode(s);
const isB64 = (s: unknown, len?: number) => {
  if (typeof s !== "string" || s.length > 16_000_000) return false;
  try {
    const n = unb64(s).length;
    return len === undefined ? n > 0 : n === len;
  } catch {
    return false;
  }
};
const isWrap = (w: any) => !!w && isB64(w.iv, 12) && isB64(w.data, 48);
export function validateEnvelope(x: unknown): Envelope {
  const e = x as any;
  if (
    !e ||
    (e.version !== 1 && e.version !== 3) ||
    typeof e.id !== "string" ||
    e.id.length > 100 ||
    typeof e.iv !== "string" ||
    typeof e.ciphertext !== "string" ||
    e.ciphertext.length > 12_000_000
  )
    throw Error("不支援或損壞的加密備份");
  if (e.version === 1) {
    if (
      e.kdf !== "PBKDF2-SHA256" ||
      e.iterations !== ITERATIONS ||
      typeof e.salt !== "string"
    )
      throw Error("不支援或損壞的加密備份");
    if (!isB64(e.salt, 16)) throw Error("加密資料格式錯誤");
  } else {
    const k = e.keys;
    if (
      !k ||
      !Number.isSafeInteger(k.updated) ||
      k.kdf !== "PBKDF2-SHA256" ||
      k.iterations !== ITERATIONS ||
      !isB64(k.salt, 16) ||
      !isWrap(k.password) ||
      (k.recovery !== undefined &&
        (!isWrap(k.recovery) || !isB64(k.recovery.salt, 16))) ||
      !isB64(k.authIv, 12) ||
      !isB64(k.auth, 16)
    )
      throw Error("加密資料格式錯誤");
  }
  if (!isB64(e.iv, 12) || unb64(e.ciphertext).length < 16)
    throw Error("加密資料格式錯誤");
  return e as Envelope;
}
export async function derive(password: string, salt: string) {
  const base = await crypto.subtle.importKey(
    "raw",
    text(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: unb64(salt),
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}
const aad = (e: Envelope) =>
  text(
    e.version === 1
      ? `Veilmark|1|${e.id}|${e.salt}|${e.iterations}`
      : `Veilmark|3|${e.id}`,
  );
async function aesSeal(e: Envelope, key: CryptoKey, v: Vault) {
  return b64(
    new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: unb64(e.iv), additionalData: aad(e) },
        key,
        text(JSON.stringify(v)),
      ),
    ),
  );
}
/** Legacy v1 sealing; kept for reading old data and for tests. */
export async function encrypt(
  v: Vault,
  key: CryptoKey,
  salt: string,
): Promise<LegacyEnvelope> {
  const e: LegacyEnvelope = {
    version: 1,
    id: v.id,
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt,
    iv: b64(random(12)),
    ciphertext: "",
  };
  e.ciphertext = await aesSeal(e, key, v);
  return e;
}
/** Encrypts the vault with the data key and attaches the key slots. */
export async function seal(
  v: Vault,
  dek: CryptoKey,
  keys: KeySlots,
): Promise<SealedEnvelope> {
  const e: SealedEnvelope = {
    version: 3,
    id: v.id,
    keys,
    iv: b64(random(12)),
    ciphertext: "",
  };
  e.ciphertext = await aesSeal(e, dek, v);
  return e;
}

// ---- Data key and key slots -------------------------------------------------
export const newDataKey = () =>
  crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]) as Promise<CryptoKey>;
export const exportKey = async (k: CryptoKey) =>
  b64(new Uint8Array(await crypto.subtle.exportKey("raw", k)));
export const importKey = (raw: string) =>
  crypto.subtle.importKey("raw", unb64(raw), { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
async function wrap(dek: CryptoKey, kek: CryptoKey, label: string) {
  const iv = random(12);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", dek));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: text(label) },
    kek,
    raw,
  );
  return { iv: b64(iv), data: b64(new Uint8Array(data)) };
}
async function unwrap(w: Wrap, kek: CryptoKey, label: string, error: string) {
  try {
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(w.iv), additionalData: text(label) },
      kek,
      unb64(w.data),
    );
    return importKey(b64(new Uint8Array(raw)));
  } catch {
    throw Error(error);
  }
}
const pwLabel = (id: string, salt: string) => `Veilmark|pw|${id}|${salt}`;
const rkLabel = (id: string, salt: string) => `Veilmark|rk|${id}|${salt}`;
// Explicit field order: chrome.storage does not preserve object key order.
function slotsPayload(id: string, k: KeySlots) {
  return JSON.stringify([
    "Veilmark|slots",
    id,
    k.updated,
    k.kdf,
    k.iterations,
    k.salt,
    k.password.iv,
    k.password.data,
    k.recovery ? [k.recovery.salt, k.recovery.iv, k.recovery.data] : null,
  ]);
}
async function authSlots(dek: CryptoKey, id: string, k: KeySlots) {
  const iv = random(12);
  const tag = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: text(slotsPayload(id, k)) },
    dek,
    new Uint8Array(0),
  );
  k.authIv = b64(iv);
  k.auth = b64(new Uint8Array(tag));
  return k;
}
/** Throws unless the slots were written by someone holding this data key. */
export async function verifySlots(dek: CryptoKey, id: string, k: KeySlots) {
  try {
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unb64(k.authIv),
        additionalData: text(slotsPayload(id, k)),
      },
      dek,
      unb64(k.auth),
    );
  } catch {
    throw Error("保險庫金鑰資料無效或已被竄改");
  }
}
/** Builds (or replaces) the password slot; keeps any recovery slot. */
export async function setPassword(
  dek: CryptoKey,
  id: string,
  password: string,
  previous?: KeySlots,
  salt = b64(random(16)),
) {
  const kek = await derive(password, salt);
  const k: KeySlots = {
    updated: Math.max(Date.now(), (previous?.updated || 0) + 1),
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt,
    password: await wrap(dek, kek, pwLabel(id, salt)),
    ...(previous?.recovery ? { recovery: previous.recovery } : {}),
    authIv: "",
    auth: "",
  };
  return authSlots(dek, id, k);
}
/** Adds or replaces the recovery slot. */
export async function setRecovery(
  dek: CryptoKey,
  id: string,
  code: Uint8Array,
  previous: KeySlots,
) {
  const salt = b64(random(16));
  const kek = await recoveryKek(code, salt);
  const k: KeySlots = {
    ...previous,
    updated: Math.max(Date.now(), previous.updated + 1),
    recovery: { salt, ...(await wrap(dek, kek, rkLabel(id, salt))) },
  };
  return authSlots(dek, id, k);
}
export async function openWithPassword(e: SealedEnvelope, password: string) {
  const k = e.keys;
  const kek = await derive(password, k.salt);
  const dek = await unwrap(
    k.password,
    kek,
    pwLabel(e.id, k.salt),
    "密碼不正確，或加密資料已損壞",
  );
  await verifySlots(dek, e.id, k);
  return { dek, kek };
}
export async function openWithRecovery(e: SealedEnvelope, code: Uint8Array) {
  const r = e.keys.recovery;
  if (!r) throw Error("這個保險庫尚未建立救援金鑰");
  const dek = await unwrap(
    r,
    await recoveryKek(code, r.salt),
    rkLabel(e.id, r.salt),
    "救援金鑰不正確",
  );
  await verifySlots(dek, e.id, e.keys);
  return dek;
}

// ---- Recovery key -----------------------------------------------------------
// 20 random bytes (160 bits) shown as 32 Crockford Base32 characters.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newRecoveryCode() {
  const bytes = random(20);
  let bits = 0,
    value = 0,
    out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return { bytes, code: out.match(/.{4}/g)!.join("-") };
}
export function parseRecoveryCode(code: unknown) {
  const clean = String(code || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (clean.length !== 32 || [...clean].some((c) => !B32.includes(c)))
    throw Error("救援金鑰格式不正確，應為 32 個英數字");
  const bytes = new Uint8Array(20);
  let bits = 0,
    value = 0,
    i = 0;
  for (const c of clean) {
    value = ((value << 5) | B32.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes[i++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return bytes;
}
async function recoveryKek(code: Uint8Array, salt: string) {
  const ikm = new Uint8Array(code.length);
  ikm.set(code);
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: unb64(salt),
      info: text("Veilmark recovery v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Decrypts a v1 envelope with a password key or a v3 envelope with the DEK. */
export async function decrypt(input: unknown, key: CryptoKey): Promise<Vault> {
  const e = validateEnvelope(input);
  let v: Omit<Vault, "version" | "memos"> & {
    version: 1 | 2;
    memos?: Memo[];
  };
  try {
    v = JSON.parse(
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: unb64(e.iv), additionalData: aad(e) },
          key,
          unb64(e.ciphertext),
        ),
      ),
    );
  } catch {
    throw Error("密碼不正確，或加密資料已損壞");
  }
  if (
    (v.version !== 1 && v.version !== 2) ||
    v.id !== e.id ||
    !Array.isArray(v.entries) ||
    v.entries.length > 20000
  )
    throw Error("書籤資料格式錯誤");
  if (v.version === 1) v.memos = [];
  v.version = 2;
  if (!Array.isArray(v.memos) || v.memos.length > 5000)
    throw Error("記事資料格式錯誤");
  for (const x of v.memos)
    if (
      typeof x.id !== "string" ||
      typeof x.title !== "string" ||
      typeof x.body !== "string" ||
      x.body.length > MEMO_MAX ||
      (x.format !== undefined && x.format !== "html" && x.format !== "text") ||
      !Number.isSafeInteger(x.updated) ||
      typeof x.revision !== "string" ||
      typeof x.deleted !== "boolean"
    )
      throw Error("記事資料格式錯誤");
  for (const x of v.entries) {
    if (
      typeof x.id !== "string" ||
      typeof x.title !== "string" ||
      typeof x.url !== "string" ||
      typeof x.folder !== "string" ||
      typeof x.notes !== "string" ||
      !Array.isArray(x.tags) ||
      !x.tags.every((t) => typeof t === "string") ||
      !Number.isSafeInteger(x.updated) ||
      typeof x.revision !== "string" ||
      typeof x.deleted !== "boolean"
    )
      throw Error("書籤資料格式錯誤");
    safeUrl(x.url);
  }
  return v as Vault;
}
export function safeUrl(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw Error("請輸入完整的 https:// 或 http:// 網址");
  }
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
    throw Error("僅接受不含帳密的 HTTP / HTTPS 網址");
  return u.href;
}
// LWW records with deterministic tie-break; tombstones prevent deleted records returning.
function lww<T extends { id: string; updated: number; revision: string }>(
  a: T[],
  b: T[],
): T[] {
  const map = new Map<string, T>();
  for (const x of [...a, ...b]) {
    const old = map.get(x.id);
    if (
      !old ||
      x.updated > old.updated ||
      (x.updated === old.updated && x.revision > old.revision)
    )
      map.set(x.id, x);
  }
  return [...map.values()].sort((x, y) => x.id.localeCompare(y.id));
}
export function merge(a: Vault, b: Vault): Vault {
  if (a.id !== b.id)
    throw Error("這是不同的保險庫，請使用原始備份或從 Drive 還原");
  return {
    version: 2,
    id: a.id,
    entries: lww(a.entries, b.entries),
    memos: lww(a.memos || [], b.memos || []),
  };
}
