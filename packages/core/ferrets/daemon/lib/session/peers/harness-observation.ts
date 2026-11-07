/**
 * PEER: today's `daemon/src/lib/session/harness/observation.ts` — owned by the claude-code and codex plugins.
 * Ferrets is core and cannot import a plugin's code (§2.1); this is the part the session code reads, injected by the host.
 *
 * Kept apart from `peers/harness.ts` (another porter's file): only the observed-runtime projection the observer's
 * question part folds. The types are copied verbatim; the projection is an interface the host supplies.
 */
import type { SessionState } from '../../protocol/session.ts';
import type { TranscriptEvent } from './transcript.ts';

/** The harness-observed runtime, as the transcript last stated it. */
export interface ObservedRuntime {
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** Whether fast mode is on, as the harness last stated it. */
  readonly fast?: boolean;
  /** The timestamp of the newest record that carried any of these. */
  readonly at?: string;
  /** How large the conversation last was, as the harness's own newest usage record stated it. */
  readonly context?: ObservedContext;
}

/** The context size the transcript last stated: a token count, when it was written, and a window if the harness named one. */
export interface ObservedContext {
  readonly tokens: number;
  readonly at: string;
  /** The window the harness itself reported (Codex does); never derived here. */
  readonly window?: number;
}

/**
 * The harness's own account of its runtime, read from a transcript tail — today's free functions
 * `projectObservedContext`, `projectObservedRuntime` and `observedRuntimeStatePatch`, with their signatures.
 */
export interface ObservedRuntimePolicy {
  projectObservedContext(events: readonly TranscriptEvent[]): ObservedContext | undefined;
  projectObservedRuntime(events: readonly TranscriptEvent[]): ObservedRuntime;
  observedRuntimeStatePatch(
    current: Pick<
      SessionState,
      | 'observedModel'
      | 'observedModelAt'
      | 'observedReasoningEffort'
      | 'observedFast'
      | 'contextTokens'
      | 'contextAt'
      | 'contextWindow'
    >,
    observed: ObservedRuntime,
  ): Partial<SessionState>;
}
