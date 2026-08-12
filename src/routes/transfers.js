import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { TRANSFER_STATUS } from '../constants.js';
import { insufficientFunds, notFound, selfTransferNotAllowed } from '../errors.js';
import { executeTransfer, findTransferForParticipant } from '../services/transfers.js';
import {
  assertAmountPaise,
  assertIdempotencyKey,
  assertObjectBody,
  assertUserId,
  computeRequestHash,
} from '../validate.js';
import { asyncHandler } from './async-handler.js';

export const transfersRouter = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

transfersRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    assertObjectBody(req.body);

    const toUser = assertUserId(req.body.to_user, 'to_user');
    const amountPaise = assertAmountPaise(req.body.amount_paise);
    const idempotencyKey = assertIdempotencyKey(req.body.idempotency_key);

    // The sender is the token subject. Any from_user in the body is not read.
    const fromUser = req.caller;

    // Before any transaction opens, so a malformed request consumes no key.
    if (toUser === fromUser) throw selfTransferNotAllowed();

    const result = await executeTransfer({
      fromUser,
      toUser,
      amountPaise,
      idempotencyKey,
      requestHash: computeRequestHash({ toUser, amountPaise }),
    });

    // Already committed by now, which is what makes the rejection replayable.
    if (result.transfer.status === TRANSFER_STATUS.REJECTED) {
      throw insufficientFunds({
        transfer_id: result.transfer.id,
        balance_paise: result.balancePaise,
        amount_paise: amountPaise,
      });
    }

    // On a replay this is the balance as it was when the transfer was applied,
    // not the balance now: the response reproduces the original outcome.
    res.status(201).json({
      transfer_id: result.transfer.id,
      new_balance: result.balancePaise,
    });
  }),
);

transfersRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Answered like an unknown id rather than reaching the database and failing
    // on a cast.
    if (!UUID_PATTERN.test(req.params.id)) throw notFound();

    const transfer = await findTransferForParticipant(req.params.id, req.caller);
    if (!transfer) throw notFound();

    res.json({
      transfer_id: transfer.id,
      from_user: transfer.from_user,
      to_user: transfer.to_user,
      amount_paise: transfer.amount_paise,
      status: transfer.status,
      reason: transfer.reason,
      created_at: transfer.created_at,
    });
  }),
);
