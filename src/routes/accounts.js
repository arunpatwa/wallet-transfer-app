import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { notFound } from '../errors.js';
import { findWallet, getOrCreateWallet } from '../services/accounts.js';
import { asyncHandler } from './async-handler.js';

export const accountsRouter = Router();

/**
 * Get-or-create the caller's wallet. Idempotent: calling twice returns the same
 * wallet, never two.
 *
 * The wallet belongs to the token's subject. There is no way to create or
 * address a wallet for anyone else.
 */
accountsRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const wallet = await getOrCreateWallet(req.caller);
    res.status(200).json({ user_id: wallet.userId, balance_paise: wallet.balancePaise });
  }),
);

accountsRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const wallet = await findWallet(req.caller);
    // Deliberately not auto-created on read: a GET should not have the side
    // effect of creating state. POST /accounts is the documented way.
    if (!wallet) throw notFound('No wallet yet for this user; POST /accounts creates one');
    res.json({ user_id: wallet.userId, balance_paise: wallet.balancePaise });
  }),
);
