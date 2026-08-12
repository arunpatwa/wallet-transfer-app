# Wallet / P2P Transfer Service

Users hold a balance in integer paise and transfer to each other. Money is never lost or created, a retried transfer never applies twice, and no one can move anyone else's money — including under a concurrent burst.

- **Live URL** — <https://wallet-transfer-app.onrender.com>
- **Logs** — <https://wallet-transfer-app.onrender.com/logs> (public, no login) · **Dashboard** — <https://wallet-transfer-app.onrender.com/>
- **Repo** — <https://github.com/arunpatwa/wallet-transfer-app>
- **Design** — [plan.md](plan.md) · **Write-up** — [WRITEUP.md](WRITEUP.md) · **Deploy** — [DEPLOY.md](DEPLOY.md)

## Run the correctness gate

One command, against the live service. Creates brand-new users each run, so it is safe to run repeatedly.

```bash
./burst.sh https://wallet-transfer-app.onrender.com
```

Last run against production: **37/37 checks passed**, including 30 concurrent first-transfers to a brand-new wallet, 25 concurrent retries of one idempotency key, and 50 simultaneous transfers against a balance affording exactly 5.

It fires overlapping first-transfers, concurrent retries of one idempotency key, and an overspend probe, then asserts that money is conserved, wallets are created exactly once, retries apply once, and nothing 5xxs. Prints a PASS/FAIL table and exits non-zero on any failure.

Nine phases: get-or-create race · concurrent retries · same-key-different-body → 409 · deadlock probe · two brand-new users transferring both ways at once · overspend probe · authorization · validation · conservation snapshot taken before and after.

Tunable: `BURST_N` (concurrent first transfers, default 30), `BURST_RETRIES` (25), `BURST_OVERSPEND` (50), `BURST_AMOUNT` (1000 paise).

## Run it locally

```bash
docker compose up --build          # app on :8080, Postgres on :5433
./burst.sh http://localhost:8080
```

Or without Docker, against your own Postgres:

```bash
cp .env.example .env               # set DATABASE_URL and JWT_SECRET
npm ci
npm run migrate
npm start
```

## Tests

```bash
npm ci
TEST_DATABASE_URL=postgres://user@host:5432/wallet_test npm test
```

28 tests. The concurrency suite drives a real HTTP server with overlapping requests rather than calling services directly, because the bugs it exists to catch only appear when requests genuinely interleave. Conservation is asserted after **every** test, so no case can pass while quietly creating or destroying money.

## API

All endpoints except `/auth/token` and the operational ones require `Authorization: Bearer <jwt>`. **The caller is the token's subject and nothing else** — no header or body field is ever consulted for identity.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/accounts` | Get-or-create the caller's wallet → `{ user_id, balance_paise }`. Idempotent. |
| `GET` | `/accounts/me` | `{ user_id, balance_paise }` |
| `POST` | `/transfers` | `{ to_user, amount_paise, idempotency_key }` → `{ transfer_id, new_balance }` |
| `GET` | `/transfers/:id` | Transfer detail. Participants only; anyone else gets 404. |
| `GET` | `/healthz` | Liveness. Touches no dependency. |
| `GET` | `/readyz` | Readiness including the datastore. 503 when unreachable. |
| `GET` | `/metrics` | Prometheus exposition, including p99 latency |
| `GET` | `/logs` | Recent structured logs (ring buffer), public |
| `GET` | `/invariants` | Aggregates that make conservation checkable: `total_balance_paise`, `ledger_sum_paise`, `ledger_balanced` |
| `GET` | `/` | Dashboard over the three endpoints above |

Two demo endpoints, each behind a default-off flag, exist so the gate runs as one command against a live URL. Neither is part of a production surface:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/token` | Mints a token for a `user_id`. Stands in for an identity provider; the service itself only ever *verifies*. |
| `POST` | `/dev/credit` | Capped treasury → caller credit, along the normal transfer path, so faucet money stays conserved. |

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request` | Malformed body; amount non-integer, zero, negative, a string, or over cap; missing key; malformed user id |
| 401 | `unauthenticated` | Token missing, malformed, expired, or badly signed |
| 404 | `not_found` | Unknown transfer, or one the caller is not party to |
| 409 | `idempotency_key_reuse` | Same key, different body |
| 422 | `insufficient_funds` | Well-formed and authorized, unprocessable given the balance |
| 422 | `self_transfer_not_allowed` | Recipient equals the caller |
| 503 | `database_unavailable` | Datastore unreachable or too slow — fails closed |

`422` rather than `402` (effectively reserved, means "pay the service") or `409` (kept for key reuse, so a client can branch on status alone: 409 means fix your key, 422 means fund the wallet).

## Try it by hand

```bash
URL=http://localhost:8080

ALICE=$(curl -s -X POST $URL/auth/token -H 'content-type: application/json' \
  -d '{"user_id":"alice"}' | sed -E 's/.*"access_token":"([^"]+)".*/\1/')

# Fund Alice from the treasury (demo faucet)
curl -s -X POST $URL/dev/credit -H "authorization: Bearer $ALICE" \
  -H 'content-type: application/json' \
  -d '{"amount_paise":500000,"idempotency_key":"seed-1"}'

# Transfer to Bob, whose wallet does not exist yet
curl -s -X POST $URL/transfers -H "authorization: Bearer $ALICE" \
  -H 'content-type: application/json' \
  -d '{"to_user":"bob","amount_paise":25000,"idempotency_key":"pay-bob-1"}'

# Same key again: replays the original outcome, moves nothing
curl -s -X POST $URL/transfers -H "authorization: Bearer $ALICE" \
  -H 'content-type: application/json' \
  -d '{"to_user":"bob","amount_paise":25000,"idempotency_key":"pay-bob-1"}'

# Same key, different amount: 409
curl -s -X POST $URL/transfers -H "authorization: Bearer $ALICE" \
  -H 'content-type: application/json' \
  -d '{"to_user":"bob","amount_paise":99999,"idempotency_key":"pay-bob-1"}'

# Conservation: total_balance_paise never changes, ledger_sum_paise is always 0
curl -s $URL/invariants
```

## How correctness is achieved

One `READ COMMITTED` transaction per transfer, no `SERIALIZABLE`, no external locks:

1. **`INSERT … ON CONFLICT (from_user, idempotency_key) DO UPDATE`** claims the key as the transaction's first write. `DO UPDATE` rather than `DO NOTHING` is the crux: on conflict it waits for the in-flight winner and returns the winner's committed row. `DO NOTHING` returns zero rows, and a follow-up `SELECT` cannot see an uncommitted row under `READ COMMITTED` — the classic find-or-create failure that either 500s or double-spends.
2. **`INSERT … ON CONFLICT DO NOTHING`** creates both wallets with no `SELECT`-then-`INSERT` window.
3. **`SELECT … ORDER BY user_id FOR UPDATE`** takes both rows in a deterministic order before either balance moves, so opposite-direction transfers cannot deadlock.
4. **`UPDATE … WHERE balance_paise >= amount`** decides affordability and applies the debit atomically. No balance is ever read then written.

The key is written before the mutation in the same transaction, so key and money commit or roll back together. See [WRITEUP.md](WRITEUP.md) for the alternatives rejected and why.

## Configuration

Every setting comes from the environment; see [.env.example](.env.example). Required: `DATABASE_URL`, `JWT_SECRET`. Nothing sensitive is committed.

On Supabase, use the **Connection Pooler** URI, not the direct one — the free tier has no IPv4 address on the direct connection and Render's egress is IPv4. Set `DATABASE_SSL=true`.
