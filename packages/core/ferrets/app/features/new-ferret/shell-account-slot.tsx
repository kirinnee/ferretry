/**
 * THE RUNTIME FIELD'S SLOT, as the new-ferret page mounts it: the shell's `PanelSlot` for `ferrets.new-ferret-account`,
 * handed the props Ferrets' contract declares, and the page's own typed input in its place when nothing usable was
 * contributed there (Runtimes off on this daemon, or its panel could not be drawn).
 *
 * The page never knows what draws the picker. A daemon without Runtimes shows the page with a typed runtime box, and
 * Runtimes without this page shows nothing extra: the slot name and the props are the whole agreement.
 */

import { PanelSlot } from '@ferretry/app';
import { NEW_FERRET_ACCOUNT_SLOT, type NewFerretAccountSlotProps } from '@ferretry/core-ferrets/contract';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

export interface AccountSlotProps {
  readonly daemon: string;
  readonly slot: NewFerretAccountSlotProps;
  /** The page's own typed runtime box, drawn when the slot holds no working picker. */
  readonly fallback: ReactNode;
}

/** Whether a slot element holds at least one panel and none of them is the shell's one-line "cannot draw this". */
export const holdsPicker = (root: HTMLElement | null): boolean => {
  const slot = root?.querySelector(`[data-slot="${NEW_FERRET_ACCOUNT_SLOT}"]`) ?? null;
  if (slot === null) return false;
  const panels = slot.querySelectorAll('.fy-panel');
  return panels.length > 0 && slot.querySelector('.fy-shell-line') === null;
};

export function ShellAccountSlot({ daemon, slot, fallback }: AccountSlotProps): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  // Assume a picker until the committed tree says otherwise, so a contributed picker never flashes a second box.
  const [picker, setPicker] = useState(true);
  useLayoutEffect(() => {
    const next = holdsPicker(root.current);
    if (next !== picker) setPicker(next);
  });
  return (
    <div ref={root}>
      <PanelSlot daemon={daemon} props={{ ...slot }} slot={NEW_FERRET_ACCOUNT_SLOT} />
      {picker ? null : fallback}
    </div>
  );
}
