/** The address bar as the Board reads it: the query string, kept current across the shell's navigation. */

import { useCallback, useEffect, useState } from 'react';

const currentSearch = (): string => globalThis.location?.search ?? '';

/** The URL's query string (with its `?`) and a way to rewrite it without leaving the page. */
export const useLocationSearch = (): readonly [string, (next: string) => void] => {
  const [search, setSearch] = useState(currentSearch);
  useEffect(() => {
    const read = (): void => setSearch(currentSearch());
    globalThis.addEventListener('popstate', read);
    return () => globalThis.removeEventListener('popstate', read);
  }, []);
  const write = useCallback((next: string): void => {
    const query = next === '' ? '' : `?${next.replace(/^\?/u, '')}`;
    globalThis.history.replaceState(globalThis.history.state, '', `${globalThis.location.pathname}${query}`);
    setSearch(query);
  }, []);
  return [search, write];
};
