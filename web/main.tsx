import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import {
  cleanDrawing,
  cleanRecordings,
  safeUrl,
  type DrawingStroke,
  type Entry,
  type Memo,
  type MemoImage,
  type MemoRecording,
} from "../src/crypto";
import { DrawingLayer } from "../src/drawing";
import { AudioSticker, Recorder } from "../src/recorder";
import {
  LANGS,
  detect,
  preferred,
  lang,
  setLang,
  t,
  tError,
  type Lang,
} from "../src/i18n";
import { memoTitle } from "../src/memos";
import { imageSrc, importImage } from "../src/ruled";
import { DEFAULT_PAPER } from "../src/memo-ops";
import {
  htmlToText,
  imageIds,
  memoHtml,
  memoText,
  sanitizeHtml,
} from "../src/sanitize";
import { folderNames, ordered } from "../src/sortable";
import {
  baseName,
  depthOf,
  isPrivate,
  PRIVATE_FOLDER,
  parentOf,
  pathLabel,
  within,
} from "../src/folders";
import { IMPORT_ACCEPT, importFile } from "../src/import-doc";
import { TagInput } from "../src/tag-input";
import {
  configured,
  forgetToken,
  handleReturn,
  loadConfig,
  migrateAccount,
  renewSilently,
  signInPopup,
  signInRedirect,
  token,
} from "./google";
import {
  clearCache,
  prepareAccountSwitch,
  removeWorkspace,
  hasCache,
  lock,
  removeEntry,
  removeMemo,
  saveEntry,
  saveMemo,
  subscribe,
  syncNow,
  syncState,
  unlock,
  vault,
  enableBiometric,
  unlockBiometric,
  needsSetup,
  createVault,
  finishCreate,
  addSharedLinks,
} from "./vault";
import * as shareInbox from "./share-inbox";
import { AccountMenu } from "./account-menu";
import { drawDiagrams, htmlText, markdownPreview } from "../src/md-preview";
import { RecoveryKeyModal } from "../src/recovery";
import { removeAccount } from "./accounts";
import * as bio from "./biometric";
import { lookupBookmarkTitle } from "../src/bookmark-title";
import { VERSION } from "../src/version";
import { BobaSupport } from "../src/boba-support";
import "./app.css";

const GITHUB = "https://github.com/RyanXuwei/veil-bookmark";
const IDLE_LOCK = 15 * 60 * 1000;
const HIDDEN_LOCK = 5 * 60 * 1000;
const ALL = "\u0000all";
const UNFILED = "\u0000unfiled";
const STORE =
  "https://chromewebstore.google.com/detail/chpabfajilpjflfmnkopjjcnoaaliefg";
const PAPER_COLORS = [
  "#fff4be",
  "#fbe0dc",
  "#e4eddb",
  "#dfeef4",
  "#eee3f3",
  "#fffdf5",
];

/** Google Chrome on a computer, where the extension can be installed.
 *  Phones, tablets and other desktop browsers keep using this app. */
function desktopChrome() {
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return false;
  // iPadOS asks for desktop sites with a Mac user agent.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return false;
  const data = (
    navigator as {
      userAgentData?: { mobile?: boolean; brands?: { brand: string }[] };
    }
  ).userAgentData;
  return (
    data?.mobile === false &&
    !!data.brands?.some((b) => b.brand === "Google Chrome")
  );
}

// Language: saved choice on this phone, otherwise the browser's.
function initLang() {
  let saved = "";
  try {
    saved = localStorage.getItem("veilLang") || "";
  } catch {}
  setLang(
    LANGS.some((x) => x.code === saved)
      ? (saved as Lang)
      : detect(preferred()),
  );
}

// Shared to the app (Android "Share" → Veil Bookmark, or an iPhone Shortcut).
// A link alone becomes a bookmark; selected text or pictures become a note.
// Android posts to ./share: the service worker keeps it in memory only and
// hands it to this page once (nothing is written to storage unencrypted).
type SharedNote = { title: string; text: string; url: string; files: File[] };
type Shared = {
  link: { title: string; url: string } | null;
  note: SharedNote | null;
  lost?: boolean;
};
function classifyShare(
  title: string,
  text: string,
  url: string,
  files: File[],
): Shared {
  const link = url || text.match(/https?:\/\/\S+/)?.[0] || "";
  const rest = (link ? text.replace(link, "") : text).trim();
  // A page shared with a short caption ("Look at this <link>") is still a
  // bookmark. Selected text (Chrome adds a #:~:text= link), pictures, text
  // without a link, or a longer passage become a note.
  const passage =
    !link ||
    link.includes("#:~:text=") ||
    rest.length > 120 ||
    rest.split("\n").length > 2;
  if (files.length || (rest && passage))
    return {
      link: null,
      note: { title: title.trim(), text: rest, url: link, files },
    };
  return {
    link: link ? { title: title || rest, url: link } : null,
    note: null,
  };
}
type Posted = { title: string; text: string; url: string; files: File[] };
function takeShare(id: string): Promise<Posted | null> {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  return new Promise((done) => {
    setTimeout(() => done(null), 4000);
    void navigator.serviceWorker.ready.then((reg) => {
      const sw = navigator.serviceWorker.controller || reg.active;
      if (!sw) return done(null);
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => done(e.data || null);
      sw.postMessage({ type: "takeShare", id }, [ch.port2]);
    });
  });
}
async function readShare(): Promise<Shared> {
  const p = new URLSearchParams(location.search);
  const id = p.get("share");
  if (!id && !p.has("text") && !p.has("url") && !p.has("title"))
    return { link: null, note: null };
  history.replaceState(null, "", location.pathname);
  if (id) {
    const x = await takeShare(id);
    if (!x) return { link: null, note: null, lost: true };
    return classifyShare(x.title || "", x.text || "", x.url || "", x.files || []);
  }
  return classifyShare(
    p.get("title") || "",
    p.get("text") || "",
    p.get("url") || "",
    [],
  );
}
const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
/** The note saved from shared text, pictures and the page's link. */
async function noteFromShare(n: SharedNote) {
  const images: MemoImage[] = [];
  for (const f of n.files.slice(0, 10))
    try {
      images.push(await importImage(f));
    } catch {}
  let link = "";
  try {
    if (n.url) link = safeUrl(n.url);
  } catch {}
  if (!images.length && !n.text && !link) throw Error("無法讀取這張圖片");
  const paras = n.text
    .split(/\n{2,}/)
    .filter((x) => x.trim())
    .map((x) => `<p>${escapeHtml(x.trim()).replace(/\n/g, "<br>")}</p>`);
  const pics = images.map((i) => `<p><img data-veil-img="${i.id}" alt=""></p>`);
  const source = link
    ? `<p><a href="${escapeHtml(link)}">${escapeHtml(n.title || host(link))}</a></p>`
    : "";
  const first = n.text
    .split("\n")[0]
    .replace(/^["“「]+|["”」]+$/g, "")
    .trim();
  return {
    title: (n.title || first || t("分享的圖片")).slice(0, 80),
    body: [...paras, ...pics, source].join(""),
    format: "html",
    images,
  };
}

type Draft = {
  id?: string;
  title: string;
  url: string;
  folder: string;
  tags: string;
  notes: string;
};
const emptyDraft: Draft = {
  title: "",
  url: "",
  folder: "",
  tags: "",
  notes: "",
};

function useStore() {
  const v = useSyncExternalStore(subscribe, vault);
  const s = useSyncExternalStore(subscribe, syncState);
  return { v, s };
}
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function App({
  shared,
  note,
}: {
  shared: Draft | null;
  note: SharedNote | null;
}) {
  const { v, s } = useStore();
  const [ready, setReady] = useState(false);
  const [cache, setCache] = useState(false);
  const [error, setError] = useState("");
  const [, setLangTick] = useState(0);
  const [pendingShare, setPendingShare] = useState(shared);
  const [pendingNote, setPendingNote] = useState(note);
  // Shared pages sealed on this phone, added as bookmarks at the next unlock.
  const [waiting, setWaiting] = useState(0);
  const [justShared, setJustShared] = useState(false);
  useEffect(() => {
    void (async () => {
      await loadConfig();
      // A shared page arrives with the app locked (every share reloads it):
      // seal it in the share inbox at once, so the user can go back and
      // share the next page without unlocking each time.
      let inMemory = !!shared;
      if (shared && !vault())
        try {
          if (await shareInbox.stash(shared)) {
            inMemory = false;
            setPendingShare(null);
            setJustShared(true);
          }
        } catch {}
      setWaiting(await shareInbox.count());
      // Connected before but the hour is over: get a new token unprompted.
      if (!inMemory && !note && renewSilently()) return;
      setCache(await hasCache());
      setReady(true);
    })();
  }, []);
  useEffect(() => {
    if (ready && !v) void shareInbox.count().then(setWaiting);
  }, [!!v]);
  // After locking, offer the phone's encrypted copy even when offline.
  useEffect(() => {
    if (ready && !v) void hasCache().then(setCache);
  }, [!!v]);

  // Auto-lock: idle for 15 minutes, or away from the app for 5 minutes.
  useEffect(() => {
    if (!v) return;
    let last = Date.now(),
      hiddenAt = 0;
    const active = () => (last = Date.now());
    const check = () => {
      if (Date.now() - last > IDLE_LOCK) lock();
    };
    const visibility = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > HIDDEN_LOCK) lock();
      else active();
    };
    const timer = setInterval(check, 30_000);
    // Any use of the page counts: taps, typing, scrolling anywhere (also
    // inside sheets, the reader and the note editor, hence capture).
    const events = [
      "pointerdown",
      "pointermove",
      "touchstart",
      "touchmove",
      "keydown",
      "input",
      "wheel",
      "scroll",
    ];
    for (const e of events)
      addEventListener(e, active, { passive: true, capture: true });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      for (const e of events) removeEventListener(e, active, { capture: true });
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [!!v]);

  if (!ready)
    return (
      <div className="boot" aria-busy="true">
        <img src="./icon-192.png" alt="" />
      </div>
    );
  const relang = (l: Lang) => {
    setLang(l);
    try {
      localStorage.setItem("veilLang", l);
    } catch {}
    setLangTick((x) => x + 1);
  };
  return (
    <>
      {v ? (
        <Library
          shared={pendingShare}
          clearShared={() => setPendingShare(null)}
          note={pendingNote}
          clearNote={() => setPendingNote(null)}
          onLang={relang}
          onCleared={() => setCache(false)}
        />
      ) : (
        <Unlock
          cache={cache}
          error={error}
          setError={setError}
          shared={pendingNote ? "note" : pendingShare ? "link" : ""}
          waiting={waiting}
          justShared={justShared}
          syncError={s.error}
        />
      )}
    </>
  );
}

// ---- Locked ----------------------------------------------------------------
function Unlock({
  cache,
  error,
  setError,
  shared,
  waiting,
  justShared,
}: {
  cache: boolean;
  error: string;
  setError: (e: string) => void;
  shared: "" | "link" | "note";
  waiting: number;
  justShared: boolean;
  syncError: string;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [bioState, setBioState] = useState<bio.BioStatus>("off");
  const signedIn = !!token();
  // A new user: Drive has no vault yet, so offer to create one here.
  const [setup, setSetup] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [recovery, setRecovery] = useState("");
  const canOpen = (signedIn || cache) && !setup;
  useEffect(() => {
    void bio.status().then(setBioState);
  }, []);
  useEffect(() => {
    if (!signedIn || cache) return;
    let live = true;
    needsSetup().then(
      (x) => live && setSetup(x),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [signedIn, cache]);
  async function create() {
    setError("");
    if (password !== confirm) return setError("兩次密碼不一致");
    setBusy(true);
    try {
      setRecovery(await createVault(password));
      setPassword("");
      setConfirm("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // Locked screen (e.g. after the app was in the background): when the
  // Google connection has expired, renew it without a prompt. Nothing is
  // unlocked here, so leaving for Google and coming back loses nothing.
  useEffect(() => {
    const renew = () => {
      if (!document.hidden && configured() && !token()) renewSilently();
    };
    renew();
    document.addEventListener("visibilitychange", renew);
    return () => document.removeEventListener("visibilitychange", renew);
  }, []);
  async function submit(withBio = false) {
    setBusy(true);
    setError("");
    try {
      if (withBio) await unlockBiometric();
      else await unlock(password);
      setPassword("");
    } catch (e) {
      setError((e as Error).message);
      void bio.status().then(setBioState);
    } finally {
      setBusy(false);
    }
  }
  const useBio = canOpen && bioState === "on";
  return (
    <main className="unlock">
      <header className="brand">
        <img src="./icon-192.png" alt="" />
        <span>Veil Bookmark</span>
        <AccountMenu />
      </header>
      <section className="welcomeCard">
        <p className="eyebrow">PRIVATE BY DESIGN</p>
        <h1>
          {setup
            ? t("建立你的保險庫")
            : canOpen
              ? t("歡迎回來")
              : t("在手機上開啟你的書籤")}
        </h1>
        <p className="muted">
          {setup
            ? t(
                "這個 Google 帳號還沒有 Veil Bookmark 保險庫。設定主密碼就能開始使用，之後在電腦安裝擴充功能也能用同一組主密碼開啟。",
              )
            : canOpen
            ? t("輸入主密碼，打開你的收藏。")
            : t(
                "連接你在電腦上同步書籤的 Google 帳號，再輸入主密碼。資料只在這支手機上解密。",
              )}
        </p>
        {justShared && (
          <p className="status ok sharedSaved" role="status">
            ✓ {t("已收到分享的網頁，並加密暫存在這支手機。")}
          </p>
        )}
        {waiting > 0 && (
          <p className="note sharedWaiting">
            {t(
              "{count} 個分享的網頁正在等待，解鎖後會自動加入書籤。不必現在解鎖，可以回到瀏覽器繼續分享。",
              { count: waiting },
            )}
          </p>
        )}
        {shared && (
          <p className="note">
            {shared === "note"
              ? t("解鎖後會把分享的內容加入記事本。")
              : t("解鎖後會自動把分享的網頁加入書籤。")}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {tError(error)}
          </p>
        )}
        {!configured() ? (
          <p className="note">
            {t("手機版尚未完成 Google 設定，暫時無法連接 Drive。")}
          </p>
        ) : !signedIn ? (
          <button
            className={canOpen ? "secondary full" : "primary full"}
            onClick={() => {
              try {
                signInRedirect();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <GoogleMark /> {t("使用 Google 帳號連接 Drive")}
          </button>
        ) : (
          <p className="status ok">● {t("已連接 Google Drive")}</p>
        )}
        {useBio && (
          <>
            <button
              className="primary full bioButton"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              <FingerprintIcon /> {t("使用 Face ID／指紋解鎖")}
            </button>
            <p className="or">{t("或輸入主密碼")}</p>
          </>
        )}
        {setup && (
          <form
            className="setupForm"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label>
              {t("主密碼")}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={4}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              {t("再次輸入密碼")}
              <input
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            <p className="pwWarning" role="note">
              ⚠{" "}
              {t(
                "請記住主密碼，它不會被備份。建立後會給你一組救援金鑰，忘記密碼時用它救回資料。",
              )}
            </p>
            <button
              className="primary full"
              disabled={busy || !password || !confirm}
            >
              {busy ? t("處理中…") : t("建立保險庫 →")}
            </button>
          </form>
        )}
        {recovery && (
          <RecoveryKeyModal
            quick
            code={recovery}
            onDone={() => {
              setRecovery("");
              finishCreate();
            }}
          />
        )}
        {canOpen && bioState === "expired" && (
          <p className="note">
            {t("生物辨識解鎖已超過 30 天，請輸入一次主密碼。")}
          </p>
        )}
        {canOpen && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label>
              {t("主密碼")}
              <input
                type="password"
                autoComplete="current-password"
                autoFocus={!useBio}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button
              className={useBio ? "secondary full" : "primary full"}
              disabled={busy || !password}
            >
              {busy ? t("解密中…") : t("解鎖保險庫 →")}
            </button>
            {!signedIn && (
              <p className="small muted">
                {t("尚未連接 Google：會開啟這支手機上次同步的資料。")}
              </p>
            )}
          </form>
        )}
      </section>
      <p className="fine">
        {t("主密碼不會離開這支手機。閒置 15 分鐘或離開 5 分鐘後自動上鎖。")}
      </p>
      <Credits />
    </main>
  );
}

// ---- Unlocked --------------------------------------------------------------
function Library({
  shared,
  clearShared,
  note,
  clearNote,
  onLang,
  onCleared,
}: {
  shared: Draft | null;
  clearShared: () => void;
  note: SharedNote | null;
  clearNote: () => void;
  onLang: (l: Lang) => void;
  onCleared: () => void;
}) {
  const { v, s } = useStore();
  const [view, setView] = useState<"bookmarks" | "memos">("bookmarks");
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState(ALL);
  // The incognito-only folder: grey until the user opens it (each time the
  // app is unlocked); the phone cannot open bookmarks in incognito.
  const [showPrivate, setShowPrivate] = useState(false);
  const [askPrivate, setAskPrivate] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [actions, setActions] = useState<Entry | null>(null);
  const [reading, setReading] = useState<Memo | null>(null);
  const [writing, setWriting] = useState<{ memo: Memo | null } | null>(null);
  const [memoActions, setMemoActions] = useState<Memo | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  // Each chosen file (.txt, .md, .html, .docx) becomes a new note.
  async function importFiles(chosen: FileList | null) {
    // Copy the list now: clearing the input afterwards empties the FileList.
    const files = Array.from(chosen || []).slice(0, 20);
    if (!files.length) return;
    setImporting(true);
    setImportError("");
    let done = 0,
      skipped = 0;
    const failed: string[] = [];
    for (const f of files) {
      try {
        const r = await importFile(f);
        skipped += r.skipped;
        await saveMemo({
          title: r.title,
          body: r.html,
          format: "html",
          images: r.images,
        });
        done++;
      } catch (e) {
        failed.push(
          t("無法匯入「{name}」：{reason}", {
            name: f.name,
            reason: tError((e as Error).message),
          }),
        );
      }
    }
    setImporting(false);
    if (skipped)
      failed.push(
        t("有 {count} 張圖片的格式無法匯入（例如 EMF／WMF），已略過。", {
          count: skipped,
        }),
      );
    setImportError(failed.join("\n"));
    if (done) setToast(t("已匯入 {count} 則記事", { count: done }));
  }
  const [settings, setSettings] = useState(false);
  const [toast, setToast] = useState("");
  // After shared pages were added: a message and a shortcut to fill in the
  // rest (folder, tags, notes) of the bookmark later.
  const [sharedToast, setSharedToast] = useState<{
    text: string;
    entry: Entry | null;
  } | null>(null);
  useEffect(() => {
    // Shared pages become bookmarks right away: from this phone's share
    // inbox (shared while locked) and the one shared just now, if any.
    const extra = shared ? [{ title: shared.title, url: shared.url }] : [];
    if (shared) clearShared();
    void (async () => {
      try {
        const r = await addSharedLinks(extra);
        if (r.invalid.length) setEditing({ ...emptyDraft, ...r.invalid[0] });
        if (r.unreadable)
          setImportError(
            t("有 {count} 個分享的網頁無法讀取，請再分享一次。", {
              count: r.unreadable,
            }),
          );
        const n = r.added.length,
          dup = r.existing.length;
        if (!n && !dup) return;
        setView("bookmarks");
        const text =
          n && dup
            ? t("已加入 {count} 個書籤，{dup} 個原本就在書籤中", {
                count: n,
                dup,
              })
            : n > 1
              ? t("已加入 {count} 個書籤", { count: n })
              : n
                ? t("已加入書籤：{title}", { title: r.added[0].title })
                : dup > 1
                  ? t("{count} 個網頁原本就在書籤中", { count: dup })
                  : t("這個網頁原本就在書籤中");
        const entry =
          n === 1 ? r.added[0] : !n && dup === 1 ? r.existing[0] : null;
        setSharedToast({ text, entry });
      } catch (e) {
        // Could not save (e.g. Google Drive not connected): edit by hand.
        if (shared) setEditing({ ...emptyDraft, ...shared });
        else setImportError(tError((e as Error).message));
      }
    })();
    if (note) {
      clearNote();
      setView("memos");
      void (async () => {
        try {
          const saved = await saveMemo(await noteFromShare(note));
          setWriting({ memo: saved });
          setToast(t("已加入記事本"));
        } catch (e) {
          setImportError(tError((e as Error).message));
        }
      })();
    }
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 2400);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (!sharedToast) return;
    const id = setTimeout(() => setSharedToast(null), 6000);
    return () => clearTimeout(id);
  }, [sharedToast]);
  if (!v) return null;
  // The incognito-only folder is always offered (also empty, so bookmarks can
  // be added to it here); its bookmarks are listed only after the user opens
  // it (see showPrivate).
  const hasPrivate = true;
  const entries = v.entries.filter(
    (x) => !x.deleted && (showPrivate || !isPrivate(x.folder)),
  );
  const memos = v.memos.filter((x) => !x.deleted);
  const q = query.trim().toLowerCase();
  const folders = folderNames(
    "entry",
    (v.folders || []).filter(
      (f) => f.kind !== "entry" || showPrivate || !isPrivate(f.name),
    ),
    entries,
  );
  const hasUnfiled = entries.some((x) => !x.folder);
  const shown = ordered(
    entries.filter(
      (x) =>
        (folder === ALL ||
          (folder === UNFILED ? !x.folder : within(x.folder, folder))) &&
        (!q ||
          `${x.title} ${x.url} ${x.tags.join(" ")} ${x.notes}`
            .toLowerCase()
            .includes(q)),
    ),
    (a, b) => b.updated - a.updated,
  );
  // Grouped by folder in the extension's (tree) order: everything under
  // "All", or the chosen top-level folder and its subfolders.
  const topFolders = folders.filter((f) => !parentOf(f));
  const groups =
    (folder === ALL || (folder !== UNFILED && folders.includes(folder))) && !q
      ? [
          ...folders
            .filter((f) => folder === ALL || within(f, folder))
            .map((f) => ({
              name: f,
              items: shown.filter((x) => x.folder === f),
            })),
          ...(folder === ALL
            ? [{ name: "", items: shown.filter((x) => !x.folder) }]
            : []),
        ].filter((g) => g.items.length)
      : [{ name: null as string | null, items: shown }];
  const memoFolders = folderNames("memo", v.folders, memos);
  const memoShown = ordered(
    memos.filter(
      (m) => !q || `${m.title} ${memoText(m)}`.toLowerCase().includes(q),
    ),
    (a, b) => b.updated - a.updated,
  );
  const memoGroups = q
    ? [{ name: null as string | null, items: memoShown }]
    : [
        ...memoFolders.map((f) => ({
          name: f,
          items: memoShown.filter((m) => m.folder === f),
        })),
        { name: "", items: memoShown.filter((m) => !m.folder) },
      ].filter((g) => g.items.length);

  return (
    <div className="library">
      <header className="topBar">
        <div className="brand">
          <img src="./icon-192.png" alt="" />
          <span>Veil Bookmark</span>
        </div>
        <AccountMenu />
        <button
          className={`syncDot ${s.error ? "bad" : s.pending ? "wait" : "ok"}`}
          aria-label={t("同步與設定")}
          onClick={() => setSettings(true)}
        >
          <span aria-hidden="true">●</span>
          {s.syncing
            ? t("同步中…")
            : s.error || (s.pending && !token())
              ? t("需要處理")
              : s.pending
                ? t("等待上傳")
                : t("已同步")}
        </button>
        <button className="ghost" onClick={lock}>
          {t("上鎖")}
        </button>
      </header>
      {(s.error || (s.pending && !token())) && (
        <button className="syncHint" onClick={() => setSettings(true)}>
          ⚠{" "}
          {s.error
            ? tError(s.error)
            : t("Google 連線已過期，修改尚未上傳。點這裡重新連線。")}
        </button>
      )}
      <BioPrompt onDone={setToast} />
      <nav className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={view === "bookmarks"}
          onClick={() => setView("bookmarks")}
        >
          {t("書籤")} <small>{entries.length}</small>
        </button>
        <button
          role="tab"
          aria-selected={view === "memos"}
          onClick={() => setView("memos")}
        >
          {t("記事本")} <small>{memos.length}</small>
        </button>
      </nav>
      <div className="search">
        <input
          type="search"
          aria-label={view === "bookmarks" ? t("搜尋書籤") : t("搜尋記事")}
          placeholder={
            view === "bookmarks"
              ? t("搜尋名稱、網址、標籤或備註")
              : t("搜尋記事…")
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {view === "bookmarks" ? (
        <>
          {(folders.length > 0 || hasUnfiled || hasPrivate) && (
            <div className="chips" role="toolbar" aria-label={t("資料夾")}>
              <button
                aria-pressed={folder === ALL}
                onClick={() => setFolder(ALL)}
              >
                {t("全部")}
              </button>
              {hasPrivate && (
                <button
                  className={showPrivate ? "privChip" : "privChip off"}
                  aria-pressed={showPrivate && folder === PRIVATE_FOLDER}
                  onClick={() =>
                    showPrivate
                      ? setFolder(PRIVATE_FOLDER)
                      : setAskPrivate(true)
                  }
                >
                  {t(PRIVATE_FOLDER)}
                </button>
              )}
              {[
                ...topFolders
                  .filter((f) => f !== PRIVATE_FOLDER)
                  .map((f) => [f, f]),
                ...(folders.length && hasUnfiled
                  ? [[UNFILED, t("未分類")]]
                  : []),
              ].map(([key, name]) => (
                <button
                  key={key}
                  aria-pressed={folder === key}
                  onClick={() => setFolder(key)}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          <main className="list">
            {groups.map((g) => (
              <section key={g.name ?? "*"}>
                {g.name !== null && folders.length > 0 && (
                  <h2 className="groupTitle">
                    {g.name
                      ? pathLabel(
                          g.name.replace(PRIVATE_FOLDER, t(PRIVATE_FOLDER)),
                        )
                      : t("未分類")}
                  </h2>
                )}
                <ul>
                  {g.items.map((x) => (
                    <BookmarkRow
                      key={x.id}
                      x={x}
                      onMore={() => setActions(x)}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {!shown.length && (
              <div className="empty">
                <p>
                  {q
                    ? t("沒有符合的書籤")
                    : folder === PRIVATE_FOLDER
                      ? t("無痕專用資料夾還是空的")
                      : t("還沒有私人書籤")}
                </p>
                <small>
                  {q
                    ? t("試試其他關鍵字")
                    : t("點右下角的 ＋ 收藏第一個網址。")}
                </small>
              </div>
            )}
          </main>
          <button
            className="fab"
            aria-label={t("新增書籤")}
            onClick={() =>
              setEditing({
                ...emptyDraft,
                folder: folder === ALL || folder === UNFILED ? "" : folder,
              })
            }
          >
            ＋
          </button>
        </>
      ) : (
        <main className="list">
          <div className="importRow">
            <button
              className="secondary"
              disabled={importing}
              onClick={() => importInput.current?.click()}
            >
              {importing ? t("匯入中…") : t("匯入檔案")}
            </button>
            <small>{t("支援 .txt、.md、.html、.docx")}</small>
            <input
              ref={importInput}
              type="file"
              accept={IMPORT_ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                void importFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          {importError && (
            <p className="error importError" role="alert">
              {importError}
            </p>
          )}
          {memoGroups.map((g) => (
            <section key={g.name ?? "*"}>
              {g.name !== null && memoFolders.length > 0 && (
                <h2 className="groupTitle">
                  {g.name ? pathLabel(g.name) : t("未分類")}
                </h2>
              )}
              <ul>
                {g.items.map((m) => {
                  const text = memoText(m).trim();
                  return (
                    <li key={m.id} className="row memo">
                      <button className="rowMain" onClick={() => setReading(m)}>
                        <span className="rowIcon">✎</span>
                        <span className="rowText">
                          <strong>{memoTitle(m)}</strong>
                          <small>
                            {new Date(m.updated).toLocaleDateString(lang())}
                            {text &&
                              ` · ${text.replace(/\s+/g, " ").slice(0, 80)}`}
                          </small>
                        </span>
                      </button>
                      <button
                        className="more"
                        aria-label={t("更多操作：{title}", {
                          title: memoTitle(m),
                        })}
                        onClick={() => setMemoActions(m)}
                      >
                        ⋯
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {!memoShown.length && (
            <div className="empty">
              <p>{q ? t("沒有符合的記事") : t("還沒有加密記事")}</p>
              <small>
                {q ? t("試試其他關鍵字") : t("點右下角的 ＋ 寫下第一則記事。")}
              </small>
            </div>
          )}
          <button
            className="fab"
            aria-label={t("新增記事")}
            onClick={() => setWriting({ memo: null })}
          >
            ＋
          </button>
        </main>
      )}
      {editing && (
        <Editor
          draft={editing}
          folders={folders}
          known={entries.map((x) => x.tags)}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setToast(msg);
          }}
        />
      )}
      {actions && (
        <Sheet title={actions.title} onClose={() => setActions(null)}>
          <ActionList
            x={actions}
            onEdit={() => {
              setEditing({
                id: actions.id,
                title: actions.title,
                url: actions.url,
                folder: actions.folder,
                tags: actions.tags.join(", "),
                notes: actions.notes,
              });
              setActions(null);
            }}
            onDone={(msg) => {
              setActions(null);
              if (msg) setToast(msg);
            }}
          />
        </Sheet>
      )}
      {reading && (
        <Reader
          memo={reading}
          onClose={() => setReading(null)}
          onEdit={() => {
            setWriting({ memo: reading });
            setReading(null);
          }}
        />
      )}
      {memoActions && (
        <Sheet
          title={memoTitle(memoActions)}
          onClose={() => setMemoActions(null)}
        >
          <MemoActionList
            m={memoActions}
            onRead={() => {
              setReading(memoActions);
              setMemoActions(null);
            }}
            onEdit={() => {
              setWriting({ memo: memoActions });
              setMemoActions(null);
            }}
            onDone={(msg) => {
              setMemoActions(null);
              if (msg) setToast(msg);
            }}
          />
        </Sheet>
      )}
      {writing && (
        <MemoEditor
          memo={writing.memo}
          folders={memoFolders}
          onClose={(msg) => {
            setWriting(null);
            if (msg) setToast(msg);
          }}
        />
      )}
      {askPrivate && (
        <Sheet
          title={t("開啟無痕專用資料夾？")}
          onClose={() => setAskPrivate(false)}
        >
          <p className="privNote">
            {t(
              "手機版無法支援完整的無痕功能：網頁無法用無痕模式開啟書籤，也無法得知自己是否在無痕分頁。開啟後會在這支手機上列出這個資料夾的書籤，點開時用一般模式；上鎖或關閉 App 後會再次隱藏。",
            )}
          </p>
          <div className="privButtons">
            <button className="secondary" onClick={() => setAskPrivate(false)}>
              {t("取消")}
            </button>
            <button
              className="primary"
              onClick={() => {
                setAskPrivate(false);
                setShowPrivate(true);
                setFolder(PRIVATE_FOLDER);
              }}
            >
              {t("開啟")}
            </button>
          </div>
        </Sheet>
      )}
      {settings && (
        <Settings
          onClose={() => setSettings(false)}
          onLang={onLang}
          onCleared={onCleared}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {t(toast)}
        </div>
      )}
      {sharedToast && !toast && (
        <div className="toast sharedToast" role="status">
          <span>{sharedToast.text}</span>
          {sharedToast.entry && (
            <button
              type="button"
              onClick={() => {
                const x = sharedToast.entry!;
                setSharedToast(null);
                setEditing({
                  id: x.id,
                  title: x.title,
                  url: x.url,
                  folder: x.folder,
                  tags: x.tags.join(", "),
                  notes: x.notes,
                });
              }}
            >
              {t("補填資料")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BookmarkRow({ x, onMore }: { x: Entry; onMore: () => void }) {
  const memo = x.notes.trim();
  return (
    <li className="row">
      <a
        className="rowMain"
        href={x.url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
      >
        <span className="rowIcon">
          {(x.title.trim()[0] || "·").toUpperCase()}
        </span>
        <span className="rowText">
          <strong>{x.title}</strong>
          <small>{host(x.url)}</small>
          {(x.tags.length > 0 || memo) && (
            <span className="rowMeta">
              {x.tags.map((tag) => (
                <span className="tag" key={tag}>
                  #{tag}
                </span>
              ))}
              {memo && <span className="memoText">{memo}</span>}
            </span>
          )}
        </span>
      </a>
      <button
        className="more"
        aria-label={t("更多操作：{title}", { title: x.title })}
        onClick={onMore}
      >
        ⋯
      </button>
    </li>
  );
}

function ActionList({
  x,
  onEdit,
  onDone,
}: {
  x: Entry;
  onEdit: () => void;
  onDone: (msg?: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="actions">
      <a
        className="action"
        href={x.url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        onClick={() => onDone()}
      >
        {t("開啟網頁 ↗")}
      </a>
      <button className="action" onClick={onEdit}>
        {t("編輯")}
      </button>
      <button
        className="action"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(x.url);
            onDone("已複製網址");
          } catch {
            onDone("無法複製，請長按網址手動複製");
          }
        }}
      >
        {t("複製網址")}
      </button>
      {confirm ? (
        <button
          className="action danger"
          onClick={async () => {
            try {
              await removeEntry(x.id);
              onDone("已刪除書籤");
            } catch (e) {
              onDone(tError((e as Error).message));
            }
          }}
        >
          {t("確定刪除？會同步到所有裝置")}
        </button>
      ) : (
        <button className="action dangerText" onClick={() => setConfirm(true)}>
          {t("刪除")}
        </button>
      )}
    </div>
  );
}

// Same actions and the same two-step delete as a bookmark's ⋯ sheet.
function MemoActionList({
  m,
  onRead,
  onEdit,
  onDone,
}: {
  m: Memo;
  onRead: () => void;
  onEdit: () => void;
  onDone: (msg?: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="actions">
      <button className="action" onClick={onRead}>
        {t("閱讀")}
      </button>
      <button className="action" onClick={onEdit}>
        {t("編輯")}
      </button>
      {confirm ? (
        <button
          className="action danger"
          onClick={async () => {
            try {
              await removeMemo(m.id);
              onDone("已刪除記事");
            } catch (e) {
              onDone(tError((e as Error).message));
            }
          }}
        >
          {t("確定刪除？會同步到所有裝置")}
        </button>
      ) : (
        <button className="action dangerText" onClick={() => setConfirm(true)}>
          {t("刪除")}
        </button>
      )}
    </div>
  );
}

function Editor({
  draft,
  folders,
  known,
  onClose,
  onSaved,
}: {
  draft: Draft;
  folders: string[];
  known: string[][];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [d, setD] = useState(draft);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      title={d.id ? t("編輯書籤") : t("留下一個好去處")}
      onClose={onClose}
      tall
    >
      <form
        className="editor"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const title = d.title.trim() || (await lookupBookmarkTitle(d.url));
            if (!alive.current) return;
            await saveEntry({ ...d, title });
            onSaved(d.id ? "已更新書籤" : "已加密收藏");
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error && (
          <p className="error" role="alert">
            {tError(error)}
          </p>
        )}
        <label>
          {t("名稱")}
          <input
            placeholder={t("留空會自動取得網頁名稱，失敗時使用網域")}
            disabled={busy}
            maxLength={300}
            value={d.title}
            onChange={(e) => setD({ ...d, title: e.target.value })}
          />
        </label>
        <label>
          {t("網址")}
          <input
            required
            type="url"
            inputMode="url"
            autoCapitalize="off"
            placeholder="https://"
            value={d.url}
            disabled={busy}
            onChange={(e) => setD({ ...d, url: e.target.value })}
          />
        </label>
        <label>
          {t("資料夾")}
          <input
            list="webFolders"
            maxLength={100}
            value={d.folder}
            onChange={(e) => setD({ ...d, folder: e.target.value })}
          />
          <datalist id="webFolders">
            {folders.map((f) => (
              <option key={f} value={f} label={pathLabel(f)} />
            ))}
          </datalist>
        </label>
        <TagInput
          label={t("標籤")}
          value={d.tags}
          known={known}
          onChange={(tags) => setD({ ...d, tags })}
        />
        <label>
          {t("私密備註")}
          <textarea
            rows={3}
            maxLength={5000}
            value={d.notes}
            onChange={(e) => setD({ ...d, notes: e.target.value })}
          />
        </label>
        <button className="primary full" disabled={busy}>
          {busy ? t("儲存中…") : t("加密儲存 →")}
        </button>
      </form>
    </Sheet>
  );
}

/** Shows notebook pictures (stored encrypted beside the memo) in place. */
function showImages(el: HTMLElement, images: Map<string, MemoImage>) {
  for (const img of Array.from(
    el.querySelectorAll<HTMLImageElement>("img[data-veil-img]"),
  )) {
    const i = images.get(img.dataset.veilImg || "");
    if (i) img.src = imageSrc(i);
    else img.remove();
  }
}

function Reader({
  memo,
  onClose,
  onEdit,
}: {
  memo: Memo;
  onClose: () => void;
  onEdit: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  // Markdown / Mermaid preview of the note's text.
  const [md, setMd] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    if (md) {
      el.innerHTML = markdownPreview(htmlText(memoHtml(memo)));
      void drawDiagrams(el);
      return;
    }
    el.innerHTML = memoHtml(memo);
    showImages(el, new Map((memo.images || []).map((i) => [i.id, i])));
    // Links in notes open outside the app without a referrer.
    for (const a of Array.from(el.querySelectorAll("a"))) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }, [memo, md]);
  const strokes = cleanDrawing(memo.drawing);
  const voices = cleanRecordings(memo.recordings);
  const area = useRef<HTMLDivElement>(null);
  const inkHeight = useInkHeight(
    area,
    strokes,
    !md && (strokes.length > 0 || voices.length > 0),
  );
  return (
    <div
      className="reader"
      role="dialog"
      aria-modal="true"
      aria-label={memoTitle(memo)}
    >
      <header className="readerBar">
        <button className="ghost" onClick={onClose}>
          {t("← 返回")}
        </button>
        <span>{new Date(memo.updated).toLocaleString(lang())}</span>
        <button
          className={md ? "ghost mdToggle on" : "ghost mdToggle"}
          aria-pressed={md}
          aria-label={t("Markdown 預覽")}
          onClick={() => setMd(!md)}
        >
          MD
        </button>
        <button className="ghost strong" onClick={onEdit}>
          {t("編輯")}
        </button>
      </header>
      <article
        className="paper"
        style={{ background: memo.paperColor || DEFAULT_PAPER }}
      >
        <h1>{memoTitle(memo)}</h1>
        <div className="inkArea" ref={area} style={{ minHeight: inkHeight }}>
          <div className={md ? "memoBody mdPreview" : "memoBody"} ref={body} />
          {!md && (
            <DrawingLayer
              strokes={strokes}
              mode="text"
              color=""
              width={0}
              onChange={() => {}}
            />
          )}
          {!md && (
            <div className="nbAudioLayer">
              {voices.map((r) => (
                <VoicePlayer key={r.id} recording={r} />
              ))}
            </div>
          )}
        </div>
      </article>
    </div>
  );
}

/** Room for handwriting and voice notes: the paper is at least 70% of the
 *  screen tall when a note has them (or while drawing), and tall enough for
 *  the lowest stroke (strokes use a 794-unit wide page). */
function useInkHeight(
  area: React.RefObject<HTMLDivElement | null>,
  strokes: DrawingStroke[],
  needed: boolean,
) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const o = new ResizeObserver(() => setWidth(el.offsetWidth));
    o.observe(el);
    return () => o.disconnect();
  }, []);
  if (!needed || !width) return undefined;
  const lowest = strokes.reduce(
    (m, s) => s.points.reduce((n, p) => Math.max(n, p[1] + s.width), m),
    0,
  );
  return Math.max(innerHeight * 0.7, (lowest * width) / 794 + 24);
}

/** A voice note in the reader: plays where it was placed. */
function VoicePlayer({ recording: r }: { recording: MemoRecording }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    const u = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [r.data, r.mime]);
  return (
    <div
      className="nbAudioSticker"
      style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%` }}
    >
      <div className="nbAudioHandle readOnly">
        {t("錄音")} · {Math.floor(r.duration / 60)}:
        {String(Math.floor(r.duration % 60)).padStart(2, "0")}
      </div>
      <audio controls src={url} preload="metadata" aria-label={t("播放錄音")} />
    </div>
  );
}

// Pen colours and width (in the 794-unit page space the extension uses).
const INK_COLORS = ["#30372d", "#c0392b", "#2463b5", "#2e8b57"];
const INK_WIDTH = 5;

// The phone's notebook: text styles, lists, quotes, highlight, pictures,
// handwriting and voice notes. Fonts, alignment and page layout stay on the
// computer.
const TOOLS: {
  cmd: string;
  label: string;
  icon: React.ReactNode;
  value?: string;
}[] = [
  { cmd: "bold", label: "粗體", icon: <b>B</b> },
  { cmd: "italic", label: "斜體", icon: <i>I</i> },
  { cmd: "underline", label: "底線", icon: <u>U</u> },
  { cmd: "strikeThrough", label: "刪除線", icon: <s>S</s> },
  { cmd: "heading", label: "標題 2", icon: <b>H</b> },
  { cmd: "insertUnorderedList", label: "項目符號", icon: "•≡" },
  { cmd: "insertOrderedList", label: "編號", icon: "1." },
  { cmd: "quote", label: "引言", icon: "❝" },
  {
    cmd: "hiliteColor",
    label: "螢光筆",
    icon: <mark>A</mark>,
    value: "#fff176",
  },
  { cmd: "removeFormat", label: "清除格式設定", icon: "⌫" },
  { cmd: "image", label: "插入圖片", icon: "🖼" },
  { cmd: "undo", label: "復原", icon: "↶" },
  { cmd: "redo", label: "取消復原", icon: "↷" },
];

function MemoEditor({
  memo,
  folders,
  onClose,
}: {
  memo: Memo | null;
  folders: string[];
  onClose: (msg?: string) => void;
}) {
  const [title, setTitle] = useState(memo?.title || "");
  const [paper, setPaper] = useState(
    /^#[0-9a-f]{6}$/i.test(memo?.paperColor || "")
      ? memo!.paperColor!
      : DEFAULT_PAPER,
  );
  const [folder, setFolder] = useState(memo?.folder || "");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">(
    "saved",
  );
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [keyboard, setKeyboard] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const id = useRef(memo?.id || "");
  const images = useRef(new Map((memo?.images || []).map((i) => [i.id, i])));
  const dirty = useRef(false);
  const range = useRef<Range | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const latest = useRef({ title, paper, folder });
  latest.current = { title, paper, folder };
  // Handwriting and voice notes, in the extension's formats (a 794-unit page
  // and page-relative sticker positions), saved with the note.
  const [mode, setMode] = useState<"text" | "pen" | "eraser">("text");
  const [penColor, setPenColor] = useState(INK_COLORS[0]);
  const [strokes, setStrokes] = useState<DrawingStroke[]>(() =>
    cleanDrawing(memo?.drawing),
  );
  const [voices, setVoices] = useState<MemoRecording[]>(() =>
    cleanRecordings(memo?.recordings),
  );
  const [recording, setRecording] = useState(false);
  const ink = useRef(strokes);
  ink.current = strokes;
  const audio = useRef(voices);
  audio.current = voices;
  const area = useRef<HTMLDivElement>(null);
  const inkHeight = useInkHeight(
    area,
    strokes,
    mode !== "text" || strokes.length > 0 || voices.length > 0,
  );
  function drawChanged(next: DrawingStroke[]) {
    setStrokes(next);
    ink.current = next;
    changed();
  }
  function voicesChanged(next: MemoRecording[]) {
    setVoices(next);
    audio.current = next;
    changed();
  }

  useLayoutEffect(() => {
    const el = body.current!;
    el.innerHTML = memo ? memoHtml(memo) : "";
    showImages(el, images.current);
    document.execCommand("defaultParagraphSeparator", false, "p");
  }, []);

  // Keep the toolbar above the on-screen keyboard; remember the caret so
  // toolbar taps and the photo picker insert where the user was typing.
  useEffect(() => {
    const vv = window.visualViewport;
    const place = () =>
      vv && setKeyboard(Math.max(0, innerHeight - vv.height - vv.offsetTop));
    const selection = () => {
      const sel = getSelection();
      const el = body.current;
      if (!sel?.rangeCount || !el) return;
      const r = sel.getRangeAt(0);
      if (!el.contains(r.commonAncestorContainer)) return;
      range.current = r.cloneRange();
      const q = (c: string) => {
        try {
          return document.queryCommandState(c);
        } catch {
          return false;
        }
      };
      const block = String(document.queryCommandValue("formatBlock") || "")
        .replace(/[<>]/g, "")
        .toLowerCase();
      setActive({
        bold: q("bold"),
        italic: q("italic"),
        underline: q("underline"),
        strikeThrough: q("strikeThrough"),
        insertUnorderedList: q("insertUnorderedList"),
        insertOrderedList: q("insertOrderedList"),
        heading: /^h[1-3]$/.test(block),
        quote: block === "blockquote",
      });
    };
    const hidden = () => document.hidden && void save();
    vv?.addEventListener("resize", place);
    vv?.addEventListener("scroll", place);
    document.addEventListener("selectionchange", selection);
    document.addEventListener("visibilitychange", hidden);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    place();
    return () => {
      vv?.removeEventListener("resize", place);
      vv?.removeEventListener("scroll", place);
      document.removeEventListener("selectionchange", selection);
      document.removeEventListener("visibilitychange", hidden);
      document.body.style.overflow = prev;
      clearTimeout(timer.current);
    };
  }, []);

  function changed() {
    dirty.current = true;
    setSaveState("dirty");
    setFailed(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 1000);
  }

  // One save at a time; the first one gives a new memo its permanent ID.
  function save(): Promise<boolean> {
    clearTimeout(timer.current);
    chain.current = chain.current.then(async () => {
      const el = body.current;
      if (!dirty.current || !el) return true;
      dirty.current = false;
      const html = sanitizeHtml(el.innerHTML);
      const used = imageIds(html).filter((x) => images.current.has(x));
      const now = latest.current;
      if (
        !id.current &&
        !now.title.trim() &&
        !htmlToText(html) &&
        !used.length &&
        !ink.current.length &&
        !audio.current.length
      ) {
        setSaveState("saved");
        return true; // An untouched new memo is not kept.
      }
      setSaveState("saving");
      try {
        const m = await saveMemo({
          id: id.current || undefined,
          title: now.title,
          body: html,
          format: "html",
          paperColor: now.paper,
          folder: now.folder,
          images: used.map((x) => images.current.get(x)!),
          drawing: ink.current,
          recordings: audio.current,
        });
        id.current = m.id;
        setSaveState(dirty.current ? "dirty" : "saved");
        setError("");
        return true;
      } catch (e) {
        dirty.current = true;
        setSaveState("dirty");
        setError((e as Error).message);
        return false;
      }
    });
    return chain.current;
  }

  async function back() {
    if (failed) return onClose(); // Second tap: leave without saving.
    const isNew = !id.current;
    if (await save()) onClose(isNew && id.current ? "已加密收藏記事" : "");
    else setFailed(true);
  }

  function restore() {
    const el = body.current!;
    el.focus({ preventScroll: true });
    const sel = getSelection();
    if (
      range.current &&
      sel &&
      el.contains(range.current.commonAncestorContainer)
    ) {
      sel.removeAllRanges();
      sel.addRange(range.current);
    }
  }

  function exec(cmd: string, value?: string) {
    if (cmd === "image") return picker.current?.click();
    restore();
    if (cmd === "heading" || cmd === "quote") {
      const tag = cmd === "heading" ? "h2" : "blockquote";
      const now = String(document.queryCommandValue("formatBlock") || "")
        .replace(/[<>]/g, "")
        .toLowerCase();
      const on = cmd === "heading" ? /^h[1-3]$/.test(now) : now === tag;
      document.execCommand("formatBlock", false, on ? "p" : tag);
    } else {
      document.execCommand(
        "styleWithCSS",
        false,
        String(cmd === "hiliteColor"),
      );
      document.execCommand(cmd, false, value);
    }
    changed();
    document.dispatchEvent(new Event("selectionchange"));
  }

  async function addImages(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    for (const f of Array.from(files).slice(0, 10)) {
      try {
        const i = await importImage(f);
        images.current.set(i.id, i);
        restore();
        const el = body.current!;
        const sel = getSelection()!;
        let r = sel.rangeCount ? sel.getRangeAt(0) : null;
        if (!r || !el.contains(r.commonAncestorContainer)) {
          r = document.createRange();
          r.selectNodeContents(el);
          r.collapse(false);
        }
        const img = document.createElement("img");
        img.setAttribute("data-veil-img", i.id);
        img.alt = "";
        img.src = imageSrc(i);
        r.deleteContents();
        r.insertNode(img);
        r.setStartAfter(img);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        range.current = r.cloneRange();
        changed();
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }

  return (
    <div
      className="reader memoEdit"
      role="dialog"
      aria-modal="true"
      aria-label={memo ? t("編輯記事") : t("新增記事")}
    >
      <header className="readerBar">
        <button className="ghost" onClick={() => void back()}>
          {failed ? t("放棄修改並返回") : t("← 完成")}
        </button>
        <span role="status">
          {saveState === "saving"
            ? t("儲存中…")
            : saveState === "dirty"
              ? t("尚未儲存")
              : id.current
                ? t("已加密儲存")
                : ""}
        </span>
        <button
          className="ghost"
          aria-label={t("記事選項")}
          onClick={() => setMore(true)}
        >
          ⋯
        </button>
      </header>
      {error && (
        <p className="error editError" role="alert">
          {tError(error)}
        </p>
      )}
      <article className="paper editPaper" style={{ background: paper }}>
        <input
          className="memoTitle"
          aria-label={t("標題")}
          placeholder={t("標題")}
          maxLength={300}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            latest.current.title = e.target.value;
            changed();
          }}
        />
        <div
          className="inkArea"
          ref={area}
          style={{ minHeight: inkHeight }}
        >
        <div
          ref={body}
          className={"memoBody editable" + (mode === "text" ? "" : " drawing")}
          contentEditable={mode === "text"}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={t("記事內容")}
          data-placeholder={t("開始寫下你的想法…")}
          onInput={changed}
          onPaste={(e) => {
            // Plain text only: pasted pages could carry remote pictures.
            e.preventDefault();
            document.execCommand(
              "insertText",
              false,
              e.clipboardData.getData("text/plain"),
            );
          }}
        />
          <DrawingLayer
            strokes={strokes}
            mode={mode}
            color={penColor}
            width={INK_WIDTH}
            onChange={drawChanged}
          />
          <div className="nbAudioLayer">
            {voices.map((r) => (
              <AudioSticker
                key={r.id}
                recording={r}
                onMove={(x, y) =>
                  voicesChanged(
                    audio.current.map((a) => (a.id === r.id ? { ...a, x, y } : a)),
                  )
                }
                onDelete={() =>
                  voicesChanged(audio.current.filter((a) => a.id !== r.id))
                }
              />
            ))}
          </div>
        </div>
      </article>
      <div
        className="tools"
        role="toolbar"
        aria-label={t("格式工具列")}
        style={{ bottom: keyboard }}
      >
        {recording || voices.length < 5 ? (
          <div className="inkRecorder">
            <Recorder
              disabled={false}
              onBusy={setRecording}
              onRecorded={(r) => {
                // Placed at the left of what is on screen; drag to move.
                const box = area.current?.getBoundingClientRect();
                const y = box
                  ? Math.max(0, Math.min(0.9, (innerHeight * 0.3 - box.top) / box.height))
                  : 0.1;
                voicesChanged([...audio.current, { ...r, x: 0.04, y }]);
              }}
            />
          </div>
        ) : null}
        <button
          type="button"
          aria-label={t("手寫")}
          title={t("手寫")}
          aria-pressed={mode === "pen"}
          onClick={() => setMode(mode === "pen" ? "text" : "pen")}
        >
          ✎
        </button>
        <button
          type="button"
          aria-label={t("橡皮擦")}
          title={t("橡皮擦")}
          aria-pressed={mode === "eraser"}
          onClick={() => setMode(mode === "eraser" ? "text" : "eraser")}
        >
          ⌫̸
        </button>
        {mode !== "text" && (
          <>
            {INK_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="inkSwatch"
                aria-label={t("筆色") + " " + c}
                aria-pressed={penColor === c}
                onClick={() => {
                  setPenColor(c);
                  setMode("pen");
                }}
              >
                <span style={{ background: c }} />
              </button>
            ))}
            <button
              type="button"
              aria-label={t("復原最後一筆")}
              title={t("復原最後一筆")}
              disabled={!strokes.length}
              onClick={() => drawChanged(ink.current.slice(0, -1))}
            >
              ↺
            </button>
            <button
              type="button"
              aria-label={t("回到文字")}
              title={t("回到文字")}
              onClick={() => setMode("text")}
            >
              T
            </button>
          </>
        )}
        {mode === "text" && TOOLS.map((x) => (
          <button
            key={x.cmd}
            type="button"
            aria-label={t(x.label)}
            title={t(x.label)}
            aria-pressed={x.cmd in active ? !!active[x.cmd] : undefined}
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => exec(x.cmd, x.value)}
          >
            {x.icon}
          </button>
        ))}
      </div>
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void addImages(e.target.files);
          e.target.value = "";
        }}
      />
      {more && (
        <Sheet title={t("記事選項")} onClose={() => setMore(false)}>
          <section className="settings">
            <h3>{t("資料夾")}</h3>
            <select
              aria-label={t("資料夾")}
              value={folder}
              onChange={(e) => {
                setFolder(e.target.value);
                latest.current.folder = e.target.value;
                changed();
              }}
            >
              <option value="">{t("未分類")}</option>
              {[...new Set([...folders, ...(folder ? [folder] : [])])].map(
                (f) => (
                  <option key={f} value={f}>
                    {"\u00a0\u00a0".repeat(depthOf(f)) + baseName(f)}
                  </option>
                ),
              )}
            </select>
            <h3>{t("紙張顏色")}</h3>
            <div className="swatches">
              {PAPER_COLORS.map((c) => (
                <button
                  key={c}
                  aria-label={c}
                  aria-pressed={paper === c}
                  style={{ background: c }}
                  onClick={() => {
                    setPaper(c);
                    latest.current.paper = c;
                    changed();
                  }}
                />
              ))}
            </div>
            <h3>{t("刪除")}</h3>
            {confirmDelete ? (
              <button
                className="danger full"
                onClick={async () => {
                  clearTimeout(timer.current);
                  dirty.current = false;
                  await chain.current;
                  if (id.current) await removeMemo(id.current);
                  onClose(id.current ? "已刪除記事" : "");
                }}
              >
                {t("確定刪除？會同步到所有裝置")}
              </button>
            ) : (
              <button
                className="secondary full dangerText"
                onClick={() => setConfirmDelete(true)}
              >
                {t("刪除記事")}
              </button>
            )}
          </section>
        </Sheet>
      )}
    </div>
  );
}

function Settings({
  onClose,
  onLang,
  onCleared,
}: {
  onClose: () => void;
  onLang: (l: Lang) => void;
  onCleared: () => void;
}) {
  const { s } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const signedIn = !!token();
  return (
    <Sheet title={t("同步與設定")} onClose={onClose} tall>
      <section className="settings">
        <h3>Google Drive</h3>
        <p className="small">
          {s.syncing
            ? t("同步中…")
            : s.lastSync
              ? t("上次同步：{time}", {
                  time: new Date(s.lastSync).toLocaleString(lang()),
                })
              : signedIn
                ? t("尚未同步")
                : t("尚未連接 Google，只顯示這支手機上次同步的資料。")}
        </p>
        {s.pending && !s.syncing && (
          <p className="note">{t("有修改尚未上傳到 Google Drive。")}</p>
        )}
        {(s.error || error) && (
          <p className="error" role="alert">
            {tError(s.error || error)}
          </p>
        )}
        <div className="buttons">
          {signedIn ? (
            <button
              className="primary"
              disabled={busy || s.syncing}
              onClick={() => void syncNow()}
            >
              {t("立即同步")}
            </button>
          ) : null}
          <button
            className={signedIn ? "secondary" : "primary"}
            disabled={busy}
            onClick={() => window.dispatchEvent(new Event("veil-connect"))}
          >
            <GoogleMark />{" "}
            {signedIn ? t("重新連線 Google") : t("使用 Google 帳號連接 Drive")}
          </button>
        </div>
        <p className="small muted">
          {t(
            "只使用 Google Drive 的隱藏應用程式資料夾，存放加密後的資料；不會讀取你的其他檔案。",
          )}
        </p>
        <BiometricSettings />
        <h3>{t("語言")}</h3>
        <select
          aria-label={t("語言")}
          value={lang()}
          onChange={(e) => onLang(e.target.value as Lang)}
        >
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <h3>{t("這支手機")}</h3>
        <p className="small muted">
          {t(
            "這支手機保留一份加密副本，沒有網路時也能開啟。清除後不影響電腦與 Google Drive 上的資料。",
          )}
        </p>
        {confirmClear ? (
          <button
            className="danger full"
            onClick={async () => {
              // Remove everything first, then show the locked screen.
              await removeWorkspace();
              sessionStorage.removeItem("veilActiveAccount");
              location.reload();
              lock();
              onCleared();
            }}
          >
            {t("確定清除並登出？")}
          </button>
        ) : (
          <button
            className="secondary full"
            onClick={() => setConfirmClear(true)}
          >
            {t("移除此帳戶的本機資料並登出")}
          </button>
        )}
        <Credits />
      </section>
    </Sheet>
  );
}

function Sheet({
  title,
  onClose,
  tall,
  children,
}: {
  title: string;
  onClose: () => void;
  tall?: boolean;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      removeEventListener("keydown", esc);
      document.body.style.overflow = prev;
    };
  }, []);
  return (
    <div
      className="scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className={tall ? "sheet tall" : "sheet"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="sheetHead">
          <h2>{title}</h2>
          <button className="ghost" aria-label={t("關閉")} onClick={onClose}>
            ×
          </button>
        </div>
        <div className="sheetBody">{children}</div>
      </section>
    </div>
  );
}

function Credits() {
  return (
    <footer className="credits">
      Veil Bookmark {VERSION} · {t("手機版")}
      <br />
      Made by{" "}
      <a
        href="https://github.com/RyanXuwei"
        target="_blank"
        rel="noopener noreferrer"
      >
        Ryan Hsu
      </a>{" "}
      · BitingBox Studio ·{" "}
      <a href="../privacy.html" target="_blank" rel="noopener noreferrer">
        {t("隱私權政策")}
      </a>{" "}
      ·{" "}
      <a href={GITHUB} target="_blank" rel="noopener noreferrer">
        GitHub
      </a>
      <div>
        <BobaSupport />
      </div>
    </footer>
  );
}

/** Offers Face ID / fingerprint unlock on the main screen, right after the
 *  vault is opened with the master password, until it is turned on or the
 *  user says "not now" (it stays available under Sync & settings). */
function BioPrompt({ onDone }: { onDone: (msg: string) => void }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void (async () => {
      let later = false;
      try {
        later = !!localStorage.getItem("veilBioLater");
      } catch {}
      if (!later && (await bio.available()) && (await bio.status()) === "off")
        setShow(true);
    })();
  }, []);
  if (!show) return null;
  return (
    <section className="bioPrompt" aria-label={t("生物辨識解鎖")}>
      <FingerprintIcon />
      <div>
        <strong>{t("下次用 Face ID／指紋解鎖")}</strong>
        <p>{t("不必每次輸入主密碼。主密碼不會被儲存。")}</p>
        {error && (
          <p className="error" role="alert">
            {tError(error)}
          </p>
        )}
        <div className="bioPromptButtons">
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              // WebAuthn must start directly from this tap.
              setBusy(true);
              setError("");
              try {
                await enableBiometric();
                setShow(false);
                onDone(
                  "已啟用生物辨識解鎖。下次可以直接用 Face ID／指紋打開。",
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("立即啟用")}
          </button>
          <button
            className="ghost"
            onClick={() => {
              try {
                localStorage.setItem("veilBioLater", "1");
              } catch {}
              setShow(false);
              onDone("之後可以在「同步與設定」啟用生物辨識解鎖。");
            }}
          >
            {t("以後再說")}
          </button>
        </div>
      </div>
    </section>
  );
}

function BiometricSettings() {
  const [state, setState] = useState<bio.BioStatus | "unavailable" | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const refresh = async () =>
    setState((await bio.available()) ? await bio.status() : "unavailable");
  useEffect(() => {
    void refresh();
  }, []);
  if (!state) return null;
  return (
    <>
      <h3>{t("生物辨識解鎖")}</h3>
      {state === "unavailable" ? (
        <p className="small muted">
          {t("這支手機或瀏覽器不支援以 Face ID／指紋解鎖，請繼續使用主密碼。")}
        </p>
      ) : (
        <>
          <p className="small muted">
            {t(
              "用 Face ID 或指紋代替輸入主密碼。主密碼不會被儲存；能解鎖這支手機的人也能打開保險庫。每 30 天需要輸入一次主密碼。",
            )}
          </p>
          {error && (
            <p className="error" role="alert">
              {tError(error)}
            </p>
          )}
          {done && (
            <p className="note" role="status">
              {t(done)}
            </p>
          )}
          {state === "off" ? (
            <button
              className="secondary full"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                setDone("");
                try {
                  await enableBiometric();
                  setDone(
                    "已啟用生物辨識解鎖。下次可以直接用 Face ID／指紋打開。",
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                  void refresh();
                }
              }}
            >
              <FingerprintIcon /> {t("啟用 Face ID／指紋解鎖")}
            </button>
          ) : (
            <>
              <p className="status ok">
                ●{" "}
                {state === "on"
                  ? t("已啟用")
                  : t("已啟用（需要輸入一次主密碼）")}
              </p>
              <button
                className="secondary full"
                onClick={async () => {
                  await bio.disable();
                  setDone(
                    "已停用生物辨識解鎖。可在手機的密碼設定中刪除「Veil Bookmark」通行金鑰。",
                  );
                  void refresh();
                }}
              >
                {t("停用生物辨識解鎖")}
              </button>
            </>
          )}
        </>
      )}
    </>
  );
}

function FingerprintIcon() {
  return (
    <svg
      className="gmark"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6.5 6.2A8 8 0 0 1 20 12v1.5" />
      <path d="M4 11.5A8 8 0 0 1 5 8" />
      <path d="M8 12a4 4 0 0 1 8 0v2.5a10 10 0 0 1-1.2 4.8" />
      <path d="M12 12v3a13 13 0 0 1-2 7" />
      <path d="M4.5 15.5a14 14 0 0 0 .5-3" />
      <path d="M7.7 19.5A13 13 0 0 0 9 14" />
      <path d="M17.6 20.5c.6-1.7 1.4-4 1.4-7" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg className="gmark" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.3 5.7c4.3-3.9 7-9.8 7-17.1z"
      />
      <path
        fill="#FBBC05"
        d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.9-6.1z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.7 2.3-8.6 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}

// ---- Start -----------------------------------------------------------------
async function boot() {
  if (window.top !== window.self) {
    // Never run inside another site's frame.
    document.body.textContent = "";
  } else {
    initLang();
    let returned: Awaited<ReturnType<typeof handleReturn>> = "";
    let startError = "";
    try {
      returned = await handleReturn();
      if (returned !== "popup") await migrateAccount();
    } catch (e) {
      startError = (e as Error).message;
    }
    const root = createRoot(document.getElementById("root")!);
    if (
      returned !== "popup" &&
      desktopChrome() &&
      !new URLSearchParams(location.search).has("desktop")
    ) {
      // In Chrome on a computer the extension is the full product.
      location.replace(STORE);
    } else if (returned === "popup")
      root.render(
        <main className="unlock">
          <section className="welcomeCard">
            <h1>{t("已連接 Google")}</h1>
            <p className="muted">
              {t("可以關閉這個分頁，回到 Veil Bookmark。")}
            </p>
          </section>
        </main>,
      );
    else {
      const got = await readShare();
      root.render(
        <AppWithError
          shared={got.link && { ...emptyDraft, ...got.link }}
          note={got.note}
          initial={
            startError ||
            (got.lost ? "分享的內容沒有收到，請再分享一次。" : "")
          }
        />,
      );
    }
    if ("serviceWorker" in navigator && window.isSecureContext)
      navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  function AppWithError({
    shared,
    note,
    initial,
  }: {
    shared: Draft | null;
    note: SharedNote | null;
    initial: string;
  }) {
    const [shown, setShown] = useState(initial);
    return (
      <>
        {shown && (
          <div className="topError" role="alert" onClick={() => setShown("")}>
            {tError(shown)}
          </div>
        )}
        <App shared={shared} note={note} />
      </>
    );
  }
}
void boot();
