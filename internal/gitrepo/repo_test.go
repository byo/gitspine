package gitrepo

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

func TestSpineAndExpandAgainstFixture(t *testing.T) {
	root := findRepoRoot(t)
	fixture := filepath.Join(root, "testdata", "fixture-repo")
	if _, err := os.Stat(filepath.Join(fixture, ".git")); err != nil {
		t.Skip("fixture missing; run: make fixture")
	}

	repo, err := Open(fixture)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	_, tip, err := repo.ResolveIntegrationRef(ctx, "")
	if err != nil {
		t.Fatal(err)
	}

	nodes, hasMore, err := repo.Spine(ctx, tip, 50, 0, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) < 5 {
		t.Fatalf("expected several spine nodes, got %d", len(nodes))
	}
	_ = hasMore

	// Tip of the integration branch must expose its branch name (and HEAD if checked out).
	if len(nodes[0].Commit.Refs) == 0 {
		t.Fatalf("expected tip %s to have refs (branch/tag decorations), got none", nodes[0].Commit.ShortOID)
	}
	foundMain := false
	for _, ref := range nodes[0].Commit.Refs {
		if ref == "main" || ref == "master" {
			foundMain = true
			break
		}
	}
	if !foundMain {
		t.Fatalf("expected main/master on tip refs, got %v", nodes[0].Commit.Refs)
	}

	// Every ref tip that lies on this first-parent page should be decorated.
	idx, err := repo.refIndex(ctx)
	if err != nil {
		t.Fatal(err)
	}
	onPage := map[string][]string{}
	for _, n := range nodes {
		onPage[n.Commit.OID] = n.Commit.Refs
	}
	for oid, names := range idx {
		if refs, ok := onPage[oid]; ok {
			for _, want := range names {
				if want == "HEAD" {
					continue
				}
				if !slices.Contains(refs, want) {
					t.Errorf("commit %s missing ref %q; have %v", shortTest(oid), want, refs)
				}
			}
		}
	}

	var merges int
	for _, n := range nodes {
		if n.Capsule != nil {
			merges++
			// capsule count should match git rev-list --count
			c := n.Commit
			if len(c.Parents) < 2 {
				t.Fatalf("capsule on non-merge %s", c.ShortOID)
			}
			want := gitCount(t, fixture, c.Parents[1:], c.Parents[0])
			if n.Capsule.CommitCount != want {
				t.Errorf("capsule %s count=%d want %d", n.Capsule.HintTitle, n.Capsule.CommitCount, want)
			}

			sg, err := repo.ExpandFeature(ctx, c.OID, 500)
			if err != nil {
				t.Fatal(err)
			}
			if len(sg.Commits) != want {
				t.Errorf("expand %s commits=%d want %d", n.Capsule.HintTitle, len(sg.Commits), want)
			}
			// must have landing edges for each tip
			if len(sg.Tips) != len(c.Parents)-1 {
				t.Errorf("tips mismatch")
			}
			var landings int
			for _, e := range sg.Edges {
				if e.Kind == "landing" {
					landings++
				}
			}
			if landings != len(sg.Tips) {
				t.Errorf("landing edges=%d tips=%d", landings, len(sg.Tips))
			}
		}
	}
	if merges < 2 {
		t.Fatalf("expected multiple merge capsules, got %d", merges)
	}
}

func gitCount(t *testing.T, dir string, tips []string, exclude string) int {
	t.Helper()
	args := []string{"-C", dir, "rev-list", "--count"}
	args = append(args, tips...)
	args = append(args, "--not", exclude)
	out, err := exec.Command("git", args...).Output()
	if err != nil {
		t.Fatal(err)
	}
	var n int
	_, _ = parseInt(string(out), &n)
	return n
}

func parseInt(s string, n *int) (int, error) {
	var v int
	for _, ch := range s {
		if ch >= '0' && ch <= '9' {
			v = v*10 + int(ch-'0')
		}
	}
	*n = v
	return v, nil
}

func shortTest(oid string) string {
	if len(oid) >= 7 {
		return oid[:7]
	}
	return oid
}

func findRepoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := wd
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found")
		}
		dir = parent
	}
}
