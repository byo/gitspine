.PHONY: fixture ensure-ui web dev-api dev-web dev test build build-go clean-ui lint vet

FIXTURE ?= testdata/fixture-repo
REPO ?= $(FIXTURE)
LISTEN ?= 127.0.0.1:8080
UI_DIST := internal/ui/dist
UI_PLACEHOLDER := internal/ui/placeholder/index.html

fixture:
	bash scripts/gen-fixture-repo.sh $(FIXTURE)

# Ensure go:embed has something to compile against (placeholder or real Vite build).
ensure-ui:
	@mkdir -p $(UI_DIST)
	@if [ ! -f $(UI_DIST)/index.html ]; then \
		cp $(UI_PLACEHOLDER) $(UI_DIST)/index.html; \
		echo "ui: installed placeholder at $(UI_DIST)/index.html"; \
	fi

# --- Development (split processes) ---
# Terminal A: make dev-api
# Terminal B: make dev-web  → open http://127.0.0.1:5173
# Go enables CORS; Vite proxies /api → :8080. UI is not required from the binary.

dev-api: fixture
	go run ./cmd/gitspine -repo $(REPO) -listen $(LISTEN) -log-level debug -dev -no-ui

dev-web:
	cd web && npm run dev

dev:
	@echo "Terminal A: make dev-api REPO=$(REPO)"
	@echo "Terminal B: make dev-web"
	@echo "Open http://127.0.0.1:5173"

# --- Production single binary (API + embedded SPA) ---

# Build the React app into internal/ui/dist for go:embed.
web:
	cd web && npm install && npm run build
	@test -f $(UI_DIST)/index.html
	@echo "ui: production assets in $(UI_DIST)"

# Go binary only (uses whatever is currently in internal/ui/dist).
build-go: ensure-ui
	go build -o bin/gitspine ./cmd/gitspine

# Full release path: Vite production build + embed + compile.
build: web build-go
	@echo "Built bin/gitspine — run: ./bin/gitspine -repo $(REPO) -listen $(LISTEN)"
	@echo "Open http://$(LISTEN)/"

clean-ui:
	rm -rf $(UI_DIST)
	@$(MAKE) ensure-ui

lint: ensure-ui
	golangci-lint run ./...
	cd web && npm run lint

vet: ensure-ui
	go vet ./...
	cd web && npm run typecheck

test: ensure-ui
	go test ./...
	cd web && npm test --if-present
