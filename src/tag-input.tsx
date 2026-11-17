import React, { useId, useMemo, useRef, useState } from "react";
import { t } from "./i18n";

const MAX_TAGS = 30;
const MAX_LENGTH = 50;
const split = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Tags as removable chips. A comma, Enter or Tab turns the typed text into a
 *  chip; Backspace on an empty field removes the last one. Tags used on other
 *  bookmarks are offered as a quick-pick list, most used first. The value
 *  stays the comma-separated string the background expects. */
export function TagInput({
  value,
  onChange,
  known,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  known: string[][];
  label: string;
}) {
  const tags = split(value);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  // Every tag in use, most used first (ties alphabetically).
  const ranked = useMemo(() => {
    const count = new Map<string, { name: string; n: number }>();
    for (const list of known)
      for (const name of list) {
        const k = name.toLowerCase();
        const c = count.get(k);
        if (c) c.n++;
        else count.set(k, { name, n: 1 });
      }
    return [...count.values()]
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
      .map((x) => x.name);
  }, [known]);
  const q = draft.trim().toLowerCase();
  const options = ranked
    .filter((x) => !tags.some((y) => same(x, y)))
    .filter((x) => !q || x.toLowerCase().includes(q))
    .slice(0, 6);
  const shown = open && options.length > 0;

  function set(next: string[]) {
    onChange(next.join(", "));
  }
  function add(raw: string) {
    const names = split(raw).map((x) => x.slice(0, MAX_LENGTH));
    const next = [...tags];
    for (const name of names)
      if (next.length < MAX_TAGS && !next.some((y) => same(y, name)))
        next.push(ranked.find((y) => same(y, name)) || name);
    set(next);
    setDraft("");
    setActive(0);
  }
  function remove(i: number) {
    set(tags.filter((_, j) => j !== i));
    input.current?.focus();
  }
  function highlight(name: string) {
    const i = q ? name.toLowerCase().indexOf(q) : -1;
    if (i < 0) return <span>{name}</span>;
    return (
      <span>
        {name.slice(0, i)}
        <b>{name.slice(i, i + q.length)}</b>
        {name.slice(i + q.length)}
      </span>
    );
  }

  return (
    <div className="tagInput">
      <span className="tagLabel">{label}</span>
      <div className="tagBox" onClick={() => input.current?.focus()}>
        {tags.map((name, i) => (
          <span className="tagChip" key={`${name}-${i}`}>
            <span className="tagMark" aria-hidden="true">
              #
            </span>
            {name}
            <button
              type="button"
              aria-label={t("移除標籤：{tag}", { tag: name })}
              onClick={(e) => {
                e.stopPropagation();
                remove(i);
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          aria-label={label}
          role="combobox"
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          value={draft}
          maxLength={MAX_LENGTH * 2}
          placeholder={tags.length ? "" : t("輸入後按逗號或 Enter")}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            if (draft.trim()) add(draft);
          }}
          onChange={(e) => {
            const v = e.target.value;
            // Typing or pasting a comma completes the tags before it.
            if (v.includes(",") || v.includes("，")) {
              const parts = v.replace(/，/g, ",").split(",");
              add(parts.slice(0, -1).join(","));
              setDraft(parts[parts.length - 1]);
            } else setDraft(v);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" && shown) {
              e.preventDefault();
              setActive((active + 1) % options.length);
            } else if (e.key === "ArrowUp" && shown) {
              e.preventDefault();
              setActive((active - 1 + options.length) % options.length);
            } else if (e.key === "Enter" || e.key === "Tab") {
              const pick = shown && q ? options[active] : undefined;
              if (pick || draft.trim()) {
                e.preventDefault();
                add(pick || draft);
              }
            } else if (e.key === "Escape" && shown) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            } else if (e.key === "Backspace" && !draft && tags.length) {
              e.preventDefault();
              set(tags.slice(0, -1));
            }
          }}
        />
      </div>
      {shown && (
        <ul className="tagOptions" id={listId} role="listbox">
          {options.map((name, i) => (
            <li
              key={name}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onMouseEnter={() => setActive(i)}
              // mousedown keeps focus in the field (blur would close the list).
              onMouseDown={(e) => {
                e.preventDefault();
                add(name);
              }}
            >
              <span className="tagMark" aria-hidden="true">
                #
              </span>
              {highlight(name)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
