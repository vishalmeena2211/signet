// Keyboard shortcuts, and the overlay that admits they exist.
//
// A dense console is only fast if you can move without the mouse, and hidden
// shortcuts might as well not exist — so `?` lists them. Everything is
// suppressed while typing: a console that swallows the letter "g" inside a text
// field is worse than one with no shortcuts at all.

import { useEffect, type ReactNode } from "react";
import { navigate, type Route } from "../router.js";
import { Kbd, Row, Stack } from "../ui/primitives.js";

/** Vim-ish "go to" pairs, plus the palette and help. */
const GOTO: Record<string, Route["view"]> = {
  o: "overview",
  w: "work",
  r: "runs",
  c: "constitution",
  a: "activity",
  s: "system",
};

export const SHORTCUTS: readonly { keys: string; does: string }[] = [
  { keys: "⌘K / Ctrl-K", does: "Command palette — go anywhere, run any action" },
  { keys: "g then o", does: "Overview" },
  { keys: "g then w", does: "Work" },
  { keys: "g then r", does: "Runs" },
  { keys: "g then c", does: "Constitution" },
  { keys: "g then a", does: "Activity" },
  { keys: "g then s", does: "System" },
  { keys: "n", does: "New feature" },
  { keys: "↑ ↓ / j k", does: "Move between table rows" },
  { keys: "↵", does: "Open the focused row" },
  { keys: "esc", does: "Close the drawer, palette or overlay" },
  { keys: "?", does: "This list" },
];

/** True when focus is in something that legitimately wants the keystroke. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function useShortcuts({
  onPalette,
  onHelp,
  disabled,
}: {
  onPalette: () => void;
  onHelp: () => void;
  disabled: boolean;
}) {
  useEffect(() => {
    // The "g" prefix waits briefly for its second key, then forgets — so a
    // stray "g" cannot silently arm a jump minutes later.
    let awaitingGoto = false;
    let gotoTimer: ReturnType<typeof setTimeout> | null = null;

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onPalette();
        return;
      }
      if (disabled || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;

      if (awaitingGoto) {
        const view = GOTO[e.key.toLowerCase()];
        awaitingGoto = false;
        if (gotoTimer) clearTimeout(gotoTimer);
        if (view) {
          e.preventDefault();
          navigate({ view } as Route);
        }
        return;
      }

      if (e.key === "g") {
        awaitingGoto = true;
        gotoTimer = setTimeout(() => (awaitingGoto = false), 1200);
        return;
      }
      if (e.key === "n") {
        e.preventDefault();
        navigate({ view: "new" });
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        onHelp();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (gotoTimer) clearTimeout(gotoTimer);
    };
  }, [onPalette, onHelp, disabled]);
}

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--scrim)", zIndex: 80 }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(460px, 92vw)",
          background: "var(--overlay)",
          border: "1px solid var(--line-strong)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--shadow-3)",
          padding: "var(--s5)",
          zIndex: 81,
        }}
      >
        <Stack gap="var(--s3)">
          <Row justify="space-between">
            <strong style={{ fontSize: "var(--fs-md)" }}>Keyboard</strong>
            <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>
              <Kbd>esc</Kbd> to close
            </span>
          </Row>
          <Stack gap="var(--s1)">
            {SHORTCUTS.map((s) => (
              <Row key={s.keys} justify="space-between" gap="var(--s4)">
                <span style={{ color: "var(--fg-muted)" }}>{s.does}</span>
                <Shortcut keys={s.keys} />
              </Row>
            ))}
          </Stack>
        </Stack>
      </div>
    </>
  );
}

function Shortcut({ keys }: { keys: string }): ReactNode {
  return (
    <Row gap="var(--s1)" style={{ flex: "0 0 auto" }}>
      {keys.split(" ").map((k, i) =>
        k === "then" || k === "/" ? (
          <span key={i} style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-xs)" }}>
            {k}
          </span>
        ) : (
          <Kbd key={i}>{k}</Kbd>
        ),
      )}
    </Row>
  );
}
