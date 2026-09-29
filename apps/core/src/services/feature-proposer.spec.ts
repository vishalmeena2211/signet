// The proposer's honesty checks, pinned.
//
// A proposal is prose plus globs, and prose always reads fine. The thing that decides
// whether a proposal is any good is whether its file surfaces correspond to reality —
// because a surface is a HARD boundary: a plan touching a file outside it is a
// non-recoverable error and the run is killed with no repair.
//
// So `src/cart/**` for a repo that keeps cart.mjs at the root is not a cosmetic
// mistake. It looks completely reasonable on screen, it will be approved, and it will
// produce a dead run. Catching it before the signature costs nothing.
//
// These tests are about that check and about refusing to invent: proposing against a
// repo we could not read must fail loudly rather than return plausible fiction.

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeatureProposal } from "@signet/contracts";
import { profileRepo, type RepoProfile } from "../domain/learner/repo-profiler.js";
import { FeatureProposer, REAL_INPUT, askQuestions, checkSurfaces, proposalToCreateRequest } from "./feature-proposer.js";

/** The pilot's demo repo in miniature: flat, .mjs, tests named *.test.mjs. */
async function flatRepo(): Promise<{ root: string; profile: RepoProfile; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "signet-proposer-"));
  await writeFile(join(root, "cart.mjs"), "export const cart = () => {};\n");
  await writeFile(join(root, "cart.test.mjs"), "import './cart.mjs';\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "util.mjs"), "export const u = 1;\n");
  return {
    root,
    profile: await profileRepo(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function proposalWithSurface(surface: string[]): FeatureProposal {
  return {
    title: "t",
    understanding: "u",
    steps: [{ title: "step one", rationale: "r", declaredSurface: surface, acceptanceMd: "a", doubts: [] }],
    uncertainties: [],
    noWorkNeeded: null,
  };
}

describe("surfaces are checked against files that actually exist", () => {
  it("flags a plausible-looking glob that matches nothing", async () => {
    const { profile, cleanup } = await flatRepo();
    try {
      // The exact shape of the pilot's dead run: a sensible-sounding directory that
      // this repo does not have.
      const warnings = checkSurfaces(proposalWithSurface(["src/cart/**"]), profile);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.reason).toBe("matches_nothing");
      expect(warnings[0]?.pattern).toBe("src/cart/**");
    } finally {
      await cleanup();
    }
  });

  it("accepts a glob that matches real files", async () => {
    const { profile, cleanup } = await flatRepo();
    try {
      expect(checkSurfaces(proposalWithSurface(["cart.mjs", "src/*.mjs"]), profile)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("allows a NEW file beside an existing one, because new files do not exist yet", async () => {
    const { profile, cleanup } = await flatRepo();
    try {
      // A step that adds discount.mjs next to cart.mjs is legitimate. Refusing every
      // path that is not already on disk would make it impossible to propose creating
      // anything, which is most of the work.
      expect(checkSurfaces(proposalWithSurface(["discount.mjs", "src/new-thing.mjs"]), profile)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("flags a bare word that is not a file at all", async () => {
    const { profile, cleanup } = await flatRepo();
    try {
      // Taken from the pilot's real data. A step titled "do whatever" was given the
      // surface `anything` — the user was asked to invent a glob and typed the most
      // reasonable-sounding word available. The system accepted it, then killed the run
      // with "plan touches files outside the declared surface: cart.mjs".
      //
      // The first version of this check let it through: no wildcard, root directory
      // exists, so it looked like a new file about to be created. A new file has to at
      // least LOOK like a file.
      for (const pattern of ["anything", "everything", "src"]) {
        const warnings = checkSurfaces(proposalWithSurface([pattern]), profile);
        expect(warnings, pattern).toHaveLength(1);
        expect(warnings[0]?.reason, pattern).toBe("matches_nothing");
      }
    } finally {
      await cleanup();
    }
  });

  it("flags a new file in a directory the repo does not have", async () => {
    const { profile, cleanup } = await flatRepo();
    try {
      const warnings = checkSurfaces(proposalWithSurface(["packages/api/handler.mjs"]), profile);
      expect(warnings[0]?.reason).toBe("matches_nothing");
    } finally {
      await cleanup();
    }
  });

  it("flags a surface that hands over the whole repository", async () => {
    const { profile, cleanup } = await flatRepo();
    try {
      // `**` is a surface in name only. The guard is nominally present and enforcing
      // nothing, which is worse than no guard because it looks like one.
      for (const pattern of ["**", "**/*", "*"]) {
        const warnings = checkSurfaces(proposalWithSurface([pattern]), profile);
        expect(warnings[0]?.reason, pattern).toBe("matches_everything");
      }
    } finally {
      await cleanup();
    }
  });

  it("flags anything trying to escape the repository", async () => {
    const { profile, cleanup } = await flatRepo();
    try {
      for (const pattern of ["/etc/passwd", "../other-repo/src/**"]) {
        const warnings = checkSurfaces(proposalWithSurface([pattern]), profile);
        expect(warnings[0]?.reason, pattern).toBe("outside_repo");
      }
    } finally {
      await cleanup();
    }
  });

  it("names the step a bad surface came from, so the warning is actionable", async () => {
    const { profile, cleanup } = await flatRepo();
    try {
      const proposal: FeatureProposal = {
        title: "t",
        understanding: "u",
        uncertainties: [],
        noWorkNeeded: null,
        steps: [
          { title: "good step", rationale: "r", declaredSurface: ["cart.mjs"], acceptanceMd: "a", doubts: [] },
          { title: "bad step", rationale: "r", declaredSurface: ["nope/**"], acceptanceMd: "a", doubts: [] },
        ],
      };
      const warnings = checkSurfaces(proposal, profile);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.stepTitle).toBe("bad step");
    } finally {
      await cleanup();
    }
  });
});

describe("refusing to propose against a repo it could not read", () => {
  it("fails loudly instead of returning plausible fiction", async () => {
    // The failure being prevented: a confident-looking breakdown for a repo that was
    // never surveyed. On screen it is indistinguishable from a real one.
    const proposer = new FeatureProposer({
      targetRepoPath: join(tmpdir(), "signet-nonexistent-repo"),
      adapter: {
        execute: () => {
          throw new Error("the adapter must not be called when there is nothing to plan against");
        },
      },
    });
    const result = await proposer.propose({ goal: "add a discount feature to the shopping cart" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("propose.empty_repo");
  });
});

describe("the proposer never touches the target repository", () => {
  it("points the agent at a scratch directory, not the real repo", async () => {
    const { root, cleanup } = await flatRepo();
    try {
      let sawWorkspace = "";
      const proposer = new FeatureProposer({
        targetRepoPath: root,
        adapter: {
          execute: async (input) => {
            sawWorkspace = input.workspacePath;
            return { ok: true, resultText: "not json" };
          },
        },
      });
      await proposer.propose({ goal: "add a discount feature to the shopping cart" });
      // Proposing is a read-and-think step. It must not be able to leave a mark on the
      // target even by accident, so the survey is handed over as text instead.
      expect(sawWorkspace).not.toBe(root);
      expect(sawWorkspace).toContain("signet-propose-");
    } finally {
      await cleanup();
    }
  });

  it("reports unparseable output as a validation failure, naming the field", async () => {
    const { root, cleanup } = await flatRepo();
    try {
      const proposer = new FeatureProposer({
        targetRepoPath: root,
        adapter: {
          // Steps present but each missing acceptanceMd — the realistic near-miss.
          execute: async () => ({
            ok: true,
            resultText: JSON.stringify({
              title: "t",
              understanding: "u",
              uncertainties: [],
              steps: [{ title: "s", rationale: "r", declaredSurface: ["cart.mjs"] }],
            }),
          }),
        },
      });
      const result = await proposer.propose({ goal: "add a discount feature to the shopping cart" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("propose.unparseable");
      expect(result.error.message).toContain("acceptanceMd");
    } finally {
      await cleanup();
    }
  });

  it("returns warnings alongside a valid proposal rather than rejecting it", async () => {
    const { root, cleanup } = await flatRepo();
    try {
      const proposer = new FeatureProposer({
        targetRepoPath: root,
        adapter: {
          execute: async () => ({
            ok: true,
            resultText: JSON.stringify({
              title: "Discounts",
              understanding: "Add discount support to the cart.",
              uncertainties: ["whether discounts stack"],
              steps: [
                { title: "add helper", rationale: "r", declaredSurface: ["cart.mjs"], acceptanceMd: "returns a new cart", doubts: [] },
                { title: "wire it", rationale: "r", declaredSurface: ["src/checkout/**"], acceptanceMd: "checkout applies it" },
              ],
            }),
          }),
        },
      });
      const result = await proposer.propose({ goal: "add a discount feature to the shopping cart" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The user may know something the survey does not, so a suspect surface is
      // reported rather than used to reject the whole plan.
      expect(result.response.surfaceWarnings).toHaveLength(1);
      expect(result.response.surfaceWarnings[0]?.stepTitle).toBe("wire it");
      expect(result.response.filesSurveyed).toBeGreaterThan(0);
      expect(result.response.surveyTruncated).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("turning an approved proposal into a feature", () => {
  it("carries the acceptance criteria per step", () => {
    // These had nowhere to live until now: acceptance.md was hardcoded empty, so no
    // agent had ever been told what done meant.
    const req = proposalToCreateRequest({
      title: "Discounts",
      understanding: "Add discount support.",
      uncertainties: [],
      noWorkNeeded: null,
      steps: [{ title: "s", rationale: "r", declaredSurface: ["cart.mjs"], acceptanceMd: "rejects >100", doubts: [] }],
    });
    expect(req.increments[0]?.acceptanceMd).toBe("rejects >100");
  });

  it("keeps the open questions in the brief, so signature 1 records them", () => {
    const req = proposalToCreateRequest({
      title: "Discounts",
      understanding: "Add discount support.",
      uncertainties: ["whether discounts stack"],
      noWorkNeeded: null,
      steps: [{ title: "s", rationale: "r", declaredSurface: ["cart.mjs"], acceptanceMd: "a", doubts: [] }],
    });
    expect(req.briefMd).toContain("Add discount support.");
    expect(req.briefMd).toContain("whether discounts stack");
  });
});

describe("a proposal may say there is nothing to do", () => {
  it("accepts an empty plan when it explains why", async () => {
    // The bug this closes, from the first real automated run: the recipe was "add tests to
    // any module missing them", every module already had tests, and the honest answer was
    // an empty list. The schema required at least one step, so the run FAILED with
    // "steps Too small: expected array to have >=1 items" against a clean repo.
    //
    // For something that fires unattended every night, "must find something" is the worst
    // possible bias to encode in a contract.
    const { root, cleanup } = await flatRepo();
    try {
      const proposer = new FeatureProposer({
        targetRepoPath: root,
        adapter: {
          execute: async () => ({
            ok: true,
            resultText: JSON.stringify({
              title: "Nothing to do",
              understanding: "Add tests to any module missing them.",
              steps: [],
              noWorkNeeded: "Every module in this repo already has a sibling test file.",
              uncertainties: [],
            }),
          }),
        },
      });
      const result = await proposer.propose({ goal: "add tests to any module missing them" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.response.proposal.steps).toHaveLength(0);
      expect(result.response.proposal.noWorkNeeded).toContain("already has a sibling test");
    } finally {
      await cleanup();
    }
  });

  it("refuses an empty plan that does NOT explain itself", async () => {
    // Otherwise "nothing to do" and "the model returned nothing useful" are the same
    // response, and an automation quietly doing nothing is the hardest failure to notice.
    const { root, cleanup } = await flatRepo();
    try {
      const proposer = new FeatureProposer({
        targetRepoPath: root,
        adapter: {
          execute: async () => ({
            ok: true,
            resultText: JSON.stringify({
              title: "Nothing",
              understanding: "u",
              steps: [],
              noWorkNeeded: null,
              uncertainties: [],
            }),
          }),
        },
      });
      const result = await proposer.propose({ goal: "add tests to any module missing them" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("noWorkNeeded");
    } finally {
      await cleanup();
    }
  });
});

describe("planning looks at how input really arrives", () => {
  // A Slack command's by=<name> filter was sealed with every promise proven and still
  // failed on first use: people type by=@name, the bot strips mentions before parsing,
  // and the filter was silently dropped. Both planning passes carry the same guidance.
  it("puts the real-input guidance in the questions and the proposal", async () => {
    const { root, cleanup } = await flatRepo();
    try {
      const prompts: string[] = [];
      const adapter = {
        execute: async (input: { prompt: string }) => {
          prompts.push(input.prompt);
          return { ok: true as const, resultText: "not json" };
        },
      };
      await askQuestions({ adapter }, root, "accept by=<name> in the cart command");
      await new FeatureProposer({ targetRepoPath: root, adapter }).propose({ goal: "accept by=<name> in the cart command" });
      expect(prompts).toHaveLength(2);
      for (const prompt of prompts) expect(prompt).toContain(REAL_INPUT);
      expect(REAL_INPUT).toContain("never silently dropped");
    } finally {
      await cleanup();
    }
  });
});
