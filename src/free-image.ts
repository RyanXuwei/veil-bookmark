// The drawing layer uses a 794-unit page. Free pictures use the same scale
// across desktop and mobile; inline widths remain ordinary CSS pixels.
export const IMAGE_PAGE = 794;
export function freePosition(img: Element) {
  if (img.getAttribute("data-veil-mode") !== "free") return null;
  const number = (name: string, max: number) => {
    const raw = img.getAttribute(name) || "0";
    return /^\d{1,5}$/.test(raw) ? Math.min(max, +raw) : 0;
  };
  const width = Math.max(
    32,
    Math.min(794, Number(img.getAttribute("width")) || 320),
  );
  return {
    width,
    x: Math.min(794 - width, number("data-veil-x", 794)),
    y: number("data-veil-y", 16000),
  };
}

export function layoutFreeImages(editor: HTMLElement) {
  const scale = editor.clientWidth / IMAGE_PAGE;
  let bottom = 0;
  for (const img of Array.from(
    editor.querySelectorAll<HTMLImageElement>("img[data-veil-img]"),
  )) {
    const free = freePosition(img);
    if (!free) {
      img.style.position =
        img.style.left =
        img.style.top =
        img.style.zIndex =
          "";
      img.style.touchAction = "";
      continue;
    }
    img.onload = () => layoutFreeImages(editor);
    Object.assign(img.style, {
      position: "absolute",
      left: `${(free.x / IMAGE_PAGE) * 100}%`,
      top: `${free.y * scale}px`,
      width: `${(free.width / IMAGE_PAGE) * 100}%`,
      height: "auto",
      marginBottom: "0px",
      zIndex: "1",
      touchAction: "none",
    });
    bottom = Math.max(
      bottom,
      free.y * scale +
        (img.naturalHeight / (img.naturalWidth || 1)) * free.width * scale +
        24,
    );
  }
  // Reset before measuring the stylesheet minimum so moving up can shrink it.
  editor.style.minHeight = "";
  if (bottom)
    editor.style.minHeight = `${Math.max(bottom, parseFloat(getComputedStyle(editor).minHeight) || 0)}px`;
}

export function observeImageLayout(editor: HTMLElement) {
  let width = -1;
  const observer = new ResizeObserver(() => {
    if (editor.clientWidth === width) return;
    width = editor.clientWidth;
    layoutFreeImages(editor);
  });
  observer.observe(editor);
  return () => observer.disconnect();
}
