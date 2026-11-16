import type { ChosenFerretAccount, NewFerretAccountSlotProps } from '@ferretry/core-ferrets/contract';
import { type ReactNode, useEffect } from 'react';
import { render } from '../support/react.ts';
import { scripted, type Call } from '../support/client.ts';
import { NewFerretPage, type NewFerretPageProps } from '../../../../app/features/new-ferret/new-ferret-page.tsx';
import type { AccountSlotProps } from '../../../../app/features/new-ferret/shell-account-slot.tsx';
import type { RecentFolder } from '../../../../app/features/new-ferret/recent-folders.ts';

/** A ferret's summary as far as the folder box reads it. */
export const summaryAt = (folder: string, stateAt: string): Record<string, unknown> => ({
  id: 'f1',
  name: 'Hadi',
  folder,
  stateAt,
});

export interface Harness {
  readonly navigated: string[];
  readonly backed: string[];
  readonly calls: Call[];
  readonly view: ReturnType<typeof render>;
  /** The slot props the page handed the last time it drew the slot. */
  readonly slot: () => NewFerretAccountSlotProps | undefined;
}

export interface PageOptions {
  readonly list?: unknown;
  readonly start?: unknown;
  /** What the slot's panel does with the props; absent = nothing contributed (the typed fallback shows). */
  readonly panel?: (slot: NewFerretAccountSlotProps) => ReactNode;
  readonly props?: Partial<NewFerretPageProps>;
}

export const page = (options: PageOptions = {}): Harness => {
  const navigated: string[] = [];
  const backed: string[] = [];
  const calls: Call[] = [];
  let seen: NewFerretAccountSlotProps | undefined;
  const client = scripted(
    {
      'GET /v1/ferrets': options.list ?? [],
      'POST /v1/ferrets': options.start ?? { id: 'new-ferret' },
    },
    calls,
  );
  /** Stands in for the shell's slot: it hands the contract's props to a stub panel, or draws the fallback. */
  const AccountSlot = ({ slot, fallback }: AccountSlotProps): ReactNode => {
    seen = slot;
    return options.panel === undefined ? fallback : options.panel(slot);
  };
  const view = render(
    <NewFerretPage
      AccountSlot={AccountSlot}
      client={client}
      daemon="daemon/a"
      onBack={path => backed.push(path)}
      onNavigate={path => navigated.push(path)}
      {...options.props}
    />,
  );
  return { navigated, backed, calls, view, slot: () => seen };
};

/** A stub runtime picker: one button that proposes a wrapper and reports the runtime it names. */
export function StubPicker({
  slot,
  account,
  noAccounts = false,
}: {
  readonly slot: NewFerretAccountSlotProps;
  readonly account: ChosenFerretAccount;
  readonly noAccounts?: boolean;
}): ReactNode {
  useEffect(() => {
    slot.onChosen(slot.value === account.wrapper ? account : null);
  }, [slot, account]);
  return noAccounts ? (
    (slot.noAccounts as ReactNode)
  ) : (
    <button data-stub-runtime={account.wrapper} onClick={() => slot.onValueChange(account.wrapper)} type="button">
      {account.displayName}
    </button>
  );
}

export const recent = (path: string, lastActivity: string): RecentFolder => ({ path, lastActivity });
