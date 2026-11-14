SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install dev build test verify contract deploy demo reset clean

help:
	@echo "QUEUE — make targets"
	@echo "  make install    install workspace dependencies"
	@echo "  make dev        run API (:8789) and web (:4178)"
	@echo "  make build      typecheck and build the web console"
	@echo "  make test       run core, ledger, server, and web tests"
	@echo "  make verify     full local verification, including a live scenario"
	@echo "  make contract   cargo test + wasm build"
	@echo "  make deploy     deploy the contract to NEAR testnet"
	@echo "  make demo       run the on-chain proof scenario"
	@echo "  make reset      reset the local console to standby"

install:
	npm install

dev:
	npm run dev

build:
	npm run build

test:
	npm test

verify:
	npm run verify

contract:
	cd contracts/queue && cargo test
	cd contracts/queue && cargo build --target wasm32-unknown-unknown --release

deploy:
	npm run deploy:testnet

demo:
	npm run demo:onchain

reset:
	npm run seed

clean:
	rm -rf apps/web/dist packages/core/dist data/queue.db data/queue.db-*
	cd contracts/queue && cargo clean
