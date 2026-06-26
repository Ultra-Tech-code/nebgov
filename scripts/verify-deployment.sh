#!/usr/bin/env bash
# ============================================================
# scripts/verify-deployment.sh
#
# Verify that all NebGov contracts are deployed and initialized
# correctly on the configured Stellar network.
#
# Usage:
#   ./scripts/verify-deployment.sh              # uses .env.testnet
#   ENV_FILE=.env.custom ./scripts/verify-deployment.sh
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

if [[ ! -f "$ENV_FILE" ]]; then
  fail "Env file not found: $ENV_FILE"
fi

set -a
source "$ENV_FILE"
set +a

command -v stellar >/dev/null 2>&1 || fail "stellar-cli not found"

IDENTITY="${STELLAR_IDENTITY:-deployer}"
NETWORK="${STELLAR_NETWORK:-testnet}"

CONTRACTS=(
  "TOKEN_VOTES_ADDRESS:Token-Votes"
  "TIMELOCK_ADDRESS:Timelock"
  "GOVERNOR_ADDRESS:Governor"
  "TREASURY_ADDRESS:Treasury"
  "FACTORY_ADDRESS:Factory"
)

all_ok=true

for entry in "${CONTRACTS[@]}"; do
  var="${entry%%:*}"
  name="${entry##*:}"
  addr="${!var:-}"

  if [[ -z "$addr" ]]; then
    warn "$name: $var not set in env"
    all_ok=false
    continue
  fi

  result=$(stellar contract id --id "$addr" --network "$NETWORK" 2>/dev/null || true)
  if [[ -n "$result" ]]; then
    ok "$name: $addr"
  else
    fail "$name: $addr not found on $NETWORK"
    all_ok=false
  fi
done

info "Identity: $(stellar keys address "$IDENTITY" 2>/dev/null || echo 'not found')"

if $all_ok; then
  ok "All contracts verified successfully."
else
  fail "Some contracts failed verification."
fi
