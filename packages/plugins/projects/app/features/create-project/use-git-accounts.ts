/**
 * THE CONNECTED GIT ACCOUNTS, read once and again on demand. Three readings, never two: unread, failed (the daemon's own
 * sentence, with the last good list kept), and a list.
 *
 * A read the page makes on its own is refused (not prompted) when the machine wants the passkey first; `stepUp` says so
 * and `confirm` is the person's press, which reads again and may ask. Nothing opens a passkey dialog without a press.
 */
import { isStepUpRefusal } from '@ferretry/app/ui';
import { useCallback, useEffect, useState } from 'react';
import { type ProjectsClient, reasonOf } from '../../lib/client.ts';
import { type GitAccountRow, readGitAccounts } from './accounts-api.ts';

export interface GitAccountsState {
  readonly accounts: readonly GitAccountRow[] | null;
  readonly error: string | null;
  /** The last read was refused only for want of the passkey step-up. */
  readonly stepUp: boolean;
  readonly reload: () => void;
  /** The person's press: read again, and ask for the passkey if the machine wants it. */
  readonly confirm: () => void;
}

interface Read {
  readonly tick: number;
  readonly pressed: boolean;
}

export function useGitAccounts(client: ProjectsClient): GitAccountsState {
  const [accounts, setAccounts] = useState<readonly GitAccountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [read, setRead] = useState<Read>({ tick: 0, pressed: false });
  const reload = useCallback(() => setRead(last => ({ tick: last.tick + 1, pressed: false })), []);
  const confirm = useCallback(() => setRead(last => ({ tick: last.tick + 1, pressed: true })), []);
  useEffect(() => {
    let current = true;
    void readGitAccounts(client, read.pressed).then(
      rows => {
        if (!current) return;
        setAccounts(rows);
        setError(null);
        setStepUp(false);
      },
      (cause: unknown) => {
        if (!current) return;
        setError(reasonOf(cause));
        setStepUp(isStepUpRefusal(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [client, read]);
  return { accounts, error, stepUp, reload, confirm };
}
