/**
 * Is the software keyboard up? Ported from kteam
 * `ui/src/hooks/useAppViewport.ts`'s `useKeyboardOpen`.
 *
 * It OBSERVES `<html data-keyboard>` rather than re-deriving the geometry. The
 * attribute is already the one place that rule lives, CSS keys off exactly the
 * same signal (`[data-keyboard='open'] [data-kb-hide]`), and a second
 * measurement path would be a second thing to keep true. The observer is
 * per-consumer and detaches with the component.
 *
 * `useAppViewport` is the producer: it writes the attribute from visual viewport
 * geometry, while this hook only observes that stable shared signal.
 */

import { useEffect, useState } from 'react';

/** The root attribute both this hook and the global stylesheet read. */
export const KEYBOARD_ATTRIBUTE = 'data-keyboard';

/** Pure, so the rule tests without a DOM: only the literal `open` counts. */
export const keyboardOpenFromAttribute = (value: string | null): boolean => value === 'open';

export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(
    () =>
      typeof document !== 'undefined' &&
      keyboardOpenFromAttribute(document.documentElement.getAttribute(KEYBOARD_ATTRIBUTE)),
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const read = () => setOpen(keyboardOpenFromAttribute(root.getAttribute(KEYBOARD_ATTRIBUTE)));
    // One read after mount: the attribute may have been written between the
    // lazy initial state and this effect.
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: [KEYBOARD_ATTRIBUTE] });
    return () => observer.disconnect();
  }, []);

  return open;
}
