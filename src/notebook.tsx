import React, { useCallback, useEffect, useRef, useState } from "react";
import "./notebook.css";
import type { Memo } from "./crypto";
import { LANGS, lang, saveLang, t, tError, type Lang } from "./i18n";
import {
  countWords,
  htmlToText,
  memoHtml,
  memoText,
  sanitizeHtml,
} from "./sanitize";

type Rpc = (type: string, data?: Record<string, unknown>) => Promise<any>;
type Tab = "home" | "insert" | "view";
const PAGE_HEIGHT = 1123; // A4 at 96 dpi
const STYLES: [string, string][] = [
  ["P", "內文"],
  ["H1", "標題 1"],
  ["H2", "標題 2"],
  ["H3", "標題 3"],
  ["BLOCKQUOTE", "引文"],
  ["PRE", "程式碼"],
];

function titleOf(m: Memo) {
  return (
    m.title ||
    memoText(m).split("\n").find(Boolean)?.slice(0, 60) ||
    t("未命名記事")
  );
}

export function NotebookPage({ rpc }: { rpc: Rpc }) {
  const [status, setStatus] = useState<any>(null);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [current, setCurrent] = useState<string>("");
  const [title, setTitle] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">(
    "saved",
  );
  const [savedAt, setSavedAt] = useState<number>(0);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("home");
  const [zoom, setZoom] = useState(100);
  const [navOpen, setNavOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [uiLang, setUiLang] = useState<Lang>(lang());
  const [counts, setCounts] = useState({ words: 0, chars: 0, pages: 1 });
  const [active, setActive] = useState<Record<string, boolean>>({});
  const [block, setBlock] = useState("P");
  const editor = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(0);
  const state = useRef({ current: "", title: "", dirty: false });
  const lastTouch = useRef(0);
  // Document to show once the editor is mounted (undefined = nothing pending).
  const pending = useRef<Memo | null | undefined>(undefined);
  const pick = (list: Memo[] | null) => {
    const id = location.hash.slice(1);
    pending.current =
      (list || []).find((m) => m.id === id && !m.deleted) || null;
  };
  state.current.current = current;
  state.current.title = title;

  const unlocked = !!status?.unlocked;

  const refresh = useCallback(async () => {
    const s = await rpc("STATUS");
    setStatus(s);
    if (!s.unlocked) return null;
    const v = await rpc("LIST");
    setMemos(v.memos || []);
    return v.memos as Memo[];
  }, [rpc]);

  function updateCounts() {
    const el = editor.current;
    if (!el) return;
    const c = countWords(el.innerText || "");
    // Content height plus the 1-inch top/bottom margins; ignore sub-pixel
    // rounding so a document that exactly fills one page stays at one page.
    const contentHeight = el.scrollHeight + 192;
    const pages = Math.max(1, Math.ceil((contentHeight - 2) / PAGE_HEIGHT));
    setCounts({ ...c, pages });
  }

  function load(m: Memo | null) {
    const el = editor.current;
    if (!el) return;
    el.innerHTML = m ? memoHtml(m) : "<p><br></p>";
    setCurrent(m?.id || "");
    setTitle(m?.title || "");
    state.current.dirty = false;
    setSaveState("saved");
    history.replaceState(null, "", `#${m?.id || "new"}`);
    updateCounts();
    el.focus({ preventScroll: true });
  }

  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    const el = editor.current;
    if (!el || !state.current.dirty) return;
    const body = sanitizeHtml(el.innerHTML);
    const titleNow = state.current.title;
    if (!titleNow.trim() && !htmlToText(body)) return; // nothing to keep yet
    state.current.dirty = false;
    setSaveState("saving");
    try {
      const memo = await rpc("MEMO_UPSERT", {
        memo: {
          id: state.current.current,
          title: titleNow,
          body,
          format: "html",
        },
      });
      if (!state.current.current) {
        setCurrent(memo.id);
        state.current.current = memo.id;
        history.replaceState(null, "", `#${memo.id}`);
      }
      setMemos((list) => [...list.filter((x) => x.id !== memo.id), memo]);
      setSavedAt(Date.now());
      setSaveState(state.current.dirty ? "dirty" : "saved");
      setError("");
    } catch (e) {
      state.current.dirty = true;
      setSaveState("dirty");
      setError((e as Error).message);
      void refresh().catch(() => {});
    }
  }, [rpc, refresh]);

  function changed() {
    state.current.dirty = true;
    setSaveState("dirty");
    updateCounts();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 1200);
    if (Date.now() - lastTouch.current > 30000) {
      lastTouch.current = Date.now();
      void rpc("TOUCH").catch(() => refresh());
    }
  }

  // Initial load + react to locking from anywhere.
  useEffect(() => {
    document.execCommand("defaultParagraphSeparator", false, "p");
    refresh()
      .then((list) => list && pick(list))
      .catch((e) => setError(e.message));
    const onStorage = (changes: any, area: string) => {
      if (area === "session" && changes.session && !changes.session.newValue) {
        // Locked: wipe decrypted content from the page immediately.
        window.clearTimeout(timer.current);
        if (editor.current) editor.current.innerHTML = "";
        setMemos([]);
        setTitle("");
        setCurrent("");
        void refresh();
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (state.current.dirty) {
        void save();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    const onSel = () => refreshActive();
    document.addEventListener("selectionchange", onSel);
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("selectionchange", onSel);
    };
  }, []);

  useEffect(() => {
    if (unlocked && editor.current && pending.current !== undefined) {
      const m = pending.current;
      pending.current = undefined;
      load(m);
    }
  }, [unlocked, memos]);

  function refreshActive() {
    const sel = document.getSelection();
    if (!sel?.anchorNode || !editor.current?.contains(sel.anchorNode)) return;
    const q = (c: string) => document.queryCommandState(c);
    setActive({
      bold: q("bold"),
      italic: q("italic"),
      underline: q("underline"),
      strikeThrough: q("strikeThrough"),
      insertUnorderedList: q("insertUnorderedList"),
      insertOrderedList: q("insertOrderedList"),
      justifyLeft: q("justifyLeft"),
      justifyCenter: q("justifyCenter"),
      justifyRight: q("justifyRight"),
      justifyFull: q("justifyFull"),
    });
    const b = String(document.queryCommandValue("formatBlock") || "p")
      .replace(/[<>]/g, "")
      .toUpperCase();
    setBlock(STYLES.some(([tag]) => tag === b) ? b : "P");
  }
  function exec(cmd: string, value?: string) {
    editor.current?.focus({ preventScroll: true });
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(cmd, false, value);
    refreshActive();
    changed();
  }

  async function open(m: Memo | null) {
    await save();
    load(m);
  }

  async function remove() {
    if (!current) {
      load(null);
      return;
    }
    if (!confirm(t("刪除這份記事？內容會立即清除，無法復原。"))) return;
    window.clearTimeout(timer.current);
    state.current.dirty = false;
    try {
      await rpc("MEMO_DELETE", { id: current });
      const list = await refresh();
      load(
        (list || [])
          .filter((m) => !m.deleted)
          .sort((a, b) => b.updated - a.updated)[0] || null,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function insertLink() {
    const url = prompt(t("輸入連結網址（https://）"), "https://");
    if (!url) return;
    if (!/^(https?:|mailto:)/i.test(url.trim())) {
      setError("僅接受不含帳密的 HTTP / HTTPS 網址");
      return;
    }
    exec("createLink", url.trim());
  }

  const live = memos
    .filter((m) => !m.deleted)
    .sort((a, b) => b.updated - a.updated);
  const shown = live.filter((m) =>
    `${m.title} ${memoText(m)}`.toLowerCase().includes(query.toLowerCase()),
  );

  const Btn = ({
    cmd,
    label,
    icon,
    value,
    onClick,
  }: {
    cmd?: string;
    label: string;
    icon: React.ReactNode;
    value?: string;
    onClick?: () => void;
  }) => (
    <button
      type="button"
      className={"rb" + (cmd && active[cmd] ? " on" : "")}
      title={t(label)}
      aria-label={t(label)}
      aria-pressed={cmd && cmd in active ? !!active[cmd] : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick || (() => exec(cmd!, value))}
    >
      {icon}
    </button>
  );

  if (!status) return <div className="nbLoading">{t("正在讀取…")}</div>;

  if (!unlocked)
    return (
      <div className="nbLocked">
        <form
          className="nbLockCard"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            rpc("UNLOCK", { password })
              .then(async () => {
                const v = await rpc("LIST");
                pick(v.memos || []);
                setPassword("");
                await refresh();
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <img src="icons/128.png" alt="" width="64" height="64" />
          <h1>{t("加密筆記本")}</h1>
          <p>
            {status.exists
              ? t("保險庫已上鎖。輸入主密碼以開啟你的記事。")
              : t("請先在工具列浮框建立保險庫。")}
          </p>
          {status.exists && (
            <>
              <input
                type="password"
                autoFocus
                autoComplete="current-password"
                aria-label={t("主密碼")}
                placeholder={t("輸入主密碼")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button className="nbPrimary" disabled={busy}>
                {busy ? t("處理中…") : t("解鎖保險庫 →")}
              </button>
            </>
          )}
          {error && <p className="nbError">{tError(error)}</p>}
        </form>
      </div>
    );

  const saveLabel =
    saveState === "saving"
      ? t("儲存中…")
      : saveState === "dirty"
        ? t("尚未儲存")
        : savedAt
          ? t("已加密儲存 {time}", {
              time: new Date(savedAt).toLocaleTimeString(lang(), {
                hour: "2-digit",
                minute: "2-digit",
              }),
            })
          : t("已加密儲存");

  return (
    <div className="nb">
      <header className="nbTitlebar">
        <img src="icons/32.png" alt="" width="20" height="20" />
        <span className="nbApp">{t("加密筆記本")}</span>
        <input
          className="nbTitle"
          aria-label={t("文件標題")}
          placeholder={t("未命名記事")}
          value={title}
          maxLength={300}
          onChange={(e) => {
            setTitle(e.target.value);
            state.current.title = e.target.value;
            changed();
          }}
        />
        <span className={"nbSave " + saveState} role="status">
          {saveLabel}
        </span>
        <span className="nbSpacer" />
        <button
          className="nbTbBtn"
          onClick={async () => {
            await save();
            await rpc("LOCK");
          }}
        >
          🔒 {t("上鎖")}
        </button>
      </header>

      <nav className="nbTabs" role="tablist">
        <button
          className="nbFile"
          onClick={() => void open(null)}
          title={t("新增記事")}
        >
          {t("＋ 新增")}
        </button>
        {(
          [
            ["home", "常用"],
            ["insert", "插入"],
            ["view", "檢視"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {t(label)}
          </button>
        ))}
      </nav>

      <div className="nbRibbon" role="toolbar" aria-label={t("功能區")}>
        {tab === "home" && (
          <>
            <div className="rg">
              <div className="rgRow">
                <Btn cmd="undo" label="復原" icon="↶" />
                <Btn cmd="redo" label="取消復原" icon="↷" />
              </div>
              <span className="rgName">{t("復原")}</span>
            </div>
            <div className="rg">
              <div className="rgRow">
                <select
                  className="rSelect"
                  aria-label={t("字型大小")}
                  title={t("字型大小")}
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) exec("fontSize", e.target.value);
                    e.target.value = "";
                  }}
                >
                  <option value="">{t("字型大小")}</option>
                  <option value="2">{t("小")}</option>
                  <option value="3">{t("標準")}</option>
                  <option value="4">{t("大")}</option>
                  <option value="5">{t("特大")}</option>
                  <option value="6">{t("超大")}</option>
                </select>
              </div>
              <div className="rgRow">
                <Btn cmd="bold" label="粗體" icon={<b>B</b>} />
                <Btn cmd="italic" label="斜體" icon={<i>I</i>} />
                <Btn cmd="underline" label="底線" icon={<u>U</u>} />
                <Btn cmd="strikeThrough" label="刪除線" icon={<s>ab</s>} />
                <label className="rb color" title={t("字型色彩")}>
                  <span style={{ borderBottomColor: "#c0392b" }}>A</span>
                  <input
                    type="color"
                    aria-label={t("字型色彩")}
                    defaultValue="#c0392b"
                    onChange={(e) => exec("foreColor", e.target.value)}
                  />
                </label>
                <label className="rb color" title={t("醒目提示")}>
                  <span className="hl">ab</span>
                  <input
                    type="color"
                    aria-label={t("醒目提示")}
                    defaultValue="#fff59d"
                    onChange={(e) => exec("hiliteColor", e.target.value)}
                  />
                </label>
                <Btn cmd="removeFormat" label="清除格式設定" icon="⌫" />
              </div>
              <span className="rgName">{t("字型")}</span>
            </div>
            <div className="rg">
              <div className="rgRow">
                <Btn cmd="insertUnorderedList" label="項目符號" icon="•≡" />
                <Btn cmd="insertOrderedList" label="編號" icon="1≡" />
                <Btn cmd="outdent" label="減少縮排" icon="⇤" />
                <Btn cmd="indent" label="增加縮排" icon="⇥" />
              </div>
              <div className="rgRow">
                <Btn cmd="justifyLeft" label="靠左對齊" icon="⯇≡" />
                <Btn cmd="justifyCenter" label="置中" icon="≡" />
                <Btn cmd="justifyRight" label="靠右對齊" icon="≡⯈" />
                <Btn cmd="justifyFull" label="左右對齊" icon="☰" />
              </div>
              <span className="rgName">{t("段落")}</span>
            </div>
            <div className="rg styles">
              <div className="rgRow">
                {STYLES.map(([tag, label]) => (
                  <button
                    key={tag}
                    type="button"
                    className={
                      "styleChip s" + tag + (block === tag ? " on" : "")
                    }
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => exec("formatBlock", `<${tag}>`)}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
              <span className="rgName">{t("樣式")}</span>
            </div>
          </>
        )}
        {tab === "insert" && (
          <>
            <div className="rg">
              <div className="rgRow">
                <Btn
                  label="連結"
                  icon={<>🔗 {t("連結")}</>}
                  onClick={insertLink}
                />
                <Btn
                  cmd="insertHorizontalRule"
                  label="水平線"
                  icon={<>― {t("水平線")}</>}
                />
                <Btn
                  label="日期和時間"
                  icon={<>📅 {t("日期和時間")}</>}
                  onClick={() =>
                    exec("insertText", new Date().toLocaleString(lang()))
                  }
                />
                <Btn
                  label="核取方塊"
                  icon={<>☐ {t("核取方塊")}</>}
                  onClick={() => exec("insertText", "☐ ")}
                />
              </div>
              <span className="rgName">{t("插入")}</span>
            </div>
          </>
        )}
        {tab === "view" && (
          <>
            <div className="rg">
              <div className="rgRow">
                <Btn
                  label="導覽窗格"
                  icon={
                    <>
                      {navOpen ? "☑" : "☐"} {t("導覽窗格")}
                    </>
                  }
                  onClick={() => setNavOpen(!navOpen)}
                />
                <Btn label="100%" icon="100%" onClick={() => setZoom(100)} />
                <Btn
                  label="頁寬"
                  icon={t("頁寬")}
                  onClick={() => setZoom(125)}
                />
              </div>
              <span className="rgName">{t("顯示")}</span>
            </div>
            <div className="rg">
              <div className="rgRow">
                <Btn
                  label="列印"
                  icon={<>🖨 {t("列印")}</>}
                  onClick={() => window.print()}
                />
                <Btn
                  label="刪除記事"
                  icon={<>🗑 {t("刪除記事")}</>}
                  onClick={() => void remove()}
                />
              </div>
              <span className="rgName">{t("文件")}</span>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="nbAlert" role="alert">
          {tError(error)}
          <button onClick={() => setError("")} aria-label={t("關閉錯誤")}>
            ×
          </button>
        </div>
      )}

      <div className="nbBody">
        {navOpen && (
          <aside className="nbNav" aria-label={t("記事清單")}>
            <input
              className="nbSearch"
              aria-label={t("搜尋記事")}
              placeholder={t("搜尋記事…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <ul>
              {shown.map((m) => (
                <li key={m.id}>
                  <button
                    className={m.id === current ? "on" : ""}
                    onClick={() => void open(m)}
                  >
                    <strong>{titleOf(m)}</strong>
                    <small>
                      {new Date(m.updated).toLocaleDateString(lang())}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            {!shown.length && (
              <p className="nbEmpty">
                {query ? t("沒有符合的記事") : t("還沒有加密記事")}
              </p>
            )}
          </aside>
        )}
        <main className="nbCanvas">
          <div
            className="nbPage"
            ref={page}
            style={{ zoom: zoom / 100 } as React.CSSProperties}
          >
            <div
              ref={editor}
              className="nbEditor"
              contentEditable
              suppressContentEditableWarning
              spellCheck
              role="textbox"
              aria-multiline="true"
              aria-label={t("記事內容")}
              onInput={changed}
              onBlur={() => void save()}
              onPaste={(e) => {
                e.preventDefault();
                const html = e.clipboardData.getData("text/html");
                const text = e.clipboardData.getData("text/plain");
                if (html) exec("insertHTML", sanitizeHtml(html));
                else exec("insertText", text);
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void save();
                }
              }}
            />
          </div>
        </main>
      </div>

      <footer className="nbStatus">
        <span>
          {t("第 {page} 頁，共 {pages} 頁", { page: 1, pages: counts.pages })}
        </span>
        <span>{t("{count} 個字", { count: counts.words })}</span>
        <span>{t("{count} 個字元", { count: counts.chars })}</span>
        <span className="nbLock">🔒 {t("AES-256 加密")}</span>
        <span className="nbSpacer" />
        <select
          className="nbLang"
          aria-label={t("介面語言")}
          value={uiLang}
          onChange={(e) => {
            const next = e.target.value as Lang;
            setUiLang(next);
            void saveLang(next);
          }}
        >
          {LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <button
          className="nbZoomBtn"
          aria-label={t("縮小")}
          onClick={() => setZoom(Math.max(50, zoom - 10))}
        >
          −
        </button>
        <input
          type="range"
          min={50}
          max={200}
          step={10}
          value={zoom}
          aria-label={t("縮放")}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
        <button
          className="nbZoomBtn"
          aria-label={t("放大")}
          onClick={() => setZoom(Math.min(200, zoom + 10))}
        >
          +
        </button>
        <span className="nbZoom">{zoom}%</span>
      </footer>
    </div>
  );
}
