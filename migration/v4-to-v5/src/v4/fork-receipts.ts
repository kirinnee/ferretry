import { SessionForkReceiptSchema } from '@ferretry/core-ferrets/contract';

/** The retired v4 fork ledger. Only the one-time converter carries these receipts into the new home. */
export const ForkFiles = {
  name: 'forks',
  path: 'forks/*.json',
  store: 'json',
  format: 1,
  mode: 0o600,
  schema: SessionForkReceiptSchema,
} as const;
