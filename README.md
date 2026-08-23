# GitSpine

**First-parent git history you can actually read** — merge commits keep feature development history; the UI treats that history as on-demand detail, not visual noise.

This is a **local-only UX spike** (no GitHub/GitLab integration). Point it at a git folder with real merge commits and explore:

1. **Main spine** — first-parent walk of the integration branch (what “landed”).
2. **Merge capsules** — collapsed feature summaries (`feat/login +3`).
3. **Feature focus** — expand one merge to see the merge-range commits (`M^1..M^2`).

Full product design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Requirements

- Go 1.22+
- Node 20+
- `git` on `PATH`

## Quick start

```bash
# 1) sample history with proper merges
make fixture

# 2) API (terminal A)
go run ./cmd/gitspine -repo testdata/fixture-repo -listen 127.0.0.1:8080

# 3) UI (terminal B)
cd web && npm install && npm run dev
```

Open **http://127.0.0.1:5173** (Vite proxies `/api` → `:8080`).

Against your own repo:

```bash
go run ./cmd/gitspine -repo /path/to/repo -listen 127.0.0.1:8080
```

Optional: `-ref main` if HEAD is not the integration branch you want.

## How to read the view

| Element | Meaning |
|--------|---------|
| Thick vertical rail | First-parent product timeline |
| Yellow double-ring node | Landing merge |
| Gray capsule on the right | Collapsed feature (`hint +N`) |
| Expanded blue lane | Commits introduced by that merge only |
| Dashed stub | Boundary/sync edge (parent outside the feature bundle) |

**Click a merge** on the spine to expand its feature history; click again (or **Esc** / *Exit feature focus*) to collapse.

## API (spike)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/repo` | Path + integration tip |
| GET | `/api/v1/spine?offset=&limit=` | First-parent page + capsules |
| GET | `/api/v1/features/{oid}/expand` | Merge-range feature subgraph |
| GET | `/api/v1/commits/{oid}` | Single commit |

Feature membership is plain git: commits reachable from non-first parents of `M`, excluding ancestors of the first parent.

## Project layout

```
cmd/gitspine/        HTTP entrypoint
internal/gitrepo/    local git via CLI (thin)
internal/api/        JSON handlers
web/                 React + canvas UI
scripts/             fixture generator
docs/DESIGN.md       architecture & PR plan
```

## Not in this spike

- Remote forges / PR metadata
- Squash/rebase rewriting advice
- Full Git GUI actions
- Linux-scale performance work (design covers a path; spike targets small/medium local repos)
