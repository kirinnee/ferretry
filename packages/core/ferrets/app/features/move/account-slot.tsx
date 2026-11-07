/**
 * The runtime field of the move page: the slot `ferrets.move-account`, drawn by whatever panel an installed plugin
 * contributes to it (Runtimes offers its runtime picker, with each login's health and quota). The page owns the typed
 * wrapper and the model box; a panel only proposes through the callbacks Ferrets' contract declares.
 *
 * A daemon without Runtimes contributes no panel, and Runtimes paused, still loading or failed on a daemon leaves the
 * shell's one-line "cannot draw this" in the slot instead. The page must still be usable in both, so when the slot
 * holds no working picker (the same rule as the new-ferret page) the wrapper is a plain text box, submitted exactly as
 * typed: the daemon is the thing that accepts or refuses a wrapper.
 */

import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { type ChosenFerretAccount, type HarnessKey, MOVE_ACCOUNT_SLOT } from '../../../contract/index.ts';
import { holdsPicker } from '../../lib/slot-picker.ts';

export interface AccountSlotField {
  readonly harness: HarnessKey;
  readonly value: string;
  readonly onValueChange: (next: string) => void;
  readonly onChosen: (chosen: ChosenFerretAccount | null) => void;
  readonly fallbackId: string;
  readonly labelId: string;
  readonly fallbackPlaceholder: string;
  /** Drawn by the panel in place of its picker when the roster was read and nothing can run a ferret. */
  readonly noAccounts: ReactNode;
}

/** Draws the slot for the given props: the shell's `PanelSlot` in production, a scripted stand-in in a test. */
export type RenderAccountSlot = (field: AccountSlotField) => ReactNode;

export function AccountSlot({
  render,
  field,
  fallbackLabel,
}: {
  readonly render: RenderAccountSlot;
  readonly field: AccountSlotField;
  readonly fallbackLabel: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  // Unknown until the slot has drawn once: a first frame must not flash a text box a picker then replaces.
  const [bare, setBare] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const node = host.current;
    setBare(node !== null && !holdsPicker(node, MOVE_ACCOUNT_SLOT));
  });
  const fallbackId = useId().replace(/:/gu, '');
  return (
    <div data-move-account-slot="">
      <div ref={host}>{render(field)}</div>
      {bare === true ? (
        <input
          aria-label={fallbackLabel}
          autoCapitalize="none"
          autoCorrect="off"
          className="kt-input !min-h-[44px] w-full mono"
          data-move-account-fallback={fallbackId}
          id={field.fallbackId}
          onChange={event => field.onValueChange(event.target.value)}
          placeholder={field.fallbackPlaceholder}
          spellCheck={false}
          value={field.value}
        />
      ) : null}
    </div>
  );
}
