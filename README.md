# E-Commerce & Business Management Platform

A full-stack MERN business platform that starts as a family-business e-commerce and management
system and is designed to evolve into a multi-organization / multi-vendor marketplace. See
[`CLAUDE.md`](./CLAUDE.md) for the complete architecture, security and development-governance
rules that apply to all work in this repository.

## Architecture

This repository is a modular-monolith npm workspaces monorepo:

```text
apps/
  web/      customer storefront (Vite + React + TypeScript)
  admin/    admin / business management application (Vite + React + TypeScript)
  api/      backend API skeleton (TypeScript only — Express is added in a later task)
packages/
  config/        shared TypeScript, ESLint and Prettier configuration
  shared-types/  cross-app TypeScript types, shared as business modules need them
```

`apps/api` is intentionally a bare TypeScript skeleton — the Express application, routes,
middleware and database connection are added by later tasks (FOUND-002, DB-001), not by this
initial scaffold.

## Prerequisites

- Node.js `24.21.0` (see [`.nvmrc`](./.nvmrc))
- npm `>=11.0.0 <12`

## Install

```bash
npm install
```

## Workspace Commands

Run from the repository root — each command fans out to every workspace that defines it:

```bash
npm run typecheck     # tsc across all workspaces
npm run lint           # eslint across all workspaces
npm run format          # prettier --write .
npm run format:check    # prettier --check .
npm run build            # build all workspaces
```

To run a single workspace's script directly:

```bash
npm run dev -w @ecommerce/web
npm run dev -w @ecommerce/admin
```

`apps/api` has no `dev` script yet — it has no server to run until FOUND-002.

## Planning Files

Development is file-driven rather than tracked in an external project-management tool. Before
starting any task, read `Planning/MASTER_TASK_LIST.xlsx` for the task definition and acceptance
criteria, and check `Planning/OPEN_DECISIONS.md` and `Planning/ARCHITECTURE_DECISIONS.md` for
relevant decisions. Progress is recorded in `Planning/DEVELOPMENT_PROGRESS.xlsx`,
`Planning/CHANGE_LOG.xlsx` and `Planning/DEVELOPMENT_LOG.md` as work completes. See
[`CLAUDE.md`](./CLAUDE.md) §16–§19 for the full workflow.
