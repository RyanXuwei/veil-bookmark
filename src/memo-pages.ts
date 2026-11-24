// Notebook pages. A memo keeps one body: its pages are joined by
// <hr data-veil-page="">, so older versions still show every page (as one
// long note with dividers) and lose nothing. Handwriting strokes and voice
// notes carry the 0-based page they belong to (left out on the first page);
// their coordinates stay relative to their own page.
import { MEMO_PAGES_MAX } from "./crypto";

export const PAGE_BREAK = '<hr data-veil-page="">';
export { MEMO_PAGES_MAX };

type OnPage = { page?: number };

/** Pages of a sanitized document (memoHtml); always at least one. */
export function splitPages(html: string): string[] {
  const pages = html.split(PAGE_BREAK);
  if (pages.length <= MEMO_PAGES_MAX) return pages;
  // Never drop text: anything past the limit stays on the last page.
  return [
    ...pages.slice(0, MEMO_PAGES_MAX - 1),
    pages.slice(MEMO_PAGES_MAX - 1).join("<hr>"),
  ];
}

export function joinPages(pages: string[]): string {
  return pages.join(PAGE_BREAK);
}

export const pageOf = (x: OnPage) => x.page || 0;

function onPageAs<T extends OnPage>(x: T, page: number): T {
  const { page: _old, ...rest } = x;
  return (page ? { ...rest, page } : rest) as T;
}

/** Items of one page. */
export function onPage<T extends OnPage>(list: T[], page: number): T[] {
  return list.filter((x) => pageOf(x) === page);
}

/** Replaces one page's items, keeping every other page's. */
export function replacePage<T extends OnPage>(
  list: T[],
  page: number,
  next: T[],
): T[] {
  return [
    ...list.filter((x) => pageOf(x) !== page),
    ...next.map((x) => onPageAs(x, page)),
  ];
}

/** Drops one page's items; later pages move up by one. */
export function removePageItems<T extends OnPage>(
  list: T[],
  page: number,
): T[] {
  return list.flatMap((x) => {
    const p = pageOf(x);
    if (p === page) return [];
    return [p > page ? onPageAs(x, p - 1) : x];
  });
}

/** True when a page holds no text, picture, drawing or voice note. */
export function pageBlank(
  html: string,
  page: number,
  strokes: OnPage[],
  voices: OnPage[],
): boolean {
  const text = html
    .replace(/<img\b/gi, "x<img")
    .replace(/<hr\b/gi, "x<hr")
    .replace(/<[^>]*>|&nbsp;|\s/g, "");
  return (
    !text &&
    !strokes.some((s) => pageOf(s) === page) &&
    !voices.some((v) => pageOf(v) === page)
  );
}

/**
 * Pages to store: blank pages at the end (left by flipping past the last
 * page) are not kept. The first page always stays.
 */
export function storedPages(
  pages: string[],
  strokes: OnPage[],
  voices: OnPage[],
): string[] {
  let n = pages.length;
  while (n > 1 && pageBlank(pages[n - 1], n - 1, strokes, voices)) n--;
  return pages.slice(0, n);
}
