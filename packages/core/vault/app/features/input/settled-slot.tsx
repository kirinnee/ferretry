/**
 * WHAT FOLLOWS A SETTLED CARD that used a saved account: the shell's `PanelSlot` for `vault.input-settled`, handed the
 * ids and names the contract declares (`contract/input-slots.ts`).
 *
 * The card never knows what draws there. Accounts contributes its "Don't ask again" sheet; a daemon without Accounts
 * (or a shell that is not drawing panels) shows the settled card with nothing after it. The slot is mounted ONLY when
 * the owner tapped a saved account: nothing is offered after a typed value, a paste or a refusal, and no value is
 * handed over, because the card never held one.
 */
import { PanelSlot, useOptionalRouter } from '@ferretry/app';
import { INPUT_SETTLED_SLOT, type InputSettledSlotProps } from '../../../contract/index.ts';

export function SettledSlot({ slot }: { readonly slot: InputSettledSlotProps }) {
  const router = useOptionalRouter();
  const daemon = router?.route.kind === 'screen' ? router.route.daemon : undefined;
  if (daemon === undefined) return null;
  return (
    <div data-input-settled-slot="">
      <PanelSlot daemon={daemon} props={{ ...slot }} slot={INPUT_SETTLED_SLOT} subject={slot.ferret} />
    </div>
  );
}
