// A searchable field that offers suggestions without taking the field over.
//
// Deliberately a combobox and not a select. The repository field has to accept
// three different things: a local absolute path, an arbitrary GitHub URL, and one
// of the operator's own repositories. A dropdown that only offered the third would
// break the first two, and a plain text field makes the third a memory test. So
// free text is always valid and the list is a shortcut, never a constraint.
//
// Keyboard-first for the same reason the rest of the console is: arrow keys move,
// Enter takes the highlighted suggestion, Escape closes the list and leaves what
// you typed alone.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

export interface ComboOption {
  /** The value written into the field when chosen. */
  value: string;
  label: string;
  hint?: string;
  /** Shown right-aligned — a language, a timestamp, a badge. */
  meta?: ReactNode;
}

export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  mono = false,
  loading = false,
  emptyNote,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly ComboOption[];
  placeholder?: string;
  mono?: boolean;
  loading?: boolean;
  /** Shown under the list when there is nothing to suggest — say WHY, not "no results". */
  emptyNote?: string;
  /** Enter on the raw text, when no suggestion is highlighted. */
  onSubmit?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const matches = useMemo(() => {
    const needle = value.trim().toLowerCase();
    if (!needle) return options.slice(0, 12);
    // Rank by where the match lands: a prefix match is almost always what
    // someone typing three characters meant.
    return options
      .map((o) => {
        const at = o.label.toLowerCase().indexOf(needle);
        const inHint = o.hint?.toLowerCase().includes(needle) ? 500 : Infinity;
        return { o, score: at >= 0 ? at : inHint };
      })
      .filter((x) => x.score !== Infinity)
      .sort((a, b) => a.score - b.score)
      .slice(0, 12)
      .map((x) => x.o);
  }, [value, options]);

  useEffect(() => setCursor(-1), [value]);

  // Close when focus or a click leaves the control entirely.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  const choose = (o: ComboOption) => {
    onChange(o.value);
    setOpen(false);
    setCursor(-1);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        value={value}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setCursor((c) => Math.min(c + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, -1));
          } else if (e.key === "Enter") {
            const picked = cursor >= 0 ? matches[cursor] : undefined;
            if (picked) {
              e.preventDefault();
              choose(picked);
            } else {
              // Nothing highlighted: the typed text IS the answer.
              setOpen(false);
              onSubmit?.();
            }
          } else if (e.key === "Escape") {
            // Close the list; never discard what was typed.
            setOpen(false);
            setCursor(-1);
          }
        }}
        style={{ width: "100%", ...(mono ? { fontFamily: "var(--mono)" } : {}) }}
      />

      {open && (matches.length > 0 || emptyNote || loading) && (
        <div
          id={listId}
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 30,
            background: "var(--overlay)",
            border: "1px solid var(--line-strong)",
            borderRadius: "var(--r-sm)",
            boxShadow: "var(--shadow-2)",
            maxHeight: 280,
            overflow: "auto",
          }}
        >
          {loading && (
            <div style={{ padding: "var(--s3)", color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
              Reading your repositories…
            </div>
          )}

          {matches.map((o, i) => (
            <button
              key={o.value}
              role="option"
              aria-selected={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(o)}
              style={{
                display: "flex",
                width: "100%",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: "var(--s3)",
                textAlign: "left",
                background: i === cursor ? "var(--accent-quiet)" : "transparent",
                border: "none",
                padding: "var(--s2) var(--s3)",
                cursor: "pointer",
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ fontFamily: mono ? "var(--mono)" : "inherit" }}>{o.label}</span>
                {o.hint && (
                  <span
                    style={{
                      display: "block",
                      color: "var(--fg-subtle)",
                      fontSize: "var(--fs-sm)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {o.hint}
                  </span>
                )}
              </span>
              {o.meta && <span style={{ flex: "0 0 auto" }}>{o.meta}</span>}
            </button>
          ))}

          {!loading && matches.length === 0 && emptyNote && (
            <div style={{ padding: "var(--s3)", color: "var(--fg-muted)", fontSize: "var(--fs-sm)" }}>
              {emptyNote}
            </div>
          )}

          {matches.length > 0 && (
            <div
              style={{
                padding: "var(--s2) var(--s3)",
                borderTop: "1px solid var(--line)",
                color: "var(--fg-subtle)",
                fontSize: "var(--fs-xs)",
              }}
            >
              A local path or any GitHub URL also works — the list is a shortcut, not a limit.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
