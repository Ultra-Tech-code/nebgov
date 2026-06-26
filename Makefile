.PHONY: test-contracts build-wasm deploy-testnet verify-testnet fmt lint

test-contracts:
	cargo test --workspace -- --nocapture

build-wasm:
	cargo build --release --target wasm32v1-none

deploy-testnet:
	./scripts/deploy-testnet.sh

verify-testnet:
	./scripts/verify-deployment.sh

fmt:
	cargo fmt --all

lint:
	cargo clippy --workspace -- -D warnings
