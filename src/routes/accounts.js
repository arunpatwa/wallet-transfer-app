import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { notFound } from '../errors.js';
import { findWallet, getOrCreateWallet } from '../services/accounts.js';
import { asyncHandler } from './async-handler.js';

export const accountsRouter = Router();

/**
 * `balance` is the field name in the specification; `balance_paise` states the
 * unit, which matters in a money API where a bare "balance" invites someone to
 * assume rupees. Same number, both present.
 */
const walletBody = (wallet) => ({
  user_id: wallet.userId,
  balance: wallet.balancePaise,
  balance_paise: wallet.balancePaise,
});

/** Idempotent: calling twice returns the same wallet, never two. */
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
    // Not auto-created: a GET should not have the side effect of creating state.
    if (!wallet) throw notFound('No wallet yet for this user; POST /accounts creates one');
    res.json(walletBody(wallet));
  }),
);
