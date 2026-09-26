// The words the console says out loud.
//
// Every user-facing noun lives here, in one file, because the internal name and
// the spoken name are allowed to differ — and they should. The API, the database
// and the variable names say "increment" because that is what the domain model
// calls it; the screen says "step", because nobody outside this codebase has ever
// described their work as an increment.
//
// Keeping the mapping in one place means changing the product's vocabulary is a
// one-line edit rather than a search-and-replace across nine screens, and it makes
// the jargon inventory auditable: if a word is not here, it should not be on
// screen.
//
// Rules applied when choosing these:
//   · Prefer the word a user would say to a colleague, not the word in the design
//     document. "Step", not "increment". "Checks", not "gates".
//   · Prefer plain over clever. "Rules" beats "constitution", however good the
//     metaphor is internally.
//   · Keep precision where precision is the point. "Merge" stays "merge" because
//     it is literally a git merge, and softening it would mislead.
//   · Sentence case everywhere. Title Case is for proper nouns.

export const WORDS = {
  /**
   * INTERNAL: increment. One PR-sized piece of a feature, with its own run and its
   * own two approvals. "Step" is what people actually say about a piece of work
   * that is part of a bigger thing.
   */
  step: "step",
  steps: "steps",
  Step: "Step",
  Steps: "Steps",

  /** INTERNAL: feature. Already plain; kept for completeness and consistency. */
  feature: "feature",
  features: "features",
  Feature: "Feature",

  /**
   * INTERNAL: run. An attempt at one step. "Run" survives — it is short, ordinary
   * and already how people talk about CI.
   */
  run: "run",
  runs: "runs",
  Run: "Run",
  Runs: "Runs",

  /**
   * INTERNAL: gate. "Checks" is what GitHub calls them and what everyone already
   * understands; "gate" is precise about blocking but is our word, not theirs.
   */
  check: "check",
  checks: "checks",
  Checks: "Checks",

  /**
   * INTERNAL: design of record. The approved visual ground truth a change is
   * judged against. "Approved design" says the same thing without the legalese.
   */
  approvedDesign: "approved design",
  ApprovedDesign: "Approved design",

  /**
   * INTERNAL: escalation. The agent stopping to ask rather than guess. It is a
   * question; calling it an escalation makes it sound like a complaint.
   */
  question: "question",
  questions: "questions",
  Question: "Question",

  /**
   * INTERNAL: constitution. Evocative internally, opaque on a screen. These are
   * rules.
   */
  rules: "rules",
  Rules: "Rules",

  /**
   * INTERNAL: declared surface. The files a step is allowed to change. Saying it
   * as a sentence beats naming it as a term.
   */
  allowedFiles: "files it may change",
  AllowedFiles: "Files it may change",

  /**
   * INTERNAL: context pack. What the agent was given before it wrote any code.
   */
  briefing: "briefing",
  Briefing: "Briefing",

  /** INTERNAL: worktree. A private copy of the repository for one step. */
  workingCopy: "working copy",
  WorkingCopy: "Working copy",

  /** INTERNAL: dispatcher. What starts and holds work. */
  pipeline: "pipeline",
  Pipeline: "Pipeline",
} as const;

/**
 * Rule lifecycle, in words rather than database values. "Demoted" described what
 * the system did to the row; these describe what the operator should understand.
 */
export const RULE_STATUS: Record<string, { label: string; blurb: string }> = {
  PROPOSED: {
    label: "Suggested",
    blurb: "Found in your code. Nothing is enforced until you accept it.",
  },
  CONFIRMED: {
    label: "Accepted",
    blurb: "Warns when new code breaks it.",
  },
  DEMOTED: {
    label: "Set aside",
    blurb: "Turned itself off after three false alarms. Accept it again only if it is still right.",
  },
};

/**
 * The two approvals. The product thinks of them as signatures, which is a good
 * internal idea and a poor button label — a button should say what pressing it
 * does.
 */
export const APPROVALS = {
  first: { button: "Approve and start", meaning: "Signet begins work on this step." },
  second: { button: "Merge", meaning: "The change lands on your main branch." },
} as const;
