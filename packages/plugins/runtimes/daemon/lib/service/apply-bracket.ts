import { ApiError } from '@ferretry/kernel/contract';

/** The error an apply whose request already ended is answered with (nothing was written, the change stays pending). */
export function assertRequestLive(bracket: ApplyBracket | undefined): void {
  if (bracket?.signal?.aborted === true)
    throw new ApiError(499, 'the request ended before this change was applied; nothing was written', 'request_aborted');
}

/** The error an apply whose request ended MID-WAY is answered with: it stops before its next write. */
export function assertRequestLiveBetweenWrites(bracket: ApplyBracket | undefined): void {
  if (bracket?.signal?.aborted === true)
    throw new ApiError(
      499,
      'the request ended while this change was being applied; it stopped before its next write, and what was already written stays',
      'request_aborted',
    );
}

/** What a person is told about a change that was cut short after some files landed (the page shows this word for word). */
export function partlyAppliedSentence(landed: readonly string[]): string {
  return `Part of this change was applied: ${landed.join(', ')}. The rest was not.`;
}

/**
 * An apply stopped by its request ending (`request_aborted`) AFTER files landed is answered with those paths, in words
 * and as `extra.landed` (what the boundary keeps, so a re-read of the spent change says what landed). Any other error,
 * and an abort before any write, is returned as it is.
 */
export function abortedAfterWriting(error: unknown, landed: readonly string[]): unknown {
  const written = [...new Set(landed)];
  if (!(error instanceof ApiError) || error.code !== 'request_aborted' || written.length === 0) return error;
  return new ApiError(
    error.status,
    `${error.message}. ${partlyAppliedSentence(written)}`,
    'request_aborted',
    undefined,
    { landed: written },
  );
}

/** The paths an `abortedAfterWriting` answer names; none for any other error. */
export function landedBeforeAbort(error: unknown): readonly string[] {
  const landed = error instanceof ApiError && error.code === 'request_aborted' ? error.extra?.landed : undefined;
  return Array.isArray(landed) ? landed.filter((path): path is string => typeof path === 'string') : [];
}

/** What a finished apply left behind: waiting for the owner, not written, or cut short. */
export type ApplyLeft = 'held' | 'refused' | 'unfinished';

/** One loosening act the boundary opened for an apply (`openLooseningAct`): its proof covers every file of the change. */
export interface ApplyAct {
  /** Whether a governed caller's one proof covers each loosening the change writes. */
  readonly covered: boolean;
  /** Closes the act (idempotent); always called when the apply ends, whatever it did. */
  end(): void;
}

/**
 * What the boundary lends ONE apply, used inside the serialised section: the proposal is resolved there, so the act
 * is decided from the change as it is THEN, never from a read that raced an apply in flight (C59 O5-10b R1).
 */
export interface ApplyBracket {
  /** The request's own lifecycle: an apply whose request already ended writes nothing. */
  readonly signal?: AbortSignal;
  /** Told, once, that the catalogue knows the change id being applied (a change it holds, pending or spent). */
  readonly known?: () => void;
  /**
   * Called once the change is resolved (consumed) and before any work, with its kind. Answers the act to run it in, or
   * `undefined` when the kind is not an act; THROWS to refuse (the change is put back, nothing was written).
   */
  readonly open?: (kind: string) => ApplyAct | undefined;
  /** Told what the executor left held, refused or unfinished (see `ExecutorCaller.left`). */
  readonly left?: (state: ApplyLeft, kind: string) => void;
}
