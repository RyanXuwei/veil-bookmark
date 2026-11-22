import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n";
import "./image-resize.css";

/** Selection controls live outside the editable document, never in saved HTML. */
export function ImageResize({
  editor,
  enabled,
  documentKey,
  onChange,
}: {
  editor: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  documentKey: string;
  onChange: () => void;
}) {
  const [image, select] = useState<HTMLImageElement | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    select(null);
    if (!enabled) return;
    const pick = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".veilImageResize")) return;
      select(
        target instanceof HTMLImageElement &&
          editor.current?.contains(target) &&
          target.hasAttribute("data-veil-img")
          ? target
          : null,
      );
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") select(null);
    };
    document.addEventListener("pointerdown", pick);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", pick);
      document.removeEventListener("keydown", escape);
    };
  }, [enabled, documentKey, editor]);
  useEffect(() => {
    if (!image || !enabled) return;
    let raf = 0;
    const place = () => {
      if (!editor.current?.contains(image)) {
        select(null);
        return;
      }
      const rect = image.getBoundingClientRect();
      if (frame.current)
        Object.assign(frame.current.style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [image, enabled, editor]);
  if (!enabled || !image) return null;
  return createPortal(
    <div className="veilImageResize" ref={frame}>
      {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map(
        (direction) => (
          <button
            key={direction}
            type="button"
            className={`veilImageHandle ${direction}`}
            aria-label={`${t("調整圖片大小")} (${direction})`}
            onKeyDown={(e) => {
              if (
                !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                  e.key,
                )
              )
                return;
              e.preventDefault();
              const width = parseFloat(getComputedStyle(image).width);
              const max = Math.min(1600, editor.current!.clientWidth);
              image.width = Math.round(
                Math.max(
                  Math.min(32, max),
                  Math.min(
                    max,
                    width + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -8 : 8),
                  ),
                ),
              );
              image.style.width = `${image.width}px`;
              image.style.height = "auto";
              change.current();
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              const button = e.currentTarget;
              button.setPointerCapture(e.pointerId);
              const startX = e.clientX,
                startY = e.clientY;
              const rect = image.getBoundingClientRect();
              const width = parseFloat(getComputedStyle(image).width);
              const scale = rect.width / width || 1;
              const max = Math.min(1600, editor.current!.clientWidth);
              const move = (event: PointerEvent) => {
                if (!editor.current?.contains(image)) return;
                const dx =
                  (event.clientX - startX) * (direction.includes("w") ? -1 : 1);
                const dy =
                  (event.clientY - startY) * (direction.includes("n") ? -1 : 1);
                const delta =
                  direction === "n" || direction === "s"
                    ? (dy * rect.width) / rect.height
                    : direction.length === 2
                      ? (dx + (dy * rect.width) / rect.height) / 2
                      : dx;
                image.width = Math.round(
                  Math.max(
                    Math.min(32, max),
                    Math.min(max, width + delta / scale),
                  ),
                );
                image.style.width = `${image.width}px`;
                image.style.height = "auto";
                change.current();
              };
              const finish = () => {
                button.removeEventListener("pointermove", move);
                button.removeEventListener("pointerup", finish);
                button.removeEventListener("pointercancel", finish);
                button.removeEventListener("lostpointercapture", finish);
              };
              button.addEventListener("pointermove", move);
              button.addEventListener("pointerup", finish);
              button.addEventListener("pointercancel", finish);
              button.addEventListener("lostpointercapture", finish);
            }}
          />
        ),
      )}
    </div>,
    document.body,
  );
}
