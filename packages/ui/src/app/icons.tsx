// The console's icons: one lucide stroke geometry, the same paths the wireframes draw.

import type { ReactNode } from "react";

function I({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const Icon = {
  inbox: () => (
    <I>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </I>
  ),
  columns: () => (
    <I>
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="10" y="3" width="5" height="12" rx="1" />
      <rect x="17" y="3" width="4" height="8" rx="1" />
    </I>
  ),
  wrench: () => (
    <I>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </I>
  ),
  pen: () => (
    <I>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </I>
  ),
  reply: () => (
    <I>
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </I>
  ),
  git: () => (
    <I>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </I>
  ),
  file: () => (
    <I>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </I>
  ),
  folder: () => (
    <I>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </I>
  ),
  lock: () => (
    <I>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </I>
  ),
  scissors: () => (
    <I>
      <circle cx="6" cy="6" r="3" />
      <path d="M8.12 8.12 12 12" />
      <path d="M20 4 8.12 15.88" />
      <circle cx="6" cy="18" r="3" />
      <path d="M14.8 14.8 20 20" />
    </I>
  ),
  grip: () => (
    <I>
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="19" r="1" />
    </I>
  ),
  undo: () => (
    <I>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </I>
  ),
  check: () => (
    <I>
      <path d="M20 6 9 17l-5-5" />
    </I>
  ),
  x: () => (
    <I>
      <path d="M18 6 6 18M6 6l12 12" />
    </I>
  ),
  plus: () => (
    <I>
      <path d="M12 5v14M5 12h14" />
    </I>
  ),
  pause: () => (
    <I>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </I>
  ),
};

/** A tick in a circle — proven. With `gap`, a cross in the seal colour — not proven. */
export function Tick({ gap = false }: { gap?: boolean }): ReactNode {
  return <span className={`tick ${gap ? "gap" : ""}`}>{gap ? <Icon.x /> : <Icon.check />}</span>;
}
