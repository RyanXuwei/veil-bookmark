import { workspaceKey } from "./accounts";
// Face ID / fingerprint unlock for the mobile web app, with a passkey and the
// WebAuthn PRF extension. The passkey (kept by the phone, unlocked with
// biometrics) produces a secret that only this phone can compute; that secret
// wraps the vault's data key, stored on this phone. The master password itself
// is never stored. Drive data is not changed.
import { b64, exportKey, importKey, random, unb64 } from "../src/crypto";

export const MAX_AGE = 30 * 24 * 3600 * 1000; // master password again after 30 days

type BioRecord = {
  credential: string; // passkey ID (base64)
  salt: string; // PRF input (base64)
  iv: string;
  wrapped: string; // data key encrypted with the PRF-derived key
  vault: string; // vault ID
  passwordAt: number; // last unlock with the master password
};

// ---- Storage on this phone (IndexedDB, next to the encrypted copy) ----------
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("veil-bookmark-bio", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kv<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
) {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const r = fn(d.transaction("kv", mode).objectStore("kv"));
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => reject(r.error);
    });
  } finally {
    d.close();
  }
}
const load = () => {
  const key = workspaceKey("unlock");
  return kv<BioRecord | undefined>("readonly", (s) => s.get(key));
};
const store = (r: BioRecord, key = workspaceKey("unlock")) =>
  kv("readwrite", (s) => s.put(r, key));
/** Turns biometric unlock off on this phone. */
export const disable = (key = workspaceKey("unlock")) =>
  kv("readwrite", (s) => s.delete(key));

export type BioStatus = "off" | "on" | "expired";
export async function status(): Promise<BioStatus> {
  try {
    const r = await load();
    if (!r) return "off";
    return Date.now() - r.passwordAt > MAX_AGE ? "expired" : "on";
  } catch {
    return "off";
  }
}
/** Records an unlock with the master password (restarts the 30 days). */
export async function passwordUsed(vault: string) {
  const storageKey = workspaceKey("unlock");
  try {
    const r = await load();
    if (r && r.vault === vault)
      await store({ ...r, passwordAt: Date.now() }, storageKey);
    else if (r) await disable(storageKey); // A different vault now: the key is useless.
  } catch {}
}

/** Whether this phone has a biometric (or screen lock) authenticator. The
 *  PRF extension is checked for real when the passkey is created. */
export async function available() {
  try {
    if (!window.PublicKeyCredential || !window.isSecureContext) return false;
    const caps = await (
      PublicKeyCredential as unknown as {
        getClientCapabilities?: () => Promise<Record<string, boolean>>;
      }
    ).getClientCapabilities?.();
    if (caps && caps["extension:prf"] === false) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

const label = (vault: string) =>
  new TextEncoder().encode(`Veilmark|bio|${vault}`);
async function wrapKey(secret: ArrayBuffer, salt: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as Uint8Array<ArrayBuffer>,
      info: new TextEncoder().encode("Veil Bookmark biometric unlock"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
type Prf = { results?: { first?: ArrayBuffer } };
function prfOf(cred: PublicKeyCredential | null) {
  const ext = cred?.getClientExtensionResults() as { prf?: Prf } | undefined;
  return ext?.prf?.results?.first;
}
async function assert(credential: string, salt: Uint8Array) {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [
        { type: "public-key", id: unb64(credential), transports: ["internal"] },
      ],
      userVerification: "required",
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: salt } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const secret = prfOf(cred);
  if (!secret) throw Error("這支手機的瀏覽器不支援生物辨識解鎖");
  return secret;
}

/** Creates a passkey and stores the data key wrapped with its secret. */
export async function enable(dek: CryptoKey, vault: string) {
  const storageKey = workspaceKey("unlock");
  const salt = random(32);
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: random(32),
        rp: { name: "Veil Bookmark" },
        user: {
          id: random(16),
          name: "Veil Bookmark",
          displayName: "Veil Bookmark",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "preferred",
          userVerification: "required",
        },
        timeout: 60_000,
        extensions: {
          prf: { eval: { first: salt } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch {
    throw Error("未完成生物辨識設定");
  }
  if (!cred) throw Error("未完成生物辨識設定");
  const ext = cred.getClientExtensionResults() as {
    prf?: Prf & { enabled?: boolean };
  };
  if (ext.prf?.enabled === false || !ext.prf)
    throw Error("這支手機的瀏覽器不支援生物辨識解鎖");
  const id = b64(new Uint8Array(cred.rawId));
  // Some phones only evaluate the secret when the passkey is used.
  const secret = prfOf(cred) || (await assert(id, salt));
  const key = await wrapKey(secret, salt);
  const iv = random(12);
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: label(vault) },
    key,
    unb64(await exportKey(dek)),
  );
  await store(
    {
      credential: id,
      salt: b64(salt),
      iv: b64(iv),
      wrapped: b64(new Uint8Array(wrapped)),
      vault,
      passwordAt: Date.now(),
    },
    storageKey,
  );
}

/** Asks for Face ID / fingerprint and returns the vault's data key. */
export async function unlockKey(): Promise<{ dek: CryptoKey; vault: string }> {
  const storageKey = workspaceKey("unlock");
  const r = await load();
  if (!r) throw Error("尚未啟用生物辨識解鎖");
  if (Date.now() - r.passwordAt > MAX_AGE)
    throw Error("已超過 30 天，請輸入一次主密碼");
  let secret: ArrayBuffer;
  try {
    secret = await assert(r.credential, unb64(r.salt));
  } catch (e) {
    if ((e as Error).message === "這支手機的瀏覽器不支援生物辨識解鎖") throw e;
    throw Error("未完成生物辨識，請再試一次或輸入主密碼");
  }
  try {
    const key = await wrapKey(secret, unb64(r.salt));
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(r.iv), additionalData: label(r.vault) },
      key,
      unb64(r.wrapped),
    );
    return { dek: await importKey(b64(new Uint8Array(raw))), vault: r.vault };
  } catch {
    await disable(storageKey);
    throw Error("生物辨識資料已失效，請輸入主密碼後重新啟用");
  }
}
