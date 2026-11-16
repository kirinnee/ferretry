/** The file browser's search box: Conversation contributes the current-ferret file and card search. */
export const FILES_SEARCH_SLOT = 'ferrets.files-search' as const;

/** What the file browser hands a search panel. */
export interface FilesSearchSlotProps {
  readonly ferret: string;
  /** Opens a file of this ferret in the browser. */
  readonly openFile: (path: string) => void;
}

export function isFilesSearchSlotProps(props: unknown): props is FilesSearchSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return typeof candidate.ferret === 'string' && typeof candidate.openFile === 'function';
}

export default { slot: FILES_SEARCH_SLOT } as const;
