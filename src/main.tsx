import { FolderPlusIcon, FolderTree, folderNames, ordered } from "./sortable";
import { pathLabel, within } from "./folders";
import { ConfirmDelete, itemDeleteDetail } from "./confirm";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { DRIVE_FULL, STORAGE_URL } from "./drive";
import { TagInput } from "./tag-input";
import { VERSION } from "./version";
import { BobaSupport } from "./boba-support";
import { DriveConflict } from "./drive-conflict";
import { PasswordChangeSection } from "./password-change";
import { SetupPage } from "./setup";
import { Disclaimer } from "./disclaimer";
import { RecoverForm, RecoveryKeyModal, RecoverySection } from "./recovery";
import { MemoList } from "./memos";
import { NotebookPage } from "./notebook";
import type { Vault, Entry } from "./crypto";
import "./style.css";
import { LANGS, lang, loadLang, saveLang, t, tError, type Lang } from "./i18n";
const ALL = "__veil_all__";
// Production metadata (bitingbox-promotion). productionDate = first
// deliverable version (0.1.0), Asia/Taipei. Copyright holder confirmed by the
// user on 2026-11-15.
const CREDITS = {
  creator: "Ryan Hsu",
  studio: "BitingBox Studio",
  github: "https://github.com/RyanXuwei",
  privacy: "https://ryanxuwei.github.io/veil-bookmark/privacy.html",
  version: VERSION,
  productionDate: "2026-11-15",
  lastUpdatedDate: "2026-11-18",
  copyrightYear: "2026",
  copyrightHolder: "Ryan Hsu",
};
async function rpc(type: string, data: Record<string, unknown> = {}) {
  if (!globalThis.chrome?.runtime?.id)
    throw Error("請將 dist 載入 Chrome 擴充功能後使用");
  const source = await chrome.windows.getCurrent();
  const r = await chrome.runtime.sendMessage({
    type,
    sourceWindowId: source.id,
    // Only the notebook page needs note pictures, audio and drawings.
    lite: !isNotes,
    ...data,
  });
  if (!r?.ok) throw Error(r?.error || t("背景服務沒有回應"));
  return r.data;
}
const isPopup = new URLSearchParams(location.search).has("popup");
const isSetup = new URLSearchParams(location.search).has("setup");
const isNotes = new URLSearchParams(location.search).has("notes");
async function openNotebook(id = "") {
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`index.html?notes#${id || "new"}`),
  });
  if (isPopup) window.close();
}
async function openSetup() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("index.html?setup") });
  if (isPopup) window.close();
}
document.documentElement.dataset.surface = isNotes
  ? "notes"
  : isSetup
    ? "setup"
    : isPopup
      ? "popup"
      : "manager";
const empty = { id: "", title: "", url: "", folder: "", tags: "", notes: "" };
function App() {
  const [status, setStatus] = useState<any>(null),
    [vault, setVault] = useState<Vault | null>(null),
    [password, setPassword] = useState(""),
    [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [folder, setFolder] = useState(ALL),
    [editor, setEditor] = useState<typeof empty | null>(null),
    [panel, setPanel] = useState(""),
    [deleting, setDeleting] = useState<Entry | null>(null),
    [file, setFile] = useState<File | null>(null);
  const activity = useRef(0);
  const viewEpoch = useRef(0);
  const [uiLang, setUiLang] = useState<Lang>(lang());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [view, setView] = useState<"bookmarks" | "memos">("bookmarks");
  const [ack, setAck] = useState(false);
  const [recoveryShown, setRecoveryShown] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isPopup)
      document.documentElement.style.minHeight =
        editor ||
        deleting ||
        recoveryShown ||
        panel === "settings" ||
        panel === "security" ||
        panel === "mobile" ||
        panel === "about"
          ? "570px"
          : "";
  }, [editor, deleting, recoveryShown, panel]);
  async function refresh() {
    const requestEpoch = viewEpoch.current;
    const s = await rpc("STATUS");
    if (requestEpoch !== viewEpoch.current) return;
    const v = s.unlocked ? await rpc("LIST") : null;
    if (requestEpoch !== viewEpoch.current) return;
    setStatus(s);
    setVault(v);
    if (!s.unlocked) {
      setEditor(null);
      setQuery("");
      setFolder(ALL);
      setDeleting(null);
    }
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const timer = setInterval(
      () => refresh().catch((e) => setError(e.message)),
      10000,
    );
    const listener = (changes: any, area: string) => {
      if (area === "session" && changes.session && !changes.session.newValue) {
        viewEpoch.current++;
        setStatus((s: any) => (s ? { ...s, unlocked: false } : s));
        setRecoveryShown(null);
        setPanel("");
        setConfirmPassword("");
        setFile(null);
        setVault(null);
        setEditor(null);
        setQuery("");
        setDeleting(null);
        setMenuId(null);
        setPassword("");
        void refresh();
      } else if (
        area === "local" &&
        (changes.lastSync || changes.syncError || changes.driveConflict)
      )
        void refresh().catch(() => {});
    };
    chrome?.storage?.onChanged?.addListener(listener);
    return () => {
      clearInterval(timer);
      chrome?.storage?.onChanged?.removeListener(listener);
    };
  }, []);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      try {
        await refresh();
      } catch {}
    } finally {
      setBusy(false);
    }
  }
  // New installation: look for a vault in Google Drive so another computer's
  // data is restored instead of starting an unrelated local vault.
  const [driveProbe, setDriveProbe] = useState("");
  const probed = useRef(false);
  useEffect(() => {
    if (!status || status.exists || !status.configured || probed.current)
      return;
    probed.current = true;
    rpc("DRIVE_PROBE")
      .then((r) => {
        setDriveProbe(r.state);
        if (r.state === "found")
          setPanel((p: string) => (p === "" ? "drive" : p));
      })
      .catch(() => setDriveProbe("unknown"));
  }, [status]);
  async function checkDrive() {
    if (!status?.configured) return run(openSetup);
    await run(async () => {
      const r = await rpc("DRIVE_PROBE", { interactive: true });
      setDriveProbe(r.state);
      if (r.state === "found") {
        setPanel("drive");
        setError("");
      } else if (r.state === "empty")
        setNotice(
          "Google Drive 中沒有 Veil Bookmark 的備份，可以直接建立新的保險庫。",
        );
    });
  }
  const restoring = panel === "restore" || panel === "drive";
  async function auth(mode: string) {
    await run(async () => {
      const operationEpoch = viewEpoch.current;
      if (mode === "CREATE" && password !== confirmPassword)
        throw Error("兩次密碼不一致");
      if (mode === "CREATE" && !ack)
        throw Error("請先確認已了解主密碼無法救援");
      if (mode === "CREATE" && password.length < 4)
        throw Error("主密碼至少 4 個字元");
      let data: any = { password };
      if (mode === "RESTORE") {
        if (!file) throw Error("請選擇加密備份檔");
        if (file.size > 66_000_000) throw Error("備份檔過大");
        data.envelope = JSON.parse(await file.text());
      }
      if (operationEpoch !== viewEpoch.current) return;
      const r = await rpc(mode, data);
      if (operationEpoch !== viewEpoch.current) return;
      if (r?.recoveryKey) setRecoveryShown(r.recoveryKey);
      setPassword("");
      setConfirmPassword("");
      setPanel("");
      setFile(null);
      await refresh();
    });
  }
  async function recover(d: {
    recoveryKey: string;
    newPassword: string;
    confirm: string;
    file: File | null;
  }) {
    await run(async () => {
      const operationEpoch = viewEpoch.current;
      if (d.newPassword !== d.confirm) throw Error("兩次密碼不一致");
      const data: any = {
        recoveryKey: d.recoveryKey,
        newPassword: d.newPassword,
      };
      if (!status?.exists) {
        if (!d.file) throw Error("請選擇加密備份檔");
        if (d.file.size > 66_000_000) throw Error("備份檔過大");
        data.envelope = JSON.parse(await d.file.text());
      }
      if (operationEpoch !== viewEpoch.current) return;
      const r = await rpc("RECOVER", data);
      if (operationEpoch !== viewEpoch.current) return;
      setRecoveryShown(r.recoveryKey);
      setPanel("");
      await refresh();
    });
  }
  async function createRecovery(pw: string) {
    let ok = false;
    await run(async () => {
      const operationEpoch = viewEpoch.current;
      const r = await rpc("RECOVERY_CREATE", { password: pw });
      if (operationEpoch !== viewEpoch.current) return;
      setRecoveryShown(r.recoveryKey);
      await refresh();
      ok = true;
    });
    return ok;
  }
  function touch() {
    if (!vault || Date.now() - activity.current < 30000) return;
    activity.current = Date.now();
    void rpc("TOUCH").catch(() => refresh());
  }
  async function addCurrent() {
    await run(async () => {
      let capture: { title?: string; url?: string } | undefined;
      if (isPopup) {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        capture = tab;
      } else
        capture = (
          await chrome.storage.session.get<{
            capture?: { title: string; url: string };
          }>("capture")
        ).capture;
      if (!capture?.url || !/^https?:/.test(capture.url))
        throw Error(
          "請在想收藏的 HTTP / HTTPS 網頁上開啟工具列浮框，再按收藏目前網頁",
        );
      setEditor({
        ...empty,
        title: capture.title || capture.url,
        url: capture.url,
      });
      await chrome.storage.session.remove("capture");
    });
  }
  async function openBookmark(x: Entry, incognito = false, newTab = false) {
    await run(async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab) throw Error("目前沒有可開啟書籤的分頁");
      await rpc("OPEN", {
        id: x.id,
        incognito,
        targetTabId: !incognito && !newTab ? tab.id : undefined,
        sourceWindowId: tab.windowId,
      });
      if (isPopup) window.close();
    });
  }
  function hoverText(x: Entry) {
    const lines = [];
    if (x.tags.length) lines.push(x.tags.map((tag) => `#${tag}`).join("  "));
    const memo = x.notes.trim();
    if (memo) lines.push(memo.length > 600 ? `${memo.slice(0, 600)}…` : memo);
    return lines.length ? lines.join("\n") : x.url;
  }
  function popupRow(x: Entry) {
    return (
      <>
        <div className="quickRow">
          <button
            className="quickLink"
            title={hoverText(x)}
            disabled={busy}
            onClick={(e) => void openBookmark(x, false, e.ctrlKey || e.metaKey)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void openBookmark(x, false, true);
              }
            }}
          >
            <span className="quickIcon">▱</span>
            <span className="quickText">
              <strong>{x.title}</strong>
              <small>{new URL(x.url).hostname}</small>
            </span>
          </button>
          <button
            className="quickMore"
            aria-label={t("更多操作：{title}", { title: x.title })}
            aria-expanded={menuId === x.id}
            onClick={() => setMenuId(menuId === x.id ? null : x.id)}
          >
            ⋯
          </button>
        </div>
        {menuId === x.id && (
          <div className="quickActions">
            <button disabled={busy} onClick={() => void openBookmark(x, true)}>
              {t("無痕開啟")}
            </button>
            <button
              disabled={busy}
              onClick={() => void openBookmark(x, false, true)}
            >
              {status?.incognito ? t("無痕新分頁") : t("新分頁開啟")}
            </button>
            <button
              onClick={() => {
                setEditor({ ...x, tags: x.tags.join(", ") });
                setMenuId(null);
              }}
            >
              {t("編輯")}
            </button>
            <button
              onClick={() => {
                setDeleting(x);
                setMenuId(null);
              }}
            >
              {t("刪除")}
            </button>
          </div>
        )}
      </>
    );
  }
  // Folder and drag-and-drop operations (bookmarks and notes). The list
  // updates at once; the encrypted save follows, and a failure reloads it.
  function apply(type: string, data: Record<string, unknown>) {
    const epoch = viewEpoch.current;
    return run(async () => {
      const v = await rpc(type, data);
      if (epoch === viewEpoch.current && v && "entries" in v) setVault(v);
    });
  }
  type Kind = "entry" | "memo";
  const organize = {
    reorder: (kind: Kind, folder: string, ids: string[]) => {
      const pos = new Map(ids.map((id, i) => [id, i]));
      const move = <T extends { id: string; folder?: string; order?: number }>(
        list: T[],
      ) =>
        list.map((x) =>
          pos.has(x.id) ? { ...x, folder, order: pos.get(x.id) } : x,
        );
      setVault(
        (v: Vault | null) =>
          v &&
          (kind === "entry"
            ? { ...v, entries: move(v.entries) }
            : { ...v, memos: move(v.memos) }),
      );
      return apply("REORDER", { kind, folder, ids });
    },
    folderOrder: (kind: Kind, names: string[]) => {
      setVault((v: Vault | null) => {
        if (!v) return v;
        const rest = (v.folders || []).filter(
          (f) => f.kind !== kind || !names.includes(f.name),
        );
        const now = Date.now();
        return {
          ...v,
          folders: [
            ...rest,
            ...names.map((name, order) => ({
              id: `${kind}:${name}`,
              kind,
              name,
              order,
              updated: now,
              revision: "",
              deleted: false,
            })),
          ],
        };
      });
      return apply("FOLDER_ORDER", { kind, names });
    },
    create: async (kind: Kind, name: string) => {
      await apply("FOLDER_CREATE", { kind, name });
      setCreatingFolder(false);
    },
    rename: (kind: Kind, from: string, to: string) =>
      apply("FOLDER_RENAME", { kind, from, to }),
    move: (kind: Kind, from: string, to: string, order?: string[]) =>
      apply("FOLDER_RENAME", { kind, from, to, order }),
    remove: (kind: Kind, name: string) =>
      apply("FOLDER_DELETE", { kind, name }),
  };
  async function backup() {
    await run(async () => {
      const data = await rpc("EXPORT");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `Veil Bookmark-encrypted-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("已匯出加密備份，請妥善保留主密碼。");
    });
  }
  // Sync problems are listed in Sync & backup; the main screens show a short
  // hint when the user must act (conflict, Drive full) or sync has been
  // failing for over an hour, so it is not missed.
  const syncHint = !status?.unlocked
    ? ""
    : status.driveConflict
      ? "Google Drive 有另一個保險庫，請選擇要保留哪一份"
      : !status.driveEnabled || !status.syncError
        ? ""
        : status.syncError === DRIVE_FULL
          ? "Google Drive 空間已滿，同步已暫停"
          : !status.lastSync || Date.now() - status.lastSync > 3_600_000
            ? "已超過 1 小時未能同步到 Google Drive"
            : "";
  const syncHintButton = syncHint && (
    <button
      className="syncHint"
      role="status"
      onClick={() => setPanel("settings")}
    >
      ⚠ {t(syncHint)}
    </button>
  );
  const entries = vault?.entries.filter((x) => !x.deleted) || [];
  const folders = folderNames("entry", vault?.folders, entries);
  const byPosition = ordered(entries, (a, b) => a.title.localeCompare(b.title));
  const visible = entries
    .filter(
      (x) =>
        (folder === ALL || within(x.folder, folder)) &&
        `${x.title} ${x.url} ${x.tags.join(" ")} ${x.notes}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => b.updated - a.updated);
  const footer = (
    <footer>
      <span>
        Made by{" "}
        <a
          href={CREDITS.github}
          target="_blank"
          rel="noopener noreferrer"
          title={t("在 GitHub 查看 Ryan Hsu 的作品")}
        >
          Ryan Hsu ↗
        </a>{" "}
        · BitingBox Studio
      </span>
      <select
        className="langSelect"
        aria-label={t("介面語言")}
        value={uiLang}
        onChange={(e) => {
          const next = e.target.value as Lang;
          setUiLang(next);
          saveLang(next).catch(() => setError("語言設定儲存失敗，請重試"));
        }}
      >
        {LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
      <button className="text" onClick={() => setPanel("about")}>
        {isPopup ? t("關於") : t("關於 Veil Bookmark")}
      </button>
    </footer>
  );
  return (
    <div className="app" onPointerDown={touch} onKeyDown={touch}>
      <header>
        <a className="wordmark" href="#" onClick={(e) => e.preventDefault()}>
          <img className="productIcon" src="icons/32.png" alt="" />
          Veil Bookmark
        </a>
        <div className="headerRight">
          {status?.incognito && (
            <span className="privateBadge">{t("無痕")}</span>
          )}
          <span className="privacy">
            <i />{" "}
            {status?.incognito
              ? t("無痕視窗 · 加密保護")
              : t("一般視窗 · 加密保護")}
          </span>
          {vault && (
            <button
              onClick={() =>
                run(async () => {
                  await rpc("LOCK");
                  await refresh();
                })
              }
            >
              {isPopup ? t("上鎖") : t("立即上鎖 ↗")}
            </button>
          )}
        </div>
      </header>
      {error && (
        <div className="alert" role="alert">
          {tError(error)}
          <button
            className="text"
            onClick={() => setError("")}
            aria-label={t("關閉錯誤")}
          >
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {t(notice)}
        </div>
      )}
      {!status ? (
        <div className="privateGate">
          <p>{t("正在讀取…")}</p>
        </div>
      ) : !vault ? (
        <main className="welcome">
          <section className="intro">
            <div className="eyebrow">YOUR PRIVATE LITTLE CORNER</div>
            <h1>
              {t("值得收藏的，")}
              <br />
              {t("留給自己。")}
            </h1>
            <p>
              {t("靈感、計畫，或只想私藏的好去處。")}
              <br />
              {t("用一把只有你知道的鑰匙，好好收著。")}
            </p>
            <div className="seal">
              <span>◇</span>
              <div>
                <strong>{t("先加密，再儲存")}</strong>
                <small>{t("網址、標籤與筆記一起保護")}</small>
              </div>
            </div>
            <div className="orbit">
              <div className="vaultIcon">
                V<span>✦</span>
              </div>
              <span className="orbitLabel">A SPACE THAT'S ONLY YOURS</span>
            </div>
          </section>
          <section className="unlock card">
            <span className="eyebrow">PRIVATE BY DESIGN</span>
            <h2>
              {panel === "recover"
                ? t("用救援金鑰重設主密碼")
                : status?.exists
                  ? t("歡迎回來")
                  : panel === "drive"
                    ? t("在 Google Drive 找到你的保險庫")
                    : panel === "restore"
                      ? t("找回你的收藏")
                      : t("建立你的私密空間")}
            </h2>
            <p className="muted">
              {panel === "recover"
                ? status?.exists
                  ? t("輸入建立保險庫時取得的救援金鑰，並設定新的主密碼。")
                  : t("選擇加密備份檔，輸入救援金鑰，並設定新的主密碼。")
                : status?.exists
                  ? t("輸入主密碼，打開你的收藏。")
                  : panel === "drive"
                    ? t(
                        "看起來你在其他電腦用過 Veil Bookmark。輸入原本的主密碼，就能取回書籤與記事並繼續同步。",
                      )
                    : t(
                        "主密碼不會上傳。建立後會提供一組救援金鑰，請另外妥善保存。",
                      )}
            </p>
            {panel === "recover" ? (
              <RecoverForm
                needFile={!status?.exists}
                busy={busy}
                onSubmit={(d) => void recover(d)}
              />
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void auth(
                    status?.exists
                      ? "UNLOCK"
                      : panel === "drive"
                        ? "RESTORE_DRIVE"
                        : panel === "restore"
                          ? "RESTORE"
                          : "CREATE",
                  );
                }}
              >
                {!status?.exists && !restoring && driveProbe === "unknown" && (
                  <div className="driveCheck" role="note">
                    <span>
                      {t("已在其他電腦使用並開啟 Google Drive 同步？")}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void checkDrive()}
                    >
                      {t("檢查 Google Drive")}
                    </button>
                  </div>
                )}
                <label>
                  {t("主密碼")}
                  <input
                    ref={input}
                    autoFocus
                    type="password"
                    autoComplete={
                      status?.exists || restoring
                        ? "current-password"
                        : "new-password"
                    }
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={status?.exists || restoring ? 1 : 4}
                    required
                    placeholder={
                      status?.exists || restoring
                        ? t("輸入主密碼")
                        : t("至少 4 個字元")
                    }
                  />
                </label>
                {!status?.exists && !restoring && (
                  <label>
                    {t("再次輸入密碼")}
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                    />
                  </label>
                )}
                {!status?.exists && !restoring && (
                  <div className="pwWarning" role="note">
                    <strong>⚠ {t("請務必記住主密碼")}</strong>
                    <p>
                      {t(
                        "主密碼不會在任何地方備份。建立後會顯示一組救援金鑰，是忘記密碼時唯一的救援方式；主密碼與救援金鑰都遺失時，所有書籤與記事將永久無法開啟。",
                      )}
                    </p>
                    <label className="ackRow">
                      <input
                        type="checkbox"
                        checked={ack}
                        onChange={(e) => setAck(e.target.checked)}
                      />
                      <span>
                        {t(
                          "我了解主密碼與救援金鑰都遺失後無法救援，並會自行妥善保管。",
                        )}
                      </span>
                    </label>
                  </div>
                )}
                {panel === "restore" && !status?.exists && (
                  <label>
                    {t("加密備份檔")}
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                    />
                  </label>
                )}
                <button
                  className="primary full"
                  disabled={
                    busy || !status || (!status.exists && !restoring && !ack)
                  }
                >
                  {busy
                    ? t("處理中…")
                    : status?.exists
                      ? t("解鎖保險庫 →")
                      : panel === "drive"
                        ? t("從 Google Drive 還原 →")
                        : panel === "restore"
                          ? t("從檔案還原 →")
                          : t("建立保險庫 →")}
                </button>
              </form>
            )}
            {(status?.exists || panel === "recover") && (
              <div className="restore">
                <button
                  className="text"
                  onClick={() => {
                    setPanel(panel === "recover" ? "" : "recover");
                    setError("");
                  }}
                >
                  {panel === "recover"
                    ? t("← 返回")
                    : t("忘記主密碼？使用救援金鑰")}
                </button>
              </div>
            )}
            {!status?.exists && panel !== "recover" && (
              <div className="restore">
                {panel === "drive" ? (
                  <>
                    <button
                      className="text"
                      onClick={() => {
                        setPanel("");
                        setError("");
                      }}
                    >
                      {t("改為建立新的保險庫")}
                    </button>
                    <small className="muted">
                      {t(
                        "新的保險庫不會和 Drive 上的資料合併；之後連接 Drive 時需要選擇保留哪一份。",
                      )}
                    </small>
                  </>
                ) : (
                  <button
                    className="text"
                    onClick={() => {
                      setPanel(panel === "restore" ? "" : "restore");
                      setError("");
                    }}
                  >
                    {panel === "restore"
                      ? t("建立新的保險庫")
                      : t("已有備份？從加密檔案還原")}
                  </button>
                )}
                {panel === "restore" && (
                  <button
                    className="text"
                    onClick={() => {
                      setPanel("recover");
                      setError("");
                    }}
                  >
                    {t("忘記密碼？用救援金鑰從備份還原")}
                  </button>
                )}
                {panel === "drive" ? (
                  <button
                    className="text"
                    onClick={() => {
                      setPanel("restore");
                      setError("");
                    }}
                  >
                    {t("已有備份？從加密檔案還原")}
                  </button>
                ) : (
                  <button
                    className="text"
                    disabled={busy}
                    onClick={() => void checkDrive()}
                  >
                    {t("從 Google Drive 還原")}
                  </button>
                )}
              </div>
            )}
            <div className="lockNote">
              {t("◷ 閒置 15 分鐘或關閉所有 Chrome 視窗後上鎖")}
            </div>
          </section>
        </main>
      ) : isPopup ? (
        <main className="quickLibrary">
          <div className="viewTabs" role="tablist">
            <button
              role="tab"
              aria-selected={view === "bookmarks"}
              onClick={() => setView("bookmarks")}
            >
              {t("書籤")}
            </button>
            <button
              role="tab"
              aria-selected={view === "memos"}
              onClick={() => {
                setView("memos");
                setCreatingFolder(false);
              }}
            >
              {t("記事本")}
            </button>
          </div>
          {!status?.hasRecovery && (
            <button
              className="recoveryBanner"
              onClick={() => setPanel("security")}
            >
              ⚠ {t("尚未建立救援金鑰 · 立即建立")}
            </button>
          )}
          {view === "memos" ? (
            <MemoList
              memos={vault.memos || []}
              folderRecords={vault.folders}
              busy={busy}
              onOpen={(m) => void openNotebook(m.id)}
              onMeta={(id, meta) => void apply("MEMO_META", { id, ...meta })}
              onDelete={(id) => void apply("MEMO_DELETE", { id })}
              organize={organize}
            />
          ) : (
            <>
              <div className="quickSearch">
                <input
                  autoFocus
                  aria-label={t("搜尋書籤")}
                  placeholder={t("搜尋書籤…")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="quickTools">
                <button className="quickCapture" onClick={addCurrent}>
                  {t("＋ 收藏目前網頁")}
                </button>
                <button
                  title={t("手動新增網址")}
                  aria-label={t("手動新增書籤")}
                  onClick={() => setEditor({ ...empty })}
                >
                  {t("手動新增")}
                </button>
                <button
                  className="quickNewFolder"
                  title={t("新增資料夾")}
                  aria-label={t("新增資料夾")}
                  onClick={() => setCreatingFolder(true)}
                >
                  <FolderPlusIcon />
                </button>
              </div>
              <div className="quickList" aria-label={t("私人書籤清單")}>
                {query ? (
                  <>
                    <div className="quickCaption">
                      {t("搜尋結果 ·")} {visible.length}
                    </div>
                    <ul>
                      {visible.map((x) => (
                        <li className="quickItem" key={x.id}>
                          {popupRow(x)}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    <FolderTree
                      kind="entry"
                      folders={folders}
                      items={byPosition}
                      busy={busy}
                      renderItem={popupRow}
                      onReorder={(f, ids) =>
                        void organize.reorder("entry", f, ids)
                      }
                      onFolderOrder={(n) =>
                        void organize.folderOrder("entry", n)
                      }
                      onRenameFolder={(a, b) =>
                        void organize.rename("entry", a, b)
                      }
                      onDeleteFolder={(f) => void organize.remove("entry", f)}
                      onMoveFolder={(a, b, o) =>
                        void organize.move("entry", a, b, o)
                      }
                      creating={creatingFolder}
                      onCreate={(n) => void organize.create("entry", n)}
                      onCancelCreate={() => setCreatingFolder(false)}
                    />
                  </>
                )}
                {((!entries.length && !folders.length && !creatingFolder) ||
                  (query && !visible.length)) && (
                  <div className="quickEmpty">
                    <span>▱</span>
                    <p>{query ? t("沒有符合的書籤") : t("還沒有私人書籤")}</p>
                    <small>
                      {query
                        ? t("試試其他關鍵字")
                        : t("按上方「收藏目前網頁」開始收藏。")}
                    </small>
                  </div>
                )}
              </div>
            </>
          )}
          {syncHintButton}
          <div className="quickBottom">
            <span>
              {view === "memos"
                ? t("{count} 則加密記事", {
                    count: (vault.memos || []).filter((x) => !x.deleted).length,
                  })
                : t("{count} 個私人書籤", { count: entries.length })}
            </span>
            <span className="quickBottomActions">
              <button onClick={() => setPanel("security")}>
                {t("安全性")}
              </button>
              <button onClick={() => setPanel("settings")}>
                {t("同步與備份")}
              </button>
              <button onClick={() => setPanel("mobile")}>{t("手機版")}</button>
            </span>
          </div>
        </main>
      ) : null}
      {footer}
      {editor && (
        <div className="overlay">
          <section
            className="modal card"
            role="dialog"
            aria-modal="true"
            aria-label={t("書籤編輯")}
          >
            <div className="modalTitle">
              <h2>{editor.id ? t("編輯書籤") : t("留下一個好去處")}</h2>
              <button onClick={() => setEditor(null)} aria-label={t("關閉")}>
                ×
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await rpc("UPSERT", { entry: editor });
                  setEditor(null);
                  await refresh();
                });
              }}
            >
              <label>
                {t("名稱")}
                <input
                  autoFocus
                  required
                  maxLength={300}
                  value={editor.title}
                  onChange={(e) =>
                    setEditor({ ...editor, title: e.target.value })
                  }
                />
              </label>
              <label>
                {t("網址")}
                <input
                  type="url"
                  required
                  placeholder="https://"
                  value={editor.url}
                  onChange={(e) =>
                    setEditor({ ...editor, url: e.target.value })
                  }
                />
              </label>
              <div className="two">
                <label>
                  {t("資料夾")}
                  <input
                    list="folders"
                    maxLength={100}
                    value={editor.folder}
                    onChange={(e) =>
                      setEditor({ ...editor, folder: e.target.value })
                    }
                  />
                </label>
                <datalist id="folders">
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {pathLabel(f)}
                    </option>
                  ))}
                </datalist>
                <TagInput
                  label={t("標籤")}
                  value={editor.tags}
                  known={entries.map((x) => x.tags)}
                  onChange={(tags) => setEditor({ ...editor, tags })}
                />
              </div>
              <label>
                {t("私密備註")}
                <textarea
                  rows={3}
                  maxLength={5000}
                  value={editor.notes}
                  onChange={(e) =>
                    setEditor({ ...editor, notes: e.target.value })
                  }
                />
              </label>
              <button className="primary full" disabled={busy}>
                {busy ? t("儲存中…") : t("加密儲存 →")}
              </button>
            </form>
          </section>
        </div>
      )}
      {recoveryShown && (
        <RecoveryKeyModal
          code={recoveryShown}
          onDone={() => setRecoveryShown(null)}
        />
      )}
      {deleting && (
        <ConfirmDelete
          title={t("刪除「{title}」？", { title: deleting.title })}
          detail={itemDeleteDetail()}
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            run(async () => {
              await rpc("DELETE", { id: deleting.id });
              setDeleting(null);
              await refresh();
            })
          }
        />
      )}
      {(panel === "settings" ||
        panel === "security" ||
        panel === "mobile" ||
        panel === "about") && (
        <div className="overlay">
          <section
            className="modal card"
            role="dialog"
            aria-modal="true"
            aria-label={
              panel === "settings"
                ? t("同步與備份")
                : panel === "security"
                  ? t("安全性")
                  : panel === "mobile"
                    ? t("在手機上使用")
                    : t("關於 Veil Bookmark")
            }
          >
            <div className="modalTitle">
              <h2>
                {panel === "settings"
                  ? t("同步與備份")
                  : panel === "security"
                    ? t("安全性")
                    : panel === "mobile"
                      ? t("在手機上使用")
                      : t("關於 Veil Bookmark")}
              </h2>
              <button onClick={() => setPanel("")} aria-label={t("關閉")}>
                ×
              </button>
            </div>
            {panel === "settings" ? (
              <>
                {!status?.allowed && (
                  <>
                    <h3>{t("在無痕視窗使用")}</h3>
                    <p className="muted">
                      {t(
                        "前往擴充功能詳細資料，啟用「允許在無痕模式中執行」。一般視窗不需要這項授權。",
                      )}
                    </p>
                    <button
                      onClick={() =>
                        run(async () => {
                          await rpc("OPEN_SETTINGS");
                        })
                      }
                    >
                      {t("開啟擴充功能設定 ↗")}
                    </button>
                    <hr />
                  </>
                )}
                <h3>Google Drive</h3>
                <p className="muted">
                  {status?.oauthSource === "manifest"
                    ? t(
                        "一鍵連接：使用 Chrome 登入的 Google 帳號授權，加密快照存放在 Drive 的隱藏應用程式資料夾。",
                      )
                    : status?.configured
                      ? t("使用 Google Drive 隱藏應用程式資料夾同步加密快照。")
                      : t(
                          "尚未設定 Google Drive。依說明頁完成一次設定即可啟用。",
                        )}
                </p>
                <p className="small">
                  {status?.driveEnabled
                    ? t(
                        "自動同步已啟用：解鎖時立即同步，修改後隨即上傳，並每 5 分鐘檢查一次。",
                      )
                    : t("目前僅儲存在這台電腦。")}
                  <br />
                  {status?.lastSync &&
                    t("上次同步：{time}", {
                      time: new Date(status.lastSync).toLocaleString(lang()),
                    })}
                </p>
                {status?.driveConflict ? (
                  <DriveConflict
                    rpc={rpc}
                    onDone={async (message) => {
                      await refresh();
                      setNotice(message);
                    }}
                  />
                ) : (
                  status?.syncError && (
                    <p className="inlineError">
                      {tError(status.syncError)}
                      {status.syncError === DRIVE_FULL && (
                        <>
                          {" "}
                          <a
                            href={STORAGE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {t("管理 Google 儲存空間 ↗")}
                          </a>
                        </>
                      )}
                    </p>
                  )
                )}
                <div className="row">
                  {!status?.configured ? (
                    <button className="primary" onClick={() => run(openSetup)}>
                      {t("開啟設定說明 ↗")}
                    </button>
                  ) : (
                    <button className="text" onClick={() => run(openSetup)}>
                      {status?.oauthSource === "manifest"
                        ? t("連接說明")
                        : t("Drive 設定")}
                    </button>
                  )}
                  {!status?.driveConflict && (
                    <button
                      disabled={busy || !status?.configured}
                      onClick={() =>
                        run(async () => {
                          let synced = true;
                          try {
                            await rpc("SYNC");
                          } catch (e) {
                            // A different vault in Drive: the choices appear
                            // in this panel instead of an error banner.
                            if (!(await rpc("STATUS")).driveConflict) throw e;
                            synced = false;
                          }
                          await refresh();
                          if (synced) setNotice("已合併並同步加密收藏。");
                        })
                      }
                    >
                      {busy
                        ? t("處理中…")
                        : status?.driveEnabled
                          ? t("立即同步")
                          : t("連接 Google Drive")}
                    </button>
                  )}
                  {(status?.driveEnabled || status?.driveConflict) && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await rpc("DISCONNECT");
                          await refresh();
                        })
                      }
                    >
                      {t("中斷連線")}
                    </button>
                  )}
                </div>
                <hr />
                <h3>{t("加密備份")}</h3>
                <p className="muted">
                  {t(
                    "備份檔仍需要主密碼才能還原。新裝置請先還原同一個保險庫，再開啟同步。",
                  )}
                </p>
                <button onClick={backup} disabled={busy}>
                  {t("匯出加密備份 ↓")}
                </button>
                <hr />
                <p className="small muted">
                  {t(
                    "書籤在目前視窗模式開啟；一般模式可能留下瀏覽紀錄。加密收藏會保留在本機。遺失主密碼無法復原。同步採逐筆最後更新優先，裝置時間需正確。",
                  )}
                </p>
              </>
            ) : panel === "mobile" ? (
              <MobileSection
                driveOn={!!status?.driveEnabled}
                onDrive={() => setPanel("settings")}
              />
            ) : panel === "security" ? (
              <>
                <PasswordChangeSection rpc={rpc} />
                <hr />
                <RecoverySection
                  hasRecovery={!!status?.hasRecovery}
                  busy={busy}
                  onCreate={createRecovery}
                />
                <hr />
                <Disclaimer />
              </>
            ) : (
              // Same layout as the studio's other extensions (YuanYuan
              // Cursor Pet): studio logo, product, credit line, details.
              <section className="about" aria-label={t("關於")}>
                <img
                  className="studioLogo"
                  src="brand/BITINGBOX_no_square_border.svg"
                  alt="BitingBox Studio"
                  width="128"
                  height="139"
                />
                <p className="product">Veil Bookmark</p>
                <p className="credit">Made by Ryan Hsu · BitingBox Studio</p>
                <dl className="credits">
                  <dt>{t("製作者")}</dt>
                  <dd>{CREDITS.creator}</dd>
                  <dt>{t("工作室")}</dt>
                  <dd>{CREDITS.studio}</dd>
                  <dt>{t("程式製作年份")}</dt>
                  <dd>{CREDITS.productionDate.slice(0, 4)}</dd>
                  <dt>{t("程式製作日期")}</dt>
                  <dd>
                    <time dateTime={CREDITS.productionDate}>
                      {CREDITS.productionDate}
                    </time>
                  </dd>
                  <dt>{t("版本")}</dt>
                  <dd>{CREDITS.version}</dd>
                  <dt>{t("最後更新日期")}</dt>
                  <dd>
                    <time dateTime={CREDITS.lastUpdatedDate}>
                      {CREDITS.lastUpdatedDate}
                    </time>
                  </dd>
                </dl>
                <a
                  className="github"
                  href={CREDITS.github}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("在 GitHub 查看 Ryan Hsu 的作品")}
                </a>
                <a
                  className="policy"
                  href={CREDITS.privacy}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("隱私權政策")}
                </a>
                <BobaSupport />
                <p className="copyright">
                  © {CREDITS.copyrightYear} {CREDITS.copyrightHolder}. All
                  rights reserved.
                </p>
              </section>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
// The old full-page bookmark view is gone; an extension tab without a
// known page opens the notebook instead.
if (!isPopup && !isNotes && !isSetup) location.replace("index.html?notes");
else
  void loadLang().then(() =>
    createRoot(document.getElementById("root")!).render(
      isNotes ? (
        <NotebookPage rpc={rpc} />
      ) : isSetup ? (
        <SetupPage rpc={rpc} />
      ) : isPopup ? (
        <App />
      ) : null,
    ),
  );
import "./popup.css";

const MOBILE_URL = "https://veil-bookmark.bitingbox.win/";
/** QR code that opens the mobile web app on a phone. */
function MobileSection({
  driveOn,
  onDrive,
}: {
  driveOn: boolean;
  onDrive: () => void;
}) {
  return (
    <div className="mobileQr">
      <p className="muted">
        {t(
          "用手機相機掃描，開啟 Veil Bookmark 手機版：可以瀏覽、搜尋、收藏書籤，閱讀與撰寫記事，並支援 Face ID／指紋解鎖。",
        )}
      </p>
      <img src="mobile-qr.svg" alt={t("手機版網址的 QR code")} />
      <a href={MOBILE_URL} target="_blank" rel="noopener noreferrer">
        {MOBILE_URL.replace("https://", "")}
      </a>
      {driveOn ? (
        <p className="small muted">
          {t("在手機上連接同一個 Google 帳號，再輸入主密碼即可開啟。")}
        </p>
      ) : (
        <p className="small note">
          {t(
            "手機版透過 Google Drive 讀取資料，請先在「同步與備份」連接 Google Drive。",
          )}{" "}
          <button className="linkButton" onClick={onDrive}>
            {t("前往同步與備份")}
          </button>
        </p>
      )}
    </div>
  );
}
