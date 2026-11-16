/**
 * One login's sign-in, mounted by itself (the `claude-code-login` and `codex-login` panels): reads the login named by
 * the panel's subject and draws its harness's sign-in. A subject that names no login, or one of the other harness,
 * says so instead of starting anything.
 */

import { useCallback, useEffect, useState } from 'react';
import type { LoginList } from '../../contract/index.ts';
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { type LoginsClient, refusalSentence } from '../lib/client.ts';
import { readLogins } from '../lib/logins-api.ts';
import { HARNESS_NAMES } from '../lib/logins-view.ts';
import { LoginSignIn } from './login-sign-in.tsx';

export interface LoginSignInPanelProps {
  readonly client: LoginsClient;
  readonly harness: HarnessKey;
  /** The login's id. */
  readonly subject?: string;
  readonly pollMs?: number;
}

export function LoginSignInPanel({ client, harness, subject, pollMs }: LoginSignInPanelProps) {
  const [list, setList] = useState<LoginList | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setList(await readLogins(client));
    } catch (error) {
      setFailure(refusalSentence(error));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (failure !== null)
    return (
      <p role="alert" className="m-0 text-cell leading-base text-warn">
        {failure}
      </p>
    );
  if (list === null)
    return (
      <p role="status" className="m-0 text-cell text-muted">
        Reading the logins on this machine…
      </p>
    );
  const login = subject === undefined ? undefined : list.logins.find(item => item.id === subject);
  if (login === undefined || login.harness !== harness)
    return (
      <p className="m-0 text-cell leading-base text-muted" data-login-sign-in-panel="none">
        {subject === undefined
          ? `Name a ${HARNESS_NAMES[harness]} login to sign in.`
          : `There is no ${HARNESS_NAMES[harness]} login ${subject} on ${list.machine}.`}
      </p>
    );
  return (
    <LoginSignIn
      login={login}
      machineName={list.machine}
      client={client}
      onSignedIn={() => void reload()}
      {...(pollMs === undefined ? {} : { pollMs })}
    />
  );
}
