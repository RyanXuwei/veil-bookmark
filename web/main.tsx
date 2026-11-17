import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import type { Entry, Memo } from "../src/crypto";
import {
  LANGS,
  detect,
  lang,
  setLang,
  t,
  tError,
  type Lang,
} from "../src/i18n";
import { memoTitle } from "../src/memos";
import { imageSrc } from "../src/ruled";
import { memoHtml, memoText } from "../src/sanitize";
import { folderNames, ordered } from "../src/sortable";
import { TagInput } from "../src/tag-input";
import {
  configured,
  forgetToken,
  handleReturn,
  loadConfig,
  signInPopup,
  signInRedirect,
  token,
} from "./google";
import {
  clearCache,
  hasCache,
  lock,
  removeEntry,
  saveEntry,
  subscribe,
  syncNow,
  syncState,
  unlock,
  vault,
  enableBiometric,
  unlockBiometric,
} from "./vault";
import * as bio from "./biometric";
import "./app.css";

const VERSION = "1.2.0";
const GITHUB = "https://github.com/RyanXuwei/veil-bookmark";
const IDLE_LOCK = 15 * 60 * 1000;
const HIDDEN_LOCK = 5 * 60 * 1000;
const ALL = "\u0000all";
const UNFILED = "\u0000unfiled";

// Language: saved choice on this phone, otherwise the browser's.
function initLang() {
  let saved = "";
  try {
    saved = localStorage.getItem("veilLang") || "";
  } catch {}
  setLang(
    LANGS.some((x) => x.code === saved)
      ? (saved as Lang)
      : detect(navigator.language),
  );
}

// A link shared to the app (Android "Share" → Veil Bookmark).
function sharedLink() {
  const p = new URLSearchParams(location.search);
  const text = p.get("text") || "";
  const url = p.get("url") || text.match(/https?:\/\/\S+/)?.[0] || "";
  if (!url) return null;
  history.replaceState(null, "", location.pathname);
  return { title: p.get("title") || "", url };
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

function App({ shared }: { shared: Draft | null }) {
  const { v, s } = useStore();
  const [ready, setReady] = useState(false);
  const [cache, setCache] = useState(false);
  const [error, setError] = useState("");
  const [, setLangTick] = useState(0);
  const [pendingShare, setPendingShare] = useState(shared);
  useEffect(() => {
    void (async () => {
      await loadConfig();
      setCache(await hasCache());
      setReady(true);
    })();
  }, []);
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
    for (const e of ["pointerdown", "keydown", "scroll"])
      addEventListener(e, active, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      for (const e of ["pointerdown", "keydown", "scroll"])
        removeEventListener(e, active);
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
  return v ? (
    <Library
      shared={pendingShare}
      clearShared={() => setPendingShare(null)}
      onLang={relang}
      onCleared={() => setCache(false)}
    />
  ) : (
    <Unlock
      cache={cache}
      error={error}
      setError={setError}
      shared={!!pendingShare}
      syncError={s.error}
    />
  );
}

// ---- Locked ----------------------------------------------------------------
function Unlock({
  cache,
  error,
  setError,
  shared,
}: {
  cache: boolean;
  error: string;
  setError: (e: string) => void;
  shared: boolean;
  syncError: string;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [bioState, setBioState] = useState<bio.BioStatus>("off");
  const signedIn = !!token();
  const canOpen = signedIn || cache;
  useEffect(() => {
    void bio.status().then(setBioState);
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
      </header>
      <section className="welcomeCard">
        <p className="eyebrow">PRIVATE BY DESIGN</p>
        <h1>{canOpen ? t("歡迎回來") : t("在手機上開啟你的書籤")}</h1>
        <p className="muted">
          {canOpen
            ? t("輸入主密碼，打開你的收藏。")
            : t(
                "連接你在電腦上同步書籤的 Google 帳號，再輸入主密碼。資料只在這支手機上解密。",
              )}
        </p>
        {shared && (
          <p className="note">{t("解鎖後即可收藏分享過來的網頁。")}</p>
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
  onLang,
  onCleared,
}: {
  shared: Draft | null;
  clearShared: () => void;
  onLang: (l: Lang) => void;
  onCleared: () => void;
}) {
  const { v, s } = useStore();
  const [view, setView] = useState<"bookmarks" | "memos">("bookmarks");
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState(ALL);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [actions, setActions] = useState<Entry | null>(null);
  const [reading, setReading] = useState<Memo | null>(null);
  const [settings, setSettings] = useState(false);
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (shared) {
      setEditing({ ...emptyDraft, ...shared });
      clearShared();
    }
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 2400);
    return () => clearTimeout(id);
  }, [toast]);
  if (!v) return null;
  const entries = v.entries.filter((x) => !x.deleted);
  const memos = v.memos.filter((x) => !x.deleted);
  const q = query.trim().toLowerCase();
  const folders = folderNames("entry", v.folders, entries);
  const hasUnfiled = entries.some((x) => !x.folder);
  const shown = ordered(
    entries.filter(
      (x) =>
        (folder === ALL ||
          (folder === UNFILED ? !x.folder : x.folder === folder)) &&
        (!q ||
          `${x.title} ${x.url} ${x.tags.join(" ")} ${x.notes}`
            .toLowerCase()
            .includes(q)),
    ),
    (a, b) => b.updated - a.updated,
  );
  // "All": grouped by folder in the extension's order.
  const groups =
    folder === ALL && !q
      ? [
          ...folders.map((f) => ({
            name: f,
            items: shown.filter((x) => x.folder === f),
          })),
          { name: "", items: shown.filter((x) => !x.folder) },
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
          {(folders.length > 0 || hasUnfiled) && (
            <div className="chips" role="toolbar" aria-label={t("資料夾")}>
              {[
                [ALL, t("全部")],
                ...folders.map((f) => [f, f]),
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
                  <h2 className="groupTitle">{g.name || t("未分類")}</h2>
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
                <p>{q ? t("沒有符合的書籤") : t("還沒有私人書籤")}</p>
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
          {memoGroups.map((g) => (
            <section key={g.name ?? "*"}>
              {g.name !== null && memoFolders.length > 0 && (
                <h2 className="groupTitle">{g.name || t("未分類")}</h2>
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
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {!memoShown.length && (
            <div className="empty">
              <p>{q ? t("沒有符合的記事") : t("還沒有加密記事")}</p>
              <small>{t("記事請在電腦的筆記本中撰寫；手機版可以閱讀。")}</small>
            </div>
          )}
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
      {reading && <Reader memo={reading} onClose={() => setReading(null)} />}
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
            await removeEntry(x.id);
            onDone("已刪除書籤");
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
            await saveEntry(d);
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
            required
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
              <option key={f} value={f} />
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

function Reader({ memo, onClose }: { memo: Memo; onClose: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    el.innerHTML = memoHtml(memo);
    const images = new Map((memo.images || []).map((i) => [i.id, i]));
    for (const img of Array.from(
      el.querySelectorAll<HTMLImageElement>("img[data-veil-img]"),
    )) {
      const i = images.get(img.dataset.veilImg || "");
      if (i) img.src = imageSrc(i);
      else img.remove();
    }
    // Links in notes open outside the app without a referrer.
    for (const a of Array.from(el.querySelectorAll("a"))) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }, [memo]);
  const extras = (memo.recordings?.length || 0) + (memo.drawing?.length || 0);
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
      </header>
      <article className="paper">
        <h1>{memoTitle(memo)}</h1>
        {extras > 0 && (
          <p className="note">
            {t("這則記事含有錄音或手繪，請在電腦的筆記本中檢視。")}
          </p>
        )}
        <div className="memoBody" ref={body} />
      </article>
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
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await signInPopup();
                await syncNow();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
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
              forgetToken();
              await clearCache();
              await bio.disable();
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
            {t("清除這支手機上的資料並登出")}
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
    </footer>
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
if (window.top !== window.self) {
  // Never run inside another site's frame.
  document.body.textContent = "";
} else {
  initLang();
  let returned: ReturnType<typeof handleReturn> = "";
  let startError = "";
  try {
    returned = handleReturn();
  } catch (e) {
    startError = (e as Error).message;
  }
  const root = createRoot(document.getElementById("root")!);
  if (returned === "popup")
    root.render(
      <main className="unlock">
        <section className="welcomeCard">
          <h1>{t("已連接 Google")}</h1>
          <p className="muted">{t("可以關閉這個分頁，回到 Veil Bookmark。")}</p>
        </section>
      </main>,
    );
  else {
    const shared = sharedLink();
    root.render(
      <AppWithError
        shared={shared && { ...emptyDraft, ...shared }}
        initial={startError}
      />,
    );
  }
  if ("serviceWorker" in navigator && location.protocol === "https:")
    navigator.serviceWorker.register("./sw.js").catch(() => {});
}
function AppWithError({
  shared,
  initial,
}: {
  shared: Draft | null;
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
      <App shared={shared} />
    </>
  );
}
