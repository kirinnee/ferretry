/**
 * Where a step's own actions go: Skip, Import, Continue.
 *
 * Inline — inside Settings — they sit under the step, as they always did. On the full-screen setup they
 * are pinned to the bottom of the screen beside ‹ Back, in the same place on every step (the approved
 * proposal: "Back, Skip and Import always at the bottom"). A step never knows which: it renders its
 * actions through {@link StepperFoot}, and the stepper says where they land by providing a node.
 *
 * The node is INSIDE the stepper's own section, so an action is still found under
 * `[data-machine-stepper][data-step=…]` exactly as before.
 */

import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

/** The pinned footer's slot, or `null` when the stepper is inline. */
export const StepperFootContext = createContext<HTMLElement | null>(null);

export function StepperFoot({ children }: { readonly children: ReactNode }) {
  const slot = useContext(StepperFootContext);
  if (slot === null) return <div className="mt-4 flex flex-wrap gap-2">{children}</div>;
  return createPortal(children, slot);
}
