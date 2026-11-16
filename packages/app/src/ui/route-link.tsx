/**
 * The in-app navigation anchor. Ported from kteam `ui/src/lib/router.tsx`'s
 * `Link`, with one deliberate change and one refinement kept verbatim.
 *
 * CHANGED — it does not touch `history` itself. kteam's Link called
 * `history.pushState` and dispatched a synthetic `popstate` from inside the
 * component, which made every feature screen depend on one ambient global
 * router. Here the destination is a plain pathname and the navigation effect
 * arrives as `onNavigate`, so a screen can be rendered, tested and screenshotted
 * without a document, and so a host that keeps several paired daemons on one
 * origin decides for itself what "navigate" means.
 *
 * KEPT — the modifier-key escape hatch. A ctrl/cmd/shift/alt click, or any
 * non-primary button, falls through to the browser untouched, so "open in a new
 * tab" and "open in a new window" keep working on every in-app link. This is
 * exactly why the anchor stays a real `<a href>` rather than a button.
 */

import type { AnchorHTMLAttributes, MouseEvent, Ref } from 'react';

export interface RouteLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** The canonical in-app pathname, built by `lib/pages/routes.ts`. */
  readonly to: string;
  /** Invoked for a plain primary click only; the default action is prevented. */
  readonly onNavigate?: (to: string) => void;
  readonly ref?: Ref<HTMLAnchorElement>;
}

export function RouteLink({ to, onNavigate, onClick, ...rest }: RouteLinkProps) {
  return (
    <a
      href={to}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        onNavigate?.(to);
        onClick?.(event);
      }}
      {...rest}
    />
  );
}
