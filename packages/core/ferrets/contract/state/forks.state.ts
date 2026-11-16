import { defineState } from '@ferretry/kernel/contract';
import { SessionForkReceiptSchema } from '../transfer.ts';

/** `forks/<planId>.json`: one fork receipt each (`./transfer.ts`, today's `lib/fork/receipt.ts`). */
export const ForkFiles = defineState({
  name: 'forks',
  path: 'forks/*.json',
  store: 'json',
  format: 1,
  mode: 0o600,
  schema: SessionForkReceiptSchema,
});
