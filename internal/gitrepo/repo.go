// Package gitrepo is a thin local-git reader for GitSpine.
// It shells out to git for correctness of first-parent and merge-range walks.
package gitrepo

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Commit is a lightweight commit summary.
type Commit struct {
	OID          string    `json:"oid"`
	ShortOID     string    `json:"shortOid"`
	Subject      string    `json:"subject"`
	Body         string    `json:"body,omitempty"`
	AuthorName   string    `json:"authorName"`
	AuthorEmail  string    `json:"authorEmail"`
	AuthorTime   time.Time `json:"authorTime"`
	Parents      []string  `json:"parents"`
	IsMerge      bool      `json:"isMerge"`
	Refs         []string  `json:"refs,omitempty"`
}

// Capsule summarizes a collapsed feature attached to a landing merge.
type Capsule struct {
	MergeOID    string `json:"mergeOid"`
	HintTitle   string `json:"hintTitle"`
	CommitCount int    `json:"commitCount"`
	CountExact  bool   `json:"countExact"`
}

// SpineNode is one commit on the first-parent rail.
type SpineNode struct {
	Commit  Commit   `json:"commit"`
	Index   int      `json:"spineIndex"`
	Capsule *Capsule `json:"capsule,omitempty"`
}

// Edge connects two commits in a feature expand payload.
type Edge struct {
	From string `json:"from"` // child
	To   string `json:"to"`   // parent
	Kind string `json:"kind"` // internal | landing | boundary
	// Role classifies boundary targets: integration | base | synced.
	Role string `json:"role,omitempty"`
}

// ExternalNode is a commit outside the feature bundle that the feature touches.
type ExternalNode struct {
	Commit Commit `json:"commit"`
	// Role: integration = M^1 (where feature lands); base = branch starting point;
	// synced = history merged into the feature from outside (e.g. merge main into feat).
	Role string `json:"role"`
}

// FeatureSubgraph is the expand payload for one merge.
type FeatureSubgraph struct {
	MergeOID    string         `json:"mergeOid"`
	FirstParent string         `json:"firstParent"` // M^1 integration parent
	Commits     []Commit       `json:"commits"`    // in-bundle feature commits
	Edges       []Edge         `json:"edges"`
	Tips        []string       `json:"tips"` // non-first parents of merge
	Externals   []ExternalNode `json:"externals"`
	// Truncated is true when the feature bundle hit the commit cap; roots may be
	// artificial cut points rather than the true branch start.
	Truncated bool `json:"truncated"`
}

// Repo is an open local git repository.
type Repo struct {
	Path string

	// refsByOID caches ref tips → short names (built lazily, process-lifetime).
	refsByOID map[string][]string
}

// Open validates path is a git worktree or .git dir.
func Open(path string) (*Repo, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(abs); err != nil {
		return nil, fmt.Errorf("repo path: %w", err)
	}
	r := &Repo{Path: abs}
	if _, err := r.run(context.Background(), "rev-parse", "--git-dir"); err != nil {
		return nil, fmt.Errorf("not a git repository: %s", abs)
	}
	return r, nil
}

// ResolveIntegrationRef picks the integration branch tip.
// Order: explicit ref, HEAD symbolic branch, main, master, trunk, bare HEAD.
func (r *Repo) ResolveIntegrationRef(ctx context.Context, explicit string) (string, string, error) {
	if explicit != "" {
		oid, err := r.revParse(ctx, explicit)
		return explicit, oid, err
	}
	// symbolic-ref may fail on detached HEAD
	if branch, err := r.run(ctx, "symbolic-ref", "--short", "HEAD"); err == nil && branch != "" {
		oid, err := r.revParse(ctx, "HEAD")
		return branch, oid, err
	}
	for _, name := range []string{"main", "master", "trunk"} {
		if oid, err := r.revParse(ctx, name); err == nil {
			return name, oid, nil
		}
	}
	oid, err := r.revParse(ctx, "HEAD")
	return "HEAD", oid, err
}

// Meta returns path + integration tip info.
func (r *Repo) Meta(ctx context.Context, ref string) (map[string]any, error) {
	name, oid, err := r.ResolveIntegrationRef(ctx, ref)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"path":           r.Path,
		"integrationRef": name,
		"integrationOid": oid,
		"shortOid":       short(oid),
	}, nil
}

// Spine returns first-parent history newest-first.
//
// Performance: one `git log` for the page + one cached refs map. Avoids N×
// `git show` / `for-each-ref --points-at` (catastrophic on Linux-scale repos).
// Capsules (per-merge rev-list --count) are optional and budgeted.
func (r *Repo) Spine(ctx context.Context, tip string, limit, offset int, withCapsules bool) ([]SpineNode, bool, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	// One process: commit fields for limit+1 first-parent commits.
	// Record separator %x1e between commits; field separator %x1f.
	const fmtStr = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e"
	args := []string{
		"log", "--first-parent",
		"--skip=" + strconv.Itoa(offset),
		"--max-count=" + strconv.Itoa(limit+1),
		"--format=" + fmtStr,
		tip,
	}
	out, err := r.run(ctx, args...)
	if err != nil {
		return nil, false, err
	}

	records := strings.Split(out, "\x1e")
	// git may leave a trailing empty record after the last %x1e
	commits := make([]Commit, 0, limit+1)
	for _, rec := range records {
		rec = strings.TrimSpace(rec)
		if rec == "" {
			continue
		}
		c, err := parseCommitRecord(rec, false)
		if err != nil {
			return nil, false, err
		}
		commits = append(commits, c)
	}

	hasMore := len(commits) > limit
	if hasMore {
		commits = commits[:limit]
	}

	refs, err := r.refIndex(ctx)
	if err != nil {
		// Non-fatal: decorate without refs.
		refs = nil
	}

	// Capsule counts are expensive (one rev-list per merge). Cap how many we
	// compute per page so Linux histories stay interactive.
	const maxCapsuleCounts = 12
	capsuleBudget := 0
	if withCapsules {
		capsuleBudget = maxCapsuleCounts
	}

	nodes := make([]SpineNode, 0, len(commits))
	for i, c := range commits {
		if refs != nil {
			c.Refs = refs[c.OID]
		}
		node := SpineNode{Commit: c, Index: offset + i}
		if withCapsules && c.IsMerge {
			if capsuleBudget > 0 {
				cap, err := r.capsuleForMerge(ctx, c)
				if err == nil && cap != nil {
					node.Capsule = cap
					capsuleBudget--
				}
			} else {
				// Still mark as expandable without an exact count walk.
				node.Capsule = &Capsule{
					MergeOID:    c.OID,
					HintTitle:   hintTitle(c.Subject),
					CommitCount: 0,
					CountExact:  false,
				}
			}
		}
		nodes = append(nodes, node)
	}
	return nodes, hasMore, nil
}

// ExpandFeature returns merge-range commits: tips of M not reachable from M^1,
// plus classified external context nodes (integration base, branch points, syncs).
func (r *Repo) ExpandFeature(ctx context.Context, mergeOID string, maxCommits int) (*FeatureSubgraph, error) {
	if maxCommits <= 0 {
		maxCommits = 500
	}
	m, err := r.GetCommit(ctx, mergeOID)
	if err != nil {
		return nil, err
	}
	if !m.IsMerge || len(m.Parents) < 2 {
		return nil, fmt.Errorf("not_a_merge")
	}
	first := m.Parents[0]
	tips := m.Parents[1:]

	// commits in any tip.. not reachable from first parent
	// rev-list tip1 tip2 --not first
	args := []string{"rev-list", "--max-count=" + strconv.Itoa(maxCommits+1)}
	args = append(args, tips...)
	args = append(args, "--not", first)
	out, err := r.run(ctx, args...)
	if err != nil {
		return nil, err
	}
	oids := splitNonEmpty(out)
	truncated := len(oids) > maxCommits
	if truncated {
		oids = oids[:maxCommits]
	}

	inBundle := map[string]struct{}{mergeOID: {}}
	for _, oid := range oids {
		inBundle[oid] = struct{}{}
	}

	byOID, err := r.commitsByOID(ctx, oids)
	if err != nil {
		return nil, err
	}

	commits := make([]Commit, 0, len(oids))
	seen := map[string]struct{}{}
	ordered := make([]string, 0, len(oids))
	for _, t := range tips {
		if _, ok := inBundle[t]; ok {
			if _, s := seen[t]; !s {
				ordered = append(ordered, t)
				seen[t] = struct{}{}
			}
		}
	}
	for _, oid := range oids {
		if _, s := seen[oid]; !s {
			ordered = append(ordered, oid)
			seen[oid] = struct{}{}
		}
	}

	for _, oid := range ordered {
		c, ok := byOID[oid]
		if !ok {
			c, err = r.GetCommit(ctx, oid)
			if err != nil {
				return nil, err
			}
		}
		commits = append(commits, c)
	}

	// roleRank: higher wins when the same external is referenced multiple ways.
	roleRank := map[string]int{
		"integration": 3,
		"synced":      2,
		"base":        1,
	}
	extRoles := map[string]string{} // oid -> role
	setRole := func(oid, role string) {
		if prev, ok := extRoles[oid]; ok && roleRank[prev] >= roleRank[role] {
			return
		}
		extRoles[oid] = role
	}

	// Landing merge always ties the feature to its integration parent (M^1).
	setRole(first, "integration")

	var edges []Edge
	for _, t := range tips {
		edges = append(edges, Edge{From: mergeOID, To: t, Kind: "landing"})
	}

	const maxBoundary = 16
	boundaryN := 0
	for _, c := range commits {
		hasInBundleParent := false
		for _, p := range c.Parents {
			if _, ok := inBundle[p]; ok {
				hasInBundleParent = true
				break
			}
		}
		for i, p := range c.Parents {
			if _, ok := inBundle[p]; ok {
				edges = append(edges, Edge{From: c.OID, To: p, Kind: "internal"})
				continue
			}
			// Outside the feature bundle.
			role := "base"
			if p == first {
				role = "integration"
			} else if i >= 1 {
				// Non-first parent from outside ≈ merge-in (e.g. merge main into feature).
				role = "synced"
			} else if !hasInBundleParent {
				// Root of the feature history — branch starting point.
				role = "base"
			} else {
				// First parent outside while also having in-bundle parents (unusual) — treat as base.
				role = "base"
			}
			setRole(p, role)
			if boundaryN < maxBoundary {
				edges = append(edges, Edge{From: c.OID, To: p, Kind: "boundary", Role: role})
				boundaryN++
			}
		}
	}

	// Classic fork point: merge-base(M^1, first tip), if outside the bundle.
	// If no loaded commit parents directly to it (common when truncated), still
	// expose it as base and attach a layout edge from the oldest loaded commit.
	var mergeBase string
	if len(tips) > 0 {
		if mb, err := r.run(ctx, "merge-base", first, tips[0]); err == nil && mb != "" {
			mergeBase = mb
			if _, in := inBundle[mb]; !in {
				setRole(mb, "base")
			}
		}
	}
	if mergeBase != "" {
		if _, in := inBundle[mergeBase]; !in {
			hasEdge := false
			for _, e := range edges {
				if e.Kind == "boundary" && e.To == mergeBase {
					hasEdge = true
					break
				}
			}
			if !hasEdge && len(commits) > 0 {
				// commits are tips-first; last entry is oldest among loaded.
				oldest := commits[len(commits)-1].OID
				edges = append(edges, Edge{
					From: oldest,
					To:   mergeBase,
					Kind: "boundary",
					Role: "base",
				})
			}
		}
	}

	// Always expose integration parent even with no boundary edge budget left.
	externals := make([]ExternalNode, 0, len(extRoles))
	// Stable-ish order: integration, base, synced; then oid.
	orderRoles := []string{"integration", "base", "synced"}
	for _, role := range orderRoles {
		for oid, rname := range extRoles {
			if rname != role {
				continue
			}
			c, err := r.GetCommit(ctx, oid)
			if err != nil {
				continue
			}
			c.Refs = r.refsPointingAt(ctx, oid)
			externals = append(externals, ExternalNode{Commit: c, Role: role})
		}
	}

	return &FeatureSubgraph{
		MergeOID:    mergeOID,
		FirstParent: first,
		Commits:     commits,
		Edges:       edges,
		Tips:        tips,
		Externals:   externals,
		Truncated:   truncated,
	}, nil
}

// GetCommit loads one commit (single object; prefer batch paths for lists).
func (r *Repo) GetCommit(ctx context.Context, oid string) (Commit, error) {
	const fmtStr = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b"
	out, err := r.run(ctx, "show", "-s", "--format="+fmtStr, oid)
	if err != nil {
		return Commit{}, err
	}
	return parseCommitRecord(strings.TrimSpace(out), true)
}

// parseCommitRecord parses a %x1f-separated commit line.
// With body: H P an ae aI s b ; without body: H P an ae aI s
func parseCommitRecord(rec string, withBody bool) (Commit, error) {
	n := 6
	if withBody {
		n = 7
	}
	parts := strings.SplitN(rec, "\x1f", n)
	if len(parts) < 6 {
		return Commit{}, fmt.Errorf("parse commit record: fields=%d", len(parts))
	}
	parents := splitFields(parts[1])
	at, _ := time.Parse(time.RFC3339, parts[4])
	body := ""
	if withBody && len(parts) >= 7 {
		body = strings.TrimSpace(parts[6])
	}
	full := strings.TrimSpace(parts[0])
	return Commit{
		OID:         full,
		ShortOID:    short(full),
		Subject:     parts[5],
		Body:        body,
		AuthorName:  parts[2],
		AuthorEmail: parts[3],
		AuthorTime:  at,
		Parents:     parents,
		IsMerge:     len(parents) > 1,
	}, nil
}

// commitsByOID loads many commits with a single `git log --no-walk`.
func (r *Repo) commitsByOID(ctx context.Context, oids []string) (map[string]Commit, error) {
	out := make(map[string]Commit, len(oids))
	if len(oids) == 0 {
		return out, nil
	}
	const fmtStr = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e"
	args := append([]string{"log", "--no-walk=sorted", "--format=" + fmtStr}, oids...)
	raw, err := r.run(ctx, args...)
	if err != nil {
		// Fallback: empty map, caller may GetCommit individually.
		return out, nil
	}
	for _, rec := range strings.Split(raw, "\x1e") {
		rec = strings.TrimSpace(rec)
		if rec == "" {
			continue
		}
		c, err := parseCommitRecord(rec, false)
		if err != nil {
			continue
		}
		out[c.OID] = c
	}
	return out, nil
}

// refIndex returns oid → short ref names (heads/tags), cached for the process.
func (r *Repo) refIndex(ctx context.Context) (map[string][]string, error) {
	if r.refsByOID != nil {
		return r.refsByOID, nil
	}
	out, err := r.run(ctx, "for-each-ref", "--format=%(objectname)%x1f%(refname:short)")
	if err != nil {
		return nil, err
	}
	m := make(map[string][]string)
	for _, line := range splitNonEmpty(out) {
		parts := strings.SplitN(line, "\x1f", 2)
		if len(parts) != 2 {
			continue
		}
		oid, name := parts[0], parts[1]
		m[oid] = append(m[oid], name)
	}
	r.refsByOID = m
	return m, nil
}

func (r *Repo) capsuleForMerge(ctx context.Context, m Commit) (*Capsule, error) {
	if len(m.Parents) < 2 {
		return nil, nil
	}
	first := m.Parents[0]
	tips := m.Parents[1:]
	args := []string{"rev-list", "--count"}
	args = append(args, tips...)
	args = append(args, "--not", first)
	out, err := r.run(ctx, args...)
	if err != nil {
		return nil, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, nil // empty / degenerate
	}
	return &Capsule{
		MergeOID:    m.OID,
		HintTitle:   hintTitle(m.Subject),
		CommitCount: n,
		CountExact:  true,
	}, nil
}

func hintTitle(subject string) string {
	// "Merge branch 'feat/login'" -> feat/login
	s := subject
	if i := strings.Index(s, "'"); i >= 0 {
		rest := s[i+1:]
		if j := strings.Index(rest, "'"); j >= 0 {
			return rest[:j]
		}
	}
	if i := strings.Index(s, "\""); i >= 0 {
		rest := s[i+1:]
		if j := strings.Index(rest, "\""); j >= 0 {
			return rest[:j]
		}
	}
	// fallback: trim Merge prefix
	s = strings.TrimPrefix(s, "Merge branch ")
	s = strings.TrimPrefix(s, "Merge pull request ")
	if len(s) > 40 {
		return s[:40]
	}
	return s
}

func (r *Repo) refsPointingAt(ctx context.Context, oid string) []string {
	m, err := r.refIndex(ctx)
	if err != nil {
		return nil
	}
	return m[oid]
}

func (r *Repo) revParse(ctx context.Context, rev string) (string, error) {
	return r.run(ctx, "rev-parse", rev)
}

func (r *Repo) run(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = r.Path
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w (%s)", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(stdout.String()), nil
}

func short(oid string) string {
	if len(oid) >= 7 {
		return oid[:7]
	}
	return oid
}

func splitNonEmpty(s string) []string {
	if s == "" {
		return nil
	}
	var out []string
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

func splitFields(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return strings.Fields(s)
}
