import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/** A watched compaction longer than this was not one compaction (a parked pane, a clock jump). */
export const MAX_COMPACTION_MS = 30 * 60_000;

/** One compaction this daemon watched from start to end: what the history keeps, and the only fields it keeps. */
export const CompactionRecordSchema = z.strictObject({
  harness: z.enum(['claude', 'codex']),
  model: z.string().min(1).optional(),
  durationMs: z.number().int().positive().max(MAX_COMPACTION_MS),
  tokensBefore: z.number().int().nonnegative().optional(),
  at: z.iso.datetime(),
});
export type CompactionRecord = z.infer<typeof CompactionRecordSchema>;

/** Usage's answer to "how long do compactions usually take?", and where a finished one is kept (F-0130). */
export interface CompactionHistorySource {
  /** The durations (milliseconds) of the most relevant past compactions: this model's, else this harness's. */
  durations(harness: CompactionRecord['harness'], model: string | undefined): Promise<readonly number[]>;
  record(entry: CompactionRecord): Promise<void>;
}

/** The one key `ferrets.compaction-history` is provided under: the history has exactly one owner. */
export const COMPACTION_HISTORY_KEY = 'usage';

/**
 * Who keeps the measured compaction durations the live readout estimates from. Usage owns the file (RULING #27, Q6) and
 * Ferrets cannot import Usage, so Ferrets asks through this hook. Not on the security path: a duration and a model name,
 * never text. With no provider the readout says "usually ~Ns" from its fixed prior (`basis: typical`) and a finished
 * compaction is not kept; a throw from the provider is the same as no history.
 */
export const CompactionHistoryHook = defineHook('ferrets.compaction-history', {
  mode: 'provide',
  key: z.literal(COMPACTION_HISTORY_KEY),
  value: z.custom<CompactionHistorySource>(),
  takers: ['usage'],
});
