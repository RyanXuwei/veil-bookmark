import React, { useCallback, useEffect, useRef, useState } from "react";
import "./notebook.css";
import { cleanDrawing, type Memo, type DrawingStroke } from "./crypto";
import { ToolIcon } from "./tool-icon";
import { DrawingLayer } from "./drawing";
import { drawDiagrams, editorText, markdownPreview } from "./md-preview";
import { Recorder, AudioSticker } from "./recorder";
import {
  cleanImages,
  cleanRecordings,
  imageBytes,
  MEMO_IMAGE_BYTES,
  MEMO_IMAGES_MAX,
  type MemoImage,
  type MemoRecording,
} from "./crypto";
import { folderNames, ordered } from "./sortable";
import { baseName, depthOf, pathLabel, within } from "./folders";
import { ConfirmDelete, itemDeleteDetail } from "./confirm";
import { IMPORT_ACCEPT, importFile } from "./import-doc";
import { type Folder } from "./crypto";
import { importHtmlImages, importImage, layoutRuled, RULE } from "./ruled";
import { LANGS, lang, saveLang, t, tError, type Lang } from "./i18n";
import {
  countWords,
  htmlToText,
  imageIds,
  memoHtml,
  memoText,
  sanitizeHtml,
} from "./sanitize";

type Rpc = (type: string, data?: Record<string, unknown>) => Promise<any>;
type Tab = "home" | "insert" | "view";
const PAGE_HEIGHT = 1123; // A4 at 96 dpi
const DEFAULT_PAPER = "#fff4be";
const PAPER_COLORS = [
  "#fff4be",
  "#fbe0dc",
  "#e4eddb",
  "#dfeef4",
  "#eee3f3",
  "#fffdf5",
];
// Text size comes from these styles (as in Notion); there is no font-size picker.
const STYLES: [string, string, string][] = [
  ["P", "內文", "paragraph"],
  ["H1", "標題 1", "h1"],
  ["H2", "標題 2", "h2"],
  ["H3", "標題 3", "h3"],
  ["BLOCKQUOTE", "引文", "quote"],
  ["PRE", "程式碼", "code"],
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
  const [folderRecords, setFolderRecords] = useState<Folder[]>([]);
  const [askDelete, setAskDelete] = useState(false);
  const [current, setCurrent] = useState<string>("");
  // Markdown / Mermaid preview of the note (read-only, toggled in View).
  const [mdHtml, setMdHtml] = useState<string | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => setMdHtml(null), [current]);
  useEffect(() => {
    if (mdHtml !== null && preview.current) void drawDiagrams(preview.current);
  }, [mdHtml]);
  const [title, setTitle] = useState("");
  const [paperColor, setPaperColor] = useState(DEFAULT_PAPER);
  const paper = useRef(DEFAULT_PAPER);
  const [drawing, setDrawing] = useState<DrawingStroke[]>([]);
  const ink = useRef<DrawingStroke[]>([]);
  const [recordings, setRecordings] = useState<MemoRecording[]>([]);
  const audio = useRef<MemoRecording[]>([]);
  const [recording, setRecording] = useState(false);
  const [pendingAudio, setPendingAudio] = useState<MemoRecording | null>(null);
  function audioChanged(next: MemoRecording[]) {
    audio.current = next;
    setRecordings(next);
    changed();
  }
  const [drawMode, setDrawMode] = useState<"text" | "pen" | "eraser">("text");
  const [penColor, setPenColor] = useState("#384739");
  const [penWidth, setPenWidth] = useState(2);
  function drawChanged(next: DrawingStroke[]) {
    ink.current = next;
    setDrawing(next);
    changed();
  }
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
  // Pictures of the open document by ID; the HTML only holds references.
  const images = useRef(new Map<string, MemoImage>());
  // Image IDs last saved, so unchanged images are not resent on every save.
  const savedImages = useRef("");
  const [imageBusy, setImageBusy] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const pictureRange = useRef<Range | null>(null);
  const timer = useRef<number>(0);
  const state = useRef({ current: "", title: "", dirty: false });
  const lastTouch = useRef(0);
  const epoch = useRef(0);
  const edits = useRef(0);
  const saving = useRef<Promise<boolean> | null>(null);
  const transition = useRef(false);
  const [switching, setSwitching] = useState(false);
  // Document to show once the editor is mounted (undefined = nothing pending).
  const pending = useRef<Memo | null | undefined>(undefined);
  const pick = (list: Memo[] | null) => {
    const id = location.hash.slice(1);
    pending.current =
      (list || []).find((m) => m.id === id && !m.deleted) || null;
  };

  const unlocked = !!status?.unlocked;

  const clearView = useCallback(() => {
    epoch.current++;
    edits.current++;
    window.clearTimeout(timer.current);
    pending.current = undefined;
    saving.current = null;
    state.current = { current: "", title: "", dirty: false };
    if (editor.current) editor.current.innerHTML = "";
    images.current = new Map();
    savedImages.current = "";
    setStatus((s: any) => (s ? { ...s, unlocked: false } : s));
    setMemos([]);
    setTitle("");
    paper.current = DEFAULT_PAPER;
    setPaperColor(DEFAULT_PAPER);
    ink.current = [];
    audio.current = [];
    setRecordings([]);
    setPendingAudio(null);
    setRecording(false);
    setDrawing([]);
    setDrawMode("text");
    setCurrent("");
    setQuery("");
    setPassword("");
    setSavedAt(0);
    setSaveState("saved");
    setCounts({ words: 0, chars: 0, pages: 1 });
    setActive({});
    setBlock("P");
  }, []);
  const refresh = useCallback(async () => {
    const requestEpoch = epoch.current;
    const s = await rpc("STATUS");
    if (requestEpoch !== epoch.current) return null;
    if (!s.unlocked) {
      clearView();
      setStatus(s);
      return null;
    }
    const v = await rpc("LIST");
    if (requestEpoch !== epoch.current) return null;
    setStatus(s);
    setMemos(v.memos || []);
    setFolderRecords(v.folders || []);
    return v.memos as Memo[];
  }, [rpc, clearView]);

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
    window.clearTimeout(timer.current);
    epoch.current++;
    state.current = {
      current: m?.id || "",
      title: m?.title || "",
      dirty: false,
    };
    el.innerHTML = m ? memoHtml(m) : "<p><br></p>";
    images.current = new Map(cleanImages(m?.images).map((i) => [i.id, i]));
    savedImages.current = usedImages(el.innerHTML).join(",");
    layoutRuled(el, images.current);
    setCurrent(m?.id || "");
    setTitle(m?.title || "");
    paper.current = /^#[0-9a-f]{6}$/i.test(m?.paperColor || "")
      ? m!.paperColor!
      : DEFAULT_PAPER;
    setPaperColor(paper.current);
    ink.current = cleanDrawing(m?.drawing);
    audio.current = cleanRecordings(m?.recordings);
    setRecordings(audio.current);
    setPendingAudio(null);
    setRecording(false);
    setDrawing(ink.current);
    setDrawMode("text");
    setSavedAt(m?.updated || 0);
    setSaveState("saved");
    history.replaceState(null, "", `#${m?.id || "new"}`);
    updateCounts();
    el.focus({ preventScroll: true });
  }

  // One writer per editor. Drain edits made while a save is in flight before
  // allowing a document switch; the first response supplies the permanent ID.
  const save = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    if (saving.current) return saving.current;
    const saveEpoch = epoch.current;
    const task = (async () => {
      try {
        while (
          state.current.dirty &&
          editor.current &&
          saveEpoch === epoch.current
        ) {
          const body = sanitizeHtml(editor.current.innerHTML);
          const used = usedImages(body);
          const imageKey = used.join(",");
          const titleNow = state.current.title;
          const id = state.current.current;
          const revision = edits.current;
          if (
            !titleNow.trim() &&
            !htmlToText(body) &&
            !ink.current.length &&
            !audio.current.length &&
            !used.length
          ) {
            if (id) throw Error("請輸入記事標題或內容");
            state.current.dirty = false;
            setSaveState("saved");
            return true;
          }
          setSaveState("saving");
          const memo: Memo = await rpc("MEMO_UPSERT", {
            memo: {
              id,
              title: titleNow,
              body,
              format: "html",
              paperColor: paper.current,
              drawing: ink.current,
              recordings: audio.current,
              // Only when the set of pictures changed; otherwise kept as is.
              images:
                imageKey === savedImages.current
                  ? undefined
                  : used.map((x) => images.current.get(x)!),
            },
          });
          if (saveEpoch !== epoch.current) return false;
          savedImages.current = imageKey;
          if (!id) {
            state.current.current = memo.id;
            setCurrent(memo.id);
            history.replaceState(null, "", `#${memo.id}`);
          }
          setMemos((list) =>
            saveEpoch === epoch.current
              ? [...list.filter((x) => x.id !== memo.id), memo]
              : list,
          );
          state.current.dirty = edits.current !== revision;
          setSavedAt(Date.now());
          setSaveState(state.current.dirty ? "dirty" : "saved");
          setError("");
        }
        return saveEpoch === epoch.current;
      } catch (e) {
        if (saveEpoch !== epoch.current) return false;
        state.current.dirty = true;
        setSaveState("dirty");
        setError((e as Error).message);
        void refresh().catch(() => {});
        return false;
      }
    })();
    saving.current = task;
    try {
      return await task;
    } finally {
      if (saving.current === task) saving.current = null;
    }
  }, [rpc, refresh]);

  function usedImages(html: string) {
    return imageIds(html).filter((x) => images.current.has(x));
  }

  function changed() {
    if (editor.current) layoutRuled(editor.current, images.current);
    edits.current++;
    state.current.dirty = true;
    setSaveState("dirty");
    updateCounts();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 1200);
    activity();
  }
  // Reading counts as use too: typing, clicks, scrolling and moving the
  // pointer keep the 15-minute lock away (at most one TOUCH per 30 s).
  const unlockedRef = useRef(false);
  unlockedRef.current = unlocked;
  function activity() {
    if (!unlockedRef.current || document.hidden) return;
    if (Date.now() - lastTouch.current <= 30000) return;
    lastTouch.current = Date.now();
    void rpc("TOUCH").catch(() => refresh());
  }

  // Initial load + react to locking from anywhere.
  useEffect(() => {
    document.execCommand("defaultParagraphSeparator", false, "p");
    refresh()
      .then((list) => list && pick(list))
      .catch((e) => setError(e.message));
    const onStorage = (changes: any, area: string) => {
      if (area === "session" && changes.session && !changes.session.newValue) {
        clearView();
        void refresh().catch(() => {});
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
    const active = ["pointerdown", "pointermove", "keydown", "wheel", "scroll"];
    for (const e of active)
      window.addEventListener(e, activity, { capture: true, passive: true });
    return () => {
      for (const e of active)
        window.removeEventListener(e, activity, { capture: true });
      epoch.current++;
      window.clearTimeout(timer.current);
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
    if (recording || pendingAudio) {
      setError("請先停止錄音並放置播放貼紙");
      return;
    }
    if (transition.current || (m && m.id === state.current.current)) return;
    transition.current = true;
    setSwitching(true);
    const navigationEpoch = epoch.current;
    try {
      if ((await save()) && navigationEpoch === epoch.current) load(m);
    } finally {
      transition.current = false;
      setSwitching(false);
    }
  }

  // Import: each chosen file becomes a new encrypted note.
  const importInput = useRef<HTMLInputElement>(null);
  async function importFiles(chosen: FileList | null) {
    // Copy the list now: clearing the input afterwards empties the FileList.
    const files = Array.from(chosen || []).slice(0, 20);
    if (!files.length || transition.current) return;
    if (recording || pendingAudio) {
      setError("請先停止錄音並放置播放貼紙");
      return;
    }
    transition.current = true;
    setSwitching(true);
    setError("");
    const importEpoch = epoch.current;
    let last: Memo | null = null;
    let skipped = 0;
    try {
      if (!(await save()) || importEpoch !== epoch.current) return;
      for (const f of files) {
        try {
          const r = await importFile(f);
          skipped += r.skipped;
          last = await rpc("MEMO_UPSERT", {
            memo: {
              title: r.title,
              body: r.html,
              format: "html",
              images: r.images,
            },
          });
        } catch (e) {
          setError(
            t("無法匯入「{name}」：{reason}", {
              name: f.name,
              reason: tError((e as Error).message),
            }),
          );
        }
      }
      if (importEpoch !== epoch.current) return;
      await refresh();
      if (last) load(last);
      if (skipped)
        setError(
          t("有 {count} 張圖片的格式無法匯入（例如 EMF／WMF），已略過。", {
            count: skipped,
          }),
        );
    } finally {
      transition.current = false;
      setSwitching(false);
    }
  }

  async function remove(confirmed = false) {
    if (recording || pendingAudio) {
      setError("請先停止錄音並放置播放貼紙");
      return;
    }
    if (transition.current) return;
    if (!state.current.current && !state.current.dirty) {
      load(null);
      return;
    }
    if (!confirmed) {
      setAskDelete(true); // ConfirmDelete, as everywhere else
      return;
    }
    setAskDelete(false);
    transition.current = true;
    setSwitching(true);
    const deletionEpoch = epoch.current;
    try {
      await save();
      if (deletionEpoch !== epoch.current) return;
      const id = state.current.current;
      if (id) await rpc("MEMO_DELETE", { id });
      const list = await refresh();
      if (deletionEpoch !== epoch.current) return;
      load(
        (list || [])
          .filter((m) => !m.deleted)
          .sort((a, b) => b.updated - a.updated)[0] || null,
      );
    } catch (e) {
      if (deletionEpoch === epoch.current) setError((e as Error).message);
    } finally {
      transition.current = false;
      setSwitching(false);
    }
  }

  async function lockNotebook() {
    if (transition.current) return;
    transition.current = true;
    setSwitching(true);
    const lockEpoch = epoch.current;
    try {
      const saved = await save();
      if (lockEpoch !== epoch.current) return;
      if (!saved && !confirm(t("無法儲存記事。仍要上鎖並捨棄未儲存的變更？")))
        return;
      await rpc("LOCK");
    } catch (e) {
      if (lockEpoch === epoch.current) setError((e as Error).message);
    } finally {
      transition.current = false;
      setSwitching(false);
    }
  }

  // Caret position to restore after pictures are processed asynchronously.
  function caret() {
    const sel = window.getSelection();
    const r = sel?.rangeCount ? sel.getRangeAt(0) : null;
    return r && editor.current?.contains(r.commonAncestorContainer)
      ? r.cloneRange()
      : null;
  }
  function restore(range: Range | null) {
    editor.current?.focus({ preventScroll: true });
    if (!range) return;
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  function roomFor(added: MemoImage[]) {
    const used = usedImages(editor.current?.innerHTML || "").map((x) =>
      images.current.get(x)!,
    );
    if (used.length + added.length > MEMO_IMAGES_MAX)
      throw Error("這份記事的圖片數量已達上限");
    if (imageBytes(used) + imageBytes(added) > MEMO_IMAGE_BYTES)
      throw Error("這份記事的圖片已達大小上限");
  }
  async function insertContent(
    data: { files: File[]; html: string; text: string },
    range: Range | null,
  ) {
    const pictures = data.files.filter((f) => f.type.startsWith("image/"));
    if (!pictures.length && !/<img/i.test(data.html)) {
      restore(range);
      if (data.html) exec("insertHTML", sanitizeHtml(data.html));
      else if (data.text) exec("insertText", data.text);
      return;
    }
    if (drawMode !== "text" || switching) return;
    const opened = epoch.current;
    setImageBusy(true);
    try {
      let html = "";
      let added: MemoImage[] = [];
      if (pictures.length) {
        // A copied picture also carries HTML pointing at its web address;
        // the picture itself is what the user wants.
        for (const f of pictures.slice(0, 20)) added.push(await importImage(f));
        html = added
          .map((i) => `<img data-veil-img="${i.id}" alt="">`)
          .join("");
      } else {
        ({ html, added } = await importHtmlImages(data.html));
        html = sanitizeHtml(html);
      }
      if (opened !== epoch.current) return;
      roomFor(added);
      for (const i of added) images.current.set(i.id, i);
      restore(range);
      if (html) exec("insertHTML", html);
      setError("");
    } catch (e) {
      if (opened === epoch.current) setError((e as Error).message);
    } finally {
      setImageBusy(false);
    }
  }

  // Chrome's print dialog saves PDFs ("Save as PDF"); the document title
  // becomes the suggested file name. Nothing leaves the computer.
  async function saveAsPdf() {
    await save();
    const before = document.title;
    const name =
      (
        state.current.title.trim() ||
        htmlToText(editor.current?.innerHTML || "").split("\n")[0] ||
        t("未命名記事")
      )
        .replace(/[\\/:*?"<>|]+/g, " ")
        .trim()
        .slice(0, 80) || "Veil Bookmark";
    document.title = name;
    const restore = () => {
      document.title = before;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
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
  // Without a search: notes grouped by the popup's folders, in their order.
  const navFolders = folderNames("memo", folderRecords, live);
  const navList: (Memo | string)[] = query
    ? shown
    : [...navFolders, ""].flatMap((f) => {
        const notes = ordered(
          live.filter((x) => (x.folder || "") === f),
          (a, b) => b.updated - a.updated,
        );
        // A parent folder shows when notes are anywhere below it.
        if (!notes.length && !live.some((x) => within(x.folder || "", f)))
          return [];
        return navFolders.length ? [f, ...notes] : notes;
      });

  // Large ribbon button: icon above a short label (Insert and View tabs).
  const BigBtn = ({
    label,
    icon,
    onClick,
    on,
    disabled,
    text,
  }: {
    label: string;
    icon: string;
    onClick: () => void;
    on?: boolean;
    disabled?: boolean;
    text?: string;
  }) => (
    <button
      type="button"
      className={"rbBig" + (on ? " on" : "")}
      title={t(label)}
      aria-pressed={on}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <ToolIcon name={icon} />
      <span>{text || t(label)}</span>
    </button>
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
          <h1>{t("加密記事本")}</h1>
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
      {askDelete && (
        <ConfirmDelete
          title={t("刪除「{title}」？", {
            title: title.trim() || t("未命名記事"),
          })}
          detail={itemDeleteDetail()}
          busy={switching}
          onCancel={() => setAskDelete(false)}
          onConfirm={() => void remove(true)}
        />
      )}
      <header className="nbTitlebar">
        <img src="icons/32.png" alt="" width="20" height="20" />
        <span className="nbApp">{t("加密記事本")}</span>
        <input
          className="nbTitle"
          aria-label={t("文件標題")}
          placeholder={t("未命名記事")}
          value={title}
          maxLength={300}
          disabled={switching}
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
          disabled={switching}
          onClick={() => void lockNotebook()}
        >
          🔒 {t("上鎖")}
        </button>
      </header>

      <nav className="nbTabs" role="tablist">
        <button
          className="nbFile"
          disabled={switching}
          onClick={() => void open(null)}
          title={t("新增記事")}
        >
          {t("＋ 新增")}
        </button>
        <button
          className="nbFile nbImport"
          disabled={switching}
          onClick={() => importInput.current?.click()}
          title={t("匯入文字檔、Markdown、HTML 或 Word（.docx），每個檔案成為一則新記事")}
        >
          {t("匯入")}
        </button>
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
                <Btn cmd="bold" label="粗體" icon={<b>B</b>} />
                <Btn cmd="italic" label="斜體" icon={<i>I</i>} />
                <Btn cmd="underline" label="底線" icon={<u>U</u>} />
                <Btn cmd="strikeThrough" label="刪除線" icon={<s>ab</s>} />
              </div>
              <div className="rgRow">
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
              {[STYLES.slice(0, 4), STYLES.slice(4)].map((row, i) => (
                <div className="rgRow" key={i}>
                  {row.map(([tag, label, icon]) => (
                    <button
                      key={tag}
                      type="button"
                      className={"rb" + (block === tag ? " on" : "")}
                      title={t(label)}
                      aria-label={t(label)}
                      aria-pressed={block === tag}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => exec("formatBlock", `<${tag}>`)}
                    >
                      <ToolIcon name={icon} />
                    </button>
                  ))}
                </div>
              ))}
              <span className="rgName">{t("樣式")}</span>
            </div>
          </>
        )}
        {tab === "insert" && (
          <>
            <div className="rg">
              <div className="rgRow big">
                <BigBtn
                  label="圖片"
                  icon="image"
                  disabled={imageBusy}
                  text={imageBusy ? t("處理中…") : undefined}
                  onClick={() => {
                    pictureRange.current = caret();
                    imageInput.current?.click();
                  }}
                />
                <BigBtn label="連結" icon="link" onClick={insertLink} />
                <BigBtn
                  label="水平線"
                  icon="rule"
                  onClick={() => exec("insertHorizontalRule")}
                />
                <BigBtn
                  label="日期和時間"
                  icon="calendar"
                  onClick={() =>
                    exec("insertText", new Date().toLocaleString(lang()))
                  }
                />
                <BigBtn
                  label="核取方塊"
                  icon="checkbox"
                  onClick={() => exec("insertText", "☐ ")}
                />
                <input
                  ref={imageInput}
                  className="nbFileInput"
                  type="file"
                  accept="image/*"
                  multiple
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    e.target.value = "";
                    if (files.length)
                      void insertContent(
                        { files, html: "", text: "" },
                        pictureRange.current,
                      );
                  }}
                />
              </div>
              <span className="rgName">{t("插入")}</span>
            </div>
          </>
        )}
        {tab === "view" && (
          <>
            <div className="rg">
              <div className="rgRow big">
                <BigBtn
                  label="導覽窗格"
                  icon="sidebar"
                  on={navOpen}
                  onClick={() => setNavOpen(!navOpen)}
                />
                <BigBtn
                  label="Markdown 預覽"
                  icon="markdown"
                  on={mdHtml !== null}
                  onClick={() =>
                    setMdHtml(
                      mdHtml !== null || !editor.current
                        ? null
                        : markdownPreview(editorText(editor.current)),
                    )
                  }
                />
                <BigBtn label="100%" icon="zoom" onClick={() => setZoom(100)} />
                <BigBtn
                  label="頁寬"
                  icon="pageWidth"
                  onClick={() => setZoom(125)}
                />
              </div>
              <span className="rgName">{t("顯示")}</span>
            </div>
            <div className="rg">
              <div className="rgRow big">
                <BigBtn
                  label="列印／另存 PDF"
                  icon="print"
                  onClick={() => void saveAsPdf()}
                />
                <BigBtn
                  label="刪除記事"
                  icon="trash"
                  onClick={() => void remove()}
                />
              </div>
              <span className="rgName">{t("文件")}</span>
            </div>
          </>
        )}
        <div
          className="nbNoteTools"
          hidden={tab !== "home"}
          aria-label={t("便簽工具")}
        >
          <div className="rg nbPaperTools">
            <div className="rgRow nbDrawingTools">
              {(
                [
                  ["text", "文字"],
                  ["pen", "鉛筆"],
                  ["eraser", "橡皮擦"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={"rb" + (drawMode === mode ? " on" : "")}
                  title={t(label)}
                  aria-label={t(label)}
                  aria-pressed={drawMode === mode}
                  disabled={switching}
                  onClick={() => setDrawMode(mode)}
                >
                  <ToolIcon name={mode} />
                </button>
              ))}
              <input
                type="color"
                className="nbPaperCustom"
                aria-label={t("筆色")}
                value={penColor}
                onChange={(e) => setPenColor(e.target.value)}
              />
              <select
                className="rSelect"
                aria-label={t("筆畫粗細")}
                value={penWidth}
                onChange={(e) => setPenWidth(Number(e.target.value))}
              >
                {[1, 2, 4, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} px
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rb"
                disabled={switching || !drawing.length}
                title={t("復原筆畫")}
                aria-label={t("復原筆畫")}
                onClick={() => drawChanged(ink.current.slice(0, -1))}
              >
                <ToolIcon name="undo" />
              </button>
            </div>
            <div className="rgRow">
              {PAPER_COLORS.map((color) => (
                <button
                  type="button"
                  key={color}
                  className="nbSwatch"
                  style={{ backgroundColor: color }}
                  aria-label={`${t("紙張顏色")} ${color}`}
                  aria-pressed={paperColor === color}
                  disabled={switching}
                  onClick={() => {
                    paper.current = color;
                    setPaperColor(color);
                    changed();
                  }}
                />
              ))}
              <input
                type="color"
                className="nbPaperCustom"
                aria-label={t("自訂紙張顏色")}
                title={t("自訂紙張顏色")}
                value={paperColor}
                disabled={switching}
                onChange={(e) => {
                  paper.current = e.target.value;
                  setPaperColor(e.target.value);
                  changed();
                }}
              />
            </div>
            <span className="rgName">{t("紙張顏色")}</span>
          </div>
          <Recorder
            disabled={
              switching ||
              !!pendingAudio ||
              recordings.length >= 5 ||
              recordings.reduce((n, r) => n + r.data.length, 0) > 600000
            }
            onBusy={setRecording}
            onRecorded={(r) => {
              setPendingAudio(r);
              setDrawMode("text");
            }}
          />
          {(recording || pendingAudio) && (
            <span className="nbRecordingHint" role="status">
              {pendingAudio
                ? t("點紙張任意位置放置錄音，之後可拖曳移動")
                : t("上鎖或離開會捨棄尚未完成的錄音")}
            </span>
          )}
        </div>
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
              {navList.map((m) =>
                typeof m === "string" ? (
                  <li
                    key={"folder:" + m}
                    className="nbNavFolder"
                    style={{ paddingLeft: 12 + depthOf(m) * 12 }}
                    title={m ? pathLabel(m) : undefined}
                  >
                    {m ? baseName(m) : t("未分類")}
                  </li>
                ) : (
                  <li key={m.id}>
                    <button
                      className={m.id === current ? "on" : ""}
                      disabled={switching}
                      onClick={() => void open(m)}
                    >
                      <strong>{titleOf(m)}</strong>
                      <small>
                        {new Date(m.updated).toLocaleDateString(lang())}
                      </small>
                    </button>
                  </li>
                ),
              )}
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
            style={
              {
                zoom: zoom / 100,
                "--paper-color": paperColor,
                "--paper-ink":
                  (parseInt(paperColor.slice(1, 3), 16) * 299 +
                    parseInt(paperColor.slice(3, 5), 16) * 587 +
                    parseInt(paperColor.slice(5, 7), 16) * 114) /
                    1000 <
                  128
                    ? "#fff9e9"
                    : "#30372d",
              } as React.CSSProperties
            }
          >
            <div className="nbBinding" aria-hidden="true" />
            {mdHtml !== null && (
              <div
                ref={preview}
                className="nbEditor mdPreview"
                aria-label={t("Markdown 預覽")}
                dangerouslySetInnerHTML={{ __html: mdHtml }}
              />
            )}
            <div
              ref={editor}
              className="nbEditor"
              hidden={mdHtml !== null}
              contentEditable={!switching && drawMode === "text"}
              suppressContentEditableWarning
              spellCheck
              role="textbox"
              aria-multiline="true"
              aria-label={t("記事內容")}
              onInput={changed}
              onBlur={() => void save()}
              onPaste={(e) => {
                e.preventDefault();
                void insertContent(
                  {
                    files: Array.from(e.clipboardData.files),
                    html: e.clipboardData.getData("text/html"),
                    text: e.clipboardData.getData("text/plain"),
                  },
                  caret(),
                );
              }}
              onMouseDown={(e) => {
                // Click on any empty ruled line below the text to type there:
                // blank lines are added up to that line.
                const el = editor.current;
                if (!el || e.button !== 0 || drawMode !== "text" || switching)
                  return;
                const box = el.getBoundingClientRect();
                const last = el.lastElementChild;
                const bottom = last
                  ? last.getBoundingClientRect().bottom
                  : box.top;
                if (e.clientY <= bottom + 1) return;
                const rule =
                  (RULE * box.height) /
                  (parseFloat(getComputedStyle(el).height) || box.height);
                const rows = Math.min(
                  200,
                  Math.floor((e.clientY - bottom) / rule) + 1,
                );
                e.preventDefault();
                let p: HTMLParagraphElement | null = null;
                for (let i = 0; i < rows; i++) {
                  p = document.createElement("p");
                  p.appendChild(document.createElement("br"));
                  el.appendChild(p);
                }
                el.focus({ preventScroll: true });
                const range = document.createRange();
                range.setStart(p!, 0);
                range.collapse(true);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
                changed();
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                // Never let the browser insert dropped content unsanitised.
                e.preventDefault();
                const r = document.caretRangeFromPoint(e.clientX, e.clientY);
                void insertContent(
                  {
                    files: Array.from(e.dataTransfer.files),
                    html: e.dataTransfer.getData("text/html"),
                    text: e.dataTransfer.getData("text/plain"),
                  },
                  r && editor.current?.contains(r.startContainer) ? r : caret(),
                );
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            {mdHtml === null && (
            <DrawingLayer
              strokes={drawing}
              mode={switching ? "text" : drawMode}
              color={penColor}
              width={penWidth}
              onChange={drawChanged}
            />
            )}
            <div className="nbAudioLayer" hidden={mdHtml !== null}>
              {recordings.map((r) => (
                <AudioSticker
                  key={r.id}
                  recording={r}
                  onMove={(x, y) =>
                    audioChanged(
                      audio.current.map((a) =>
                        a.id === r.id ? { ...a, x, y } : a,
                      ),
                    )
                  }
                  onDelete={() =>
                    audioChanged(audio.current.filter((a) => a.id !== r.id))
                  }
                />
              ))}
            </div>
            {pendingAudio && (
              <div
                className="nbPlaceAudio"
                onPointerDown={(e) => {
                  const box = e.currentTarget.getBoundingClientRect();
                  const x = Math.max(
                      0,
                      Math.min(
                        Math.max(0, 1 - 230 / box.width),
                        (e.clientX - box.left) / box.width,
                      ),
                    ),
                    y = Math.max(
                      0,
                      Math.min(0.9, (e.clientY - box.top) / box.height),
                    );
                  audioChanged([...audio.current, { ...pendingAudio, x, y }]);
                  setPendingAudio(null);
                  setError("");
                }}
              />
            )}
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
