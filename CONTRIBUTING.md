# Contributing to chamba

Thanks for your interest in chamba. This is an open-source AI agent harness built
phase by phase following [PLAN.md](./PLAN.md). Contributions are welcome.

## Setup

Requirements: **Node 22 LTS** and **pnpm 9+**.

```bash
git clone https://github.com/<your-org>/chamba.git
cd chamba
pnpm install
```

## Workflow

- The project is built in ordered phases (see `PLAN.md`). One phase at a time.
- Tests must be green before any commit closes a phase.
- We follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).

## Commands

```bash
pnpm -r build          # build all packages
pnpm -r test           # run all tests
pnpm biome check .     # lint + format check
pnpm biome check --write .   # autofix
```

## Design principles

The 10 non-negotiable design principles live in `PLAN.md` section 2. Read them
before opening a PR — they are the law of the project. If your change has genuine
tension with one of them, open an issue first to discuss.

## Code conventions

- Named exports only (except the `bin/` entrypoints).
- Files in kebab-case (`agent-loop.ts`).
- Types and interfaces in PascalCase; functions and variables in camelCase.
- Errors are classes extending `Error` with an explicit `name`.
- No `any` outside external-SDK adapters (justified with a comment).

## Code of conduct

Be respectful. We build in public, in Spanish and English, sin pena.
