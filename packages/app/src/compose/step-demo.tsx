/**
 * STEP DEMO: where a page's example animation goes.
 *
 *   <StepPageFrame …>
 *     <ChoiceCards layout="stack" … />
 *     <StepDemo><PermissionDemo /></StepDemo>
 *   </StepPageFrame>
 *
 * A page renders `<StepDemo>` anywhere in its body; inside a `StepPageFrame` it is drawn in the frame's demo column
 * (to the right of the choices on a wide page, above them on a phone) through a portal, so the page never has to
 * return two halves. Outside a frame it renders inline, so a settings pane can reuse it. It is decorative
 * (`aria-hidden`, set by the frame's column). The frame owns the context; this file owns the rule.
 */

import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

/** `undefined`: no frame. `null`: a frame whose demo column has not mounted yet (draw nothing, the next render does). */
export const StepDemoSlotContext = createContext<HTMLElement | null | undefined>(undefined);

export interface StepDemoProps {
  readonly children: ReactNode;
}

export function StepDemo({ children }: StepDemoProps) {
  const slot = useContext(StepDemoSlotContext);
  if (slot === undefined) return <div data-step-demo-inline="">{children}</div>;
  return slot === null ? null : createPortal(children, slot);
}
