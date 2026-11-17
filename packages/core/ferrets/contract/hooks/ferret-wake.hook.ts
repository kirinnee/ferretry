import type { FerretId } from '@ferretry/kernel/contract';
import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/** The one key `ferrets.wake` is provided under: a wake has exactly one deliverer, the Mailbox. */
export const FERRET_WAKE_KEY = 'mailbox';

/** What the deliverer answers to a wake: it took it (and where it is now), or it said no, in a closed word. */
export type WakeReceipt =
  | { readonly kind: 'accepted'; readonly sendId: string; readonly state: 'queued' | 'typing' | 'delivered' }
  | { readonly kind: 'refused'; readonly reason: string };

/** The Mailbox's side of a wake: hand it a message and it owns delivery, retry and the receipt. */
export interface WakeDelivery {
  /** Hand the wake to whoever delivers messages; `key` is the park's (`wakeSendId`), so a repeat is the same message. */
  wake(ferret: FerretId, request: { readonly key: string; readonly text: string }): Promise<WakeReceipt>;
}

/**
 * How a ferret whose declared wait ended is told so. The Mailbox delivers every message (queue, gates, retry, receipt)
 * and `@ferretry/core-mailbox` depends on this package, so Ferrets cannot import it: Ferrets offers this hook and the
 * Mailbox fills it, the same shape as `ferrets.compaction-history`.
 *
 * Never on the security path beyond "only the Mailbox provides it" (`takers`): the text that crosses is the wake's own
 * fixed words, never a transcript, a screen or a draft. With no provider the monitor falls back to the harness seam
 * Ferrets already owns, so a daemon composed without a Mailbox still wakes its ferrets.
 */
export const FerretWake = defineHook('ferrets.wake', {
  mode: 'provide',
  key: z.literal(FERRET_WAKE_KEY),
  value: z.custom<WakeDelivery>(),
  takers: ['mailbox'],
});
