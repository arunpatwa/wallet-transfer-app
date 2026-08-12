import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { notFound } from '../errors.js';
import { findWallet, getOrCreateWallet } from '../services/accounts.js';
import { asyncHandler } from './async-handler.js';

export const accountsRouter = Router();

/**
 * `balance` and `balance_paise` are the same number, deliberately duplicated.
 *
 * `balance` is the field name in the specification, so a client written
 * literally against it works. `balance_paise` states the unit in the name,
 * which is worth keeping in a money API where a bare "balance" invites someone
 * to assume rupees and be wrong by a factor of a hundred.
 */
const walletBody = (wallet) => ({
  user_id: wallet.userId,
  balance: wallet.balancePaise,
  balance_paise: wallet.balancePaise,
});

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
    res.status(200).json(walletBody(wallet));
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
    res.json(walletBody(wallet));
  }),
);
