# AGENTS.md — dsh-hub

This directory **is** the **dsh-hub** product (public HTTP Hub + HPC outbound agent). It lives at `hub/` inside deepseek-harness so `connect` can launch a live `dsh` from this checkout or a global install. It is not a harness package group and not a pnpm workspace member.

- Change Hub behavior only under `hub/`. Do not move this tree into `packages/`, do not rename its packages to `@deepseek-ai/dsh-*`, and do not edit harness plugins for a Hub feature that an overlay can provide.
- npm names here are `dsh-hub` (the bin) and `@dsh-hub/*` (`webserver-unix`, `logout`, `preview`).
- Tests: `npm test` in this directory (`node --test` via `hub/package.json`), not root `pnpm run test`. Node `^22.19 || >=24`.
- Operator docs: [README.md](README.md) (connect profile path, layer order, what each connect rewrites, plugin add vs `--patch`, customer delivery). Publish by syncing this directory to the sibling `dsh-hub` git repo (`hub/scripts/sync-to-dsh-hub.sh`, default `../dsh-hub`, remote `github.com/ZhimingYe/dsh-hub`).
- Rationale: [nested dsh-hub product](../.agents/notes/implemented/architecture/2026-08-15-hub-as-nested-dsh-hub-product.md).
