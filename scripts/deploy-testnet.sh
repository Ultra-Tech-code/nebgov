#!/usr/bin/env bash
# ============================================================
# scripts/deploy-testnet.sh
#
# Deploy all NebGov contracts to Stellar testnet.
#
# Usage:
#   ./scripts/deploy-testnet.sh              # uses .env.testnet
#   ENV_FILE=.env.custom ./scripts/deploy-testnet.sh
#
# The script is idempotent — re-running it skips contracts that
# already have an address recorded in the env file.
# ============================================================
set -euo pipefail

# ---- Resolve paths -------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.testnet}"

# ---- Colours / helpers ---------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Colour

info()  { printf "${CYAN}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[skip]${NC}  %s\n" "$*"; }
fail()  { printf "${RED}[error]${NC} %s\n" "$*" >&2; exit 1; }

# ---- Load / bootstrap env file -------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  info "Loading env from $ENV_FILE"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
else
  if [[ -f "$ROOT_DIR/.env.testnet.example" ]]; then
    info "No $ENV_FILE found — copying from .env.testnet.example"
    cp "$ROOT_DIR/.env.testnet.example" "$ENV_FILE"
    set -a
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a
  elif [[ -f "$ROOT_DIR/.env.example" ]]; then
    info "No $ENV_FILE found — copying from .env.example"
    cp "$ROOT_DIR/.env.example" "$ENV_FILE"
    set -a
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a
  else
    fail ".env.example not found. See README for setup instructions."
  fi
fi

# Helper: persist a key=value pair into the env file.
persist() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # Replace existing line in-place (portable sed)
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  export "$key=$value"
}

# ---- Check prerequisites -------------------------------------------
command -v stellar >/dev/null 2>&1 || fail "stellar-cli not found. Install: cargo install stellar-cli --locked"
command -v cargo   >/dev/null 2>&1 || fail "cargo not found. Install Rust: https://rustup.rs"

IDENTITY="${STELLAR_IDENTITY:-deployer}"
NETWORK="${STELLAR_NETWORK:-testnet}"

# ---- Ensure identity exists and is funded ---------------------------
if stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  ok "Identity '$IDENTITY' already exists"
else
  info "Creating identity '$IDENTITY' on $NETWORK ..."
  stellar keys generate --global "$IDENTITY" --network "$NETWORK"
  ok "Identity '$IDENTITY' created"
fi

DEPLOYER_ADDR="$(stellar keys address "$IDENTITY")"
info "Deployer address: $DEPLOYER_ADDR"

# Fund via friendbot (testnet only). Ignore errors if already funded.
if [[ "$NETWORK" == "testnet" ]]; then
  info "Funding identity via friendbot ..."
  stellar keys fund "$IDENTITY" --network "$NETWORK" 2>/dev/null || true
  ok "Identity funded (or was already funded)"
fi

# ---- Build WASM contracts -------------------------------------------
WASM_DIR="$ROOT_DIR/target/wasm32v1-none/release"

# Ensure the target is installed so the build doesn't fail with a cryptic error
if ! rustup target list --installed | grep -q 'wasm32v1-none'; then
  info "Installing wasm32v1-none target..."
  rustup target add wasm32v1-none
fi

info "Building WASM contracts (release) ..."
cargo build --release --target wasm32v1-none --manifest-path "$ROOT_DIR/Cargo.toml" --workspace
ok "WASM build complete"

# Verify expected artefacts exist
for wasm in sorogov_token_votes sorogov_timelock sorogov_governor sorogov_treasury sorogov_governor_factory sorogov_liquidity; do
  [[ -f "$WASM_DIR/${wasm}.wasm" ]] || fail "Expected WASM not found: $WASM_DIR/${wasm}.wasm"
done

# ---- Deploy helper --------------------------------------------------
# deploy_contract <WASM_FILE> <ENV_KEY>
#   Deploys a contract and persists its address under ENV_KEY.
#   Skips if ENV_KEY already holds a non-empty value.
deploy_contract() {
  local wasm_file="$1" env_key="$2"
  local current_value="${!env_key:-}"

  if [[ -n "$current_value" ]]; then
    warn "$env_key already set ($current_value) — skipping deploy"
    return 0
  fi

  info "Deploying $(basename "$wasm_file") ..."
  local addr
  addr="$(stellar contract deploy \
    --wasm "$wasm_file" \
    --source "$IDENTITY" \
    --network "$NETWORK")"

  [[ -n "$addr" ]] || fail "Deploy returned empty address for $wasm_file"

  persist "$env_key" "$addr"
  ok "$env_key = $addr"
}

# ---- invoke helper --------------------------------------------------
invoke() {
  stellar contract invoke \
    --id "$1" \
    --source "$IDENTITY" \
    --network "$NETWORK" \
    -- "$@"
}

# ====================================================================
# Deploy contracts in dependency order
# ====================================================================

# 1. Token-Votes
deploy_contract "$WASM_DIR/sorogov_token_votes.wasm" "TOKEN_VOTES_ADDRESS"

# 2. Timelock (needs governor address — use a placeholder, then update)
deploy_contract "$WASM_DIR/sorogov_timelock.wasm" "TIMELOCK_ADDRESS"

# 3. Governor
deploy_contract "$WASM_DIR/sorogov_governor.wasm" "GOVERNOR_ADDRESS"

# 4. Treasury
deploy_contract "$WASM_DIR/sorogov_treasury.wasm" "TREASURY_ADDRESS"

# 5. Factory
deploy_contract "$WASM_DIR/sorogov_governor_factory.wasm" "FACTORY_ADDRESS"

# 6. Liquidity
deploy_contract "$WASM_DIR/sorogov_liquidity.wasm" "LIQUIDITY_ADDRESS"

# ====================================================================
# Initialize contracts (idempotent — each checks storage internally)
# ====================================================================

# Resolve token addresses. If no governance token is provided, use native XLM.
NATIVE_TOKEN="${NATIVE_TOKEN_ADDRESS:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}"
SEP41_TOKEN="${SEP41_TOKEN_ADDRESS:-$NATIVE_TOKEN}"

# -- Initialize token-votes ------------------------------------------
info "Initializing token-votes ..."
stellar contract invoke \
  --id "$TOKEN_VOTES_ADDRESS" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$DEPLOYER_ADDR" \
  --token "$SEP41_TOKEN" \
  2>/dev/null && ok "token-votes initialized" \
  || warn "token-votes already initialized (or init failed — check manually)"

# -- Initialize timelock (use governor address or deployer as placeholder) -
TIMELOCK_GOVERNOR="${GOVERNOR_ADDRESS:-$DEPLOYER_ADDR}"
TIMELOCK_DELAY="${TIMELOCK_MIN_DELAY:-3600}"
TIMELOCK_WINDOW="${TIMELOCK_EXECUTION_WINDOW:-86400}"

info "Initializing timelock ..."
stellar contract invoke \
  --id "$TIMELOCK_ADDRESS" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$DEPLOYER_ADDR" \
  --governor "$TIMELOCK_GOVERNOR" \
  --min_delay "$TIMELOCK_DELAY" \
  --execution_window "$TIMELOCK_WINDOW" \
  2>/dev/null && ok "timelock initialized" \
  || warn "timelock already initialized (or init failed — check manually)"

# Persist timelock parameters
persist "TIMELOCK_MIN_DELAY" "$TIMELOCK_DELAY"
persist "TIMELOCK_EXECUTION_WINDOW" "$TIMELOCK_WINDOW"

# -- Initialize governor ----------------------------------------------
DELAY="${VOTING_DELAY:-60}"
PERIOD="${VOTING_PERIOD:-17280}"
QUORUM="${QUORUM_NUMERATOR:-4}"
THRESHOLD="${PROPOSAL_THRESHOLD:-100000000}"
GUARDIAN="${GUARDIAN_ADDRESS:-$DEPLOYER_ADDR}"
VOTE_TYPE="${VOTE_TYPE:-Extended}"

info "Initializing governor ..."
stellar contract invoke \
  --id "$GOVERNOR_ADDRESS" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$DEPLOYER_ADDR" \
  --votes_token "$TOKEN_VOTES_ADDRESS" \
  --timelock "$TIMELOCK_ADDRESS" \
  --voting_delay "$DELAY" \
  --voting_period "$PERIOD" \
  --quorum_numerator "$QUORUM" \
  --proposal_threshold "$THRESHOLD" \
  --guardian "$GUARDIAN" \
  --vote_type "$VOTE_TYPE" \
  2>/dev/null && ok "governor initialized" \
  || warn "governor already initialized (or init failed — check manually)"

# -- Initialize treasury -----------------------------------------------
TREASURY_THRESH="${TREASURY_THRESHOLD:-1}"

info "Initializing treasury ..."
stellar contract invoke \
  --id "$TREASURY_ADDRESS" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- initialize \
  --owners "[\"$DEPLOYER_ADDR\"]" \
  --threshold "$TREASURY_THRESH" \
  --governor "$GOVERNOR_ADDRESS" \
  2>/dev/null && ok "treasury initialized" \
  || warn "treasury already initialized (or init failed — check manually)"

# -- Initialize factory ------------------------------------------------
info "Initializing factory ..."

# Install each WASM and capture its hash for the factory.
GOVERNOR_HASH="$(stellar contract install \
  --wasm "$WASM_DIR/sorogov_governor.wasm" \
  --source "$IDENTITY" \
  --network "$NETWORK")"

TIMELOCK_HASH="$(stellar contract install \
  --wasm "$WASM_DIR/sorogov_timelock.wasm" \
  --source "$IDENTITY" \
  --network "$NETWORK")"

TOKEN_VOTES_HASH="$(stellar contract install \
  --wasm "$WASM_DIR/sorogov_token_votes.wasm" \
  --source "$IDENTITY" \
  --network "$NETWORK")"

stellar contract invoke \
  --id "$FACTORY_ADDRESS" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$DEPLOYER_ADDR" \
  --governor_wasm "$GOVERNOR_HASH" \
  --timelock_wasm "$TIMELOCK_HASH" \
  --token_votes_wasm "$TOKEN_VOTES_HASH" \
  2>/dev/null && ok "factory initialized" \
  || warn "factory already initialized (or init failed — check manually)"

info "Configuring factory native token preflight ..."
stellar contract invoke \
  --id "$FACTORY_ADDRESS" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- set_native_token \
  --admin "$DEPLOYER_ADDR" \
  --native_token "$NATIVE_TOKEN" \
  2>/dev/null && ok "factory native token configured" \
  || warn "factory native token already configured (or update failed — check manually)"

# ====================================================================
# Summary
# ====================================================================
printf '\n'
info "============================================================"
info "  NebGov testnet deployment complete"
info "============================================================"
info "  Deployer ............. $DEPLOYER_ADDR"
info "  Token-Votes .......... $TOKEN_VOTES_ADDRESS"
info "  Native Token ......... $NATIVE_TOKEN"
info "  Timelock ............. $TIMELOCK_ADDRESS"
info "  Timelock Min Delay ... $TIMELOCK_DELAY seconds"
info "  Timelock Exec Window . $TIMELOCK_WINDOW seconds"
info "  Governor ............. $GOVERNOR_ADDRESS"
info "  Treasury ............. $TREASURY_ADDRESS"
info "  Factory .............. $FACTORY_ADDRESS"
info "  Liquidity ............ $LIQUIDITY_ADDRESS"
info "  Env file ............. $ENV_FILE"
info "============================================================"
printf '\n'
ok "Done. Run again to verify idempotency — already-deployed contracts will be skipped."
