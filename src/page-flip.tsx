// Turning notebook pages by pulling past the end: at the bottom of a page,
// keep scrolling (mouse wheel / touchpad) or keep dragging up (touch) and the
// next page opens; past the last page a new blank page is added. Pulling
// past the top goes back a page. A light pull only shows the hint, so normal
// reading never turns a page by accident.
import React, { useEffect, useRef, useState } from "react";
import { t } from "./i18n";

// Wheel distance (CSS px) to keep scrolling past the edge, and the pause
// that ends one pull.
const WHEEL_PULL = 900;
const WHEEL_GAP = 450;
// After a turn, the rest of the same scroll gesture (touchpad momentum) must
// not scroll the new page away from its start.
const SETTLE = 700;
// Finger travel past the edge.
const TOUCH_PULL = 140;

export type Pull = { dir: "next" | "prev"; progress: number } | null;

const atBottom = (el: HTMLElement) =>
  el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
const atTop = (el: HTMLElement) => el.scrollTop <= 1;

export function usePageFlip(
  scroller: React.RefObject<HTMLElement | null>,
  options: {
    enabled: boolean;
    canPrev: boolean;
    onNext: () => void;
    onPrev: () => void;
  },
): Pull {
  const [pull, setPull] = useState<Pull>(null);
  const opts = useRef(options);
  opts.current = options;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let wheel = 0;
    let wheelDir: "next" | "prev" | null = null;
    let wheelTimer = 0;
    let settled = 0;
    let settleLimit = 0;
    let touch: { y: number; dir: "next" | "prev" | null; from: number } | null =
      null;
    let touchProgress = 0;
    const show = (dir: "next" | "prev", progress: number) =>
      setPull(
        progress > 0.08 ? { dir, progress: Math.min(1, progress) } : null,
      );
    const reset = () => {
      wheel = 0;
      wheelDir = null;
      setPull(null);
    };
    const fire = (dir: "next" | "prev") => {
      reset();
      settled = Date.now() + SETTLE;
      settleLimit = Date.now() + 2 * SETTLE;
      if (dir === "next") opts.current.onNext();
      else opts.current.onPrev();
    };
    const onWheel = (e: WheelEvent) => {
      if (Date.now() < settled && !e.ctrlKey) {
        e.preventDefault();
        // Until the gesture really stops (at most a moment longer).
        settled = Math.min(settleLimit, Date.now() + 200);
        return;
      }
      if (!opts.current.enabled || e.ctrlKey) return reset();
      const dy =
        e.deltaY * (e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 800 : 1);
      const dir =
        dy > 0 && atBottom(el)
          ? "next"
          : dy < 0 && atTop(el) && opts.current.canPrev
            ? "prev"
            : null;
      window.clearTimeout(wheelTimer);
      if (!dir || dir !== wheelDir) {
        wheel = 0;
        wheelDir = dir;
        if (!dir) return setPull(null);
      }
      wheel += Math.abs(dy);
      if (wheel >= WHEEL_PULL) return fire(dir);
      show(dir, wheel / WHEEL_PULL);
      wheelTimer = window.setTimeout(reset, WHEEL_GAP);
    };
    const onTouchStart = (e: TouchEvent) => {
      touch =
        opts.current.enabled && e.touches.length === 1
          ? { y: e.touches[0].clientY, dir: null, from: 0 }
          : null;
      touchProgress = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touch || !opts.current.enabled || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      // The pull starts where the finger was when the edge was reached.
      if (!touch.dir) {
        if (y < touch.y && atBottom(el))
          touch = { ...touch, dir: "next", from: y };
        else if (y > touch.y && atTop(el) && opts.current.canPrev)
          touch = { ...touch, dir: "prev", from: y };
        else {
          touch.y = y;
          return;
        }
      }
      const distance = touch.dir === "next" ? touch.from - y : y - touch.from;
      touchProgress = Math.max(0, distance / TOUCH_PULL);
      show(touch.dir!, touchProgress);
    };
    const onTouchEnd = () => {
      const dir = touch?.dir;
      touch = null;
      if (dir && touchProgress >= 1) fire(dir);
      else setPull(null);
      touchProgress = 0;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      window.clearTimeout(wheelTimer);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
    // The scroller appears once the notebook is unlocked.
  }, [scroller.current]);
  useEffect(() => {
    if (!options.enabled) setPull(null);
  }, [options.enabled]);
  return pull;
}

/** The hint shown while pulling: where the page turn will go. */
export function FlipHint({
  pull,
  page,
  pages,
  touch,
}: {
  pull: Pull;
  page: number; // 0-based, current
  pages: number;
  touch?: boolean;
}) {
  if (!pull) return null;
  const target = pull.dir === "next" ? page + 2 : page;
  const ready = pull.progress >= 1;
  const label =
    pull.dir === "next" && page + 1 >= pages
      ? ready
        ? t("放開以新增第 {page} 頁", { page: target })
        : touch
          ? t("繼續往上拉，新增第 {page} 頁", { page: target })
          : t("繼續往下捲動，新增第 {page} 頁", { page: target })
      : ready
        ? t("放開以翻到第 {page} 頁", { page: target })
        : pull.dir === "next"
          ? touch
            ? t("繼續往上拉，翻到第 {page} 頁", { page: target })
            : t("繼續往下捲動，翻到第 {page} 頁", { page: target })
          : touch
            ? t("繼續往下拉，回到第 {page} 頁", { page: target })
            : t("繼續往上捲動，回到第 {page} 頁", { page: target });
  return (
    <div
      className={"flipHint " + pull.dir + (ready ? " ready" : "")}
      role="status"
    >
      <span>{label}</span>
      <i style={{ transform: `scaleX(${Math.min(1, pull.progress)})` }} />
    </div>
  );
}
