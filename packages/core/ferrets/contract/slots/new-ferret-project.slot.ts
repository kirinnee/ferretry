/** The new-ferret page's "where it works" field: Projects contributes it; a pick fills the page's folder. */
export const NEW_FERRET_PROJECT_SLOT = 'ferrets.new-ferret-project' as const;

/** What the new-ferret page hands the "where it works" panel. */
export interface NewFerretProjectSlotProps {
  /** The daemon this page is on: the panel reads what other plugins provide there (connecting a GitHub account). */
  readonly daemon: string;
  /** The folder the page holds now. */
  readonly value: string;
  /** The element id the page's own "Where it works" label points at: the panel puts it on its main control. */
  readonly id: string;
  /** Folders ferrets were recently started in, newest first: one-tap quick picks beside the folder finder. */
  readonly recent: readonly string[];
  /** Fills the page's folder (a project's folder, a folder from the finder, or a recent one). */
  readonly onPick: (folder: string) => void;
  /**
   * Told once, when the panel has read what it needs to choose its first view (the registered projects), answered or
   * failed. The page draws nothing of the form before every field has said so, so a default the panel picks from that
   * read is picked once and never flips. Optional: a page that does not wait leaves it out.
   */
  readonly onSettled?: () => void;
}

export function isNewFerretProjectSlotProps(props: unknown): props is NewFerretProjectSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return (
    typeof candidate.daemon === 'string' &&
    typeof candidate.value === 'string' &&
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.recent) &&
    typeof candidate.onPick === 'function' &&
    (candidate.onSettled === undefined || typeof candidate.onSettled === 'function')
  );
}

export default { slot: NEW_FERRET_PROJECT_SLOT } as const;
