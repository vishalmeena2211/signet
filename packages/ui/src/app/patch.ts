// A unified diff → rows that know which file and new-side line they are, so a note can
// point at one.

export interface PatchRow {
  text: string;
  kind: "meta" | "hunk" | "add" | "del" | "ctx";
  file: string | null;
  /** New-side line number; null for removed lines and headers, which a note cannot sit on. */
  line: number | null;
}

export function patchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let file: string | null = null;
  let line = 0;
  for (const text of patch.split("\n")) {
    if (text.startsWith("+++ ")) {
      const p = text.slice(4).replace(/^b\//, "").trim();
      file = p === "/dev/null" ? null : p;
      rows.push({ text, kind: "meta", file, line: null });
    } else if (/^(--- |diff --git|index |new file|deleted file|similarity|rename )/.test(text)) {
      rows.push({ text, kind: "meta", file, line: null });
    } else if (text.startsWith("@@")) {
      line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
      rows.push({ text, kind: "hunk", file, line: null });
    } else if (text.startsWith("+")) {
      rows.push({ text, kind: "add", file, line: line++ });
    } else if (text.startsWith("-")) {
      rows.push({ text, kind: "del", file, line: null });
    } else if (text.startsWith(" ")) {
      rows.push({ text, kind: "ctx", file, line: line++ });
    }
  }
  return rows;
}
