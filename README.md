# Signet

**A feature implemented autonomously between two human signatures.**

Signet is a post-PRD delivery orchestrator: it takes an approved spec, interrogates away every ambiguity up front, freezes the brief, decomposes the feature into PR-sized increments, drives Claude Code workers through them in parallel along a dependency DAG — and gates every merge on tests that must fail-then-pass, design conformance against the approved design of record, and rules learned from the codebase itself.

## Architecture in one line

One **master** (this repo's `apps/core`: NestJS + Postgres — sole owner of state, the DAG, quota, verdicts) and many **ephemeral workers** (Claude Code processes + gate sandbox jobs) that never talk to each other.

- Plan: `../orchestrator-plan-2026-09-25.md`
- Architecture: `../orchestrator-architecture-2026-09-25.md`

## Workspace

| Package | What |
| --- | --- |
| `apps/core` | the master: runtime, adapter, gates, learner, memory, API, serves the web console |
| `apps/desktop` | Electron shell (stub until Phase 2) |
| `packages/contracts` | the spine: every cross-boundary shape as a zod schema, types inferred |
| `packages/ui` | the shared React app (five-noun screens) |
| `packages/typescript-config` / `eslint-config` | shared strict configs |
| `tooling/policy` | the enforcement arm: boundary, drift, and invariant checks that fail |

## Commands

```bash
pnpm dev          # core in watch mode
pnpm check        # check-types + lint + policy + test — the merge bar
pnpm policy       # invariant checks alone
```

Engine: the user's own Claude Code installation and subscription — Signet never uses API keys.

Versions are pinned facts, not vibes: see `VERSIONS.md`.
