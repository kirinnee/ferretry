/**
 * The move page as a screen (`ferrets.move`, path `ferrets/:ferret/move`): the ferret comes from the route, the
 * runtime field is the slot `ferrets.move-account` drawn by the shell's `PanelSlot`, and Back returns to the ferret.
 */

import { PanelSlot, useOptionalRouter } from '@ferretry/app';
import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { MOVE_ACCOUNT_SLOT } from '../../contract/index.ts';
import type { AccountSlotField } from '../features/move/account-slot.tsx';
import { chatHref } from '../features/move/chat-href.ts';
import { MovePage, type Mode } from '../features/move/move-page.tsx';
import type { LiveFerretsClient } from '../lib/client.ts';

/** The switch a link named: `?mode=cli` on this page's address opens the CLI side; anything else is the account side. */
export const initialModeOf = (search: string): Mode =>
  new URLSearchParams(search).get('mode') === 'cli' ? 'cli' : 'account';

export const createMoveScreen = (client: LiveFerretsClient): AppComponent<ScreenProps> =>
  function MoveScreen({ params }: ScreenProps): ReactNode {
    const router = useOptionalRouter();
    const ferret = params.ferret ?? '';
    const daemon = router?.route.kind === 'screen' ? router.route.daemon : undefined;
    const slot = (field: AccountSlotField): ReactNode =>
      daemon === undefined ? null : (
        <PanelSlot
          daemon={daemon}
          props={{
            value: field.value,
            onValueChange: field.onValueChange,
            onChosen: field.onChosen,
            fallbackId: field.fallbackId,
            labelId: field.labelId,
            fallbackPlaceholder: field.fallbackPlaceholder,
            noAccounts: field.noAccounts,
            harness: field.harness,
          }}
          slot={MOVE_ACCOUNT_SLOT}
          subject={ferret}
        />
      );
    return (
      <MovePage
        client={client}
        ferret={ferret}
        initialMode={initialModeOf(globalThis.location?.search ?? '')}
        onClose={() => {
          const to = daemon === undefined ? undefined : chatHref(daemon, ferret);
          if (to !== undefined) router?.back(to);
        }}
        slot={slot}
      />
    );
  };
