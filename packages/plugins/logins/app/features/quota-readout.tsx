/**
 * The `daemon.status` readout: how many logins are ready and which need signing in, in one line, from the same
 * `GET /v1/logins` the Sign-ins tab reads. Unknown is never zero: a login nobody has checked is "checking", not ready.
 */

import { useEffect, useState } from 'react';
import type { LoginList } from '../../contract/index.ts';
import { AccountStatus } from '../components/account-status.tsx';
import type { LoginsClient } from '../lib/client.ts';
import { readLogins } from '../lib/logins-api.ts';
import { plural } from '../lib/logins-view.ts';

export const readoutWords = (list: LoginList): string => {
  const total = list.logins.length;
  if (total === 0) return 'No logins';
  const needs = list.logins.filter(login => login.status.word === 'needs_sign_in').length;
  const ready = list.logins.filter(login => login.status.word === 'ready').length;
  return needs === 0
    ? `${plural(ready, 'login')} ready`
    : `${plural(needs, 'login')} need${needs === 1 ? 's' : ''} sign-in`;
};

export function QuotaReadout({ client }: { readonly client: LoginsClient }) {
  const [list, setList] = useState<LoginList | null>(null);
  useEffect(() => {
    let alive = true;
    readLogins(client).then(
      read => {
        if (alive) setList(read);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [client]);
  if (list === null) return null;
  const needs = list.logins.some(login => login.status.word === 'needs_sign_in');
  return (
    <span className="inline-flex items-center gap-1 text-meta text-muted" data-quota-readout="">
      <AccountStatus word={needs ? 'needs_sign_in' : 'ready'} />
      {readoutWords(list)}
    </span>
  );
}
