import { ApiError } from '@ferretry/kernel/contract';
import type { ComponentWriter } from '../account/owner-components.ts';

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

/**
 * What a person is told about a change that was cut short after some of it landed (the page shows this word for word):
 * what landed and, when the apply knows it, what did not.
 */
export function partlyAppliedSentence(landed: readonly string[], notLanded: readonly string[] = []): string {
  return `Part of this change was applied: ${landed.join(', ')}. The rest was not${notLanded.length === 0 ? '' : `: ${notLanded.join(', ')}`}.`;
}

/** The lists a partly applied answer carries beside its sentence, so a re-read and the page need no parsing. */
export interface PartlyApplied {
  readonly landed: readonly string[];
  readonly notLanded: readonly string[];
}

/** The lists a partly applied answer carries (`extra.landed`, `extra.notLanded`), from the error it was thrown as; none for any other. */
export function partlyAppliedOf(error: unknown): PartlyApplied | undefined {
  const extra = error instanceof Error ? (error as { extra?: unknown }).extra : undefined;
  if (typeof extra !== 'object' || extra === null) return undefined;
  const words = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const landed = words((extra as { landed?: unknown }).landed);
  return landed.length === 0 ? undefined : { landed, notLanded: words((extra as { notLanded?: unknown }).notLanded) };
}

/** The door to the owners of imported components, noting each file as it lands so a request that ends next still names it. */
export function notingLanded(writer: ComponentWriter | undefined, landed: string[]): ComponentWriter | undefined {
  if (writer === undefined) return undefined;
  return {
    put: async write => {
      const answer = await writer.put(write);
      if (answer.outcome === 'written') landed.push(write.file);
      return answer;
    },
  };
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
