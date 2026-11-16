import { validateEnvelope, type Envelope } from "./crypto";
const API = "https://www.googleapis.com/drive/v3/files";
export const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
// The user's Google storage (Drive, Gmail and Photos together) is full.
export const DRIVE_FULL =
  "Google Drive 空間已滿。資料仍安全保存在這台電腦，清出空間後會自動繼續同步。";
export const STORAGE_URL = "https://one.google.com/storage";
export const CLIENT_ID_RE = /^[\w-]+\.apps\.googleusercontent\.com$/;
type CachedToken = { clientId: string; token: string; expires: number };
function manifestClientId() {
  return chrome.runtime.getManifest().oauth2?.client_id;
}
export async function userClientId() {
  const { oauthClientId } = await chrome.storage.local.get<{
    oauthClientId?: string;
  }>("oauthClientId");
  return oauthClientId && CLIENT_ID_RE.test(oauthClientId)
    ? oauthClientId
    : undefined;
}
export async function oauthSource(): Promise<"manifest" | "user" | null> {
  if (manifestClientId()) return "manifest";
  return (await userClientId()) ? "user" : null;
}
export async function configured() {
  return !!(await oauthSource());
}
export async function setClientId(id: unknown) {
  const clientId = typeof id === "string" ? id.trim() : "";
  if (!CLIENT_ID_RE.test(clientId))
    throw Error("用戶端 ID 格式不正確，應以 .apps.googleusercontent.com 結尾");
  await clearTokens();
  await chrome.storage.local.set({ oauthClientId: clientId });
}
export async function clearClientId() {
  await clearTokens();
  await chrome.storage.local.remove("oauthClientId");
}
export async function clearTokens() {
  await chrome.storage.session.remove("driveToken");
  if (manifestClientId()) await chrome.identity.clearAllCachedAuthTokens();
}
// Runtime-configured client: OAuth implicit flow through launchWebAuthFlow, so
// the user can paste their own Client ID without rebuilding the extension.
async function webFlowToken(clientId: string, interactive: boolean) {
  const { driveToken } = await chrome.storage.session.get<{
    driveToken?: CachedToken;
  }>("driveToken");
  if (
    driveToken?.clientId === clientId &&
    driveToken.expires > Date.now() + 60_000
  )
    return driveToken.token;
  const state = crypto.randomUUID();
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: clientId,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPE,
    state,
    ...(interactive ? {} : { prompt: "none" }),
  }).toString();
  let result: string | undefined;
  try {
    result = await chrome.identity.launchWebAuthFlow({
      url: auth.toString(),
      interactive,
    });
  } catch {
    throw Error(
      interactive ? "Google 授權未完成或已取消" : "尚未取得 Google 授權",
    );
  }
  const p = new URLSearchParams(new URL(result || "about:blank").hash.slice(1));
  if (p.get("state") !== state) throw Error("Google 授權回應無效，請重試");
  const token = p.get("access_token");
  if (!token)
    throw Error(
      p.get("error") === "access_denied"
        ? "Google 授權未完成或已取消"
        : "尚未取得 Google 授權",
    );
  if (!(p.get("scope") || "").split(" ").includes(SCOPE))
    throw Error("請在 Google 授權畫面允許存取應用程式資料");
  const expires = Date.now() + Number(p.get("expires_in") || 3600) * 1000;
  await chrome.storage.session.set({
    driveToken: { clientId, token, expires } satisfies CachedToken,
  });
  return token;
}
async function token(interactive: boolean) {
  if (manifestClientId()) {
    const r = await chrome.identity.getAuthToken({ interactive });
    if (!r.token) throw Error("尚未取得 Google 授權");
    return r.token;
  }
  const clientId = await userClientId();
  if (!clientId)
    throw Error(
      "Drive 尚未設定，請先完成「Google Drive 設定」說明頁；本機功能可直接使用。",
    );
  return webFlowToken(clientId, interactive);
}
async function request(
  t: string,
  url: string,
  init: RequestInit = {},
  allow404 = false,
  timeout = 30000,
) {
  const r = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${t}` },
    signal: AbortSignal.timeout(timeout),
  });
  if (r.status === 401) {
    await chrome.storage.session.remove("driveToken");
    if (manifestClientId())
      await chrome.identity.removeCachedAuthToken({ token: t });
    throw Error("Google 授權已失效，請重新連線");
  }
  if (allow404 && r.status === 404) return null;
  if (!r.ok) {
    if (r.status === 403 && (await r.text()).includes("storageQuotaExceeded"))
      throw Error(DRIVE_FULL);
    throw Error(`Drive 請求失敗 (${r.status})，本機資料已保留`);
  }
  return r;
}
/** Lists Veil Bookmark snapshots in the app-data folder without reading them. */
export async function listSnapshots(interactive: boolean) {
  const t = await token(interactive);
  const files: { id: string }[] = [];
  let page = "";
  do {
    const q = new URLSearchParams({
      spaces: "appDataFolder",
      q: "trashed = false and appProperties has { key='veilmark' and value='1' }",
      fields: "nextPageToken,files(id)",
      pageSize: "1000",
    });
    if (page) q.set("pageToken", page);
    const data = await (await request(t, `${API}?${q}`))!.json();
    files.push(...data.files);
    page = data.nextPageToken || "";
    if (files.length > 2000)
      throw Error("Drive 快照超過 2000 份，請先匯出備份並整理");
  } while (page);
  return { t, ids: files.map((f) => f.id) };
}
export async function readRemote(interactive: boolean) {
  const { t, ids: listed } = await listSnapshots(interactive);
  const envelopes: Envelope[] = [];
  const ids: string[] = [];
  for (const id of listed) {
    // Another device may have consolidated (deleted) this snapshot meanwhile.
    const r = await request(
      t,
      `${API}/${encodeURIComponent(id)}?alt=media`,
      {},
      true,
    );
    if (!r) continue;
    const raw = await r.text();
    if (raw.length > 66_000_000) throw Error("Drive 備份過大");
    envelopes.push(validateEnvelope(JSON.parse(raw)));
    ids.push(id);
  }
  return { t, envelopes, ids };
}
// Immutable snapshots: concurrent devices never overwrite another device's changes.
export async function upload(t: string, e: Envelope) {
  const boundary = `veilmark_${crypto.randomUUID()}`;
  const meta = {
    name: `veilmark-${Date.now()}-${crypto.randomUUID()}.json`,
    parents: ["appDataFolder"],
    appProperties: { veilmark: "1" },
    mimeType: "application/json",
  };
  const json = JSON.stringify(e);
  // Multipart uploads are meant for files up to 5 MB; larger vaults (notebook
  // images) use a resumable session, sent in one request.
  if (json.length > 4_000_000) {
    const start = await request(
      t,
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "application/json",
        },
        body: JSON.stringify(meta),
      },
    );
    const session = start!.headers.get("Location");
    if (!session?.startsWith("https://www.googleapis.com/upload/drive/"))
      throw Error("Drive 回應無效，本機資料已保留");
    await request(
      t,
      session,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: json,
      },
      false,
      180000,
    );
    return;
  }
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
  await request(
    t,
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
}

// Removes snapshots whose contents are already merged into a newer upload.
// Only ids that were read in this sync are deleted, so a snapshot another
// device uploads concurrently is never lost.
export async function removeSnapshots(t: string, ids: string[]) {
  for (const id of ids)
    await request(
      t,
      `${API}/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      true,
    );
}
