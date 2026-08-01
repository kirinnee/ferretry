type SearchFocusListener = () => void;

/** One-shot signal between an independently mounted fleet list and its search field. */
const listeners = new Set<SearchFocusListener>();

/** Requests focus from the mounted fleet-search control; a missing control is a no-op. */
export const requestSearchFocus = (): void => {
  for (const listener of listeners) listener();
};

/** Subscribe the current search control and detach it when that control unmounts. */
export const subscribeSearchFocus = (listener: SearchFocusListener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
