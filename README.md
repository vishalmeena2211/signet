# Signet

**A feature built between two human signatures.**

You say what you want. Signet reads your repository, proposes how to break the work
up, writes the code, and runs every check. You sign twice: once on the plan, once on
the diff. Nothing reaches your branch without the second signature.

It drives **your** Claude Code installation and subscription. Signet never holds an
API key.

```
you describe it
     │
     ▼
  ┌─────────────────┐
  │ Signet reads    │  surveys the repo, proposes steps and the files each may touch
  │ your repo       │
  └────────┬────────┘
           ▼
     ✍ signature 1 ─── you approve the plan ─── nothing has run or cost anything yet
           │
           ▼
  ┌─────────────────┐
  │ writes the code │  in its own worktree, on its own branch
  │ runs 5 checks   │  types · lint · tests · design · conventions
  └────────┬────────┘
           │  a failing check goes back to the agent, up to 3 times
           ▼
     ✍ signature 2 ─── you review the diff and merge ─── a real `git merge --no-ff`
```

---

## Why it works this way

Most agent runners optimise for how much they can do without you. Signet optimises
for the two moments where your judgement is worth more than throughput, and makes
everything in between boring.

**Signature 1 approves spending.** Nothing has cost anything when you press it.

**Signature 2 approves code landing.** You see the diff, every check verdict, the
acceptance criteria the agent was aiming at, and which version of your request it
was built from. Nobody should sign blind.

The consequence worth stating: automation can reach signature 2, and never past it.
A scheduled workflow will prepare work, start it, run the checks and then stop —
waiting for you. That is the whole reason it is safe to leave switched on.

## The five checks

Every step must pass all of them before it can ask for your signature.

| Check | Blocks? | What it means |
| --- | --- | --- |
| **types** | yes | `tsc --noEmit` is clean |
| **lint** | yes | your lint rules pass on the changed files |
| **tests** | yes | the suite passes, **and** new tests fail against the old code |
| **design** | yes | the change matches a design of record you approved |
| **conventions** | warns | rules Signet learned from your codebase |

The tests check is the unusual one. It is not enough that tests pass — a new test
must **fail against the base commit**, or it proves nothing about the change. A test
that passes before your change is not testing your change.

That rule applies only when a source file also changed. A behaviour-preserving
refactor passes before and after by definition, and demanding otherwise would block
every refactor and every addition of coverage to code that already works.

## Quick start

**Requires** Node 24.11+, pnpm 11.25, and a working `claude` CLI on your `PATH`
(signed in — Signet uses your subscription, not an API key).

```bash
pnpm install
pnpm console
```

One command. It starts an embedded Postgres, applies migrations, builds whatever is
stale, and serves the console and API together on **http://127.0.0.1:4700**.

Then: **New feature** → pick a repo → describe the outcome → **Propose a plan**.

No environment variables needed. It defaults to a demo repository under
`~/.signet/` so you can watch a feature go end to end before pointing it at
anything you care about.

<details>
<summary>Configuring it properly</summary>

| Variable | Default | What |
| --- | --- | --- |
| `SIGNET_TARGET_REPO_PATH` | `~/.signet/demo-repo` | the repo used when a feature does not name its own |
| `SIGNET_DATABASE_URL` | embedded Postgres on 5765 | state lives here |
| `SIGNET_WORKSPACES_ROOT` | `~/.signet/workspaces` | one git worktree per step |
| `SIGNET_PACKS_ROOT` | `~/.signet/packs` | what each run was told, kept for audit |

A feature can target any **local** git repo, chosen per feature in the UI. Your
GitHub repositories are listed too, but marked **plan only**: Signet can survey and
plan against one, and cannot merge into it, because merging means pushing.

</details>

## The console

Eight screens, each answering one question.

| Screen | Answers |
| --- | --- |
| **Overview** | what needs me, and what is running |
| **Work** | everything being built, with each feature's steps as a strip |
| **Runs** | every attempt and how it went |
| **Rules** | what Signet learned from your code, pending your confirmation |
| **Graph** | how those learnings connect |
| **Automations** | saved requests, and what runs them on a schedule |
| **Activity** | what the system has been doing |
| **System** | how this copy is configured, and whether it is healthy |

A run is drawn as a pipeline: each phase with its duration, the five checks as
parallel branches, and a repair loop as an arrow going *backwards* rather than a
number. The last node is your merge, and it has no outgoing edge.

## Automations

A **recipe** is a saved request. Leave `{{blanks}}` in it and it is a template you
fill in; leave none and it is one click. A **workflow** is an ordered set of recipes
plus a trigger — a schedule, or something happening inside Signet.

Four guards, written before anything ran rather than after something ran away:

- **A kill switch** for all automation, separate from pausing the pipeline. One stops
  work from *running*; the other stops work from being *created*.
- **A depth limit.** An event-triggered workflow can cause the event it listens for.
- **No self-retrigger.** A workflow never fires on an event its own run produced.
- **Templates are refused.** Unattended means nobody is there to fill in a blank.

Only the **first** step of a feature is started, so one trigger cannot consume a
whole quota window. And every refusal is recorded with its reason: a skip that leaves
no trace is indistinguishable from never having fired.

## Architecture

One **master** and many **ephemeral workers** that never talk to each other.

```
apps/core            the master — runtime, gates, learner, API, serves the console
apps/desktop         Electron shell (a stub; not built yet)
packages/contracts   the spine: every cross-boundary shape as a zod schema
packages/ui          the console, a React app
tooling/policy       boundary and invariant checks that fail the build
```

`packages/contracts` is load-bearing. Every shape that crosses a boundary is a zod
schema first and a TypeScript type second, inferred, never written twice. State
payloads are validated at the persistence boundary: the database stores, contracts
decide.

A run walks seven phases, and can be resumed from any of them after a crash:

```
ASSEMBLE_PACK → CREATE_WORKSPACE → AGENT_PLAN → SCOPE_CHECK → AGENT_IMPLEMENT → GATES → FINALIZE
```

`SCOPE_CHECK` is the one to understand. Each step declares which files it may touch,
and a plan that reaches outside that is **non-recoverable** — the run stops rather
than negotiating. Those surfaces are proposed by Signet, from a survey of your repo,
rather than typed by you.

## Development

```bash
pnpm check     # the merge bar: build + types + lint + policy + tests
pnpm dev       # core in watch mode
pnpm policy    # invariant checks alone
```

`pnpm check` is the whole bar, and it is not advisory. Two things worth knowing about
it:

- `SIGNET_DATABASE_URL` must be set for the database-backed suites to run, and it is
  declared under turbo's `env` so the cache key includes it. Without it 28 tests skip
  — and 28 skips read as a pass.
- Every suite gets its **own** database, cloned from a migrated template. They used
  to share one and tear down by truncating it, which meant whichever suite finished
  first wiped the data out from under the others.

Versions are pinned facts rather than vibes: see [VERSIONS.md](VERSIONS.md).

## What is honest about this

**Proven end to end.** A workflow trigger through propose, create, signature 1, code,
checks, signature 2 and a real `git merge` — on a published npm package, whose tests
pass on `main` afterwards.

**Not done yet.**

- **Pushing.** Nothing in the run path pushes, which is why GitHub repos are plan
  only. Local repos work completely.
- **Branching workflows.** The engine walks a list, so the canvas draws a chain. No
  conditions, no parallel paths, no data passed between steps.
- **Two of four automation triggers.** `step_merged`, `run_failed`,
  `rules_proposed` and `quota_reset` all fire; GitHub events do not exist, because
  that would need a publicly reachable endpoint.
- **The design check needs a design.** With no approved design of record it skips,
  rather than inventing an opinion.

**A note on the test suite.** 427 tests, and the most valuable bugs this project has
had were found by running the whole thing for real rather than by any of them —
including a repair loop that spent 49 rounds on one step because a counter was never
persisted, and a worktree that had no dependencies installed so every check exited
"command not found". The fixture hid that one for weeks: it runs
`node run-tests.mjs`, which needs nothing installed, so every green run was green for
the wrong reason.

---

Engine: your own Claude Code installation and subscription. Signet never uses API keys.
