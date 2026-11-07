/**
 * STAND-IN for the core contracts (`@ferretry/core-ferrets/contract`, `@ferretry/core-asks/contract`) until the
 * core-contracts slice lands on origin/rebuild/5.0. It is the ONLY file in this package that names a core
 * hook, port or id; when the real contracts merge, replace the body of this file with re-exports of the same names.
 * Names and modes are the ones in docs/rebuild/spine.md and redesign.md §3.5.
 */
import { defineEvent, defineHook, definePort, type FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';

export type { FerretId };
export const FerretIdSchema = z
  .string()
  .min(1)
  .transform(value => value as FerretId);

/** `sitrep.lines` (contribute, Ferrets): one line a plugin adds to a ferret's sitrep. */
export const SitrepLines = defineHook('sitrep.lines', {
  mode: 'contribute',
  item: z.strictObject({ ferret: FerretIdSchema, text: z.string() }),
});

/** `ask.sources` (provide, Asks): one taker per source key; Conversation takes `question`. */
export const AskSources = defineHook('ask.sources', {
  mode: 'provide',
  key: z.string(),
  value: z.custom<unknown>(),
});

/** What Conversation needs of Ferrets: who a ferret is, and whether it is running. Grown by the core contract. */
export interface FerretsApi {
  exists(ferret: FerretId): Promise<boolean>;
  state(ferret: FerretId): Promise<'starting' | 'working' | 'idle' | 'stopped' | undefined>;
}
export const FerretsPort = definePort<FerretsApi>('ferrets');

/** What Conversation needs of Asks: raise and withdraw the `question` ask. Grown by the core contract. */
export interface AsksApi {
  raise(input: {
    readonly source: string;
    readonly ref: string;
    readonly entry?: string;
    readonly text: string;
  }): Promise<{ readonly ask: string }>;
  withdraw(ask: string): Promise<void>;
}
export const AsksPort = definePort<AsksApi>('asks');

/** `asks.answered` (event, Asks): an ask got its answer. Conversation reads it to clear a `question` ask. */
export const AskAnswered = defineEvent(
  'asks.answered',
  z.strictObject({ ask: z.string(), source: z.string(), ref: z.string(), entry: z.string().optional() }),
);
