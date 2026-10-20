/**
 * The "Move to Codex… / Move to Claude…" action for one ferret: whether the row exists, and the sheet it
 * opens. Both hosts of the Actions menu — the session header and the sessions bar — compose it, so they
 * cannot disagree about when the row is offered.
 *
 * The row exists only when the connection may change the ferret AND the machine has an account of the
 * other harness to move onto; a row whose sheet could only say "nothing to move to" is worse than none.
 */

import type { SessionView } from '@ferretry/protocol';
import { type ReactNode, useEffect, useState } from 'react';
import type { DaemonAccountPickerStore } from '../../lib/account-picker-store.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../../lib/daemon-scope.ts';
import { ConvertSheet } from './convert-sheet.tsx';
import { useConvertibleAccounts } from './use-convertible-accounts.ts';

export function useConvertAction({
  connection,
  scope,
  view,
  canControl,
  accountPicker,
  onMoved,
}: {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly view: SessionView;
  readonly canControl: boolean;
  readonly accountPicker: DaemonAccountPickerStore | undefined;
  readonly onMoved: (view: SessionView, notice: string) => void;
}): { readonly openConvert: (() => void) | undefined; readonly sheet: ReactNode } {
  const [open, setOpen] = useState(false);
  const accounts = useConvertibleAccounts(accountPicker, connection, view.config.harness);
  const session = `${connection.daemonId}:${daemonSessionKey(scope)}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairing and session are the reset trigger
  useEffect(() => setOpen(false), [session]);
  const offered = canControl && accounts.length > 0;
  return {
    openConvert: offered ? () => setOpen(true) : undefined,
    sheet: offered ? (
      <ConvertSheet
        accounts={accounts}
        connection={connection}
        onClose={() => setOpen(false)}
        onMoved={onMoved}
        open={open}
        scope={scope}
        view={view}
      />
    ) : null,
  };
}
