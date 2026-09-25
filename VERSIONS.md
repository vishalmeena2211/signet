# Pinned versions — Signet

**Pinned:** 25 September 2026 (scaffold day, via `create-turbo@latest`). Reviewed monthly (`pnpm outdated -r`); update this file with every deliberate bump.

## How to read

Each entry is the version the repo is built and tested against. "Floor" means the engines constraint; exact resolved versions live in `pnpm-lock.yaml`. This file exists so "latest" stays a dated fact, not a vibe.

| Concern | Version | Source of truth |
| --- | --- | --- |
| Node | 24.x LTS (floor 24.11; dev machine 24.15.0) | `package.json` engines |
| pnpm | 11.25.0 | `packageManager` field |
| TypeScript | 7.0.2 | root devDependencies |
| Turborepo | ^2.11.4 | root devDependencies |
| Prettier | 3.9.6 | root devDependencies |
| Claude Code (driven, not bundled) | 2.1.281 on dev machine; adapter `probe()` records per-machine | adapter probe |
| NestJS | pin at apps/core creation | apps/core package.json |
| Prisma | pin at persistence task | apps/core package.json |
| React | 19.x — pin at packages/ui adaptation | packages/ui package.json |
| Vite | pin at packages/ui adaptation | packages/ui package.json |
| Electron | pin at Phase 2 | apps/desktop package.json |
| Playwright | pin at gates task | apps/core package.json |
| zod | pin at contracts task | packages/contracts package.json |

## Monthly review log

- 2026-09-25 — initial pin (scaffold).
