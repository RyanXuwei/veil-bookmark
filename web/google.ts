// Google sign-in for the mobile web app: the OAuth 2.0 token flow, by redirect
// before unlocking, or in a popup window once the vault is open (so it stays
// unlocked). No Google script is loaded. The access token (about one hour,
// Drive app-data folder only) is kept for this tab only.
import { SCOPE } from "../src/drive";

const TOKEN = "veilGoogleToken";
const STATE = "veilOAuthState";
const CHANNEL = "veil-oauth";
type Stored = { token: string; expires: number };

let clientId = "";
export async function loadConfig() {
  try {
    const r = await fetch("./config.json", { cache: "no-store" });
    const c = await r.json();
    if (
      typeof c.clientId === "string" &&
      /^[\w-]+\.apps\.googleusercontent\.com$/.test(c.clientId)
    )
      clientId = c.clientId;
  } catch {}
  return !!clientId;
}
export const configured = () => !!clientId;

/** The app's own address (where Google sends the user back). */
export const redirectUri = () => location.origin + location.pathname;

export function token(): string {
  try {
    const s = JSON.parse(
      sessionStorage.getItem(TOKEN) || "null",
    ) as Stored | null;
    if (s && s.expires > Date.now() + 60_000) return s.token;
  } catch {}
  return "";
}
export function forgetToken() {
  try {
    sessionStorage.removeItem(TOKEN);
  } catch {}
}

function authUrl(state: string) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: SCOPE,
    state,
    include_granted_scopes: "true",
  }).toString();
  return u.toString();
}
// "p." marks the popup flow, so the popup knows to hand the reply back.
function newState(popup: boolean) {
  const state = (popup ? "p." : "r.") + crypto.randomUUID();
  sessionStorage.setItem(STATE, state);
  return state;
}

/** Leaves the page for Google's sign-in; the app reopens with a token. */
export function signInRedirect() {
  if (!clientId) throw Error("手機版尚未設定 Google 用戶端");
  location.assign(authUrl(newState(false)));
}

/** Signs in in a popup window and resolves when the token arrives. Falls back
 *  to a redirect when the browser blocks popups. */
export function signInPopup(): Promise<void> {
  if (!clientId) return Promise.reject(Error("手機版尚未設定 Google 用戶端"));
  const url = authUrl(newState(true));
  const channel = new BroadcastChannel(CHANNEL);
  const w = window.open(url, "_blank");
  if (!w) {
    channel.close();
    signInRedirect();
    return new Promise(() => {});
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        channel.close();
        reject(Error("Google 授權未完成或已取消"));
      },
      5 * 60 * 1000,
    );
    channel.onmessage = (e) => {
      const hash = e.data?.veilOAuth;
      if (typeof hash !== "string") return;
      clearTimeout(timer);
      channel.close();
      try {
        accept(hash);
        resolve();
      } catch (err) {
        reject(err);
      }
    };
  });
}

function accept(hash: string) {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const expected = sessionStorage.getItem(STATE);
  sessionStorage.removeItem(STATE);
  if (!expected || p.get("state") !== expected)
    throw Error("Google 授權回應無效，請重試");
  const t = p.get("access_token");
  if (!t)
    throw Error(
      p.get("error") === "access_denied"
        ? "Google 授權未完成或已取消"
        : "尚未取得 Google 授權",
    );
  if (!(p.get("scope") || "").split(" ").includes(SCOPE))
    throw Error("請在 Google 授權畫面允許存取應用程式資料");
  const expires = Date.now() + Number(p.get("expires_in") || 3600) * 1000;
  sessionStorage.setItem(
    TOKEN,
    JSON.stringify({ token: t, expires } satisfies Stored),
  );
}

/** Handles Google's reply when the page loads. "popup" means this window is
 *  the sign-in popup: the reply went to the app and this window can close. */
export function handleReturn(): "popup" | "done" | "" {
  const hash = location.hash;
  if (!/(^|[#&])(access_token|error)=/.test(hash)) return "";
  history.replaceState(null, "", location.pathname + location.search);
  const state = new URLSearchParams(hash.slice(1)).get("state") || "";
  if (state.startsWith("p.")) {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ veilOAuth: hash });
    channel.close();
    window.close();
    return "popup";
  }
  accept(hash);
  return "done";
}
