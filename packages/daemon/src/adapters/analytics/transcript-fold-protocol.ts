import type { AnalyticsModelAliasGroup } from '@ferretry/protocol';
import type { AnalyticsTranscriptFold } from '../../lib/analytics/usage-fold.ts';
import type { TranscriptHarness } from '../../lib/transcript/types.ts';

/** One transcript to read and fold, already resolved to its file on the event loop. */
export interface TranscriptFoldRequest {
  readonly id: number;
  readonly file: string;
  readonly sessionId: string;
  readonly harness: TranscriptHarness;
  readonly aliasGroups: readonly AnalyticsModelAliasGroup[];
}

/** Asks the worker only to prove it started; it answers `{ probe: true }`. */
export interface TranscriptFoldProbe {
  readonly probe: true;
}

/** The fold for a request, or why the worker could not produce one. */
export type TranscriptFoldResponse =
  | { readonly id: number; readonly fold: AnalyticsTranscriptFold }
  | { readonly id: number; readonly error: string }
  | { readonly probe: true };
