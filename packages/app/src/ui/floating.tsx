/**
 * WHERE A PANEL'S FLOATING THINGS GO. A dialog, a toast or a note a panel draws is `position: fixed`, which only means
 * "relative to the screen" when no ancestor has a transform: inside a bottom sheet (whose panel slides with
 * `transform`/`will-change`) a fixed element is boxed in the sheet, and inside a menu that is shut it is hidden with it.
 *
 * A host that mounts panels inside such a surface (the ferret's Modes menu) provides {@link FloatingHost}: every
 * {@link Floating} below it is drawn in the host's element (the document body) instead, still part of the panel's own
 * React tree, so its state survives the menu being shut and a note that arrives after the person clicked away is still
 * seen. With no host, `Floating` draws in place and a panel behaves exactly as it did on its own.
 */

import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { createPortal } from 'react-dom';

interface FloatingSurface {
  /** The element floating things are drawn in; absent, in place. */
  readonly element: HTMLElement | null;
  /** Puts the surface the panel sits in away (the menu), for a panel that is about to open a dialog of its own. */
  readonly dismiss: (() => void) | null;
  /** Whether the surface is on the screen now. A panel stays mounted in a shut one and may need to reset (an armed confirm). */
  readonly open: boolean;
}

const NO_SURFACE: FloatingSurface = { element: null, dismiss: null, open: true };
const FloatingContext = createContext<FloatingSurface>(NO_SURFACE);

export function FloatingHost({
  element,
  dismiss,
  open = true,
  children,
}: {
  readonly element: HTMLElement | null;
  readonly dismiss: () => void;
  /** Whether the host's surface is open; omitted means always (a host that never shuts). */
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  const value = useMemo<FloatingSurface>(() => ({ element, dismiss, open }), [element, dismiss, open]);
  return <FloatingContext.Provider value={value}>{children}</FloatingContext.Provider>;
}

/** Closes the menu or sheet this panel is drawn in, if it is in one (a no-op otherwise). */
export function useDismissSurface(): () => void {
  const { dismiss } = useContext(FloatingContext);
  return dismiss ?? noop;
}

/** Whether the surface this panel is drawn in is open now (true outside any host). */
export function useSurfaceOpen(): boolean {
  return useContext(FloatingContext).open;
}

const noop = (): void => undefined;

/** Draws `children` in the host's element when there is one (see the file's note), else where it stands. */
export function Floating({ children }: { readonly children: ReactNode }) {
  const { element } = useContext(FloatingContext);
  return element === null ? <>{children}</> : createPortal(children, element);
}
