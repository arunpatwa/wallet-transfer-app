#!/usr/bin/env node
/**
 * The correctness gate.
 *
 * Fires overlapping transfers and retries at a running service and asserts that
 * money is conserved, wallets are created exactly once, retries apply once, and
 * nothing ever 5xxs. Every run uses brand-new user ids, so it is safe to run
 * repeatedly against the same deployment.
 *
 * Zero dependencies: Node's built-in fetch only.
 *
 *   node scripts/burst.mjs https://your-service.example.com
 */
import { randomUUID } from 'node:crypto';

const BASE_URL = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(
  /\/$/,
  '',
);
const AMOUNT = Number(process.env.BURST_AMOUNT ?? 1000);
const CONCURRENCY = Number(process.env.BURST_N ?? 30);
const RETRIES = Number(process.env.BURST_RETRIES ?? 25);
const AFFORDABLE = 5;
const OVERSPEND_ATTEMPTS = Number(process.env.BURST_OVERSPEND ?? 50);

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s) => (colour ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (colour ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s) => (colour ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (colour ? `\x1b[1m${s}\x1b[0m` : s);

const results = [];
let currentPhase = '';

function phase(name) {
  currentPhase = name;
  process.stdout.write(`\n${bold(name)}\n`);
}

function check(description, passed, detail = '') {
  results.push({ phase: currentPhase, description, passed, detail });
  const mark = passed ? green('PASS') : red('FAIL');
  process.stdout.write(`  ${mark}  ${description}${detail ? dim(` -- ${detail}`) : ''}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries only *network-level* failures -- a connection reset, DNS hiccup or TLS
 * error, where no HTTP response was ever received. An HTTP response of any
 * status is a result and is returned as-is; retrying a 422 would corrupt the
 * very counts this gate exists to check.
 *
 * Retrying is safe by construction rather than by luck: every mutating request
 * here carries an idempotency key, so a retry of a request that may or may not
 * have landed either applies for the first time or replays the recorded
 * outcome. That is the guarantee under test, used to test itself.
 *
 * Necessary because a free-tier host under a 30-way concurrent burst will
 * occasionally drop a connection, and aborting the whole gate on one dropped
 * socket would report a network blip as a correctness failure.
 */
async function request(path, { method = 'GET', token, body, headers = {} } = {}, attempt = 1) {
  const MAX_ATTEMPTS = 4;
  let response;

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(300 * attempt);
      return request(path, { method, token, body, headers }, attempt + 1);
    }
    throw new Error(
      `${method} ${path} failed at the network level after ${MAX_ATTEMPTS} attempts: ${err.message}`,
    );
  }

  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    /* not every response is JSON */
  }
  return { status: response.status, body: parsed };
}

const newUserId = () => `b${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const serverErrors = (responses) => responses.filter((r) => r.status >= 500).length;
const countOf = (responses, status) => responses.filter((r) => r.status === status).length;
const fire = (count, make) => Promise.all(Array.from({ length: count }, (_, i) => make(i)));

async function mintToken(userId) {
  const response = await request('/auth/token', {
    method: 'POST',
    body: { user_id: userId },
  });
  if (response.status !== 201) {
    throw new Error(
      `could not mint a token (${response.status}). Is DEV_TOKEN_ENABLED set on the deployment?`,
    );
  }
  return response.body.access_token;
}

async function newFundedUser(amountPaise) {
  const userId = newUserId();
  const token = await mintToken(userId);
  const response = await request('/dev/credit', {
    method: 'POST',
    token,
    body: { amount_paise: amountPaise, idempotency_key: `seed-${randomUUID()}` },
  });
  if (response.status !== 201) {
    throw new Error(
      `could not fund ${userId} (${response.status}). Is FAUCET_ENABLED set on the deployment?`,
    );
  }
  return { userId, token };
}

async function balanceOf(token) {
  const response = await request('/accounts/me', { token });
  return response.status === 200 ? response.body.balance_paise : null;
}

const transfer = (token, toUser, amountPaise, idempotencyKey) =>
  request('/transfers', {
    method: 'POST',
    token,
    body: { to_user: toUser, amount_paise: amountPaise, idempotency_key: idempotencyKey },
  });

/**
 * A free-tier host may have spun the service down; a cold start takes up to a
 * minute. Waiting here keeps that from looking like a failed gate.
 */
async function waitUntilAwake() {
  const deadline = Date.now() + 120_000;
  let announced = false;
  while (Date.now() < deadline) {
    try {
      const response = await request('/healthz');
      if (response.status === 200) {
        if (announced) process.stdout.write(' awake\n');
        return true;
      }
    } catch {
      /* not up yet */
    }
    if (!announced) {
      process.stdout.write(dim('  waiting for the service to wake up (cold start)...'));
      announced = true;
    }
    process.stdout.write(dim('.'));
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}

async function main() {
  process.stdout.write(`${bold('Correctness gate')} against ${BASE_URL}\n`);

  if (!(await waitUntilAwake())) {
    process.stdout.write(red('\nService never became reachable.\n'));
    process.exit(1);
  }

  const before = (await request('/invariants')).body;

  // -- P1 ---------------------------------------------------------------------
  phase('P1  Concurrent first transfers to a brand-new recipient');
  {
    const sender = await newFundedUser(CONCURRENCY * AMOUNT);
    const recipient = newUserId();

    const responses = await fire(CONCURRENCY, (i) =>
      transfer(sender.token, recipient, AMOUNT, `p1-${i}-${randomUUID()}`),
    );

    check('no server errors', serverErrors(responses) === 0, `${serverErrors(responses)} 5xx`);
    check(
      `all ${CONCURRENCY} transfers applied`,
      countOf(responses, 201) === CONCURRENCY,
      `${countOf(responses, 201)}/${CONCURRENCY}`,
    );

    const recipientToken = await mintToken(recipient);
    const received = await balanceOf(recipientToken);
    check(
      'recipient wallet created exactly once with the exact total',
      received === CONCURRENCY * AMOUNT,
      `${received} paise, expected ${CONCURRENCY * AMOUNT}`,
    );
    const remaining = await balanceOf(sender.token);
    check('sender drained to exactly zero', remaining === 0, `${remaining} paise`);
  }

  // -- P2 ---------------------------------------------------------------------
  phase('P2  Concurrent retries of one idempotency key');
  {
    const sender = await newFundedUser(50 * AMOUNT);
    const recipient = newUserId();
    const key = `p2-${randomUUID()}`;

    const responses = await fire(RETRIES, () => transfer(sender.token, recipient, AMOUNT, key));

    check('no server errors', serverErrors(responses) === 0, `${serverErrors(responses)} 5xx`);

    const ids = new Set(responses.map((r) => r.body?.transfer_id).filter(Boolean));
    check(
      `all ${RETRIES} retries describe one transfer`,
      ids.size === 1,
      `${ids.size} distinct transfer ids`,
    );

    const recipientToken = await mintToken(recipient);
    const received = await balanceOf(recipientToken);
    check('money moved exactly once', received === AMOUNT, `${received} paise, expected ${AMOUNT}`);
  }

  // -- P3 ---------------------------------------------------------------------
  phase('P3  Same key, different body');
  {
    const sender = await newFundedUser(50 * AMOUNT);
    const recipient = newUserId();
    const key = `p3-${randomUUID()}`;

    const first = await transfer(sender.token, recipient, AMOUNT, key);
    check('original transfer applied', first.status === 201, `status ${first.status}`);
    const balanceAfterFirst = await balanceOf(sender.token);

    const conflicting = await transfer(sender.token, recipient, AMOUNT * 2, key);
    check('reused key with a different amount is 409', conflicting.status === 409, `status ${conflicting.status}`);
    check(
      'balance untouched by the conflict',
      (await balanceOf(sender.token)) === balanceAfterFirst,
    );
  }

  // -- P4 ---------------------------------------------------------------------
  phase('P4  Opposite directions at once (deadlock probe)');
  {
    const perDirection = Math.max(10, Math.floor(CONCURRENCY / 2));
    const [alice, bob] = await Promise.all([
      newFundedUser(perDirection * AMOUNT),
      newFundedUser(perDirection * AMOUNT),
    ]);
    const combinedBefore = (await balanceOf(alice.token)) + (await balanceOf(bob.token));

    const responses = await fire(perDirection * 2, (i) => {
      const aliceSends = i % 2 === 0;
      const from = aliceSends ? alice : bob;
      const to = aliceSends ? bob : alice;
      return transfer(from.token, to.userId, AMOUNT, `p4-${i}-${randomUUID()}`);
    });

    check('no server errors, so no deadlock surfaced', serverErrors(responses) === 0);
    check(
      'every transfer applied',
      countOf(responses, 201) === perDirection * 2,
      `${countOf(responses, 201)}/${perDirection * 2}`,
    );
    const combinedAfter = (await balanceOf(alice.token)) + (await balanceOf(bob.token));
    check(
      'combined balance conserved',
      combinedAfter === combinedBefore,
      `${combinedBefore} -> ${combinedAfter}`,
    );
  }

  // -- P5 ---------------------------------------------------------------------
  phase('P5  Two brand-new users, both directions, zero balance');
  {
    const perDirection = Math.max(10, Math.floor(CONCURRENCY / 2));
    const left = newUserId();
    const right = newUserId();
    const [leftToken, rightToken] = await Promise.all([mintToken(left), mintToken(right)]);

    const responses = await fire(perDirection * 2, (i) => {
      const leftSends = i % 2 === 0;
      return transfer(
        leftSends ? leftToken : rightToken,
        leftSends ? right : left,
        AMOUNT,
        `p5-${i}-${randomUUID()}`,
      );
    });

    check('never a 500 while both wallets are being created', serverErrors(responses) === 0);
    check(
      'every transfer refused for insufficient funds',
      countOf(responses, 422) === perDirection * 2,
      `${countOf(responses, 422)}/${perDirection * 2}`,
    );
    check('both wallets exist at zero', (await balanceOf(leftToken)) === 0 && (await balanceOf(rightToken)) === 0);
  }

  // -- P6 ---------------------------------------------------------------------
  phase('P6  Overspend probe');
  {
    const sender = await newFundedUser(AFFORDABLE * AMOUNT);
    const recipient = newUserId();

    const responses = await fire(OVERSPEND_ATTEMPTS, (i) =>
      transfer(sender.token, recipient, AMOUNT, `p6-${i}-${randomUUID()}`),
    );

    check('no server errors', serverErrors(responses) === 0);
    check(
      `exactly ${AFFORDABLE} of ${OVERSPEND_ATTEMPTS} applied`,
      countOf(responses, 201) === AFFORDABLE,
      `${countOf(responses, 201)} applied`,
    );
    check(
      'the rest refused',
      countOf(responses, 422) === OVERSPEND_ATTEMPTS - AFFORDABLE,
      `${countOf(responses, 422)} refused`,
    );

    const remaining = await balanceOf(sender.token);
    check('sender landed on exactly zero, never negative', remaining === 0, `${remaining} paise`);
    const recipientToken = await mintToken(recipient);
    const received = await balanceOf(recipientToken);
    check(
      'recipient received exactly what was spent',
      received === AFFORDABLE * AMOUNT,
      `${received} paise, expected ${AFFORDABLE * AMOUNT}`,
    );
  }

  // -- P7 ---------------------------------------------------------------------
  phase('P7  Authorization');
  {
    const victim = await newFundedUser(10 * AMOUNT);
    const attacker = await newFundedUser(AMOUNT);
    const recipient = newUserId();
    const victimBefore = await balanceOf(victim.token);

    check('no token is rejected', (await request('/accounts/me')).status === 401);
    check(
      'tampered token is rejected',
      (await request('/accounts/me', { token: `${attacker.token}x` })).status === 401,
    );
    check(
      'a header-supplied identity is ignored',
      (await request('/accounts/me', { headers: { 'x-user-id': victim.userId } })).status === 401,
    );

    // The attacker holds a valid token for themselves and names the victim as
    // the sender. The money must come from the attacker, not the victim.
    const injected = await request('/transfers', {
      method: 'POST',
      token: attacker.token,
      body: {
        from_user: victim.userId,
        to_user: recipient,
        amount_paise: AMOUNT,
        idempotency_key: `p7-${randomUUID()}`,
      },
    });
    check('from_user in the body is ignored', injected.status === 201, `status ${injected.status}`);
    check("victim's balance untouched", (await balanceOf(victim.token)) === victimBefore);
    check('the debit came from the caller', (await balanceOf(attacker.token)) === 0);

    const stranger = await mintToken(newUserId());
    const transferId = injected.body?.transfer_id;
    check(
      'a non-participant cannot read the transfer',
      (await request(`/transfers/${transferId}`, { token: stranger })).status === 404,
    );
    check(
      'a participant can read the transfer',
      (await request(`/transfers/${transferId}`, { token: attacker.token })).status === 200,
    );
  }

  // -- P8 ---------------------------------------------------------------------
  phase('P8  Validation');
  {
    const sender = await newFundedUser(10 * AMOUNT);
    const recipient = newUserId();
    const key = () => `p8-${randomUUID()}`;

    check('zero amount rejected', (await transfer(sender.token, recipient, 0, key())).status === 400);
    check('negative amount rejected', (await transfer(sender.token, recipient, -100, key())).status === 400);
    check('fractional amount rejected', (await transfer(sender.token, recipient, 10.5, key())).status === 400);
    check(
      'self-transfer rejected',
      (await transfer(sender.token, sender.userId, AMOUNT, key())).status === 422,
    );

    const missingKey = await request('/transfers', {
      method: 'POST',
      token: sender.token,
      body: { to_user: recipient, amount_paise: AMOUNT },
    });
    check('missing idempotency key rejected', missingKey.status === 400);
  }

  // -- P9 ---------------------------------------------------------------------
  phase('P9  Conservation');
  {
    const after = (await request('/invariants')).body;

    check(
      'total money unchanged across the entire burst',
      after.total_balance_paise === before.total_balance_paise,
      `${before.total_balance_paise} -> ${after.total_balance_paise}`,
    );
    check('ledger sums to zero', after.ledger_sum_paise === 0, `${after.ledger_sum_paise}`);
    check('ledger reports itself balanced', after.ledger_balanced === true);
  }

  // -- summary ----------------------------------------------------------------
  const failed = results.filter((r) => !r.passed);
  process.stdout.write(
    `\n${bold('Summary')}  ${results.length - failed.length}/${results.length} checks passed\n`,
  );

  if (failed.length > 0) {
    process.stdout.write(red(`\n${failed.length} failed:\n`));
    for (const failure of failed) {
      process.stdout.write(red(`  ${failure.phase} :: ${failure.description}`));
      process.stdout.write(failure.detail ? dim(` -- ${failure.detail}\n`) : '\n');
    }
    process.exit(1);
  }

  process.stdout.write(green('\nAll invariants held.\n'));
  process.exit(0);
}

main().catch((error) => {
  process.stdout.write(red(`\nBurst aborted: ${error.message}\n`));
  process.exit(1);
});
