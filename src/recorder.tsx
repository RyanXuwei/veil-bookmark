import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MemoRecording } from "./crypto";
import { t } from "./i18n";
import { ToolIcon } from "./tool-icon";

/** Where to turn the microphone back on, for this browser. */
function micHelp() {
  const ua = navigator.userAgent;
  if (/OculusBrowser/i.test(ua))
    return t("請到 Meta Quest 的「設定 › 隱私權 › 麥克風」允許瀏覽器使用麥克風，再到瀏覽器的網站設定允許這個網站。");
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1))
    return t("iPhone／iPad：點網址列的「大小」(ᴀA) › 網站設定 › 麥克風 › 允許；或到「設定 › Safari › 麥克風」。加到主畫面的 App 請到「設定 › Safari › 麥克風」。");
  if (/Android/i.test(ua))
    return t("Android：點網址列左側的設定圖示 › 權限 › 麥克風 › 允許；若仍無法使用，到手機「設定 › 應用程式 › Chrome › 權限」開啟麥克風。");
  if (location.protocol === "chrome-extension:")
    return t("點網址列右側的麥克風圖示選「一律允許」，或到 Chrome 設定 › 隱私權和安全性 › 網站設定 › 麥克風，允許 Veil Bookmark。");
  return t("點網址列左側的網站資訊圖示 › 麥克風 › 允許，然後再按一次錄音。");
}

export function Recorder({
  disabled,
  onRecorded,
  onBusy,
}: {
  disabled: boolean;
  onRecorded: (r: MemoRecording) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [phase, setPhase] = useState("idle"),
    [seconds, setSeconds] = useState(0),
    [error, setError] = useState(""),
    // Shown when the microphone was refused: how to allow it, and a retry.
    [blocked, setBlocked] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null);
  const mounted = useRef(true),
    duration = useRef(0);
  const callbacks = useRef({ onRecorded, onBusy });
  callbacks.current = { onRecorded, onBusy };
  useEffect(
    () => () => {
      mounted.current = false;
      if (recorder.current?.state !== "inactive") recorder.current?.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => {
      duration.current++;
      setSeconds(duration.current);
      if (duration.current >= 180) stop();
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);
  function stop() {
    if (recorder.current && recorder.current.state !== "inactive") {
      setPhase("processing");
      recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    }
  }
  async function start() {
    setError("");
    setBlocked(false);
    setPhase("requesting");
    callbacks.current.onBusy(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        const e = Error("unsupported");
        e.name = "NotSupportedError";
        throw e;
      }
      // Asking for the microphone shows the browser's permission prompt when
      // it has not been answered yet.
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = s;
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
        (m) => MediaRecorder.isTypeSupported(m),
      );
      if (!mime) throw Error();
      const rec = new MediaRecorder(s, {
        mimeType: mime,
        audioBitsPerSecond: 24000,
      });
      recorder.current = rec;
      duration.current = 0;
      setSeconds(0);
      const chunks: Blob[] = [];
      let size = 0,
        failed = false;
      rec.ondataavailable = (e) => {
        if (e.data.size) {
          chunks.push(e.data);
          size += e.data.size;
          if (size >= 1000000 && rec.state !== "inactive") stop();
        }
      };
      rec.onerror = () => {
        failed = true;
        if (mounted.current) setError(t("無法錄音，請確認麥克風權限與裝置"));
        stop();
      };
      rec.onstop = async () => {
        s.getTracks().forEach((t) => t.stop());
        if (!mounted.current) return;
        try {
          if (failed || !size || size > 1050000) throw Error();
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(new Blob(chunks, { type: mime }));
          });
          if (!mounted.current) return;
          callbacks.current.onBusy(false);
          callbacks.current.onRecorded({
            id: crypto.randomUUID(),
            mime,
            data,
            duration: duration.current,
            created: Date.now(),
            x: 0.15,
            y: 0.15,
          });
        } catch {
          if (mounted.current) {
            setError(t("無法保存錄音，請重新錄製"));
            callbacks.current.onBusy(false);
          }
        } finally {
          if (mounted.current) setPhase("idle");
        }
      };
      rec.start(1000);
      setPhase("recording");
    } catch (e) {
      stream.current?.getTracks().forEach((t) => t.stop());
      if (mounted.current) {
        setPhase("idle");
        callbacks.current.onBusy(false);
        const name = (e as Error)?.name || "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          setBlocked(true);
          setError(t("沒有麥克風權限。"));
        } else if (name === "NotFoundError" || name === "OverconstrainedError")
          setError(t("找不到麥克風，請確認裝置已連接。"));
        else if (name === "NotReadableError")
          setError(t("麥克風正被其他 App 使用，請關閉後再試。"));
        else if (name === "NotSupportedError")
          setError(t("這個瀏覽器不支援錄音。"));
        else setError(t("無法錄音，請確認麥克風權限與裝置"));
      }
    }
  }
  return (
    <div className="rg nbRecorder">
      <div className="rgRow">
        {phase === "idle" ? (
          <button
            className="rb"
            title={`${t("開始錄音")} · ${t("每段最長 3 分鐘")}`}
            aria-label={t("開始錄音")}
            disabled={disabled}
            onClick={() => void start()}
          >
            <ToolIcon name="mic" />
          </button>
        ) : (
          <>
            <span role="status">
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
            </span>
            <button
              className="rb"
              title={phase === "paused" ? t("繼續錄音") : t("暫停錄音")}
              aria-label={phase === "paused" ? t("繼續錄音") : t("暫停錄音")}
              disabled={!["recording", "paused"].includes(phase)}
              onClick={() => {
                if (phase === "recording") {
                  recorder.current?.pause();
                  setPhase("paused");
                } else {
                  recorder.current?.resume();
                  setPhase("recording");
                }
              }}
            >
              <ToolIcon name={phase === "paused" ? "play" : "pause"} />
            </button>
            <button
              className="rb"
              title={t("停止錄音")}
              aria-label={t("停止錄音")}
              disabled={!["recording", "paused"].includes(phase)}
              onClick={stop}
            >
              <ToolIcon name="stop" />
            </button>
          </>
        )}
      </div>
      <span className="rgName">{t("錄音機")}</span>
      {error && !blocked && (
        <span className="nbError" role="alert">
          {error}
        </span>
      )}
      {blocked &&
        // On the page itself: toolbars can clip fixed-position boxes.
        createPortal(
        <div className="micHelp" role="alertdialog" aria-label={t("沒有麥克風權限。")}>
          <strong>{t("沒有麥克風權限。")}</strong>
          <p>{micHelp()}</p>
          <div className="micHelpButtons">
            <button type="button" onClick={() => setBlocked(false)}>
              {t("關閉")}
            </button>
            <button type="button" className="primary" onClick={() => void start()}>
              {t("重試")}
            </button>
          </div>
        </div>,
          document.body,
        )}
    </div>
  );
}

export function AudioSticker({
  recording: r,
  onMove,
  onDelete,
}: {
  recording: MemoRecording;
  onMove: (x: number, y: number) => void;
  onDelete: () => void;
}) {
  const [url, setUrl] = useState("");
  const card = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLAudioElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  useEffect(() => {
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    const u = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
    setUrl(u);
    const el = player.current;
    return () => {
      el?.pause();
      el?.removeAttribute("src");
      el?.load();
      URL.revokeObjectURL(u);
    };
  }, [r.data, r.mime]);
  return (
    <div
      ref={card}
      className="nbAudioSticker"
      style={{
        left: `${(position?.x ?? r.x) * 100}%`,
        top: `${(position?.y ?? r.y) * 100}%`,
      }}
    >
      <div
        className="nbAudioHandle"
        role="button"
        tabIndex={0}
        aria-label={t("移動錄音")}
        onKeyDown={(e) => {
          const delta: { [key: string]: [number, number] } = {
            ArrowLeft: [-0.02, 0],
            ArrowRight: [0.02, 0],
            ArrowUp: [0, -0.02],
            ArrowDown: [0, 0.02],
          };
          if (delta[e.key]) {
            e.preventDefault();
            onMove(
              Math.max(0, Math.min(0.75, r.x + delta[e.key][0])),
              Math.max(0, Math.min(0.9, r.y + delta[e.key][1])),
            );
          }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, left: r.x, top: r.y };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const box = card.current!.parentElement!.getBoundingClientRect();
          setPosition({
            x: Math.max(
              0,
              Math.min(
                Math.max(
                  0,
                  1 - card.current!.getBoundingClientRect().width / box.width,
                ),
                drag.current.left + (e.clientX - drag.current.x) / box.width,
              ),
            ),
            y: Math.max(
              0,
              Math.min(
                0.9,
                drag.current.top + (e.clientY - drag.current.y) / box.height,
              ),
            ),
          });
        }}
        onPointerUp={() => {
          if (position) onMove(position.x, position.y);
          drag.current = null;
          setPosition(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setPosition(null);
        }}
      >
        <span>
          ⠿ {t("錄音")} · {Math.floor(r.duration / 60)}:
          {String(Math.floor(r.duration % 60)).padStart(2, "0")}
        </span>
      </div>
      <audio
        ref={player}
        controls
        src={url}
        preload="metadata"
        aria-label={t("播放錄音")}
      />
      <button
        className="nbAudioDelete"
        aria-label={t("刪除錄音")}
        onClick={onDelete}
      >
        ×
      </button>
    </div>
  );
}
