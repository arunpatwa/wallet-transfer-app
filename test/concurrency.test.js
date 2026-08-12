/**
 * The invariants, exercised under genuine concurrency.
 *
 * Every test here fires overlapping HTTP requests at a real server. Conservation
 * is asserted after every single test by the shared afterEach, so no case can
 * pass while quietly creating or destroying money.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TREASURY_SEED_PAISE } from '../src/constants.js';
import {
  api,
  balanceOf,
  fireConcurrently,
  fundedUser,
  invariants,
  newUserId,
  resetDatabase,
  startServer,
  stopServer,
  tokenFor,
  walletRowCount,
} from './helpers.js';

const AMOUNT = 1000; // paise

beforeAll(startServer);
afterAll(stopServer);
beforeEach(resetDatabase);

// The invariant that matters most, checked after every test in this file.
afterEach(async () => {
  const { total_balance_paise, ledger_sum_paise } = await invariants();
  expect(total_balance_paise).toBe(TREASURY_SEED_PAISE);
  expect(ledger_sum_paise).toBe(0);
});

const statuses = (responses) => responses.map((r) => r.status);
const countOf = (responses, status) => statuses(responses).filter((s) => s === status).length;
const serverErrors = (responses) => statuses(responses).filter((s) => s >= 500);

describe('get-or-create under concurrency', () => {
  it('creates a brand-new recipient wallet exactly once across N simultaneous first transfers', async () => {
    const n = 30;
    const sender = await fundedUser(n * AMOUNT);
    const recipient = newUserId();

    const responses = await fireConcurrently(n, (i) =>
      api('/transfers', {
        method: 'POST',
        token: sender.token,
        body: {
          to_user: recipient,
          amount_paise: AMOUNT,
          idempotency_key: `distinct-${i}-${randomUUID()}`,
        },
      }),
    );

    expect(serverErrors(responses)).toEqual([]);
    expect(countOf(responses, 201)).toBe(n);

    // The recipient's wallet is a primary key, so two rows are impossible by
    // construction. What this asserts is that the race resolved without any
    // request failing and without money going astray.
    expect(await walletRowCount(recipient)).toBe(1);
    expect(await balanceOf(recipient)).toBe(n * AMOUNT);
    expect(await balanceOf(sender.userId)).toBe(0);
  });

  it('never 500s when two brand-new users transfer to each other in both directions at once', async () => {
    // Both wallets are absent and both balances are zero, so every transfer must
    // be refused -- but each wallet must still be created exactly once and no
    // request may fail. This is the scenario the brief calls the crux.
    const left = newUserId();
    const right = newUserId();
    const leftToken = tokenFor(left);
    const rightToken = tokenFor(right);
    const perDirection = 15;

    const responses = await fireConcurrently(perDirection * 2, (i) => {
      const leftToRight = i % 2 === 0;
      return api('/transfers', {
        method: 'POST',
        token: leftToRight ? leftToken : rightToken,
        body: {
          to_user: leftToRight ? right : left,
          amount_paise: AMOUNT,
          idempotency_key: `crux-${i}-${randomUUID()}`,
        },
      });
    });

    expect(serverErrors(responses)).toEqual([]);
    // Zero balance on both sides: every one is refused, none is a server error.
    expect(countOf(responses, 422)).toBe(perDirection * 2);

    expect(await walletRowCount(left)).toBe(1);
    expect(await walletRowCount(right)).toBe(1);
    expect(await balanceOf(left)).toBe(0);
    expect(await balanceOf(right)).toBe(0);
  });

  it('does not deadlock when funded users transfer in opposite directions simultaneously', async () => {
    // Without a deterministic lock order, A->B and B->A overlapping is the
    // textbook deadlock. Sorting the wallet ids before the upsert is what
    // prevents it.
    const perDirection = 20;
    const [alice, bob] = await Promise.all([
      fundedUser(perDirection * AMOUNT),
      fundedUser(perDirection * AMOUNT),
    ]);
    const combinedBefore = (await balanceOf(alice.userId)) + (await balanceOf(bob.userId));

    const responses = await fireConcurrently(perDirection * 2, (i) => {
      const aliceSends = i % 2 === 0;
      const sender = aliceSends ? alice : bob;
      const recipient = aliceSends ? bob : alice;
      return api('/transfers', {
        method: 'POST',
        token: sender.token,
        body: {
          to_user: recipient.userId,
          amount_paise: AMOUNT,
          idempotency_key: `bidi-${i}-${randomUUID()}`,
        },
      });
    });

    expect(serverErrors(responses)).toEqual([]);
    expect(countOf(responses, 201)).toBe(perDirection * 2);

    const combinedAfter = (await balanceOf(alice.userId)) + (await balanceOf(bob.userId));
    expect(combinedAfter).toBe(combinedBefore);
  });
});

describe('idempotency under concurrency', () => {
  it('applies once when the same key is retried concurrently', async () => {
    const attempts = 25;
    const sender = await fundedUser(50 * AMOUNT);
    const recipient = newUserId();
    const key = `replay-${randomUUID()}`;

    const responses = await fireConcurrently(attempts, () =>
      api('/transfers', {
        method: 'POST',
        token: sender.token,
        body: { to_user: recipient, amount_paise: AMOUNT, idempotency_key: key },
      }),
    );

    expect(serverErrors(responses)).toEqual([]);
    expect(countOf(responses, 201)).toBe(attempts);

    // Every response describes the same transfer: one winner, everyone else
    // replaying its recorded outcome.
    const ids = new Set(responses.map((r) => r.body.transfer_id));
    expect(ids.size).toBe(1);

    // And the money moved exactly once.
    expect(await balanceOf(recipient)).toBe(AMOUNT);
  });

  it('rejects the same key with a different body as 409 and moves nothing', async () => {
    const sender = await fundedUser(50 * AMOUNT);
    const recipient = newUserId();
    const key = `conflict-${randomUUID()}`;

    const first = await api('/transfers', {
      method: 'POST',
      token: sender.token,
      body: { to_user: recipient, amount_paise: AMOUNT, idempotency_key: key },
    });
    expect(first.status).toBe(201);

    const balanceAfterFirst = await balanceOf(sender.userId);

    const conflicting = await api('/transfers', {
      method: 'POST',
      token: sender.token,
      body: { to_user: recipient, amount_paise: AMOUNT * 2, idempotency_key: key },
    });

    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error.code).toBe('idempotency_key_reuse');
    expect(await balanceOf(sender.userId)).toBe(balanceAfterFirst);
  });

  it('replays a committed rejection rather than re-evaluating it', async () => {
    // A key names one attempt with one answer. Topping up afterwards must not
    // turn a recorded rejection into a success.
    const sender = await fundedUser(AMOUNT);
    const recipient = newUserId();
    const key = `rejected-${randomUUID()}`;
    const body = { to_user: recipient, amount_paise: AMOUNT * 10, idempotency_key: key };

    const rejected = await api('/transfers', { method: 'POST', token: sender.token, body });
    expect(rejected.status).toBe(422);

    await api('/dev/credit', {
      method: 'POST',
      token: sender.token,
      body: { amount_paise: AMOUNT * 100, idempotency_key: `topup-${randomUUID()}` },
    });

    const replayed = await api('/transfers', { method: 'POST', token: sender.token, body });
    expect(replayed.status).toBe(422);
    // The recipient's wallet does exist: get-or-create runs before the debit is
    // attempted, so a refused transfer still leaves both wallets in place. What
    // must not happen is money arriving.
    expect(await balanceOf(recipient)).toBe(0);
  });
});

describe('conservation under contention', () => {
  it('applies exactly as many transfers as the balance affords, never more', async () => {
    // The overspend probe: a balance of exactly five transfers, fifty
    // simultaneous attempts. Read-then-write would let several through.
    const affordable = 5;
    const attempts = 50;
    const sender = await fundedUser(affordable * AMOUNT);
    const recipient = newUserId();

    const responses = await fireConcurrently(attempts, (i) =>
      api('/transfers', {
        method: 'POST',
        token: sender.token,
        body: {
          to_user: recipient,
          amount_paise: AMOUNT,
          idempotency_key: `overspend-${i}-${randomUUID()}`,
        },
      }),
    );

    expect(serverErrors(responses)).toEqual([]);
    expect(countOf(responses, 201)).toBe(affordable);
    expect(countOf(responses, 422)).toBe(attempts - affordable);

    expect(await balanceOf(sender.userId)).toBe(0);
    expect(await balanceOf(recipient)).toBe(affordable * AMOUNT);
  });
});
