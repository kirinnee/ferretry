/**
 * A stand-in for the slot the move page offers (`ferrets.move-account`): one button per scripted account, each
 * proposing its wrapper through the callbacks the contract declares, exactly as Runtimes' panel does. The host element
 * carries `data-slot`, which is how the page tells a slot with a panel from one without.
 */
import type { ReactNode } from 'react';
import type { ChosenFerretAccount, HarnessKey } from '../../../../contract/index.ts';
import type { AccountSlotField, RenderAccountSlot } from '../../../../app/features/move/account-slot.tsx';

export const chosenAccount = (
  wrapper: string,
  kind: HarnessKey,
  over: Partial<ChosenFerretAccount> = {},
): ChosenFerretAccount => ({
  wrapper,
  displayName: wrapper,
  kind,
  defaultModel: null,
  models: [],
  ...over,
});

export interface SlotLog {
  readonly fields: AccountSlotField[];
}

export const fakeSlot =
  (accounts: readonly ChosenFerretAccount[], log?: SlotLog): RenderAccountSlot =>
  (field: AccountSlotField): ReactNode => {
    log?.fields.push(field);
    return (
      <div className="fy-slot" data-slot="ferrets.move-account">
        {/* biome-ignore lint/a11y/useSemanticElements: a stand-in for the contributed picker */}
        <div role="group" aria-labelledby={field.labelId}>
          {accounts.map(account => (
            <button
              aria-pressed={field.value === account.wrapper}
              data-account={account.wrapper}
              key={account.wrapper}
              onClick={() => {
                field.onValueChange(account.wrapper);
                field.onChosen(account);
              }}
              type="button"
            >
              {account.displayName}
            </button>
          ))}
        </div>
      </div>
    );
  };

/** A slot nobody contributed to: draws nothing at all, as the shell's `PanelSlot` does for an empty slot. */
export const emptySlot: RenderAccountSlot = () => null;
