/**
 * THE CONNECTED GIT ACCOUNTS, read once and again on demand. Three readings, never two: unread, failed (the daemon's own
 * sentence, with the last good list kept), and a list.
 */
import { useCallback, useEffect, useState } from 'react';
import { type ProjectsClient, reasonOf } from '../../lib/client.ts';
import { type GitAccountRow, readGitAccounts } from './accounts-api.ts';

export interface GitAccountsState {
  readonly accounts: readonly GitAccountRow[] | null;
  readonly error: string | null;
  readonly reload: () => void;
}

export function useGitAccounts(client: ProjectsClient): GitAccountsState {
  const [accounts, setAccounts] = useState<readonly GitAccountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(value => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the reload trigger; the read itself does not use it
  useEffect(() => {
    let current = true;
    void readGitAccounts(client)
      .then(rows => {
        if (!current) return;
        setAccounts(rows);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (current) setError(reasonOf(cause));
      });
    return () => {
      current = false;
    };
  }, [client, tick]);
  return { accounts, error, reload };
}
