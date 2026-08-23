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
	"sort"
	"strconv"
	"strings"
	"time"
)

// Commit is a lightweight commit summary.
type Commit struct {
	OID         string    `json:"oid"`
	ShortOID    string    `json:"shortOid"`
	Subject     string    `json:"subject"`
	Body        string    `json:"body,omitempty"`
	AuthorName  string    `json:"authorName"`
	AuthorEmail string    `json:"authorEmail"`
	AuthorTime  time.Time `json:"authorTime"`
	Parents     []string  `json:"parents"`
	IsMerge     bool      `json:"isMerge"`
	Refs        []string  `json:"refs,omitempty"`
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
	Commits     []Commit       `json:"commits"`     // in-bundle feature commits
	Edges       []Edge         `json:"edges"`
	Tips        []string       `json:"tips"` // non-first parents of merge
	Externals   []ExternalNode `json:"externals"`
	// Truncated is true when the feature bundle hit the commit cap; roots may be
	// artificial cut points rather than the true branch start.
	Truncated bool `json:"truncated"`
}

// CommitOrigin locates a commit relative to the integration first-parent spine.
// Used to jump from a boundary/external node into the feature that introduced it.
type CommitOrigin struct {
	OID              string `json:"oid"`
	OnSpine          bool   `json:"onSpine"`
	SpineIndex       *int   `json:"spineIndex,omitempty"`       // if onSpine
	IntroducingMerge string `json:"introducingMerge,omitempty"` // landing merge that brought oid in
	// Spine index of the introducing merge (for window seek).
	IntroducingSpineIndex *int `json:"introducingSpineIndex,omitempty"`
}

// Repo is an open local git repository.
type Repo struct {
	Path string

	// refsByOID caches ref tips → short names (built lazily, process-lifetime).
	refsByOID map[string][]string

	// First-parent spine cache for LocateCommit (tip → oid→spineIndex).
	// Built once per process for a given integration tip; huge repos only pay once.
	spineTip   string
	spineIndex map[string]int
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
	// %D carries branch/tag decorations (same as git log --decorate).
	const fmtStr = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1e"
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

	// Merge %D decorations with full ref index (covers remotes/tags and any
	// refs that log decoration omitted).
	r.decorateCommits(ctx, commits)

	// Capsule counts are expensive (one rev-list per merge). Cap how many we
	// compute per page so Linux histories stay interactive.
	const maxCapsuleCounts = 12
	capsuleBudget := 0
	if withCapsules {
		capsuleBudget = maxCapsuleCounts
	}

	nodes := make([]SpineNode, 0, len(commits))
	for i, c := range commits {
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
	r.decorateCommits(ctx, commits)

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

	// First-parent rail of M^1 — parents on this rail are "on main", not a
	// floating branch-base diamond (even when they are also the feature root).
	fpSpine := r.firstParentSpineSet(ctx, first)
	onFPSpine := func(oid string) bool {
		if oid == "" || oid == first {
			return true
		}
		_, ok := fpSpine[oid]
		return ok
	}

	const maxBoundary = 16
	boundaryN := 0
	for _, c := range commits {
		for i, p := range c.Parents {
			if _, ok := inBundle[p]; ok {
				edges = append(edges, Edge{From: c.OID, To: p, Kind: "internal"})
				continue
			}
			// Outside the feature bundle.
			var role string
			if p == first || onFPSpine(p) {
				// Points at the integration rail → violet "on main" treatment.
				role = "integration"
			} else if i >= 1 {
				// Non-first parent from outside ≈ merge-in (e.g. merge topic into feature).
				role = "synced"
			} else {
				// Off-rail parent: feature root, or another external first-parent.
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
	// expose it and attach a layout edge from the oldest loaded commit.
	var mergeBase string
	if len(tips) > 0 {
		if mb, err := r.run(ctx, "merge-base", first, tips[0]); err == nil && mb != "" {
			mergeBase = mb
			if _, in := inBundle[mb]; !in {
				if onFPSpine(mb) {
					setRole(mb, "integration")
				} else {
					setRole(mb, "base")
				}
			}
		}
	}
	if mergeBase != "" {
		if _, in := inBundle[mergeBase]; !in {
			role := "base"
			if r, ok := extRoles[mergeBase]; ok {
				role = r
			}
			hasEdge := false
			for i := range edges {
				if edges[i].Kind == "boundary" && edges[i].To == mergeBase {
					edges[i].Role = role
					hasEdge = true
				}
			}
			if !hasEdge && len(commits) > 0 {
				// commits are tips-first; last entry is oldest among loaded.
				oldest := commits[len(commits)-1].OID
				edges = append(edges, Edge{
					From: oldest,
					To:   mergeBase,
					Kind: "boundary",
					Role: role,
				})
			}
		}
	}

	// Always expose integration parent even with no boundary edge budget left.
	externals := make([]ExternalNode, 0, len(extRoles))
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

// LocateCommit finds where a commit sits relative to the integration spine and,
// if it was landed by a feature merge, which merge introduced it.
//
// Performance: the previous scan walked every first-parent merge and ran two
// merge-base processes per merge (minutes on the kernel). We now:
//  1. cache the full first-parent spine index once per tip (~1s on kernel),
//  2. use a single `rev-list --ancestry-path --merges --reverse` to list
//     candidate introducing merges (~0.6s), then pick the first that lies on
//     the first-parent spine.
func (r *Repo) LocateCommit(ctx context.Context, oid, integrationRef string) (*CommitOrigin, error) {
	full, err := r.revParse(ctx, oid)
	if err != nil {
		return nil, fmt.Errorf("unknown commit: %w", err)
	}
	_, tip, err := r.ResolveIntegrationRef(ctx, integrationRef)
	if err != nil {
		return nil, err
	}

	out := &CommitOrigin{OID: full}
	if err := r.ensureSpineCache(ctx, tip); err != nil {
		return nil, err
	}

	// On first-parent rail?
	if idx, ok := r.spineIndex[full]; ok {
		out.OnSpine = true
		out.SpineIndex = &idx
		return out, nil
	}

	// Candidate introducing merges: ancestry-path from commit toward tip, oldest first.
	// The first candidate that is itself on the first-parent spine is the landing
	// merge that brought this commit onto the product history.
	cands, err := r.run(ctx, "rev-list", "--ancestry-path", "--merges", "--reverse", full+".."+tip)
	if err != nil {
		// Commit may not be an ancestor of tip at all.
		return out, nil
	}
	for _, m := range splitNonEmpty(cands) {
		if idx, ok := r.spineIndex[m]; ok {
			out.IntroducingMerge = m
			out.IntroducingSpineIndex = &idx
			return out, nil
		}
	}
	return out, nil
}

// ensureSpineCache builds oid→spineIndex for the first-parent walk of tip.
func (r *Repo) ensureSpineCache(ctx context.Context, tip string) error {
	if tip == "" {
		return fmt.Errorf("empty tip")
	}
	if r.spineTip == tip && r.spineIndex != nil {
		return nil
	}
	raw, err := r.run(ctx, "rev-list", "--first-parent", tip)
	if err != nil {
		return err
	}
	oids := splitNonEmpty(raw)
	idx := make(map[string]int, len(oids))
	for i, oid := range oids {
		idx[oid] = i
	}
	r.spineTip = tip
	r.spineIndex = idx
	return nil
}

// firstParentSpineSet returns OIDs on the first-parent walk from tip (newest→oldest).
func (r *Repo) firstParentSpineSet(ctx context.Context, tip string) map[string]struct{} {
	out := make(map[string]struct{})
	if err := r.ensureSpineCache(ctx, tip); err != nil {
		// Fall back to a bounded walk if cache build fails.
		raw, err := r.run(ctx, "rev-list", "--first-parent", "--max-count=200000", tip)
		if err != nil {
			return out
		}
		for _, oid := range splitNonEmpty(raw) {
			out[oid] = struct{}{}
		}
		return out
	}
	for oid := range r.spineIndex {
		out[oid] = struct{}{}
	}
	return out
}

// GetCommit loads one commit (single object; prefer batch paths for lists).
func (r *Repo) GetCommit(ctx context.Context, oid string) (Commit, error) {
	// body then decorations: H P an ae aI s b D
	const fmtStr = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%D"
	out, err := r.run(ctx, "show", "-s", "--format="+fmtStr, oid)
	if err != nil {
		return Commit{}, err
	}
	c, err := parseCommitRecord(strings.TrimSpace(out), true)
	if err != nil {
		return Commit{}, err
	}
	cs := []Commit{c}
	r.decorateCommits(ctx, cs)
	return cs[0], nil
}

// parseCommitRecord parses a %x1f-separated commit line.
// Without body: H P an ae aI s D
// With body:    H P an ae aI s b D
func parseCommitRecord(rec string, withBody bool) (Commit, error) {
	n := 7
	if withBody {
		n = 8
	}
	parts := strings.SplitN(rec, "\x1f", n)
	if len(parts) < 6 {
		return Commit{}, fmt.Errorf("parse commit record: fields=%d", len(parts))
	}
	parents := splitFields(parts[1])
	at, _ := time.Parse(time.RFC3339, parts[4])
	body := ""
	decor := ""
	if withBody {
		if len(parts) >= 7 {
			body = strings.TrimSpace(parts[6])
		}
		if len(parts) >= 8 {
			decor = parts[7]
		}
	} else {
		if len(parts) >= 7 {
			decor = parts[6]
		}
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
		Refs:        parseDecorations(decor),
	}, nil
}

// commitsByOID loads many commits with a single `git log --no-walk`.
func (r *Repo) commitsByOID(ctx context.Context, oids []string) (map[string]Commit, error) {
	out := make(map[string]Commit, len(oids))
	if len(oids) == 0 {
		return out, nil
	}
	const fmtStr = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1e"
	args := append([]string{"log", "--no-walk=sorted", "--format=" + fmtStr}, oids...)
	raw, err := r.run(ctx, args...)
	if err != nil {
		// Fallback: empty map, caller may GetCommit individually.
		return out, nil
	}
	for rec := range strings.SplitSeq(raw, "\x1e") {
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

// decorateCommits merges git %D decorations with the full ref index so every
// local branch, remote-tracking branch, and tag tip is visible on its commit.
func (r *Repo) decorateCommits(ctx context.Context, commits []Commit) {
	if len(commits) == 0 {
		return
	}
	idx, err := r.refIndex(ctx)
	if err != nil {
		idx = nil
	}
	for i := range commits {
		var merged []string
		merged = append(merged, commits[i].Refs...)
		if idx != nil {
			merged = append(merged, idx[commits[i].OID]...)
		}
		commits[i].Refs = normalizeRefs(merged)
	}
}

// refIndex returns commit-oid → short ref names (heads / remotes / tags),
// cached for the process. Annotated tags are peeled to their target commit.
func (r *Repo) refIndex(ctx context.Context) (map[string][]string, error) {
	if r.refsByOID != nil {
		return r.refsByOID, nil
	}
	// %(*objectname) is set for annotated tags (peeled commit); otherwise use objectname.
	// Limit to heads/remotes/tags — skip stash, notes, replace, etc.
	out, err := r.run(ctx, "for-each-ref",
		"--format=%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)%x1f%(refname:short)%x1f%(refname)",
		"refs/heads", "refs/remotes", "refs/tags",
	)
	if err != nil {
		return nil, err
	}
	m := make(map[string][]string)
	for _, line := range splitNonEmpty(out) {
		parts := strings.SplitN(line, "\x1f", 3)
		if len(parts) < 2 {
			continue
		}
		oid, name := parts[0], parts[1]
		if oid == "" || name == "" {
			continue
		}
		m[oid] = append(m[oid], name)
	}
	// Symbolic HEAD tip (helps when HEAD is detached or matches a branch).
	if headOID, err := r.revParse(ctx, "HEAD"); err == nil && headOID != "" {
		// Only add the bare "HEAD" label; the branch name is already in heads.
		m[headOID] = append(m[headOID], "HEAD")
	}
	for oid, names := range m {
		m[oid] = normalizeRefs(names)
	}
	r.refsByOID = m
	return m, nil
}

// parseDecorations turns git pretty %D into short ref names.
// Examples: "HEAD -> main, origin/main, tag: v1.0" or "tag: v0.1.0, feat/login".
func parseDecorations(d string) []string {
	d = strings.TrimSpace(d)
	if d == "" {
		return nil
	}
	var refs []string
	for part := range strings.SplitSeq(d, ", ") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		switch {
		case strings.HasPrefix(part, "HEAD -> "):
			refs = append(refs, "HEAD")
			if br := strings.TrimPrefix(part, "HEAD -> "); br != "" {
				refs = append(refs, br)
			}
		case part == "HEAD":
			refs = append(refs, "HEAD")
		case strings.HasPrefix(part, "tag: "):
			refs = append(refs, strings.TrimPrefix(part, "tag: "))
		default:
			// Local branch, remote-tracking branch, or other short name.
			refs = append(refs, part)
		}
	}
	return normalizeRefs(refs)
}

// normalizeRefs de-duplicates and orders refs for display:
// HEAD, main/master, other local branches, remotes, tags/other.
func normalizeRefs(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	var out []string
	for _, r := range in {
		r = strings.TrimSpace(r)
		if r == "" {
			continue
		}
		if _, ok := seen[r]; ok {
			continue
		}
		seen[r] = struct{}{}
		out = append(out, r)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return refRank(out[i]) < refRank(out[j]) ||
			(refRank(out[i]) == refRank(out[j]) && out[i] < out[j])
	})
	return out
}

func refRank(name string) int {
	switch {
	case name == "HEAD":
		return 0
	case name == "main" || name == "master" || name == "trunk":
		return 1
	case !strings.Contains(name, "/"):
		// Local branch or lightweight tag short name — branches first-ish.
		return 2
	case strings.HasPrefix(name, "origin/") || strings.Count(name, "/") == 1:
		// remote/branch (single slash is typical for remotes).
		return 3
	default:
		return 4
	}
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
		if before, _, ok := strings.Cut(rest, "'"); ok {
			return before
		}
	}
	if i := strings.Index(s, "\""); i >= 0 {
		rest := s[i+1:]
		if before, _, ok := strings.Cut(rest, "\""); ok {
			return before
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
	return append([]string(nil), m[oid]...)
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
	for line := range strings.SplitSeq(s, "\n") {
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
