package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/byo/gitspine/internal/gitrepo"
)

// Server serves GitSpine JSON APIs for a single local repo.
type Server struct {
	Repo   *gitrepo.Repo
	Ref    string // optional override
	Log    *slog.Logger
	DevCORS bool
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/repo", s.handleRepo)
	mux.HandleFunc("GET /api/v1/spine", s.handleSpine)
	mux.HandleFunc("GET /api/v1/features/{oid}/expand", s.handleExpand)
	mux.HandleFunc("GET /api/v1/commits/{oid}", s.handleCommit)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	return s.middleware(mux)
}

func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		if s.DevCORS {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		ww := &statusWriter{ResponseWriter: w, code: 200}
		next.ServeHTTP(ww, r)
		s.log().Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", ww.code,
			"dur_ms", time.Since(start).Milliseconds(),
		)
	})
}

func (s *Server) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

func (s *Server) handleRepo(w http.ResponseWriter, r *http.Request) {
	meta, err := s.Repo.Meta(r.Context(), s.Ref)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "repo_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) handleSpine(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))
	withCapsules := q.Get("capsules") != "0"

	_, tip, err := s.Repo.ResolveIntegrationRef(r.Context(), s.Ref)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "resolve_ref", err.Error())
		return
	}
	nodes, hasMore, err := s.Repo.Spine(r.Context(), tip, limit, offset, withCapsules)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "spine_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"nodes":   nodes,
		"hasMore": hasMore,
		"offset":  offset,
		"limit":   limit,
	})
}

func (s *Server) handleExpand(w http.ResponseWriter, r *http.Request) {
	oid := r.PathValue("oid")
	if oid == "" {
		writeErr(w, http.StatusBadRequest, "missing_oid", "merge oid required")
		return
	}
	max, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	sg, err := s.Repo.ExpandFeature(r.Context(), oid, max)
	if err != nil {
		if strings.Contains(err.Error(), "not_a_merge") {
			writeErr(w, http.StatusBadRequest, "not_a_merge", "oid is not a merge commit")
			return
		}
		writeErr(w, http.StatusInternalServerError, "expand_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sg)
}

func (s *Server) handleCommit(w http.ResponseWriter, r *http.Request) {
	oid := r.PathValue("oid")
	c, err := s.Repo.GetCommit(r.Context(), oid)
	if err != nil {
		writeErr(w, http.StatusNotFound, "oid_not_found", err.Error())
		return
	}
	c.Refs = nil // optional; could fill
	writeJSON(w, http.StatusOK, c)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	// Compact JSON — indent costs CPU/bytes on large spine pages.
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, map[string]string{"error": errCode, "message": msg})
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	w.code = code
	w.ResponseWriter.WriteHeader(code)
}
