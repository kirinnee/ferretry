import { defineState } from '@ferretry/kernel/contract';
import { SessionTransferPlanSchema } from './transfer.ts';

/**
 * The files a transfer leaves beneath the NEW ferret (§9.2), both private to Ferrets.
 *
 * A fork's receipt is `ForkFiles` (`./state.ts`) and is the single owner of that fact; these two hold only what the
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

/**
 * `state/ferrets/<ferret>/turns/turn-001.md`: the deterministic first-turn brief of a transferred ferret.
 *
 * An opaque file read and written as bytes (a markdown document, never parsed); the port writes it atomically and
 * flushes it. Its path is handed to the new agent (`pathOf`), which is why it is opaque and not a document.
 */
export const TransferBriefFiles = defineState<'transfer-brief', Uint8Array>({
  name: 'transfer-brief',
  path: '*/turns/turn-001.md',
  store: 'opaque',
  format: 1,
  mode: 0o600,
});
