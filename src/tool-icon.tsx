import React from "react";
export function ToolIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    text: (
      <>
        <path d="M5 5h14M12 5v14M8 19h8M5 5v3M19 5v3" />
      </>
    ),
    pen: (
      <>
        <path d="m4 20 4-1L20 7a2 2 0 0 0-4-4L4 15zM14 5l5 5M4 15l4 4" />
      </>
    ),
    eraser: (
      <>
        <path d="m4 13 9-9a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 8H8l-4-4a2 2 0 0 1 0-3ZM9 8l8 8M13 20h8" />
      </>
    ),
    mic: (
      <>
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3M9 21h6" />
      </>
    ),
    pause: (
      <>
        <path d="M8 5v14M16 5v14" strokeWidth="3" />
      </>
    ),
    play: <path d="m8 5 11 7-11 7z" />,
    stop: <rect x="5" y="5" width="14" height="14" rx="1" />,
    undo: (
      <>
        <path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14" />
      </>
    ),
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
