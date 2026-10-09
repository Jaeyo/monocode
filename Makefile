# MonoCode build shortcuts. See README.md "Build from source" for details.

BUNDLE_DIR := target/release/bundle

.DEFAULT_GOAL := help
.PHONY: help install dev dev-stable build build-arm build-intel check test

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# Reinstall npm packages only when the manifest or lockfile changes.
node_modules: package.json package-lock.json
	npm ci
	@touch node_modules

install: node_modules ## Install npm packages (npm ci)

dev: node_modules ## Run the app in development mode with hot reload
	npm run tauri dev

dev-stable: node_modules ## Run the app with the stable config, without file watching
	npm run tauri:stable

build: node_modules ## Build release bundles for this machine (.app/.dmg on macOS)
	npm run tauri build
	@echo "Bundles: $(BUNDLE_DIR)/"

build-arm: node_modules ## Build macOS Apple Silicon bundles (.app/.dmg)
	npx tauri build --target aarch64-apple-darwin --bundles app,dmg
	@echo "Bundles: target/aarch64-apple-darwin/release/bundle/"

# Requires the Rust target: rustup target add x86_64-apple-darwin
build-intel: node_modules ## Build macOS Intel bundles (.app/.dmg)
	npx tauri build --target x86_64-apple-darwin --bundles app,dmg
	@echo "Bundles: target/x86_64-apple-darwin/release/bundle/"

check: node_modules ## Run the CI checks (vitest, tsc, cargo fmt/clippy/test)
	npm run check

test: node_modules ## Run the web unit tests
	npm test
