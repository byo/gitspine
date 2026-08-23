.PHONY: fixture dev-api dev-web dev test build

FIXTURE ?= testdata/fixture-repo
REPO ?= $(FIXTURE)
LISTEN ?= 127.0.0.1:8080

fixture:
	bash scripts/gen-fixture-repo.sh $(FIXTURE)

dev-api: fixture
	go run ./cmd/gitspine -repo $(REPO) -listen $(LISTEN) -log-level debug

dev-web:
	cd web && npm run dev

# Run API in background instructions are in README; this just builds API checks.
test:
	go test ./...
	cd web && npm test --if-present

build:
	go build -o bin/gitspine ./cmd/gitspine
