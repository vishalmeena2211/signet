// Text an agent wrote, with its `code` spans shown as code rather than as backticks.

import type { ReactNode } from "react";

export function Inline({ text }: { text: string }): ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
          <span key={i} className="mono" style={{ fontSize: "0.92em" }}>
            {p.slice(1, -1)}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
