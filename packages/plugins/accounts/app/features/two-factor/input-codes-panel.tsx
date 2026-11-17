/**
 * "SET UP AUTOMATIC CODES" UNDER A CODE CARD: what Accounts draws in the Vault's `vault.input-card-codes` slot
 * (docs/input-requests.md, "Set up automatic codes").
 *
 * The Vault's input card, while it asks for a one-time code, offers that slot under its saved accounts and hands over ids
 * and place keys it already holds (never a typed value, a code or a seed). This panel is only the glue: it reads those
 * props with the Vault's own reader, reads the accounts from Accounts' own route, keeps the ones the DAEMON would match to
 * the card's place, and mounts the existing {@link AutomaticCodesPanel} with the card's request id, so the daemon refuses a
 * stage for any other account (`not_this_cards_account`) and can type the first code ("use it now").
 *
 * The seed is typed into that panel's own masked field and nowhere else: this file never sees it, puts none in state, in a
 * prop, a URL or a log. A slot with no usable props, accounts that cannot be read (a device that may not use secrets, a
 * failed read), no matching account or no passkey to bind the save to draws NOTHING: the card is complete without it.
 */

import { readInputCardCodesSlotProps } from '@ferretry/core-vault/contract';
import { useEffect, useMemo, useState } from 'react';
import type { AccountList, TwoFactorStageId } from '../../../contract/routes/index.ts';
import { codesAccounts, startingAccount } from '../../lib/automatic-codes.ts';
import { type AccountsClient, readAccounts } from '../accounts/accounts-api.ts';
import { AutomaticCodesPanel } from './automatic-codes.tsx';

export interface InputCodesPanelProps {
  /** The Accounts client of the machine the card is on. */
  readonly client: AccountsClient;
  /** What the slot handed the panel: the shell's `subject` and the card's props, none of them trusted. */
  readonly slot: unknown;
  /** Asks for the passkey bound to the staged seed; absent where this device cannot ask. */
  readonly addKey?: (stage: TwoFactorStageId, words: string) => Promise<boolean>;
}

export function InputCodesPanel({ client, slot, addKey }: InputCodesPanelProps) {
  const props = useMemo(() => readInputCardCodesSlotProps(slot), [slot]);
  const requestId = props?.requestId;
  const [list, setList] = useState<AccountList | undefined>(undefined);
  // A saved key changes how many keys an account holds: the accounts are read again, the panel stays where it is.
  const [reads, setReads] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` is the re-read trigger (a saved key); the effect does not read it
  useEffect(() => {
    if (requestId === undefined) return;
    let current = true;
    void readAccounts(client).then(
      read => {
        if (current) setList(read);
      },
      () => {
        if (current) setList(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [client, requestId, reads]);

  const saved = props?.saved;
  const accounts = useMemo(() => (list === undefined ? [] : codesAccounts(saved, list)), [list, saved]);
  const initial = useMemo(() => startingAccount(saved, accounts), [saved, accounts]);

  if (props === undefined || addKey === undefined || accounts.length === 0) return null;
  const { refresh } = props;
  return (
    <AutomaticCodesPanel
      accounts={accounts}
      addKey={addKey}
      client={client}
      initial={initial}
      key={props.requestId}
      onSaved={() => {
        // The daemon may have typed the first code ("use it now"): the card reads its request again.
        setReads(count => count + 1);
        refresh();
      }}
      requestId={props.requestId}
    />
  );
}
