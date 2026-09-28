// The part of the repo the agent has been in, as a map: each file a tile sized by its
// length, grouped by folder, with the fence drawn round what the step may change. A file
// it reached for outside the fence is the one tile in the seal colour.

import type { ReactNode } from "react";
import type { RepoMapFile } from "@signet/contracts";

export function RepoMap({ files }: { files: readonly RepoMapFile[] }): ReactNode {
  const groups = new Map<string, RepoMapFile[]>();
  for (const f of files) {
    const i = f.path.lastIndexOf("/");
    const dir = i === -1 ? "" : f.path.slice(0, i + 1);
    groups.set(dir, [...(groups.get(dir) ?? []), f]);
  }
  const reached = files.some((f) => f.reached);
  const tile = (f: RepoMapFile) => (
    <span
      key={f.path}
      className={`ft ${f.reached ? "hit" : f.changed ? "wrote" : f.read ? "read" : ""}`}
      style={{ flexBasis: `${Math.round(Math.sqrt(f.bytes) * 1.6 + 36)}px` }}
      title={f.path}
    >
      {f.path.slice(f.path.lastIndexOf("/") + 1)}
    </span>
  );
  return (
    <div className="rmap">
      {[...groups.entries()].map(([dir, fs]) => {
        const inside = fs.filter((f) => f.fenced);
        const outside = fs.filter((f) => !f.fenced);
        return (
          <div key={dir} className="rdir">
            <span className="dn">{dir || "top level"}</span>
            <div className="rrow">
              {inside.length > 0 && <span className="fencebox">{inside.map(tile)}</span>}
              {outside.map(tile)}
            </div>
          </div>
        );
      })}
      <div className="rlegend">
        <span>
          <i className="ft read" />
          read
        </span>
        <span>
          <i className="ft wrote" />
          changed
        </span>
        <span>
          <i className="fencebox" />
          may change
        </span>
        {reached && (
          <span>
            <i className="ft hit" />
            reached outside
          </span>
        )}
      </div>
    </div>
  );
}
