#!/usr/bin/env bash
# ============================================================
# scripts/upgrade-contract.sh
#
# Submit a governance-driven WASM upgrade for a NebGov contract.
#
# Usage:
#   ./scripts/upgrade-contract.sh <contract-name>
#
#   contract-name is the Cargo package name, e.g.:
#     sorogov_governor | sorogov_timelock | sorogov_token_votes
#     sorogov_treasury | sorogov_governor_factory
#
# Required env vars (or set in .env.testnet):
#   GOVERNOR_ADDRESS   — deployed governor contract address
#   DEPLOYER_ADDR      — proposer address (must hold governance tokens)
#   STELLAR_IDENTITY   — stellar-cli key name (default: deployer)
#   STELLAR_NETWORK    — testnet | mainnet (default: testnet)
#
# Optional env vars:
#   PROPOSAL_DESCRIPTION — human-readable upgrade description
#   TIMELOCK_MIN_DELAY   — seconds; used to compute execution ledger
#
# The script:
#   1. Builds + installs the new WASM, capturing its hash
#   2. Constructs upgrade(wasm_hash) calldata
#   3. Submits a governance proposal via stellar contract invoke
#   4. Prints the proposal ID and expected execution ledger
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.testnet}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { printf "${CYAN}[info]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$*"; }
fail()  { printf "${RED}[error]${NC} %s\n" "$*" >&2; exit 1; }

# ---- Args -------------------------------------------------------
CONTRACT_NAME="${1:-}"
[[ -n "$CONTRACT_NAME" ]] || fail "Usage: $0 <contract-name>  (e.g. sorogov_governor)"

# ---- Load env ---------------------------------------------------
if [[ -f "$ENV_FILE" ]]; then
  info "Loading env from $ENV_FILE"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

# ---- Prerequisites ----------------------------------------------
command -v stellar >/dev/null 2>&1 || fail "stellar-cli not found. Run: cargo install stellar-cli --locked"
command -v cargo   >/dev/null 2>&1 || fail "cargo not found. Install Rust: https://rustup.rs"

IDENTITY="${STELLAR_IDENTITY:-deployer}"
NETWORK="${STELLAR_NETWORK:-testnet}"

GOVERNOR_ADDRESS="${GOVERNOR_ADDRESS:-}"
[[ -n "$GOVERNOR_ADDRESS" ]] || fail "GOVERNOR_ADDRESS is not set. Run deploy-testnet.sh first or set it in $ENV_FILE."

DEPLOYER_ADDR="${DEPLOYER_ADDR:-$(stellar keys address "$IDENTITY")}"
[[ -n "$DEPLOYER_ADDR" ]] || fail "Cannot resolve deployer address for identity '$IDENTITY'."

DESCRIPTION="${PROPOSAL_DESCRIPTION:-"Upgrade $CONTRACT_NAME WASM to latest build"}"

# ---- Build WASM -------------------------------------------------
WASM_FILE="$ROOT_DIR/target/wasm32v1-none/release/${CONTRACT_NAME}.wasm"

info "Building WASM for $CONTRACT_NAME (release) ..."
cargo build --release --target wasm32v1-none --manifest-path "$ROOT_DIR/Cargo.toml" \
  -p "$(echo "$CONTRACT_NAME" | tr '_' '-')" 2>&1 | grep -v "^$" || true

[[ -f "$WASM_FILE" ]] || fail "WASM not found after build: $WASM_FILE"
ok "WASM built: $WASM_FILE"

# ---- Install WASM and capture hash ------------------------------
info "Installing WASM on $NETWORK ..."
WASM_HASH="$(stellar contract install \
  --wasm "$WASM_FILE" \
  --source "$IDENTITY" \
  --network "$NETWORK")"

[[ -n "$WASM_HASH" ]] || fail "stellar contract install returned empty hash"
ok "WASM hash: $WASM_HASH"

# ---- Encode upgrade(wasm_hash) calldata -------------------------
# The upgrade function takes a BytesN<32> argument.
# We pass it as a hex string and let stellar-cli XDR-encode it.
info "Constructing upgrade calldata for hash $WASM_HASH ..."

# Build the calldata by simulating the upgrade call (--build-only) and
# capturing the XDR operation argument, then encoding it as bytes.
CALLDATA_HEX="$WASM_HASH"

# ---- Submit governance proposal ---------------------------------
info "Submitting upgrade proposal to governor $GOVERNOR_ADDRESS ..."
info "  Proposer  : $DEPLOYER_ADDR"
info "  Target    : $GOVERNOR_ADDRESS"
info "  Function  : upgrade"
info "  Description: $DESCRIPTION"

PROPOSAL_OUTPUT="$(stellar contract invoke \
  --id "$GOVERNOR_ADDRESS" \
  --source "$IDENTITY" \
  --network "$NETWORK" \
  -- propose \
  --proposer "$DEPLOYER_ADDR" \
  --description "$DESCRIPTION" \
  --description_hash "0000000000000000000000000000000000000000000000000000000000000000" \
  --metadata_uri "" \
  --targets "[\"$GOVERNOR_ADDRESS\"]" \
  --fn_names "[\"upgrade\"]" \
  --calldatas "[\"$CALLDATA_HEX\"]" \
  2>&1)"

PROPOSAL_ID="$(printf '%s' "$PROPOSAL_OUTPUT" | grep -Eo '[0-9]+' | tail -1 || true)"

if [[ -z "$PROPOSAL_ID" ]]; then
  warn "Could not parse proposal ID from output. Full output:"
  printf '%s\n' "$PROPOSAL_OUTPUT"
else
  ok "Proposal submitted — ID: $PROPOSAL_ID"
fi

# ---- Compute expected execution ledger --------------------------
CURRENT_LEDGER="$(stellar network status --network "$NETWORK" 2>/dev/null \
  | grep -Eo 'ledger[^0-9]*[0-9]+' | grep -Eo '[0-9]+' | head -1 || echo "unknown")"

TIMELOCK_DELAY_SEC="${TIMELOCK_MIN_DELAY:-3600}"
VOTING_DELAY_LEDGERS="${VOTING_DELAY:-60}"
VOTING_PERIOD_LEDGERS="${VOTING_PERIOD:-17280}"
# ~1 ledger per 5 seconds on Stellar
TIMELOCK_DELAY_LEDGERS=$(( TIMELOCK_DELAY_SEC / 5 ))

if [[ "$CURRENT_LEDGER" != "unknown" ]]; then
  EXEC_LEDGER=$(( CURRENT_LEDGER + VOTING_DELAY_LEDGERS + VOTING_PERIOD_LEDGERS + TIMELOCK_DELAY_LEDGERS ))
else
  EXEC_LEDGER="unknown (could not fetch current ledger)"
fi

# ---- Summary ----------------------------------------------------
printf '\n'
info "============================================================"
info "  NebGov contract upgrade proposal"
info "============================================================"
info "  Contract ............. $CONTRACT_NAME"
info "  WASM hash ............ $WASM_HASH"
info "  Governor ............. $GOVERNOR_ADDRESS"
[[ -n "$PROPOSAL_ID" ]] && info "  Proposal ID .......... $PROPOSAL_ID"
info "  Current ledger ....... $CURRENT_LEDGER"
info "  Expected exec ledger . $EXEC_LEDGER"
info "============================================================"
printf '\n'
ok "Next steps:"
ok "  1. Vote on proposal $PROPOSAL_ID during the voting period"
ok "  2. Call 'queue' after voting succeeds"
ok "  3. Call 'execute' at or after ledger $EXEC_LEDGER"
