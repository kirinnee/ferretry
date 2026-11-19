import { needsSubject, type Route } from '../router/routes.ts';
import type { SideHolds } from '../layout/engine.ts';
import { useShell } from './context.tsx';
import { PanelSlot, ScreenView } from './views.tsx';

/**
 * THE SIDE COLUMN'S CONTENT (the ferret list, by default), decided once and drawn in either of two places: inside the left
 * drawer's list slot when the layout puts the column on the left, or in the frame's own right-hand column.
 */

/**
 * What the side column holds on this page, or `undefined` when the layout, the width or the page says it is not drawn. The
 * phone's overlay drawer (`overlay`) holds it too, whatever `wide-only` says of a column BESIDE the page: it is the list
 * the person opened the drawer for, and the page it covers is not shown beside it.
 */
export function useSideHolds(daemon: string | undefined, route: Route, overlay = false): SideHolds | undefined {
  const { plan, viewport } = useShell();
  const { show, holds } = plan.side;
  if (show === 'never' || holds.kind === 'none') return undefined;
  if (show === 'wide-only' && viewport === 'phone' && !overlay) return undefined;
  if (daemon === undefined) return undefined;
  if (holds.kind === 'screen' && needsSubject(holds.screen.path)) return undefined; // needs a subject the route lacks
  // The page IS the screen the column holds (the ferret list on /ferrets): draw it once, in the page, not again beside it.
  if (
    !overlay &&
    holds.kind === 'screen' &&
    route.kind === 'screen' &&
    route.screen.plugin === holds.screen.plugin &&
    route.screen.id === holds.screen.id
  )
    return undefined;
  return holds;
}

export function SideBody({ daemon, holds }: { readonly daemon: string; readonly holds: SideHolds }) {
  return (
    <>
      {holds.kind === 'screen' ? <ScreenView daemon={daemon} screen={holds.screen} params={{}} /> : null}
      {/* The side column that holds panels (S4): the `side` slot's panels, for the route's daemon. */}
      {holds.kind === 'panels' ? <PanelSlot daemon={daemon} slot="side" /> : null}
    </>
  );
}

/** The frame's right-hand column. A column the layout puts on the left is the drawer's slot instead. */
export function RightSide({ daemon, route }: { readonly daemon: string | undefined; readonly route: Route }) {
  const { plan } = useShell();
  const holds = useSideHolds(daemon, route);
  if (plan.side.at !== 'right' || holds === undefined || daemon === undefined) return null;
  return (
    <aside className="fy-side fy-side--right" data-slot="side">
      <SideBody daemon={daemon} holds={holds} />
    </aside>
  );
}
