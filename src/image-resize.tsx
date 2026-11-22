import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n";
import { freePosition, IMAGE_PAGE, observeImageLayout } from "./free-image";
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
  const [, redraw] = useState(0);
  const frame = useRef<HTMLDivElement>(null);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (editor.current) return observeImageLayout(editor.current);
  }, [editor, documentKey]);
  function moveImage(
    img: HTMLImageElement,
    target: HTMLElement,
    pointerId: number,
    x: number,
    y: number,
  ) {
    const free = freePosition(img);
    const el = editor.current;
    if (!free || !el) return;
    const scale = el.getBoundingClientRect().width / IMAGE_PAGE;
    target.setPointerCapture(pointerId);
    const move = (event: PointerEvent) => {
      if (!editor.current?.contains(img)) return;
      img.dataset.veilX = String(
        Math.round(
          Math.max(
            0,
            Math.min(
              IMAGE_PAGE - free.width,
              free.x + (event.clientX - x) / scale,
            ),
          ),
        ),
      );
      img.dataset.veilY = String(
        Math.round(
          Math.max(0, Math.min(16000, free.y + (event.clientY - y) / scale)),
        ),
      );
      change.current();
    };
    const finish = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      target.removeEventListener("lostpointercapture", finish);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
    target.addEventListener("lostpointercapture", finish);
  }
  function setWidth(img: HTMLImageElement, width: number) {
    const el = editor.current!;
    const free = freePosition(img);
    if (free) {
      img.width = Math.round(
        Math.max(
          32,
          Math.min(IMAGE_PAGE - free.x, (width * IMAGE_PAGE) / el.clientWidth),
        ),
      );
    } else {
      img.width = Math.round(
        Math.max(
          Math.min(32, el.clientWidth),
          Math.min(1600, el.clientWidth, width),
        ),
      );
      img.style.width = `${img.width}px`;
      img.style.height = "auto";
    }
    change.current();
  }
  function toggleMode(free: boolean) {
    if (!image || !editor.current || !!freePosition(image) === free) return;
    const rect = image.getBoundingClientRect();
    const box = editor.current.getBoundingClientRect();
    if (free) {
      image.dataset.veilMode = "free";
      image.width = Math.round(
        Math.max(32, Math.min(794, (rect.width / box.width) * IMAGE_PAGE)),
      );
      image.dataset.veilX = String(
        Math.round(
          Math.max(
            0,
            Math.min(
              794 - image.width,
              ((rect.left - box.left) / box.width) * IMAGE_PAGE,
            ),
          ),
        ),
      );
      image.dataset.veilY = String(
        Math.round(
          Math.max(
            0,
            Math.min(16000, ((rect.top - box.top) / box.width) * IMAGE_PAGE),
          ),
        ),
      );
    } else {
      delete image.dataset.veilMode;
      delete image.dataset.veilX;
      delete image.dataset.veilY;
      image.width = Math.max(
        32,
        Math.round((rect.width * editor.current.clientWidth) / box.width),
      );
      image.style.width = `${image.width}px`;
      image.style.height = "auto";
    }
    change.current();
    redraw((n) => n + 1);
  }
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
      if (
        target instanceof HTMLImageElement &&
        editor.current?.contains(target) &&
        freePosition(target)
      ) {
        e.preventDefault();
        moveImage(target, target, e.pointerId, e.clientX, e.clientY);
      }
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
      if (frame.current) {
        frame.current.dataset.below = String(rect.top < 60);
        frame.current.dataset.align =
          rect.left > innerWidth - 290 ? "right" : "left";
      }
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
      {freePosition(image) && (
        <button
          type="button"
          className="veilImageMove"
          aria-label={t("移動圖片")}
          onPointerDown={(e) => {
            e.preventDefault();
            moveImage(
              image,
              e.currentTarget,
              e.pointerId,
              e.clientX,
              e.clientY,
            );
          }}
          onKeyDown={(e) => {
            const free = freePosition(image)!;
            const delta = e.shiftKey ? 20 : 5;
            if (
              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                e.key,
              )
            )
              return;
            e.preventDefault();
            image.dataset.veilX = String(
              Math.max(
                0,
                Math.min(
                  794 - free.width,
                  free.x +
                    (e.key === "ArrowLeft"
                      ? -delta
                      : e.key === "ArrowRight"
                        ? delta
                        : 0),
                ),
              ),
            );
            image.dataset.veilY = String(
              Math.max(
                0,
                Math.min(
                  16000,
                  free.y +
                    (e.key === "ArrowUp"
                      ? -delta
                      : e.key === "ArrowDown"
                        ? delta
                        : 0),
                ),
              ),
            );
            change.current();
          }}
        />
      )}
      <div className="veilImageModes" onPointerDown={(e) => e.preventDefault()}>
        <button
          type="button"
          aria-pressed={!freePosition(image)}
          onClick={() => toggleMode(false)}
        >
          {t("圖文模式")}
        </button>
        <button
          type="button"
          aria-pressed={!!freePosition(image)}
          onClick={() => toggleMode(true)}
        >
          {t("自由模式")}
        </button>
        <button
          type="button"
          onClick={() => {
            image.remove();
            select(null);
            change.current();
          }}
        >
          {t("刪除圖片")}
        </button>
      </div>
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
              setWidth(
                image,
                width + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -8 : 8),
              );
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
                setWidth(image, width + delta / scale);
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
