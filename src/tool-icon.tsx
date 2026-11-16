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
    paragraph: <path d="M13 4v16M17 4v16M20 4h-9.5a4 4 0 0 0 0 8H13" />,
    h1: <path d="M4 6v12M12 6v12M4 12h8M17 10.5l3-2.5v10" />,
    h2: (
      <path d="M4 6v12M12 6v12M4 12h8M16 10a2.5 2.5 0 0 1 5 .5c0 2.5-5 4-5 7.5h5" />
    ),
    h3: <path d="M4 6v12M12 6v12M4 12h8M16 8h4.5l-3 4a3 3 0 1 1-1.8 5.4" />,
    quote: (
      <path d="M5 7h4.5v4.5C9.5 15 8 17 5 18M14.5 7H19v4.5c0 3.5-1.5 5.5-4.5 6.5" />
    ),
    code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />,
    image: (
      <>
        <rect x="3" y="4.5" width="18" height="15" rx="2" />
        <circle cx="9" cy="10" r="1.8" />
        <path d="m21 15.5-5-5-9.5 9" />
      </>
    ),
    link: (
      <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
    ),
    rule: <path d="M3 12h18M7 7.5h10M7 16.5h10" strokeOpacity=".9" />,
    calendar: (
      <>
        <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
        <path d="M3.5 10h17M8 3v4M16 3v4" />
      </>
    ),
    checkbox: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="m8 12.5 3 3 5-6" />
      </>
    ),
    sidebar: (
      <>
        <rect x="3" y="4.5" width="18" height="15" rx="2" />
        <path d="M9 4.5v15M5.5 8.5h1.5M5.5 11.5h1.5" />
      </>
    ),
    zoom: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 5 5M8 9l1.5-1v5.5M12.5 9l1.5-1v5.5" />
      </>
    ),
    pageWidth: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="1.5" />
        <path d="M8 12h8M10 10l-2 2 2 2M14 10l2 2-2 2" />
      </>
    ),
    pdf: (
      <>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5M12 11v6M9.5 14.5 12 17l2.5-2.5" />
      </>
    ),
    print: (
      <>
        <path d="M7 9V3.5h10V9M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
        <rect x="7" y="14" width="10" height="7" rx="1" />
      </>
    ),
    trash: (
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    ),
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
