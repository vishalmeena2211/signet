// A dense, sortable, keyboard-navigable table.
//
// Cards were the wrong shape for work items: an operator comparing twenty
// increments wants one line each and the ability to sort, not twenty boxes to
// scroll past. Rows are navigable with the arrow keys and openable with Enter,
// because reaching for the mouse on every row is what makes a console tiring.

import { useMemo, useRef, useState, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  /** Omit to make a column unsortable (actions, meters). */
  sort?: (a: T, b: T) => number;
  render: (row: T) => ReactNode;
  width?: string;
  align?: "left" | "right";
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onOpen,
  selectedKey,
  empty,
  initialSort,
}: {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  onOpen?: (row: T) => void;
  selectedKey?: string | null;
  empty?: ReactNode;
  initialSort?: { key: string; dir: "asc" | "desc" };
}) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(initialSort ?? null);
  const [cursor, setCursor] = useState(0);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const cmp = col.sort;
    // Copy before sorting: mutating the query cache's array in place makes
    // React Query hand out reordered data on the next render for no reason.
    const out = [...rows].sort(cmp);
    return sort.dir === "asc" ? out : out.reverse();
  }, [rows, sort, columns]);

  function toggleSort(key: string) {
    setSort((cur) =>
      cur?.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (sorted.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, sorted.length - 1));
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && onOpen) {
      const row = sorted[cursor];
      if (row) onOpen(row);
    }
  }

  if (sorted.length === 0 && empty) {
    return <>{empty}</>;
  }

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--r)",
        overflow: "hidden",
        background: "var(--panel)",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs)" }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{
                  textAlign: c.align ?? "left",
                  padding: "var(--s2) var(--s3)",
                  borderBottom: "1px solid var(--line)",
                  color: "var(--fg-subtle)",
                  fontSize: "var(--fs-xs)",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  whiteSpace: "nowrap",
                  background: "var(--panel)",
                  ...(c.width ? { width: c.width } : {}),
                }}
              >
                {c.sort ? (
                  <button
                    onClick={() => toggleSort(c.key)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      font: "inherit",
                      letterSpacing: "inherit",
                      textTransform: "inherit",
                      color: sort?.key === c.key ? "var(--fg)" : "inherit",
                      cursor: "pointer",
                    }}
                  >
                    {c.header}
                    {sort?.key === c.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                  </button>
                ) : (
                  c.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody
          ref={bodyRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          style={{ outline: "none" }}
          aria-label="Use the arrow keys to move between rows and Enter to open one"
        >
          {sorted.map((row, i) => {
            const key = rowKey(row);
            const isSelected = selectedKey === key;
            const isCursor = i === cursor;
            return (
              <tr
                key={key}
                onClick={() => onOpen?.(row)}
                onMouseEnter={() => setCursor(i)}
                style={{
                  cursor: onOpen ? "pointer" : "default",
                  background: isSelected ? "var(--accent-quiet)" : isCursor ? "var(--panel-2)" : "transparent",
                  borderLeft: `2px solid ${isSelected ? "var(--accent)" : "transparent"}`,
                }}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{
                      padding: "var(--s2) var(--s3)",
                      borderTop: i === 0 ? "none" : "1px solid var(--line)",
                      textAlign: c.align ?? "left",
                      verticalAlign: "middle",
                    }}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
