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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

transfersRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    assertObjectBody(req.body);

    const toUser = assertUserId(req.body.to_user, 'to_user');
    const amountPaise = assertAmountPaise(req.body.amount_paise);
    const idempotencyKey = assertIdempotencyKey(req.body.idempotency_key);

    // The sender is the token's subject. Any from_user in the body is ignored
    // outright -- it is not read, so it cannot be honoured.
    const fromUser = req.caller;

    // Checked before opening a transaction, so a malformed request never
    // consumes an idempotency key. The table also forbids it, as a backstop.
    if (toUser === fromUser) throw selfTransferNotAllowed();

    const result = await executeTransfer({
      fromUser,
      toUser,
      amountPaise,
      idempotencyKey,
      requestHash: computeRequestHash({ toUser, amountPaise }),
    });

    // A rejection has already been committed by this point, which is what makes
    // it replayable. Turning it into a 422 is the last step, not the first.
    if (result.transfer.status === TRANSFER_STATUS.REJECTED) {
      throw insufficientFunds({
        transfer_id: result.transfer.id,
        balance_paise: result.balancePaise,
        amount_paise: amountPaise,
      });
    }

    // A replay returns the balance as it was when the transfer was originally
    // applied, not the balance now. That is the point: the response is the
    // original outcome, reproduced exactly.
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
    // A malformed id is answered like an unknown one, rather than reaching the
    // database and failing on a cast.
    if (!UUID_PATTERN.test(req.params.id)) throw notFound();

    // Returns null both for ids that do not exist and for transfers the caller
    // is not part of, so a non-participant cannot tell the two apart.
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
