#!/usr/bin/env bash
#
# The correctness gate, in one command.
#
#   ./burst.sh                                  # against localhost:8080
#   ./burst.sh https://your-service.example.com # against a deployment
#
# Exits non-zero if any invariant fails, so it can be used as a check in CI.
#
# Tunable via the environment:
#   BURST_N=30          concurrent first transfers, and half that per direction
#   BURST_RETRIES=25    concurrent retries sharing one idempotency key
#   BURST_OVERSPEND=50  simultaneous attempts against a balance affording 5
#   BURST_AMOUNT=1000   paise per transfer
set -euo pipefail

exec node "$(dirname "$0")/scripts/burst.mjs" "${1:-http://localhost:8080}"
