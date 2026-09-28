// The repo, as Signet read it — a paragraph you can check in ten seconds, instead of a
// settings form that makes you do the survey's job. Facts come from files, not a model:
// the manifest, the lockfile, the config files, and where the tests actually live.
// Anything it is not sure of is said to be unsure, and asked about.

import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PortraitSchema, type Portrait } from "@signet/contracts";
import { z } from "zod";
import { profileRepo } from "../domain/learner/repo-profiler.js";

const exists = (p: string) =>
  access(p)
    .then(() => true)
    .catch(() => false);

const LANGUAGE: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".java": "Java", ".kt": "Kotlin", ".swift": "Swift", ".php": "PHP", ".cs": "C#",
};

const Pkg = z
  .object({
    private: z.boolean().optional(),
    main: z.string().optional(),
    exports: z.unknown().optional(),
    scripts: z.record(z.string(), z.string()).optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
  })
  .loose();

/** What the person told us about a repo, kept beside the instance's other data. */
export class RepoNotes {
  constructor(private readonly path: string) {}
  async all(): Promise<Record<string, string>> {
    try {
      const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(await readFile(this.path, "utf8"))); // signet-policy-allow: raw-json-parse -- validated on this line
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }
  async get(repoPath: string): Promise<string | null> {
    return (await this.all())[repoPath] ?? null;
  }
  async set(repoPath: string, note: string): Promise<void> {
    const all = await this.all();
    all[repoPath] = note;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(all, null, 2), "utf8");
  }
}

export async function portrait(repo: { id: string; label: string; path: string }, notes: RepoNotes): Promise<Portrait> {
  const profile = await profileRepo(repo.path);
  const pieces: Array<{ text: string; fact: boolean; unsure: boolean }> = [];
  const t = (text: string) => pieces.push({ text, fact: false, unsure: false });
  const f = (text: string, unsure = false) => pieces.push({ text, fact: true, unsure });

  const langExt = profile.languages.find((l) => LANGUAGE[l.ext]);
  const language = langExt ? LANGUAGE[langExt.ext] ?? "code" : "code";
  const pkgRaw = profile.manifests.find((m) => m.path === "package.json")?.content;
  let pkg: z.infer<typeof Pkg> | null = null;
  if (pkgRaw) {
    try {
      const parsed = Pkg.safeParse(JSON.parse(pkgRaw)); // signet-policy-allow: raw-json-parse -- validated on this line
      pkg = parsed.success ? parsed.data : null;
    } catch {
      pkg = null;
    }
  }
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const kind = pkg && (pkg.main || pkg.exports) ? "library" : deps["react"] || deps["next"] || deps["vue"] ? "app" : "project";

  t(`A${language.match(/^[AEIOU]/) ? "n" : ""} `);
  f(language);
  t(` ${kind} of `);
  f(`${profile.files.length} files`);

  const manager = (await exists(join(repo.path, "pnpm-lock.yaml")))
    ? "pnpm"
    : (await exists(join(repo.path, "yarn.lock")))
      ? "yarn"
      : (await exists(join(repo.path, "bun.lockb")))
        ? "bun"
        : (await exists(join(repo.path, "package-lock.json")))
          ? "npm"
          : null;
  if (manager) {
    t(", installed with ");
    f(manager);
  }
  t(".");

  const testScript = pkg?.scripts?.["test"] ?? "";
  const framework = deps["vitest"] || /vitest/.test(testScript) ? "vitest" : deps["jest"] || /jest/.test(testScript) ? "jest" : deps["mocha"] ? "mocha" : /node --test|node:test/.test(testScript) ? "node’s own test runner" : testScript ? testScript : null;
  if (framework || profile.testConvention) {
    t(" Tests are written with ");
    f(framework ?? "a test script");
    if (profile.testConvention) {
      const beside = profile.testConvention.examples.some((e) => !/(^|\/)(__tests__|tests?)\//.test(e));
      t(" and live ");
      f(beside ? "beside the module they test" : "in their own folder");
    }
    t(".");
  } else {
    t(" I found ");
    f("no tests", true);
    t(", so the checks will have little to go on.");
  }

  const lint = (await exists(join(repo.path, "eslint.config.js"))) || (await exists(join(repo.path, "eslint.config.mjs")))
    ? "eslint with a flat config"
    : (await exists(join(repo.path, ".eslintrc.json"))) || (await exists(join(repo.path, ".eslintrc.js"))) || (await exists(join(repo.path, ".eslintrc.cjs")))
      ? "eslint"
      : (await exists(join(repo.path, "biome.json")))
        ? "biome"
        : (await exists(join(repo.path, ".oxlintrc.json"))) || deps["oxlint"]
          ? "oxlint"
          : null;
  if (lint) {
    t(" Linting is ");
    f(lint);
    t(".");
  }

  const answered = await notes.get(repo.path);
  const buildScript = pkg?.scripts?.["build"];
  const guess = ["tsup", "vite", "rollup", "esbuild", "webpack", "tsc"].find((b) => deps[b] || (b === "tsc" && deps["typescript"]));
  let doubt: Portrait["doubt"] = null;
  if (buildScript) {
    t(" It is built with ");
    f(buildScript);
    t(".");
  } else if (answered) {
    t(" You told me: ");
    f(answered);
    t(".");
  } else if (guess) {
    t(" I think it is built with ");
    f(`${guess}, run directly`, true);
    t(" — there is no build script, so I am not sure.");
    doubt = { question: "How is it built?", options: [`${guess}, as you guessed`, "It is not built — it ships source", "Something else…"], suggested: 0 };
  }

  // Good first asks: small, and each one checkable. From what the survey found missing.
  const isTest = (p: string) => /\.(spec|test)\./.test(p) || /(^|\/)(__tests__|tests?)\//.test(p);
  // Modules, not the scaffolding around them: scripts, runners and config are not worth a test.
  const scaffolding = (p: string) =>
    p.endsWith(".d.ts") || /config/i.test(p) || /(^|\/)(scripts?|bin|tools?)\//.test(p) || /(^|\/)[^/]*(test|spec)[^/]*$/i.test(p) || /(^|\/)run-[^/]*$/.test(p);
  const sources = profile.files.filter((x) => /\.(ts|tsx|js|jsx|mjs|py|go|rs|rb)$/.test(x.path) && !isTest(x.path) && !scaffolding(x.path));
  const tests = new Set(profile.files.filter((x) => isTest(x.path)).map((x) => x.path.replace(/\.(spec|test)\./, ".")));
  const untested = sources.filter((s) => !tests.has(s.path)).sort((a, b) => b.bytes - a.bytes);
  const asks: string[] = [];
  if (untested.length === 1 && untested[0]) asks.push(`Cover ${untested[0].path} — the only module without a test`);
  else for (const u of untested.slice(0, 2)) asks.push(`Cover ${u.path} — one of ${untested.length} modules without a test`);
  const largest = [...sources].sort((a, b) => b.bytes - a.bytes)[0];
  if (largest) asks.push(`Explain what ${largest.path} does, in a comment at its top`);

  return PortraitSchema.parse({ repoId: repo.id, label: repo.label, path: repo.path, pieces, doubt, answered, asks: asks.slice(0, 3) });
}

/** One line about a repo, for choosing between them: branch, size, tests, how recent. */
export async function glance(path: string): Promise<{ branch: string; files: number; tests: boolean; changed: string | null }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const git = (args: string[]) => run("git", args, { cwd: path }).then((r) => r.stdout.trim()).catch(() => "");
  const [branch, changed, profile] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"]),
    git(["log", "-1", "--format=%cr"]),
    profileRepo(path),
  ]);
  return { branch: branch || "no commits", files: profile.files.length, tests: profile.testConvention !== null, changed: changed || null };
}
