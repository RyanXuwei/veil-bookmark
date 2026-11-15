import React, { useEffect, useRef, useState } from "react";
import type { DrawingStroke } from "./crypto";

export function DrawingLayer({
  strokes,
  mode,
  color,
  width,
  onChange,
}: {
  strokes: DrawingStroke[];
  mode: "text" | "pen" | "eraser";
  color: string;
  width: number;
  onChange: (strokes: DrawingStroke[]) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const draft = useRef<DrawingStroke | null>(null);
  const pointer = useRef<number | null>(null);
  const [preview, setPreview] = useState<DrawingStroke | null>(null);
  const [height, setHeight] = useState(1123);
  useEffect(() => {
    const el = svg.current?.parentElement;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setHeight((el.offsetHeight * 794) / el.offsetWidth),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    draft.current = null;
    pointer.current = null;
    setPreview(null);
  }, [mode, strokes]);
  function point(e: React.PointerEvent): [number, number] {
    const r = svg.current!.getBoundingClientRect();
    return [
      Math.round((((e.clientX - r.left) * 794) / r.width) * 10) / 10,
      Math.round((((e.clientY - r.top) * 794) / r.width) * 10) / 10,
    ];
  }
  function erase(e: React.PointerEvent) {
    const [x, y] = point(e);
    const hits = strokes
      .map((s, index) =>
        s.points.some(([px, py], i) => {
          if (!i) return Math.hypot(px - x, py - y) < 12 + s.width;
          const [ax, ay] = s.points[i - 1],
            dx = px - ax,
            dy = py - ay;
          const t = Math.max(
            0,
            Math.min(
              1,
              ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1),
            ),
          );
          return Math.hypot(x - ax - t * dx, y - ay - t * dy) < 12 + s.width;
        })
          ? index
          : -1,
      )
      .filter((i) => i >= 0);
    const hit = hits[hits.length - 1];
    if (hit !== undefined) onChange(strokes.filter((_, i) => i !== hit));
  }
  function finish(e: React.PointerEvent) {
    if (pointer.current !== e.pointerId) return;
    const s = draft.current;
    draft.current = null;
    pointer.current = null;
    setPreview(null);
    if (s) onChange([...strokes, s]);
  }
  const all = preview ? [...strokes, preview] : strokes;
  return (
    <svg
      ref={svg}
      className={"nbDrawing " + mode}
      viewBox={`0 0 794 ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      onPointerDown={(e) => {
        if (mode === "text" || (e.pointerType === "mouse" && e.button !== 0))
          return;
        e.preventDefault();
        svg.current!.setPointerCapture(e.pointerId);
        if (mode === "eraser") {
          erase(e);
          return;
        }
        if (
          strokes.length >= 200 ||
          strokes.reduce((n, s) => n + s.points.length, 0) >= 20000
        )
          return;
        pointer.current = e.pointerId;
        draft.current = { color, width, points: [point(e)] };
        setPreview({ ...draft.current });
      }}
      onPointerMove={(e) => {
        if (mode === "eraser" && e.buttons) {
          erase(e);
          return;
        }
        const s = draft.current;
        if (!s || pointer.current !== e.pointerId) return;
        const p = point(e),
          last = s.points[s.points.length - 1];
        if (
          s.points.length >= 2000 ||
          strokes.reduce((n, s) => n + s.points.length, 0) + s.points.length >=
            20000 ||
          Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5
        )
          return;
        s.points.push(p);
        setPreview({ ...s });
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    >
      {all.map((s, i) => (
        <path
          key={i}
          d={
            s.points.map(([x, y], n) => `${n ? "L" : "M"}${x} ${y}`).join(" ") +
            (s.points.length === 1 ? " l0.1 0" : "")
          }
          fill="none"
          stroke={s.color}
          strokeWidth={s.width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
