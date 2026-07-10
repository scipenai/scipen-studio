# SNACA build helpers.
#
# `make build`        — build the SPA (npm) and a release server binary
#                       that embeds it. Single binary, runs anywhere.
# `make build-noweb`  — backend only. The admin UI returns a friendly
#                       "SPA not built" JSON; everything else works.
# `make release`      — like `make build` but also builds the Lark plugin
#                       and CLI in release mode. What a real deployment
#                       actually needs.
# `make package`      — `make release` + `scripts/package.sh`. Produces
#                       dist/snaca-<version>-<target>.tar.gz with
#                       binaries, snaca.toml.example, docs, and example
#                       skills. SHA256SUMS bundled inside, plus a
#                       sidecar .sha256 next to the tarball.
# `make dev-web`      — vite dev server on :5173 with proxy to :8080.
# `make test`         — `cargo test --workspace`.
# `make web-install`  — npm ci, run once per checkout / lockfile change.

NPM ?= npm
CARGO ?= cargo

.PHONY: build build-noweb release package web-install web-build server-build \
        bins-build test check-boundaries dev-web clean-web clean-dist

build: web-build server-build

web-install:
	cd web && $(NPM) ci

web-build:
	cd web && $(NPM) ci && $(NPM) run build

server-build:
	$(CARGO) build --release -p snaca-server

build-noweb:
	$(CARGO) build --release -p snaca-server

# Builds every binary a real deployment needs (server, Lark plugin,
# CLI) in release mode in one cargo invocation — cheaper than three
# separate `-p` runs because cargo's unit cache shares across them.
bins-build:
	$(CARGO) build --release -p snaca-server -p snaca-plugin-lark -p snaca-cli

release: web-build bins-build

package: release
	./scripts/package.sh

dev-web:
	cd web && $(NPM) run dev

test:
	$(CARGO) test --workspace --all-features

check-boundaries:
	./scripts/check-sdk-boundaries.sh

clean-web:
	rm -rf web/dist/*

clean-dist:
	rm -rf dist/
