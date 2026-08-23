// Package ui serves the embedded GitSpine web SPA (Vite production build).
//
// Production assets live in dist/ (written by `make web` / Vite outDir).
// That directory is gitignored; `make ensure-ui` copies placeholder/index.html
// into dist when missing so `go test` / `go build` work without npm.
// Run `make build` for a binary with the full React UI embedded.
package ui

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var dist embed.FS

// FS returns the embedded dist root (files at the top level, not under "dist/").
func FS() (fs.FS, error) {
	return fs.Sub(dist, "dist")
}

// Handler serves static assets from the embedded SPA using the standard library
// file server (fs.Sub + http.FileServerFS).
//
// Unknown paths fall back to index.html so client-side routing keeps working.
// Register API routes on more specific mux patterns so they take precedence.
//
// Pattern follows: https://stackoverflow.com/a/76986541
func Handler() http.Handler {
	root, err := FS()
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "ui embed unavailable: "+err.Error(), http.StatusInternalServerError)
		})
	}

	// Native serve: FileServerFS is the Go 1.22+ form of FileServer(http.FS(root)).
	files := http.FileServerFS(root)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Resolve path relative to the embedded root (same as FileServer).
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "."
		}

		// Serve real files directly when present.
		if f, err := root.Open(name); err == nil {
			_ = f.Close()
			if strings.HasPrefix(name, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else if name == "index.html" || name == "." {
				w.Header().Set("Cache-Control", "no-cache")
			}
			files.ServeHTTP(w, r)
			return
		}

		// SPA fallback: let FileServer serve index.html for unknown client routes.
		if _, err := root.Open("index.html"); err != nil {
			http.Error(w, "UI not built: run `make build` (or `make web`)", http.StatusServiceUnavailable)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/"
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r2)
	})
}
