/**
 * Authorization and the error taxonomy: the edge cases the brief names.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  api,
  balanceOf,
  fundedUser,
  newUserId,
  resetDatabase,
  startServer,
  stopServer,
  tokenFor,
} from './helpers.js';

const AMOUNT = 1000;

beforeAll(startServer);
afterAll(stopServer);
beforeEach(resetDatabase);

describe('authorization', () => {
  it('refuses a request with no token', async () => {
    const response = await api('/accounts', { method: 'POST' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthenticated');
  });

  it('refuses a tampered token', async () => {
    const token = `${tokenFor(newUserId())}tampered`;
    const response = await api('/accounts/me', { token });
    expect(response.status).toBe(401);
  });

  it('refuses a token signed with the wrong secret', async () => {
    // Forged with a different key: the signature check is what rejects it, so
    // this proves identity is not merely read out of the payload.
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJzdWIiOiJhdHRhY2tlciIsImlzcyI6IndhbGxldC10cmFuc2Zlci1hcHAifQ' +
      '.b0gus_signature_that_will_not_verify';
    const response = await api('/accounts/me', { token: forged });
    expect(response.status).toBe(401);
  });

  it('ignores a from_user supplied in the body', async () => {
    // The attacker holds a valid token for themselves and names a victim as the
    // sender. The victim's balance must not move.
    const victim = await fundedUser(100 * AMOUNT);
    const attacker = await fundedUser(AMOUNT);
    const recipient = newUserId();
    const victimBefore = await balanceOf(victim.userId);

    const response = await api('/transfers', {
      method: 'POST',
      token: attacker.token,
      body: {
        from_user: victim.userId,
        to_user: recipient,
        amount_paise: AMOUNT,
        idempotency_key: randomUUID(),
      },
    });

    expect(response.status).toBe(201);
    expect(await balanceOf(victim.userId)).toBe(victimBefore);
    // The money came from the caller, as identified by their token.
    expect(await balanceOf(attacker.userId)).toBe(0);
  });

  it('will not honour a header-supplied identity', async () => {
    const response = await api('/accounts/me', {
      headers: { 'x-user-id': 'somebody', 'x-caller': 'somebody' },
    });
    expect(response.status).toBe(401);
  });

  it('hides a transfer from anyone who is not a participant', async () => {
    const sender = await fundedUser(10 * AMOUNT);
    const recipient = newUserId();
    const created = await api('/transfers', {
      method: 'POST',
      token: sender.token,
      body: { to_user: recipient, amount_paise: AMOUNT, idempotency_key: randomUUID() },
    });
    const transferId = created.body.transfer_id;

    for (const token of [sender.token, tokenFor(recipient)]) {
      const readable = await api(`/transfers/${transferId}`, { token });
      expect(readable.status).toBe(200);
    }

    // A stranger gets the same answer as for an id that does not exist, so the
    // endpoint cannot be used to discover which ids are real.
    const stranger = await api(`/transfers/${transferId}`, { token: tokenFor(newUserId()) });
    expect(stranger.status).toBe(404);

    const unknown = await api(`/transfers/${randomUUID()}`, { token: sender.token });
    expect(unknown.status).toBe(404);
  });
});

describe('validation', () => {
  const cases = [
    ['zero amount', { amount_paise: 0 }, 400],
    ['negative amount', { amount_paise: -100 }, 400],
    ['fractional amount', { amount_paise: 10.5 }, 400],
    ['amount as a string', { amount_paise: '100' }, 400],
    ['absurd amount', { amount_paise: 10 ** 15 }, 400],
    ['missing idempotency key', { idempotency_key: undefined }, 400],
    ['malformed recipient', { to_user: 'no' }, 400],
    ['recipient naming the treasury', { to_user: '@treasury' }, 400],
  ];

  it.each(cases)('rejects %s', async (_name, override, expected) => {
    const sender = await fundedUser(100 * AMOUNT);
    const body = {
      to_user: newUserId(),
      amount_paise: AMOUNT,
      idempotency_key: randomUUID(),
      ...override,
    };
    if ('idempotency_key' in override && override.idempotency_key === undefined) {
      delete body.idempotency_key;
    }

    const response = await api('/transfers', { method: 'POST', token: sender.token, body });
    expect(response.status).toBe(expected);
  });

  it('refuses a self-transfer', async () => {
    const sender = await fundedUser(100 * AMOUNT);
    const response = await api('/transfers', {
      method: 'POST',
      token: sender.token,
      body: {
        to_user: sender.userId,
        amount_paise: AMOUNT,
        idempotency_key: randomUUID(),
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('self_transfer_not_allowed');
  });

  it('refuses a body that is not JSON', async () => {
    const sender = await fundedUser(AMOUNT);
    const response = await api('/transfers', {
      method: 'POST',
      token: sender.token,
      headers: { 'content-type': 'application/json' },
      body: undefined,
    });
    // No body at all parses as empty, so validation catches the missing fields.
    expect(response.status).toBe(400);
  });
});

describe('accounts', () => {
  it('returns the same wallet on repeated creation', async () => {
    const userId = newUserId();
    const token = tokenFor(userId);

    const first = await api('/accounts', { method: 'POST', token });
    const second = await api('/accounts', { method: 'POST', token });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(first.body.balance_paise).toBe(0);
  });

  it('reports no wallet before one is created, then the balance', async () => {
    const userId = newUserId();
    const token = tokenFor(userId);

    expect((await api('/accounts/me', { token })).status).toBe(404);

    await api('/accounts', { method: 'POST', token });
    const me = await api('/accounts/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.balance_paise).toBe(0);
  });
});

describe('method handling', () => {
  // A browser address bar sends GET. Answering 404 for a POST-only endpoint
  // sends someone hunting for a typo in a URL that was correct.
  const wrongMethod = [
    ['GET', '/accounts', 'POST'],
    ['GET', '/transfers', 'POST'],
    ['GET', '/auth/token', 'POST'],
    ['POST', '/accounts/me', 'GET'],
    ['POST', '/healthz', 'GET'],
  ];

  it.each(wrongMethod)('answers %s %s with 405 and Allow: %s', async (method, path, allowed) => {
    const response = await fetch(`${await startServer()}${path}`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe(allowed);
    const body = await response.json();
    expect(body.error.code).toBe('method_not_allowed');
    expect(body.error.allowed).toEqual([allowed]);
  });

  it('still answers 404 for a path that genuinely does not exist', async () => {
    const response = await api('/nope');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('does not shadow a real transfer id lookup', async () => {
    // /transfers/:id is a known GET route; a GET with no token must still reach
    // auth and return 401, not 405.
    const response = await api(`/transfers/${randomUUID()}`);
    expect(response.status).toBe(401);
  });
});

describe('operational endpoints', () => {
  it('separates liveness from readiness', async () => {
    expect((await api('/healthz')).status).toBe(200);
    expect((await api('/readyz')).status).toBe(200);
  });

  it('reports a balanced ledger', async () => {
    const sender = await fundedUser(10 * AMOUNT);
    await api('/transfers', {
      method: 'POST',
      token: sender.token,
      body: { to_user: newUserId(), amount_paise: AMOUNT, idempotency_key: randomUUID() },
    });

    const response = await api('/invariants');
    expect(response.status).toBe(200);
    expect(response.body.ledger_sum_paise).toBe(0);
    expect(response.body.ledger_balanced).toBe(true);
  });

  it('exposes the required log events', async () => {
    const sender = await fundedUser(AMOUNT);
    await api('/transfers', {
      method: 'POST',
      token: sender.token,
      body: { to_user: newUserId(), amount_paise: AMOUNT * 100, idempotency_key: randomUUID() },
    });

    const response = await api('/logs?limit=1000');
    expect(response.status).toBe(200);
    const events = new Set(response.body.logs.map((entry) => entry.event));
    expect(events.has('transfer.rejected')).toBe(true);
    expect(events.has('http.request')).toBe(true);
  });
});
