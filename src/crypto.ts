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
export type Vault = { version: 1; id: string; entries: Entry[] };
export type Envelope = {
  version: 1;
  id: string;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};
export const ITERATIONS = 600000;
export const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
};
export const unb64 = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export function validateEnvelope(x: unknown): Envelope {
  const e = x as Envelope;
  if (
    !e ||
    e.version !== 1 ||
    typeof e.id !== "string" ||
    e.id.length > 100 ||
    e.kdf !== "PBKDF2-SHA256" ||
    e.iterations !== ITERATIONS ||
    typeof e.salt !== "string" ||
    typeof e.iv !== "string" ||
    typeof e.ciphertext !== "string" ||
    e.ciphertext.length > 12_000_000
  )
    throw Error("不支援或損壞的加密備份");
  if (
    unb64(e.salt).length !== 16 ||
    unb64(e.iv).length !== 12 ||
    unb64(e.ciphertext).length < 16
  )
    throw Error("加密資料格式錯誤");
  return e;
}
export async function derive(password: string, salt: string) {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
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
  new TextEncoder().encode(`Veilmark|1|${e.id}|${e.salt}|${e.iterations}`);
export async function encrypt(
  v: Vault,
  key: CryptoKey,
  salt: string,
): Promise<Envelope> {
  const e: Envelope = {
    version: 1,
    id: v.id,
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt,
    iv: b64(random(12)),
    ciphertext: "",
  };
  e.ciphertext = b64(
    new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: unb64(e.iv), additionalData: aad(e) },
        key,
        new TextEncoder().encode(JSON.stringify(v)),
      ),
    ),
  );
  return e;
}
export async function decrypt(input: unknown, key: CryptoKey): Promise<Vault> {
  const e = validateEnvelope(input);
  let v: Vault;
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
    v.version !== 1 ||
    v.id !== e.id ||
    !Array.isArray(v.entries) ||
    v.entries.length > 20000
  )
    throw Error("書籤資料格式錯誤");
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
  return v;
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
export function merge(a: Vault, b: Vault): Vault {
  if (a.id !== b.id)
    throw Error("這是不同的保險庫，請使用原始備份或從 Drive 還原");
  const map = new Map<string, Entry>();
  for (const x of [...a.entries, ...b.entries]) {
    const old = map.get(x.id);
    if (
      !old ||
      x.updated > old.updated ||
      (x.updated === old.updated && x.revision > old.revision)
    )
      map.set(x.id, x);
  }
  return {
    version: 1,
    id: a.id,
    entries: [...map.values()].sort((x, y) => x.id.localeCompare(y.id)),
  };
}
