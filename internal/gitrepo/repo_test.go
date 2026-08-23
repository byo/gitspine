package gitrepo

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
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
