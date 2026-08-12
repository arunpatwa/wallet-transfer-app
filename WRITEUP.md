# Wallet / P2P Transfer Service — Write-up

Live: <https://wallet-transfer-app.onrender.com> · Logs: [`/logs`](https://wallet-transfer-app.onrender.com/logs) · Gate: `./burst.sh <url>` → **37/37 against production**

## Data model

```
wallets         user_id PK, balance_paise BIGINT, created_at
transfers       id PK (app-generated UUID), from_user, to_user, amount_paise,
                idempotency_key, request_hash, status, reason, from_balance_after
ledger_entries  transfer_id FK, user_id FK, amount_paise (signed)
```

Four constraints carry the correctness, not application logic:

| Constraint | Guarantees |
|---|---|
| `UNIQUE (from_user, idempotency_key)` | exactly-once is a database property; scoped per sender so keys can't be probed across users |
| `CHECK (balance_paise >= 0)` | independent backstop to the conditional debit — aborts rather than commit negative money |
| `UNIQUE (transfer_id, user_id)` on ledger | a transfer physically cannot be applied twice |
| `CHECK (from_user <> to_user)` | self-transfer unrepresentable |

`status='pending'` exists only inside an open transaction, so a crash leaves no orphans.

**Money supply.** One seeded `@treasury` wallet holds the entire supply (10¹⁴ paise); money reaches users only by moving out of it along the normal transfer path. So `SUM(balance_paise)` is constant for the life of the database and `SUM(ledger.amount_paise)` is always 0 — conservation is *checkable* at `/invariants`, not merely asserted. `@` is outside the `user_id` grammar, so the treasury is unaddressable by any well-formed request.

**Integer money.** `BIGINT` paise throughout; a type parser maps `INT8`→`Number`, with supply and per-transfer cap far below 2⁵³. One trap worth recording: `sum(bigint)` returns `numeric`, which falls outside that parser and arrives as a *string* — `ledger_balanced` was comparing `'0' === 0` and reporting a balanced ledger as unbalanced. Fixed with `::bigint` casts; a test caught it, not inspection.

## Get-or-create + transfer, safely

One `READ COMMITTED` transaction. Four statements:

```sql
1. INSERT INTO transfers (...) VALUES (...,'pending')
   ON CONFLICT (from_user, idempotency_key)
     DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key   -- no-op
   RETURNING *;                     -- id ≠ ours ⇒ replay or lost race
2. INSERT INTO wallets (user_id) VALUES ($lo),($hi) ON CONFLICT DO NOTHING;
3. SELECT user_id FROM wallets WHERE user_id IN ($lo,$hi) ORDER BY user_id FOR UPDATE;
4. UPDATE wallets SET balance_paise = balance_paise - $amt
   WHERE user_id = $from AND balance_paise >= $amt RETURNING balance_paise;
   -- then credit, two ledger rows, terminal status. COMMIT.
```

**`DO UPDATE`, not `DO NOTHING`, on the key — this is the crux.** With `DO NOTHING` a losing request gets zero rows, and its follow-up `SELECT` sees *nothing*, because under `READ COMMITTED` the winner's row is uncommitted. That is the classic find-or-create failure: the loser 500s, or proceeds and moves the money twice. `DO UPDATE` takes a row lock and **blocks until the winner commits**, then returns the committed row to replay. One statement, no retry loop, no gap. Production evidence: `{"event":"transfer.race_lost","blocked_ms":188,"status":"applied"}` — a request that genuinely waited, then replayed.

**Wallets use `DO NOTHING`** — no `SELECT`-then-`INSERT` window exists; we need the row to exist, not to read it back.

**Key placement.** Inside the same transaction, *before* the mutation. Key and money commit or roll back as one atom — no interleaving where one happened without the other.

**Where I was wrong.** I believed sorting the *upsert* ordered lock acquisition and that `FOR UPDATE` bought nothing. Both false: `ON CONFLICT DO NOTHING` takes no lasting lock on an existing row, so lock order was set by debit-then-credit — the transfer's *direction*. A→B took A then B while B→A took B then A, and deadlocked. Measured: 40 opposite-direction transfers produced 503s and a 500 over **14.2s**; with the sorted `FOR UPDATE`, **0.43s**. It orders locks only — affordability is still decided atomically by step 4, so no read-then-write window.

**Rejected alternatives:** `SERIALIZABLE` (turns contention into retry storms); `FOR UPDATE` *as the affordability check* (read-then-write is the overspend bug — distinct from using it to order locks); advisory locks on the pair (serialises non-conflicting transfers); Redis/external lock (a second system that can disagree about whether money moved; expiry mid-commit is a double-spend); app mutex or single-writer queue (dies at two replicas); idempotency records in a separate store (drifts from the money it guards).

## Idempotency

**Stored** on the `transfers` row itself — `idempotency_key` + `request_hash` under `UNIQUE (from_user, idempotency_key)`. Not a separate table, so the two cannot disagree.

**Matched** by `request_hash` = sha256 of a canonicalised `{amount_paise, to_user}` with field order fixed in code, so equivalent bodies hash identically regardless of JSON key order. Same key + same hash → replay the stored outcome verbatim (original `transfer_id`, original balance, original status). Same key + **different hash → 409**.

**Rejections are durable.** Insufficient funds *commits* with `status='rejected'`, so the key returns the same 422 forever — even after a top-up. One key names one attempt with one answer. Rolling back instead would let one key give different answers over time, a weaker guarantee.

**Expiry: none, deliberately.** The transfer record *is* the audit trail. A TTL is a retention policy, not a correctness mechanism, and deleting a key silently re-arms a replay. Growth is one row per transfer; at scale the answer is monthly partitioning and archival, not deletion.

## Identity and authorization

Bearer JWT, HS256, `algorithms: ['HS256']` pinned — without the pin, `alg:none` skips verification entirely and `alg:RS256` could be verified with our secret as a public key. `exp` and `iss` checked.

The caller is `req.auth.sub` and nothing else. **No code path reads identity from a header, query or body**; a `from_user` in a body is never read. The gate proves it by sending one from an attacker's token and asserting the victim's balance is untouched. Non-participants reading a transfer get **404, not 403** — a 403 confirms the id exists. The rejection *reason* is logged, never returned.

Two flag-gated demo endpoints exist so the gate is one command against a live URL: `POST /auth/token` (an IdP stand-in — the service only ever *verifies*, and no verification path depends on it) and `POST /dev/credit` (treasury → caller along the normal transfer path, so faucet money stays conserved).

## Consistency vs. availability

**Priorities: correctness → durability → availability → latency.** Deliberately **CP**.

The failure modes aren't symmetric. An unavailable wallet is a support ticket; a double-spent wallet is an unreconcilable ledger. Availability lost in an outage is fully recovered when it ends — a duplicated paisa is not, because nothing records what the truth should have been.

**Transfer path: reject, never degrade.** Slow or unreachable database → **503**, no money moves. Connection acquisition, `statement_timeout` (3s) and `lock_timeout` (2.5s) are bounded, so requests fail fast. No queue, no write-behind, no optimistic local apply — each would mean accepting movement we cannot prove we durably recorded, which is how money gets created. A 503 is safely retryable with the same key, so failing closed costs a retry.

**Read path: also consistent.** No cache, no stale fallback. Clients *act* on balances: stale-high manufactures phantom insufficient-funds errors, stale-low suppresses legitimate transfers. Note the bound on the risk — the write path never trusts a read (affordability lives in the conditional `UPDATE`), so a stale read can't *cause* an overspend, only mislead. That's why reads are the one defensible place to degrade, and still not worth it at this scale. Scaling reads later means a replica with the staleness bound stated, not an opaque cache.

**Health split.** `/healthz` is liveness, touches nothing — an orchestrator must not kill a healthy process over a database blip. `/readyz` probes the datastore and returns 503 so the LB drains. Render's health check targets `/healthz` deliberately: pointing it at readiness turns an outage into a restart loop.

## Edge cases

| Case | Behaviour |
|---|---|
| Insufficient funds | 422, rejection committed, no movement |
| Self-transfer | 422 (also unrepresentable via CHECK) |
| Unknown recipient | wallet created as part of the transfer, then credited |
| Retry same body / different body | replay original outcome / **409** |
| Concurrent identical requests | one wins; losers block and replay |
| Zero, negative, fractional, string, over-cap amount | 400 — never coerced or rounded |
| Both users brand new, both directions at once | each wallet created once, both 422, never a 500 |
| `from_user` injected in body | ignored |
| Stranger or malformed transfer id | 404 |
| Treasury as counterparty | 400 (outside the `user_id` grammar) |
| Right path, wrong method | 405 with `Allow` |
| Database unreachable | 503 writes, `/readyz` 503, `/healthz` still 200 |

## Containerization, deploy, observability

**Image.** Multi-stage — deps resolved in a builder so npm cache and devDependencies never reach the runtime layer. `node:22-alpine`, non-root `node` user, `HEALTHCHECK` on `/healthz` via busybox `wget`. Verified: `whoami`→`node`, health→`healthy`, 250 MB disk / 60.3 MB content. Entrypoint migrates then serves; safe on concurrent boots via a transaction-scoped advisory lock. `docker compose up --build` brings up app + db, waiting for *healthy* rather than started. CI runs migrations, all 35 tests, an image build and a non-root assertion from a clean checkout.

**Deploy.** Render runs the image (not a buildpack); Postgres on Supabase. Supabase's free tier gives the direct connection no IPv4 and Render's egress is IPv4, so the **Shared Pooler** is mandatory — the direct URI is unreachable, not merely slower. Because the connection is pooled, nothing assumes session state: `pg_advisory_xact_lock` and `SET LOCAL` timeouts. Secrets come from the environment (`sync: false` / `generateValue`); nothing sensitive is committed.

**Observability.** `pino` JSON to stdout plus a ring buffer at `/logs` (public, no login). Correlation id per request via `AsyncLocalStorage` — necessary because the interesting events happen deep in the transaction, where a logger argument at every call site would obscure the money logic. Events: `transfer.applied`, `transfer.rejected`, `transfer.idempotent_replay`, `transfer.race_lost` (with `blocked_ms`), `wallet.getorcreate`, `auth.failed`. Operational routes are excluded from request logging — polling filled 924 of 1000 buffer slots and evicted every transfer event. Metrics at `/metrics`: request count by route/status (error rate derives from it), a latency histogram plus a summary carrying p99, and counters for applied/rejected/replays/races/auth failures. `/` renders all of it.

## AI usage

Claude Code (Opus) wrote most of the code; I directed the engineering decisions and the review.

**Directed:** the stack (plain JS, Express, raw `pg` — the concurrency control is the substance and belongs visible in the SQL); deployment targets; keeping the surface minimal (I cut proposed extras more than once); treasury-based money supply rather than seeding wallets, because only the former keeps conservation globally true; durable rejections; small single-purpose commits.

**Decided after being shown options:** 422 over 402/409; 404 over 403 for non-participants; keys retained rather than expired; Render's health check on `/healthz`.

**Model's, reviewed and kept:** the specific SQL shapes and where each `ON CONFLICT` variant belongs; `xmax = 0` to distinguish insert from conflict in one round trip; `SET LOCAL` over session settings; `AsyncLocalStorage` correlation ids; the `@`-prefixed unaddressable treasury.

**What testing changed:** two things we both had wrong. The `numeric`-as-string bug that made the conservation endpoint report a balanced ledger as unbalanced, and the lock-ordering claim — the design asserted sorting the upsert prevented deadlock, and a 40-request bidirectional test produced 503s and a 500 over 14.2s. I'd flagged that mechanism as the thing to verify empirically rather than argue about, which is why the test existed. The design doc was corrected in place with the measurement recorded, not quietly edited to match.

Honestly: the model was fast and mostly right about the SQL, and confidently wrong about one concurrency property. The tests settled it.

## Cost

| Component | Tier | Cost |
|---|---|---|
| Render web service | Free — 512 MB, 750 instance-hours/mo | ₹0 |
| Supabase Postgres | Free — 500 MB | ₹0 |
| GitHub + Actions | Free (public repo) | ₹0 |
| Keep-alive cron | Free | ₹0 |

**₹0**, no payment method on file anywhere. Known limits: Render cold-starts after 15 min idle (keep-alive ping mitigates; the burst script also waits one out), and Supabase pauses a project after 7 days idle — outside the review window, resumable in one click.
