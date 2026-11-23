/** The new-ferret page's "where it works" field: Projects contributes it; a pick fills the page's folder. */
export const NEW_FERRET_PROJECT_SLOT = 'ferrets.new-ferret-project' as const;

/** What the new-ferret page hands the "where it works" panel. */
export interface NewFerretProjectSlotProps {
  /** The folder the page holds now. */
  readonly value: string;
  /** The element id the page's own "Where it works" label points at: the panel puts it on its main control. */
  readonly id: string;
  /** Folders ferrets were recently started in, newest first: one-tap quick picks beside the folder finder. */
  readonly recent: readonly string[];
  /** Fills the page's folder (a project's folder, a folder from the finder, or a recent one). */
  readonly onPick: (folder: string) => void;
}

export function isNewFerretProjectSlotProps(props: unknown): props is NewFerretProjectSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return (
    typeof candidate.value === 'string' &&
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.recent) &&
    typeof candidate.onPick === 'function'
  );
}

export default { slot: NEW_FERRET_PROJECT_SLOT } as const;
