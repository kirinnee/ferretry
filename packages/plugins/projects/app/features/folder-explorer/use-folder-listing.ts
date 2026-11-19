/**
 * ONE FOLDER LISTING, READ WHEN ITS PATH CHANGES.
 *
 * Three readings, never two: nothing read yet, a failed read (with the last good listing kept on screen beside the
 * failure, so a hiccup does not blank the folder), and a listing. A read is abandoned when the path moves on.
 */
import { useCallback, useEffect, useState } from 'react';
import type { FolderListing } from '../../../contract/index.ts';
import { type ProjectsClient, reasonOf } from '../../lib/client.ts';
import { listFolder } from './folders-api.ts';

export interface FolderListingState {
  readonly listing: FolderListing | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}

/** `path` undefined opens at the home folder. */
export function useFolderListing(
  client: ProjectsClient,
  path: string | undefined,
  showHidden: boolean,
): FolderListingState {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(value => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the reload trigger; the read itself does not use it
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    void listFolder(client, path, showHidden, abort.signal)
      .then(read => {
        if (abort.signal.aborted) return;
        setListing(read);
        setError(null);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        setError(reasonOf(cause));
        setLoading(false);
      });
    return () => abort.abort();
  }, [client, path, showHidden, tick]);

  return { listing, loading, error, reload };
}
