import type { HarnessKey } from '../ids.ts';

/**
 * The new-ferret page's "Continue a past conversation" list: Conversation contributes it (it owns the listing of the
 * conversations this machine's harnesses hold). A pick fills the page's own form, and Create starts the ferret as usual
 * with the conversation named, so the harness resumes it.
 */
export const NEW_FERRET_CONTINUE_SLOT = 'ferrets.new-ferret-continue' as const;

/** One past conversation the owner picked. */
export interface ContinuePick {
  /** Which row it is, so the list can mark it. */
  readonly key: string;
  /** The harness that holds it: the runtime field offers only this harness's runtimes. */
  readonly harness: HarnessKey;
  /** The harness's own conversation id: what a start names to resume it. */
  readonly conversation: string;
  /** The folder it ran in: it fills the Folder box. */
  readonly folder: string;
  /** What the row is called (its title, else what was first said). */
  readonly title: string;
}

/** What the new-ferret page hands the continue list. */
export interface NewFerretContinueSlotProps {
  /** The row now in the form, or `null`. */
  readonly picked: string | null;
  /** Puts a pick in the form (`null` clears it). */
  readonly onPick: (pick: ContinuePick | null) => void;
}

export function isNewFerretContinueSlotProps(props: unknown): props is NewFerretContinueSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return (candidate.picked === null || typeof candidate.picked === 'string') && typeof candidate.onPick === 'function';
}

export default { slot: NEW_FERRET_CONTINUE_SLOT } as const;
