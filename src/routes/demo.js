/**
 * Demo-only endpoints, each behind its own flag and both default-off.
 *
 * They exist so the correctness gate is runnable with a single command against
 * a live URL. Neither is part of the production surface, and the service's
 * security does not depend on them being absent -- token verification never
 * consults the minting endpoint, and the faucet moves money along the same
 * audited transfer path as everything else.
 */
import { Router } from 'express';
import { signToken, requireAuth } from '../auth.js';
import { getConfig } from '../config.js';
import { TREASURY_USER_ID } from '../constants.js';
import { insufficientFunds, invalidRequest, notEnabled } from '../errors.js';
import { log } from '../logger.js';
import { TRANSFER_STATUS } from '../constants.js';
import { findWallet } from '../services/accounts.js';
import { executeTransfer } from '../services/transfers.js';
import {
  assertAmountPaise,
  assertIdempotencyKey,
  assertObjectBody,
  assertUserId,
  computeRequestHash,
} from '../validate.js';
import { asyncHandler } from './async-handler.js';

const config = getConfig();

export const demoRouter = Router();

/**
 * Stands in for an identity provider. In a real deployment tokens arrive from
 * the IdP and this endpoint does not exist.
 */
demoRouter.post(
  '/auth/token',
  asyncHandler(async (req, res) => {
    if (!config.demo.tokenEndpointEnabled) throw notEnabled('POST /auth/token');

    assertObjectBody(req.body);
    // The grammar excludes '@', so no token can ever be minted for the treasury.
    const userId = assertUserId(req.body.user_id, 'user_id');

    log().info({ event: 'auth.token_issued', subject: userId }, 'issued a demo token');

    res.status(201).json({
      access_token: signToken(userId),
      token_type: 'Bearer',
      expires_in: config.jwt.ttlSeconds,
      user_id: userId,
    });
  }),
);

/**
 * Moves money from the treasury to the caller so a fresh wallet has something
 * to send. Uses the normal transfer path, so the money is conserved and
 * auditable rather than conjured: the treasury's balance falls by exactly what
 * the caller's rises, and the ledger records both halves.
 */
demoRouter.post(
  '/dev/credit',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!config.demo.faucetEnabled) throw notEnabled('POST /dev/credit');

    assertObjectBody(req.body);
    const amountPaise = assertAmountPaise(req.body.amount_paise);
    const idempotencyKey = assertIdempotencyKey(req.body.idempotency_key);

    if (amountPaise > config.demo.faucetMaxPaise) {
      throw invalidRequest(
        `amount_paise must not exceed ${config.demo.faucetMaxPaise} for a faucet credit`,
        { field: 'amount_paise' },
      );
    }

    // Idempotency is scoped to (from_user, key) and every faucet credit shares
    // the treasury as sender, so the key is namespaced by the recipient.
    // Without this, two users choosing the same key would collide.
    const scopedKey = `credit:${req.caller}:${idempotencyKey}`;

    const result = await executeTransfer({
      fromUser: TREASURY_USER_ID,
      toUser: req.caller,
      amountPaise,
      idempotencyKey: scopedKey,
      requestHash: computeRequestHash({ toUser: req.caller, amountPaise }),
      via: 'faucet',
    });

    // Only reachable if the treasury itself is drained.
    if (result.transfer.status === TRANSFER_STATUS.REJECTED) {
      throw insufficientFunds({ transfer_id: result.transfer.id });
    }

    // executeTransfer reports the sender's balance, which here is the
    // treasury's. The caller wants their own.
    const wallet = await findWallet(req.caller);

    res.status(201).json({
      transfer_id: result.transfer.id,
      new_balance: wallet?.balancePaise ?? amountPaise,
    });
  }),
);
