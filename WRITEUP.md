# Wallet / P2P Transfer Service — Write-up

Sections follow the order the brief asked for them in.

## Data model

Three tables. Money is `BIGINT` paise throughout; no float appears anywhere.

```
wallets          user_id PK, balance_paise BIGINT >= 0, created_at
transfers        id PK (app-generated UUID), from_user, to_user, amount_paise,
                 idempotency_key, request_hash, status, reason,
                 from_balance_after, created_at
                 UNIQUE (from_user, idempotency_key)
                 CHECK  (from_user <> to_user)
                 CHECK  ((status = 'rejected') = (reason IS NOT NULL))
ledger_entries   id PK, transfer_id FK, user_id FK, amount_paise (signed)
                 UNIQUE (transfer_id, user_id)
```

Four constraints carry the correctness, rather than application logic:

- **`UNIQUE (from_user, idempotency_key)`** makes exactly-once a database property. Scoped per sender, so one user cannot deny service to another — or probe their history — by guessing keys.
- **`CHECK (balance_paise >= 0)`**, named `wallets_balance_non_negative`, is an independent backstop to the conditional debit. If that debit were ever wrong the transaction aborts rather than committing negative money, and the application recognises this specific violation as the invariant breach it would be.
- **`UNIQUE (transfer_id, user_id)`** on the ledger makes double-application physically impossible.
- **`CHECK (from_user <> to_user)`** makes self-transfer unrepresentable, not merely validated.

`status` is `pending` only *inside* an open transaction — written as the first statement, overwritten with a terminal status before commit — so a crashed process leaves no orphan rows.

**Money supply.** A single `@treasury` wallet is seeded with 10¹⁴ paise and is the only source of funds. Money reaches a user wallet only by moving out of the treasury along the same transaction path as any other transfer. `SUM(balance_paise)` across all wallets is therefore constant for the life of the database, and `SUM(ledger_entries.amount_paise)` is always zero. That turns conservation from a claim into an assertion anyone can check, exposed at `GET /invariants`. The `@` prefix is outside the `user_id` grammar, so the treasury is unaddressable by any well-formed request: no token can be minted for it and no transfer can name it.

**Integer money.** A `pg` type parser maps `INT8` to `Number`; the whole supply (10¹⁴) and the per-transfer cap (10¹²) sit far below 2⁵³, so no value risks precision loss. One subtlety bit us and is worth recording: `sum()` over a `bigint` column returns `numeric`, not `bigint`, so it falls outside that parser and arrives as a *string*. `ledger_balanced` was comparing `'0' === 0` and reporting a perfectly balanced ledger as unbalanced. Fixed with explicit `::bigint` casts. A test caught it, not inspection.

## The get-or-create + transfer race

One `READ COMMITTED` transaction per transfer. Four SQL primitives, in this order:

```sql
BEGIN;  SET LOCAL statement_timeout = 3000;  SET LOCAL lock_timeout = 2500;

-- 1. Claim the key. First write of the transaction.
INSERT INTO transfers (id, from_user, to_user, amount_paise,
                       idempotency_key, request_hash, status)
VALUES ($ourUuid, ..., 'pending')
ON CONFLICT (from_user, idempotency_key)
  DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
RETURNING *;
--   id came back ≠ $ourUuid  →  replay or lost race

-- 2. Get-or-create both wallets.
INSERT INTO wallets (user_id) VALUES ($lo), ($hi) ON CONFLICT DO NOTHING;

-- 3. Order the locks, before either balance moves.
SELECT user_id FROM wallets WHERE user_id IN ($lo, $hi) ORDER BY user_id FOR UPDATE;

-- 4. Conditional debit. Zero rows = insufficient funds.
UPDATE wallets SET balance_paise = balance_paise - $amt
WHERE user_id = $from AND balance_paise >= $amt RETURNING balance_paise;

-- then credit, two ledger rows, terminal status.
COMMIT;
```

**`ON CONFLICT DO UPDATE`, not `DO NOTHING`, on the idempotency row — this is the crux.** With `DO NOTHING`, a request that loses the race gets zero rows back, and its follow-up `SELECT` sees *nothing*, because under `READ COMMITTED` the winner's row is still uncommitted. That is exactly the classic find-or-create failure: the loser either 500s on a row that "should" be there, or proceeds and moves the money a second time. `DO UPDATE` instead takes a row lock on the conflicting tuple and **blocks until the winner commits**, then returns the committed row. The loser wakes up, sees a `request_hash` and a terminal status, and replays the winner's outcome. One statement, no application retry loop, no gap. The `SET` is a deliberate no-op — we want the conflict handling, not a change.

**Get-or-create is `ON CONFLICT DO NOTHING`** — no `SELECT`-then-`INSERT` window exists, so two concurrent first-transfers cannot both insert; the index resolves it. `DO NOTHING` is right here, unlike on the idempotency row, because we don't need the loser's row back — we only need the row to exist, and it does.

**Where the idempotency key sits relative to the balance mutation.** Inside the same transaction, written *before* the mutation. Key and money commit or roll back as one atom. There is no interleaving in which money moved but the key wasn't recorded, or the key was recorded but the money didn't move.

**Where I was wrong, and what fixed it.** I originally believed sorting the wallet *upsert* ordered lock acquisition, and that an explicit `FOR UPDATE` bought nothing. Both were wrong. `ON CONFLICT DO NOTHING` takes no lasting lock on a row that already exists, so for an established pair the upsert orders nothing — the real lock order was set by the debit and credit that follow, which is the transfer's *direction*. A→B took A then B while B→A took B then A, and they deadlocked. Measured: 40 opposite-direction transfers produced 503s and a 500 over 14.2 seconds. Adding the sorted `SELECT … FOR UPDATE` brought the same test to 0.43 seconds. It is lock ordering only — affordability is still decided by the conditional `UPDATE`, so no read-then-write window is introduced.

**Heavier alternatives rejected:**

| Alternative | Why not |
|---|---|
| `SERIALIZABLE` isolation | Correct, but converts contention into serialization failures; a burst becomes a retry storm with a much worse tail. The conditional UPDATE already gives the needed atomicity at `READ COMMITTED`. |
| `FOR UPDATE` **as the affordability check** | Read-then-write is the canonical overspend bug. Distinct from using it to order locks, which this design does need. |
| `pg_advisory_xact_lock` on the wallet pair | Serialises transfers that don't conflict, and adds a lock namespace to reason about. |
| Redis or other external lock | A second system that can disagree with the source of truth about whether money moved; lock expiry during a slow commit is a double-spend. |
| Application mutex / single-writer queue | Evaporates the moment a second replica exists — and the deploy target runs replicas. |
| Idempotency records in a separate store | Can drift from the money they exist to guard; the two-write problem has no clean solution without a transaction spanning both. |
| Catch-unique-violation then retry | Works, but needs an application retry loop and a second round trip to do what `ON CONFLICT DO UPDATE` does in one statement. |

Transactions retry up to 3 times with jittered backoff on SQLSTATE `40001`/`40P01`. With the lock ordering in place this should be unreachable; it emits a metric so we'd know if it ever fired.

## Idempotency: storage, matching, expiry

**Stored** as two columns on the `transfers` row itself — `idempotency_key` and `request_hash` — under `UNIQUE (from_user, idempotency_key)`. Not a separate table: the transfer record *is* the idempotency record, which removes any possibility of the two disagreeing.

**Matched** on replay by comparing `request_hash`: the sha256 of a canonicalised `{amount_paise, to_user}`. Field order is fixed in code rather than derived from the incoming object, so two requests with the same meaning hash identically regardless of JSON key order or whitespace. The key itself is excluded from the hash — it is the lookup key, not part of the intent.

- Same key, same hash → replay the stored outcome verbatim: the original `transfer_id`, the original balance, the original status code. No money moves. The balance returned is the balance *as it was when the transfer was applied*, not the balance now — that is the point of replaying an outcome.
- Same key, different hash → **409 `idempotency_key_reuse`**. The client reused a key for a different intent, which is a client bug; guessing which intent they meant would be worse than refusing.

**Rejections are durable.** An insufficient-funds transfer *commits* with `status='rejected'`, so the same key returns the same 422 forever — including after the sender tops up. This is the strict reading of "a retry with the same key returns the original outcome": one key names one attempt with one answer, permanently. The alternative — rolling back and leaving the key unconsumed — is friendlier but lets one key produce different answers at different times, which is a materially weaker guarantee. There is a test for exactly this: reject, top up, replay, still 422.

**Expiry: none, deliberately.** Keys live as long as the transfer record, because that record is the audit trail. A TTL sweep would be a retention policy, not a correctness mechanism, and it has a sharp edge: deleting a key silently re-arms a replay, so a client retrying an old request after expiry would move money twice. The cost is one row per transfer, the same growth the ledger already has. At real scale the answer is range partitioning by month with cold partitions archived — not deletion.

## Identity and authorization

Bearer JWT, HS256, secret from the environment. Verification pins `algorithms: ['HS256']`, which is essential rather than cosmetic: without it, a token declaring `alg: none` skips signature verification entirely, and one declaring `alg: RS256` could be verified with our secret treated as a public key. `exp` and `iss` are both checked.

The caller is `req.auth.sub` and nothing else. **No code path reads a caller identity from a header, a query parameter, or a body field.** A `from_user` in a transfer body is not read at all, so it cannot be honoured — the correctness gate asserts this by sending one from an attacker's token and confirming the victim's balance is untouched and the attacker's is debited.

- A caller can only debit their own wallet, because `from_user` is bound to the verified subject.
- `GET /transfers/:id` returns the transfer only to `from_user` or `to_user`; anyone else gets **404**, not 403, because a 403 would confirm to a stranger that the id exists. Malformed ids get the same answer instead of reaching the database.
- `user_id` must match `^[A-Za-z0-9_.:-]{3,64}$`, which structurally excludes `@treasury`.
- The rejection *reason* is logged, never returned — telling a caller which part of their forgery failed helps only the forger.

**Two demo endpoints**, each behind its own default-off flag, exist so the correctness gate runs as one command against a live URL:

- `POST /auth/token` mints a token for a requested `user_id`. An explicit stand-in for an identity provider; in a real deployment tokens arrive from the IdP and this does not exist. The service only ever *verifies* — no verification path depends on the minting endpoint existing.
- `POST /dev/credit` moves capped amounts from the treasury to the caller, through the normal transfer path, so faucet money is conserved and auditable rather than conjured.

Both are honest weak points of the demo surface and are called out as such.

## Consistency vs. availability

**NFR priorities, strictly ordered: correctness → durability → availability → latency.** Deliberately **CP**: on partition, refuse.

This ordering follows from the workload, not from taste. The failure modes are not symmetric. An unavailable wallet is a support ticket; a double-spent wallet is an unreconcilable ledger, a financial loss, and a regulatory problem. Availability lost during an outage is fully recovered the moment the outage ends — a phantom or duplicated paisa is not, because there is no record of what the truth should have been.

**Transfer path: reject, never degrade.** If the database is slow or unreachable, transfers return **503** and no money moves. Connection acquisition, `statement_timeout` (3s) and `lock_timeout` (2.5s) are all bounded, so a request fails fast instead of hanging. There is no in-memory queue of pending transfers, no write-behind buffer, no optimistic local application — each of those means accepting money movement the service cannot prove it has durably recorded, which is precisely how money gets created. A caller receiving 503 may safely retry with the same idempotency key, so failing closed costs them only a retry.

**Read path: also consistent, and this is the less obvious call.** `GET /accounts/me` reads through to the primary. No cache, no stale-read fallback. The tempting argument is that a slightly stale balance is harmless — but it is not, because clients *act* on balances. A stale-high balance manufactures insufficient-funds rejections that look like bugs; a stale-low one suppresses legitimate transfers. The authoritative read is cheap here: one primary-key lookup.

Worth being precise about the limit of that risk: the write path never trusts a read anyway, since affordability lives inside the conditional `UPDATE`. So a stale read can never *cause* an overspend — it can only mislead a human or a client. That is why reads are the one place where degradation would be defensible, and it is still not worth it at this scale. If reads later needed to scale, the honest design is a read replica with the staleness bound stated in the response, not an opaque cache.

**Health signalling.** `/healthz` is liveness only and touches no dependency, so an orchestrator never kills a healthy process over a database blip. `/readyz` runs `SELECT 1` with a short timeout and flips to 503 when the datastore is unreachable, so the load balancer drains instead. Separating the two is what makes "fail closed" a drain rather than a crash loop — and it is why Render's health check points at `/healthz`: aiming it at `/readyz` would turn a database outage into a restart loop.

## Edge cases handled

| Case | Behaviour |
|---|---|
| Insufficient funds | 422, rejection committed durably, no money moves |
| Self-transfer | 422; also unrepresentable via a table CHECK |
| Unknown recipient | Wallet created as part of the transfer, then credited |
| Retry, same body | Replays the original outcome and status; no second movement |
| Retry, different body | 409 |
| Concurrent identical requests | One wins; losers block on the conflicting row and replay the committed outcome |
| Zero / negative amount | 400 |
| Non-integer amount (`10.5`) | 400 — never coerced or rounded |
| Amount as a string (`"100"`) | 400 — accepting it invites accepting `"100.5"` |
| Amount over cap | 400, keeping arithmetic inside safe-integer range |
| Both users brand new, both directions at once | Each wallet created exactly once, both refused 422, never a 500 |
| `from_user` injected into body | Ignored; caller is the token subject |
| Reading a stranger's transfer | 404 |
| Malformed transfer id | 404, without reaching the database |
| Treasury named as counterparty | 400 — outside the `user_id` grammar |
| Refused transfer's recipient | Wallet exists at zero — get-or-create precedes the debit attempt |
| Database unreachable | 503 on writes, `/readyz` 503, `/healthz` still 200 |

## Containerization, deploy, observability

**Container.** Multi-stage: a builder resolves production dependencies so the npm cache and devDependencies never reach the runtime layer. Runtime is `node:22-alpine` running as the unprivileged `node` user, with a `HEALTHCHECK` on `/healthz` using busybox `wget` — no extra package installed. The entrypoint applies migrations then serves; safe on concurrent boots because the runner holds a transaction-scoped advisory lock (transaction-scoped, not session-scoped, because the connection may be pooled).

**Local.** `docker compose up --build` brings up app and Postgres in one command, waiting for the database to report *healthy* rather than merely started — Postgres accepts TCP some seconds before it accepts queries, and without the condition the first boot races the migration. Postgres is published on 5433 so it cannot collide with a host instance.

**Config.** 12-factor throughout. `.env.example` documents every variable with placeholder values only; nothing sensitive is committed. `render.yaml` marks `DATABASE_URL` as `sync: false` and has Render generate `JWT_SECRET`, so neither exists in git.

**Hosting.** Render deploying the Docker image (not a buildpack), with Postgres on Supabase. Two provider constraints were checked against current documentation rather than assumed, and both shaped the code:

- Supabase's free tier assigns no IPv4 address to the direct connection (port 5432 direct is IPv6-only; the IPv4 add-on is paid), and Render's egress is IPv4. The app therefore **must** connect through the Shared Pooler, which is IPv4 on all tiers. Because that connection is pooled, the code never assumes session state — hence `pg_advisory_xact_lock` and `SET LOCAL` timeouts.
- Render's free tier spins a service down after 15 minutes idle with a 30–60s cold start, and grants 750 instance-hours per month — enough for one always-on service. A 10-minute keep-alive ping stays within the allowance and keeps a reviewer from meeting a cold start. The burst script also waits out a cold start rather than reporting it as a failure.

Render's own free Postgres expires after 30 days, which is why the database lives on Supabase.

**Observability.** `pino` JSON to stdout. Every request carries a correlation id — from an inbound `X-Request-Id` (length-capped, since it lands in log fields and a response header) or freshly generated — echoed back and attached to every line for that request. Correlation ids travel via `AsyncLocalStorage` rather than a logger argument threaded through every function, which matters because the interesting events happen deep inside the transfer transaction and a logger parameter at every call site would obscure the money logic.

Logs also tee into a bounded ring buffer served at `GET /logs`, giving a public log view that needs no login. It is per-instance and resets on restart; stdout remains the durable copy.

Events, each with correlation id and caller: `transfer.applied`, `transfer.rejected` (with reason), `transfer.idempotent_replay`, `transfer.race_lost` (carrying `blocked_ms` — evidence the request genuinely waited on the winner rather than merely arriving second), `wallet.getorcreate` (which wallets were created versus already existed — for a concurrent first-transfer, those lines *are* the record of the requests that lost the get-or-create race), and `auth.failed` with a reason.

Metrics at `GET /metrics`: `http_requests_total{method,route,status}` (error rate derives from the status label), `http_request_duration_seconds` as a histogram, plus a summary carrying p50/p90/p99 so p99 is readable without a Prometheus server in front. Route labels use the matched pattern, so `/transfers/<uuid>` aggregates as `/transfers/:id` instead of producing one time series per transfer. Domain counters: `transfers_applied_total`, `transfers_rejected_total{reason}`, `idempotent_replays_total`, `race_lost_total{kind}`, `auth_failures_total`, `wallets_created_total`, `db_transaction_retries_total{code}`, `datastore_up`.

`GET /` is a single self-contained page — no build step, no framework, no external requests — polling those same three endpoints, so nothing it shows can drift from what the service reports.

## AI usage

Claude Code (Opus) wrote most of the code; I directed the engineering decisions and the review.

**What I directed.** The stack (plain JavaScript, Express, raw `pg` — no ORM, because the concurrency control is the substance of the exercise and belongs visible in the SQL). The deployment targets. That the API surface stay minimal and not be over-engineered — I cut proposed extras more than once. That money enter the system through a treasury account rather than by seeding wallets with free balances, since only the former keeps conservation globally true. That insufficient-funds rejections be durable so a key always returns the same answer. That commits be small and single-purpose, and carry no AI attribution.

**What I decided after being shown options.** `422` over `402`/`409` for insufficient funds. `404` over `403` for non-participant reads. Keys retained rather than expired. Render's health check pointing at `/healthz` rather than `/readyz`.

**What the model decided, which I reviewed and kept.** The specific SQL shapes (`ON CONFLICT DO UPDATE` versus `DO NOTHING` in each position, and why); `xmax = 0` to distinguish insert from conflict in one round trip; `SET LOCAL` for timeouts instead of pool-level session settings; `AsyncLocalStorage` for correlation ids; the `@`-prefixed treasury id making the account structurally unaddressable; the error-taxonomy layout.

**What testing changed.** Two things the model and I both had wrong, which only the tests exposed. The `sum()`/`numeric` string comparison that made the conservation endpoint report a balanced ledger as unbalanced. And the lock-ordering claim: the design document asserted that sorting the upsert prevented deadlock and that `FOR UPDATE` bought nothing, and a 40-request bidirectional test produced 503s and a 500 over 14.2 seconds. I had flagged that mechanism as the thing to verify empirically rather than argue about, which is why the test existed. The design document was corrected in place with the measurement recorded, rather than quietly edited to match the fix.

The honest summary: the model was fast and mostly right about the SQL, and confidently wrong about one concurrency property. The tests were what settled it.

## Cost

| Component | Tier | Cost |
|---|---|---|
| Render web service | Free — 512 MB, 750 instance-hours/month | ₹0 |
| Supabase Postgres | Free — 500 MB | ₹0 |
| GitHub + Actions | Free for public repositories | ₹0 |
| Keep-alive cron | Free | ₹0 |

Total: **₹0**, with no payment method on file with any provider. Known limits, stated plainly: Render cold-starts after 15 minutes idle (mitigated by the keep-alive ping, and tolerated by the burst script), and Supabase pauses a project after 7 days of inactivity — outside the review window, but it would need a dashboard resume after a long gap.
