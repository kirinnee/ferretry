/**
 * The runtime picker Ferrets' pages OFFER as slots (`ferrets.new-ferret-account`, `ferrets.move-account`), drawn by
 * Runtimes: one button per runtime that can run a ferret, with each login's health and, while Usage is on, the
 * runtime's quota. The page owns the draft and the model box; this panel only proposes a wrapper through the callbacks
 * Ferrets' contract declares, and reads nothing from the page but those props.
 *
 * A half is built per daemon, so the store made here belongs to one machine. Quota comes from Usage's contract
 * (`./lib/usage-feed.ts`); with Usage off the picker is drawn without it.
 */

import {
  type ChosenFerretAccount,
  type MoveAccountSlotProps,
  type NewFerretAccountSlotProps,
  isMoveAccountSlotProps,
  isNewFerretAccountSlotProps,
} from '@ferretry/core-ferrets/contract';
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { type ChosenRuntime, RuntimeButtons } from '../components/runtime-buttons.tsx';
import { useUsageRows } from '../hooks/use-usage-rows.ts';
import {
  checkAccountPickerHealth,
  readAccountPickerCatalog,
  readAccountPickerHealth,
} from '../lib/account-picker-catalog.ts';
import { AccountPickerStore } from '../lib/account-picker-store.ts';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { useNow } from '../ui.ts';

const noSubscribe = (): (() => void) => () => undefined;

const pickerStore = (client: LiveRuntimesClient): AccountPickerStore =>
  new AccountPickerStore({
    catalog: () => readAccountPickerCatalog(client),
    health: () => readAccountPickerHealth(client),
    checkHealth: () => checkAccountPickerHealth(client),
  });

/** What the page needs to know about the runtime picked: Ferrets' words, not this half's option record. */
export const chosenFerretAccount = (chosen: ChosenRuntime | null): ChosenFerretAccount | null => {
  if (chosen === null) return null;
  const { account } = chosen;
  return {
    wrapper: account.wrapper,
    displayName: account.displayName,
    kind: account.kind,
    defaultModel: account.defaultModel,
    models: account.models.map(model => ({
      id: model.id,
      available: model.available,
      ...(model.label === undefined ? {} : { label: model.label }),
    })),
    ...(account.modelCatalog === undefined
      ? {}
      : {
          modelCatalog: {
            id: account.modelCatalog.id,
            label: account.modelCatalog.label,
            customIds: account.modelCatalog.customIds,
          },
        }),
  };
};

interface FieldProps {
  readonly client: LiveRuntimesClient;
  readonly store: AccountPickerStore;
  readonly slot: NewFerretAccountSlotProps | MoveAccountSlotProps;
}

function AccountField({ client, store, slot }: FieldProps): ReactNode {
  const now = useNow();
  const { rows, error } = useUsageRows(client);
  const move = isMoveAccountSlotProps(slot) ? slot : null;
  const preferred = 'preferred' in slot ? slot.preferred : undefined;
  return (
    <RuntimeButtons
      client={{ subscribe: client.subscribe ?? noSubscribe }}
      fallbackId={slot.fallbackId}
      fallbackPlaceholder={slot.fallbackPlaceholder}
      labelId={slot.labelId}
      noAccounts={slot.noAccounts as ReactNode}
      now={now}
      onChosen={chosen => slot.onChosen(chosenFerretAccount(chosen))}
      onValueChange={slot.onValueChange}
      store={store}
      usage={rows}
      usageError={error}
      value={slot.value}
      {...(preferred === undefined ? {} : { preferred })}
      {...(move === null ? {} : { harness: move.harness, offerHealthCheck: true })}
    />
  );
}

const panelOf = (
  client: LiveRuntimesClient,
  accepts: (props: unknown) => props is NewFerretAccountSlotProps | MoveAccountSlotProps,
): AppComponent<PanelProps> => {
  const store = pickerStore(client);
  return function AccountPanel(props: PanelProps) {
    return accepts(props) ? <AccountField client={client} slot={props} store={store} /> : null;
  };
};

/** The panel for the page that starts a ferret. */
export const createNewFerretAccountPanel = (client: LiveRuntimesClient): AppComponent<PanelProps> =>
  panelOf(client, isNewFerretAccountSlotProps);

/** The panel for the page that moves a ferret to another runtime of its harness. */
export const createMoveAccountPanel = (client: LiveRuntimesClient): AppComponent<PanelProps> =>
  panelOf(client, isMoveAccountSlotProps);
