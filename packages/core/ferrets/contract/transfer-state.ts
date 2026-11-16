import { defineState } from '@ferretry/kernel/contract';
import { SessionTransferPlanSchema } from './transfer.ts';

/**
 * The file a transfer leaves beneath the NEW ferret on Ferrets' state port (§9.2), private to Ferrets. Its first-turn
 * brief is NOT here: it is the target's own `turns/turn-001.md` on the internal `sessions` root (`./sessions-root.ts`).
 *
 * A fork's receipt is `ForkFiles` (`./state.ts`) and is the single owner of that fact; this holds only what the
 * target itself carries, so the composition has no global transfer-receipt capability at all.
 */

/**
 * `state/ferrets/<ferret>/transfer-plan.json`: the frozen plan, installed beneath the target before import and re-read
 * on every replay (today's `transfer-plan.json`).
 *
 * `onDamaged` is the default `subsystem` ON PURPOSE: a plan that no longer parses is a corrupt durable anchor, and the
 * port's `read` must answer the damage (so the plan store refuses with `SessionTransferPlanCorruptError`) rather than
 * the `narrower` reading, which would answer the file as absent and let a fresh install write over the evidence.
 */
export const TransferPlanFiles = defineState({
  name: 'transfer-plan',
  path: '*/transfer-plan.json',
  store: 'json',
  format: 1,
  schema: SessionTransferPlanSchema,
  mode: 0o600,
});
