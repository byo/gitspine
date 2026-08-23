package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/byo/gitspine/internal/api"
	"github.com/byo/gitspine/internal/gitrepo"
)

func main() {
	repoPath := flag.String("repo", ".", "path to local git repository")
	ref := flag.String("ref", "", "integration ref (default: HEAD branch / main / master)")
	listen := flag.String("listen", "127.0.0.1:8080", "listen address")
	logLevel := flag.String("log-level", "info", "log level (debug|info|warn|error)")
	dev := flag.Bool("dev", false, "dev mode: enable CORS for Vite (http://127.0.0.1:5173)")
	noUI := flag.Bool("no-ui", false, "serve API only (skip embedded web UI)")
	flag.Parse()

	// Env override for CI/scripts: GITSPINE_DEV=1
	if v := strings.TrimSpace(os.Getenv("GITSPINE_DEV")); v == "1" || strings.EqualFold(v, "true") {
		*dev = true
	}

	var level slog.Level
	switch *logLevel {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	abs, err := filepath.Abs(*repoPath)
	if err != nil {
		log.Error("resolve repo path", "err", err)
		os.Exit(1)
	}
	repo, err := gitrepo.Open(abs)
	if err != nil {
		log.Error("open repo", "path", abs, "err", err)
		os.Exit(1)
	}

	ctx := context.Background()
	meta, err := repo.Meta(ctx, *ref)
	if err != nil {
		log.Error("repo meta", "err", err)
		os.Exit(1)
	}

	serveUI := !*noUI
	log.Info("gitspine starting",
		"repo", meta["path"],
		"ref", meta["integrationRef"],
		"tip", meta["shortOid"],
		"listen", *listen,
		"ui", serveUI,
		"dev_cors", *dev,
	)

	if host, _, err := net.SplitHostPort(*listen); err == nil && host != "" && host != "127.0.0.1" && host != "localhost" && host != "::1" {
		log.Warn("listening on non-loopback address; local git data may be exposed", "listen", *listen)
	}

	srv := &api.Server{
		Repo:    repo,
		Ref:     *ref,
		Log:     log,
		DevCORS: *dev,
		ServeUI: serveUI,
	}
	if err := http.ListenAndServe(*listen, srv.Handler()); err != nil {
		fmt.Fprintf(os.Stderr, "server error: %v\n", err)
		os.Exit(1)
	}
}
