/**
 * The shell's in-app link. Ported from kteam `ui/src/lib/router.tsx`.
 *
 * A real `<a href>`, so middle-click, "open in new tab", copy-link and the
 * status-bar preview all keep working; only a plain left-click is taken over
 * and turned into a history push. Modifier and non-primary clicks are left
 * entirely to the browser.
 *
 * kteam pushed history and dispatched `popstate` inline. Here the push is an
 * injected `navigate`, defaulting to the same behaviour: the page host owns
 * routing, and a test can watch navigation without touching real history.
 */

import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from 'react';

/** Programmatic navigation — the same mechanism `Link` uses. */
export const navigate = (to: string): void => {
  history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
};

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly to: string;
  /** Test/host seam for the history push. */
  readonly onNavigate?: (to: string) => void;
}

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { to, onClick, onNavigate = navigate, ...rest },
  ref,
) {
  return (
    <a
      ref={ref}
      href={to}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        onNavigate(to);
        onClick?.(event);
      }}
      {...rest}
    />
  );
});
