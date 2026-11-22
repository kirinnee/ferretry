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
