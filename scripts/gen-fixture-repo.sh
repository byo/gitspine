#!/usr/bin/env bash
# Generate a small, well-structured local git repo with merge commits
# for GitSpine visualization spikes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/testdata/fixture-repo}"

rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

git init -b main -q
git config user.email "gitspine@example.com"
git config user.name "GitSpine Fixture"

commit() {
  local msg="$1"
  shift || true
  # shellcheck disable=SC2048
  for f in ${*:-}; do
    echo "$msg content for $f" >>"$f"
    git add "$f"
  done
  if [[ $# -eq 0 ]]; then
    echo "$msg" >README.md
    git add README.md
  fi
  GIT_AUTHOR_DATE="${AUTHOR_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" \
  GIT_COMMITTER_DATE="${AUTHOR_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" \
    git commit -q -m "$msg"
}

# --- linear base ---
AUTHOR_DATE="2026-01-01T10:00:00Z" commit "init: project skeleton" README.md
AUTHOR_DATE="2026-01-02T10:00:00Z" commit "chore: add license" LICENSE

# --- feature: login (branched from main, 3 commits, merge back) ---
git checkout -q -b feat/login
AUTHOR_DATE="2026-01-03T11:00:00Z" commit "feat(login): add form" login.go
AUTHOR_DATE="2026-01-04T11:00:00Z" commit "feat(login): validate email" login.go
AUTHOR_DATE="2026-01-05T11:00:00Z" commit "feat(login): wire routes" routes.go
git checkout -q main
AUTHOR_DATE="2026-01-06T10:00:00Z" commit "docs: getting started" docs.md
# merge feature into main (main is first parent)
AUTHOR_DATE="2026-01-07T12:00:00Z" git merge --no-ff feat/login -m "Merge branch 'feat/login'"

# --- feature: api with a sync-from-main mid-way ---
git checkout -q -b feat/api
AUTHOR_DATE="2026-01-08T11:00:00Z" commit "feat(api): handlers skeleton" api.go
AUTHOR_DATE="2026-01-09T11:00:00Z" commit "feat(api): list endpoint" api.go
# main moves ahead
git checkout -q main
AUTHOR_DATE="2026-01-10T10:00:00Z" commit "chore: bump ci" ci.yml
# feature syncs main (merge main into feature)
git checkout -q feat/api
AUTHOR_DATE="2026-01-11T11:00:00Z" git merge --no-ff main -m "Merge branch 'main' into feat/api"
AUTHOR_DATE="2026-01-12T11:00:00Z" commit "feat(api): create endpoint" api.go
git checkout -q main
AUTHOR_DATE="2026-01-13T12:00:00Z" git merge --no-ff feat/api -m "Merge branch 'feat/api'"

# --- short feature: polish ---
git checkout -q -b feat/polish
AUTHOR_DATE="2026-01-14T11:00:00Z" commit "fix: tighten styles" styles.css
git checkout -q main
AUTHOR_DATE="2026-01-15T10:00:00Z" commit "chore: version bump" VERSION
AUTHOR_DATE="2026-01-16T12:00:00Z" git merge --no-ff feat/polish -m "Merge branch 'feat/polish'"

AUTHOR_DATE="2026-01-17T10:00:00Z" commit "release: note 0.1.0" CHANGELOG.md
git tag -a v0.1.0 -m "v0.1.0"

echo "Fixture repo ready: $DEST"
echo "Tip: $(git rev-parse --short HEAD) on $(git branch --show-current)"
git log --oneline --graph --decorate -20
