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

import { createContext, type ReactNode, useContext, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** `undefined`: no frame. `null`: a frame whose demo column has not mounted yet (draw nothing, the next render does). */
export const StepDemoSlotContext = createContext<HTMLElement | null | undefined>(undefined);

export interface StepDemoProps {
  readonly children: ReactNode;
  /**
   * On a phone, keep the demo (and the page's heading) pinned to the top of the screen while the body scrolls under them,
   * so every pick is seen working. Beside the choices (a wide frame) the demo is always pinned. Layout: `step-page-frame.css`.
   */
  readonly pinned?: boolean;
}

/** True while `node` or any ancestor up to (not including) `stop` carries the `hidden` attribute: the page is covered. */
const coveredAbove = (node: Element, stop: Element): boolean => {
  for (let at: Element | null = node; at !== null && at !== stop; at = at.parentElement)
    if (at.hasAttribute('hidden')) return true;
  return false;
};

/**
 * The portal escapes the hidden subtree its page is drawn in (a flow keeps a page `hidden` behind its loading cover),
 * so the demo would play beside the cover. A zero-size mark rides in the page where `<StepDemo>` is written; while the
 * mark or an ancestor inside the frame's body is `hidden`, the demo is not drawn, and it is drawn when the page shows.
 */
export function StepDemo({ children, pinned = false }: StepDemoProps) {
  const slot = useContext(StepDemoSlotContext);
  const mark = useRef<HTMLSpanElement>(null);
  const [covered, setCovered] = useState(false);
  useLayoutEffect(() => {
    const node = mark.current;
    if (slot === undefined || slot === null || node === null) return;
    const body = node.closest('.fy-spf__body') ?? node.ownerDocument.body;
    const update = (): void => setCovered(coveredAbove(node, body));
    update();
    const watch = new MutationObserver(update);
    watch.observe(body, { attributeFilter: ['hidden'], attributes: true, subtree: true });
    return () => watch.disconnect();
  }, [slot]);
  if (slot === undefined) return <div data-step-demo-inline="">{children}</div>;
  return (
    <>
      <span ref={mark} data-step-demo-mark="" style={{ display: 'none' }} />
      {slot === null || covered
        ? null
        : createPortal(
            pinned ? (
              <div data-step-demo-pinned="" style={{ inlineSize: '100%', minInlineSize: 0 }}>
                {children}
              </div>
            ) : (
              children
            ),
            slot,
          )}
    </>
  );
}
