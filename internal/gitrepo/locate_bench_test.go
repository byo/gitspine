package gitrepo

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestLocateCommitKernelBase(t *testing.T) {
	path := os.Getenv("GITSPINE_BENCH_REPO")
	if path == "" {
		path = "/home/bartek/code/bcachefs/bcachefs"
	}
	if _, err := os.Stat(path + "/.git"); err != nil {
		if _, err2 := os.Stat(path); err2 != nil {
			t.Skip("bench repo missing")
		}
	}
	repo, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	oid := "1ee27dacbe5dc4def481794d899d67b0d4570094"
	t0 := time.Now()
	loc, err := repo.LocateCommit(ctx, oid, "")
	d1 := time.Since(t0)
	if err != nil {
		t.Fatal(err)
	}
	t1 := time.Now()
	loc2, err := repo.LocateCommit(ctx, oid, "")
	d2 := time.Since(t1)
	if err != nil {
		t.Fatal(err)
	}
	mergeIdx := -1
	if loc.IntroducingSpineIndex != nil {
		mergeIdx = *loc.IntroducingSpineIndex
	}
	t.Logf("cold=%v warm=%v onSpine=%v merge=%s idx=%d",
		d1, d2, loc.OnSpine, loc.IntroducingMerge[:12], mergeIdx)
	if loc.OnSpine {
		t.Fatalf("expected off-spine base, got onSpine")
	}
	if loc.IntroducingMerge == "" {
		t.Fatalf("expected introducing merge, got none")
	}
	if mergeIdx < 0 {
		t.Fatalf("expected introducing spine index")
	}
	if d1 > 15*time.Second {
		t.Fatalf("cold locate too slow: %v", d1)
	}
	_ = loc2
}
