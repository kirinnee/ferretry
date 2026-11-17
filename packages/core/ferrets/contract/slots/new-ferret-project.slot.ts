/** The new-ferret page's registered-projects picker: Projects contributes it; a pick fills the folder field. */
export const NEW_FERRET_PROJECT_SLOT = 'ferrets.new-ferret-project' as const;

/** What the new-ferret page hands a project picker. */
export interface NewFerretProjectSlotProps {
  /** The folder field's current value. */
  readonly value: string;
  /** Fills the folder field with a registered project's folder. */
  readonly onPick: (folder: string) => void;
}

export function isNewFerretProjectSlotProps(props: unknown): props is NewFerretProjectSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return typeof candidate.value === 'string' && typeof candidate.onPick === 'function';
}

export default { slot: NEW_FERRET_PROJECT_SLOT } as const;
