// What the agent is doing, kept and shown.
//
// Claude Code streams every tool call it makes — each file it reads, each edit, each
// command, and its own to-do list as it rewrites it. Signet already read that stream,
// but kept only the tokens and the result. So "watch it work" had nothing to show except
// a phase name and a timer, and a run that was reading the wrong half of the codebase
// looked identical to one making steady progress.
//
// Kept as one JSON line per action in the run's own pack directory, beside the context
// the agent was given. Not in the database: it is a trace, written many times a second
// at worst and read only while someone is watching, and losing it would cost a view,
// never a decision. Not in the worktree either — anything written there ends up in the
// diff a person signs.

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AgentActionSchema,
  RunWorkViewSchema,
  type AdapterEvent,
  type AgentAction,
  type RunWorkView,
} from "@signet/contracts";
import { matchesSurface } from "../domain/pipeline/scope-checker.js";

const pexec = promisify(execFile);

/** Enough to see where it has been; a trace of thousands is noise, not evidence. */
const MAX_ACTIONS = 400;
const MAX_MAP_FILES = 80;

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

/** A path the agent used, as the repo would name it. */
function repoRelative(path: string, workspacePath: string): string {
  if (!isAbsolute(path) || workspacePath === "") return path;
  const rel = relative(workspacePath, path);
  // Outside the workspace: keep it absolute, which is itself worth noticing.
  return rel.startsWith("..") ? path : rel.split(sep).join("/");
}

/** One adapter event → one action a person would recognise, or nothing. */
export function toAgentAction(
  ev: AdapterEvent,
  phase: "plan" | "implement",
  workspacePath: string,
  now: Date,
): AgentAction | null {
  if (ev.type !== "tool_use") return null;
  const d = ev.detail ?? {};
  const base = { at: now.toISOString(), phase };
  if (ev.toolName === "TodoWrite") {
    return d.todos ? { ...base, kind: "todos", todos: d.todos } : null;
  }
  if (ev.toolName === "Read" && d.filePath) {
    return { ...base, kind: "read", path: repoRelative(d.filePath, workspacePath) };
  }
  if (EDIT_TOOLS.has(ev.toolName) && d.filePath) {
    return { ...base, kind: "edit", path: repoRelative(d.filePath, workspacePath) };
  }
  if (SEARCH_TOOLS.has(ev.toolName)) {
    return { ...base, kind: "search", text: d.pattern ?? ev.toolName };
  }
  if (ev.toolName === "Bash" && d.command) {
    return { ...base, kind: "command", text: d.command, ...(d.description ? { why: d.description } : {}) };
  }
  return { ...base, kind: "other", text: ev.toolName };
}

export class AgentWorkLog {
  constructor(private readonly packsRoot: string) {}

  private file(runId: string): string {
    return join(this.packsRoot, `run-${runId}`, "activity.jsonl");
  }

  async append(runId: string, action: AgentAction): Promise<void> {
    const f = this.file(runId);
    await mkdir(dirname(f), { recursive: true });
    await appendFile(f, JSON.stringify(action) + "\n", "utf8");
  }

  /** Oldest first. Lines that do not parse are skipped rather than failing the view. */
  async read(runId: string): Promise<AgentAction[]> {
    let raw: string;
    try {
      raw = await readFile(this.file(runId), "utf8");
    } catch {
      return [];
    }
    const out: AgentAction[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = AgentActionSchema.safeParse(JSON.parse(line)); // signet-policy-allow: raw-json-parse -- validated by AgentActionSchema on this line
        if (parsed.success) out.push(parsed.data);
      } catch {
        /* a torn last line from a crash mid-write */
      }
    }
    return out;
  }
}

/**
 * The work view: the agent's latest to-do list, its recent actions, and a map of the part
 * of the repo it has been in — every file in each directory it touched, sized by length,
 * marked read, changed, fenced, or reached-for-outside-the-fence.
 */
export async function buildWorkView(input: {
  runId: string;
  actions: AgentAction[];
  surface: string[];
  workspacePath: string | null;
  /** Files it asked for outside the fence, from an open fence question. */
  reached: string[];
}): Promise<RunWorkView> {
  const latestTodos = [...input.actions].reverse().find((a) => a.kind === "todos")?.todos ?? [];
  const read = new Set(input.actions.filter((a) => a.kind === "read" && a.path).map((a) => a.path as string));
  const changed = new Set(input.actions.filter((a) => a.kind === "edit" && a.path).map((a) => a.path as string));
  const reached = new Set(input.reached);

  // The neighbourhood: directories of every file it read, changed, or reached for, plus
  // the directories the fence names. Listing the whole repository would drown the
  // handful of files that matter.
  const interesting = new Set<string>([...read, ...changed, ...reached]);
  for (const pattern of input.surface) {
    const literal = pattern.split("*")[0] ?? "";
    if (literal !== "") interesting.add(literal.endsWith("/") ? `${literal}_` : literal);
  }
  const dirs = new Set([...interesting].filter((p) => !isAbsolute(p)).map((p) => dirOf(p)));

  let tracked: string[] = [];
  if (input.workspacePath) {
    try {
      const { stdout } = await pexec("git", ["ls-files"], { cwd: input.workspacePath, maxBuffer: 20 * 1024 * 1024 });
      tracked = stdout.split("\n").filter(Boolean);
    } catch {
      tracked = [];
    }
  }
  // New files are not tracked until the run commits, but they are exactly the ones to show.
  const candidates = new Set([...tracked.filter((f) => dirs.has(dirOf(f))), ...changed, ...reached]);
  const ordered = [...candidates]
    .filter((f) => !isAbsolute(f))
    .sort((a, b) => score(b) - score(a) || a.localeCompare(b))
    .slice(0, MAX_MAP_FILES)
    .sort((a, b) => dirOf(a).localeCompare(dirOf(b)) || a.localeCompare(b));
  function score(f: string): number {
    return (changed.has(f) ? 8 : 0) + (reached.has(f) ? 8 : 0) + (read.has(f) ? 4 : 0) + (matchesSurface(f, input.surface) ? 2 : 0);
  }

  const files = await Promise.all(
    ordered.map(async (path) => ({
      path,
      bytes: input.workspacePath
        ? await stat(join(input.workspacePath, path)).then((s) => s.size).catch(() => 0)
        : 0,
      read: read.has(path),
      changed: changed.has(path),
      fenced: matchesSurface(path, input.surface),
      reached: reached.has(path),
    })),
  );

  return RunWorkViewSchema.parse({
    runId: input.runId,
    todos: latestTodos,
    actions: input.actions.filter((a) => a.kind !== "todos").slice(-MAX_ACTIONS),
    files,
    surface: input.surface,
  });
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
