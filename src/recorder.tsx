import React, { useEffect, useRef, useState } from "react";
import type { MemoRecording } from "./crypto";
import { t } from "./i18n";

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
    [error, setError] = useState("");
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
    setPhase("requesting");
    callbacks.current.onBusy(true);
    try {
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
    } catch {
      stream.current?.getTracks().forEach((t) => t.stop());
      if (mounted.current) {
        setPhase("idle");
        callbacks.current.onBusy(false);
        setError(t("無法錄音，請確認麥克風權限與裝置"));
      }
    }
  }
  return (
    <div className="rg nbRecorder">
      <div className="rgRow">
        {phase === "idle" ? (
          <button
            className="rb"
            disabled={disabled}
            onClick={() => void start()}
          >
            ● {t("開始錄音")}
          </button>
        ) : (
          <>
            <span role="status">
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
            </span>
            <button
              className="rb"
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
              {phase === "paused" ? t("繼續錄音") : t("暫停錄音")}
            </button>
            <button
              className="rb"
              disabled={!["recording", "paused"].includes(phase)}
              onClick={stop}
            >
              {t("停止錄音")}
            </button>
          </>
        )}
      </div>
      <span className="rgName">
        {t("錄音機")} · {t("每段最長 3 分鐘")}
      </span>
      {error && (
        <span className="nbError" role="alert">
          {error}
        </span>
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
