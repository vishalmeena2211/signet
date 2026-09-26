// ⌘K: go anywhere, do anything, without leaving the keyboard.
//
// A dense console is only fast if you never have to hunt. The palette searches
// navigation, live features and the operator actions together, because "pause
// the pipeline" and "open the hero banner feature" are the same kind of thought
// and should not live in different places.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { navigate, NAV, type Route } from "../router.js";
import { Badge, Kbd, Row, Stack } from "../ui/primitives.js";
import { useToast } from "../ui/feedback.js";

interface Item {
  id: string;
  label: string;
  hint?: string;
  group: "Go to" | "Features" | "Actions";
  run: () => void;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const toast = useToast();

  // Only fetch while open: the palette should cost nothing when it is closed.
  const features = useQuery({ queryKey: ["features"], queryFn: api.features, enabled: open });
  const dispatcher = useQuery({ queryKey: ["dispatcher"], queryFn: api.dispatcher, enabled: open });

  const setPaused = useMutation({
    mutationFn: (paused: boolean) => api.setDispatcher({ paused }),
    onSuccess: (s) => {
      toast.push(s.paused ? "Pipeline paused — nothing new will start" : "Pipeline resumed", s.paused ? "warn" : "ok");
      void qc.invalidateQueries({ queryKey: ["dispatcher"] });
      void qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => toast.push(`Could not change the pipeline: ${String(e)}`, "err"),
  });

  useEffect(() => {
    if (open) {
      setQ("");
      setCursor(0);
      // The palette exists to be typed into, so it takes focus immediately.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const nav: Item[] = NAV.map((n) => ({
      id: `nav:${n.view}`,
      label: n.label,
      hint: n.hint,
      group: "Go to",
      run: () => navigate({ view: n.view } as Route),
    }));

    const feats: Item[] = (features.data ?? []).map((f) => ({
      id: `feature:${f.id}`,
      label: f.title,
      hint: `${f.incrementsMerged}/${f.incrementsTotal} merged${f.needsHuman ? " · needs you" : ""}`,
      group: "Features",
      run: () => navigate({ view: "feature", id: f.id }),
    }));

    const paused = dispatcher.data?.paused ?? false;
    const actions: Item[] = [
      {
        id: "action:new",
        label: "New feature",
        hint: "Describe it once, break it into steps",
        group: "Actions",
        run: () => navigate({ view: "new" }),
      },
      {
        id: "action:pause",
        label: paused ? "Resume the pipeline" : "Pause the pipeline",
        hint: paused
          ? "Held work resumes where it left off"
          : "In-flight runs finish; nothing new starts. Survives a restart.",
        group: "Actions",
        run: () => setPaused.mutate(!paused),
      },
      {
        id: "action:learn",
        label: "Learn from a repository",
        hint: "Find the conventions in its code",
        group: "Actions",
        run: () => navigate({ view: "constitution" }),
      },
    ];

    const all = [...nav, ...feats, ...actions];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    // Substring matching, ranked by where the match lands: a prefix match is
    // almost always what someone typing three letters meant.
    return all
      .map((i) => {
        const at = i.label.toLowerCase().indexOf(needle);
        const hintAt = i.hint?.toLowerCase().includes(needle) ? 500 : Infinity;
        return { i, score: at >= 0 ? at : hintAt };
      })
      .filter((x) => x.score !== Infinity)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.i);
  }, [q, features.data, dispatcher.data, setPaused]);

  useEffect(() => setCursor(0), [q]);

  if (!open) return null;

  const grouped = items.reduce<Record<string, Item[]>>((acc, i) => {
    (acc[i.group] ??= []).push(i);
    return acc;
  }, {});
  let flatIndex = -1;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--scrim)", zIndex: 70 }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{
          position: "fixed",
          top: "12vh",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(620px, 92vw)",
          background: "var(--overlay)",
          border: "1px solid var(--line-strong)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--shadow-3)",
          zIndex: 71,
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search features, jump to a screen, or run an action…"
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              const item = items[cursor];
              if (item) {
                item.run();
                onClose();
              }
            }
          }}
          style={{
            width: "100%",
            border: "none",
            borderBottom: "1px solid var(--line)",
            borderRadius: 0,
            background: "transparent",
            padding: "var(--s3) var(--s4)",
            fontSize: "var(--fs-md)",
          }}
        />
        <div style={{ maxHeight: "50vh", overflow: "auto", padding: "var(--s2)" }}>
          {items.length === 0 && (
            <div style={{ padding: "var(--s4)", color: "var(--fg-muted)", textAlign: "center" }}>
              Nothing matches “{q}”.
            </div>
          )}
          {Object.entries(grouped).map(([group, list]) => (
            <div key={group}>
              <div
                style={{
                  padding: "var(--s2) var(--s2) var(--s1)",
                  color: "var(--fg-subtle)",
                  fontSize: "var(--fs-xs)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                {group}
              </div>
              {list.map((item) => {
                flatIndex += 1;
                const on = flatIndex === cursor;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      item.run();
                      onClose();
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: on ? "var(--accent-quiet)" : "transparent",
                      border: "none",
                      borderRadius: "var(--r-sm)",
                      padding: "var(--s2)",
                      cursor: "pointer",
                    }}
                  >
                    <Stack gap="1px">
                      <span style={{ fontWeight: on ? 600 : 400 }}>{item.label}</span>
                      {item.hint && (
                        <span style={{ color: "var(--fg-subtle)", fontSize: "var(--fs-sm)" }}>{item.hint}</span>
                      )}
                    </Stack>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <Row
          gap="var(--s3)"
          style={{
            padding: "var(--s2) var(--s4)",
            borderTop: "1px solid var(--line)",
            color: "var(--fg-subtle)",
            fontSize: "var(--fs-xs)",
          }}
        >
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> run
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
          {setPaused.isPending && <Badge tone="run">working…</Badge>}
        </Row>
      </div>
    </>
  );
}
