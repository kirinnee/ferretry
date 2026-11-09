/**
 * THE ONE EXTERNAL LINK. Every link to the outside world the app draws — chat Markdown, a media block's Open, the
 * map's attribution — is an `ExternalLink`, and an agent's html fragment routes its anchors through the same
 * `useLinkBehaviour`, so a tap is decided in ONE place.
 *
 * The anchor is always a real `<a href target="_blank" rel="noopener noreferrer">`: a modified click, a middle click
 * and a long press stay the browser's own new tab. Ferretry references (`%browser:`, `@file`, `:agent`, …) are NOT
 * external links: they go through the reference standard and never reach here.
 *
 * WHERE A LINK OPENS (shell contract S7) is the Browsers plugin's to say — its "Open links in" setting (the in-app
 * browser pane or sheet, the iOS hand-off, this computer's browser) — and it says it PER MACHINE: Browsers provides
 * `shell.links` (`LINK_TAKERS`), built per daemon, and a link drawn in machine B's view is labelled and opened for B.
 * Without a provider, or on a daemon-less screen (no machine), every link keeps the shipped default, which is this
 * device's own browser: `activate` leaves the click to the anchor and `sheet` draws nothing. A provided `sheet` is drawn
 * once per machine by the frame (`shell/background.tsx`), not by each link.
 */

import type { AnchorHTMLAttributes, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';
import { useOptionalShell } from '../shell/context.tsx';
import { useViewPlace } from '../shell/view-place.tsx';

/** One click, as the handler reads it. */
interface LinkClick {
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

interface LinkTarget {
  readonly href: string | undefined;
  readonly download?: string | boolean | undefined;
  /** The element tapped. */
  readonly element: HTMLElement;
}

export interface LinkBehaviour {
  /** Applies the setting to one click. True when it handled the click, which is then default-prevented. */
  readonly activate: (click: LinkClick, target: LinkTarget) => boolean;
  /** Opens an address that has no anchor to carry the click: a new browser tab. */
  readonly open: (click: LinkClick, target: { readonly href: string; readonly element: HTMLElement }) => void;
  /** The preview a link with no host opens. Render it once, wherever the hook is used. */
  readonly sheet: ReactNode;
}

/** Where a tap on a link will open, said BEFORE it happens (the anchor's title, the sheet's heading). */
export type LinkDestination = 'in-app' | 'this-device-browser' | 'computer';

/** What Browsers provides for one machine (`ShellProvides.links`): the behaviour, and where a tap on `href` will land. */
export interface LinkProvision extends LinkBehaviour {
  readonly destination: (href: string) => LinkDestination;
  /**
   * The anchor's ARIA when a tap on `href` opens something in the app, as v4 drew it: `popup: 'dialog'` for the sheet,
   * `controls` the id of the pane it opens. Optional: a provider that opens nothing in the app gives none.
   */
  readonly anchor?: (href: string) => { readonly popup?: 'dialog'; readonly controls?: string };
}

/** What a link's reader gets: the behaviour for the machine it is drawn in, and where its tap will open. */
export type ResolvedLinkBehaviour = LinkBehaviour & {
  readonly destination: (href: string) => LinkDestination;
  readonly anchor?: LinkProvision['anchor'];
};

const NATIVE: ResolvedLinkBehaviour = {
  activate: () => false,
  open: (_click, target) => {
    globalThis.open?.(target.href, '_blank', 'noopener,noreferrer');
  },
  sheet: null,
  destination: () => 'this-device-browser',
};

const noSubscription = (): (() => void) => () => {};

/**
 * HOW A TAP ON A LINK IS DECIDED, for the machine the link is drawn in (S7). Daemon-less safe: outside a shell and on a
 * daemon-less screen there is no machine, so it answers the native default and says "this device's browser". The `sheet`
 * it returns is always empty — the frame draws a provided one once per machine.
 */
export function useLinkBehaviour(): ResolvedLinkBehaviour {
  const runtime = useOptionalShell()?.runtime;
  const daemon = useViewPlace()?.daemon;
  const read = () => (runtime === undefined || daemon === undefined ? undefined : runtime.linkProvision(daemon));
  const provided = useSyncExternalStore(runtime?.subscribe ?? noSubscription, read, read);
  return useMemo(() => (provided === undefined ? NATIVE : { ...provided, sheet: null }), [provided]);
}

/** The sentence a link carries for where its tap lands, for the machine it is drawn in. */
export function destinationWords(destination: LinkDestination, machine: string | undefined): string {
  switch (destination) {
    case 'in-app':
      return machine === undefined ? 'Opens in the in-app browser' : `Opens in the in-app browser on ${machine}`;
    case 'computer':
      return 'Opens in the browser on your computer';
    case 'this-device-browser':
      return "Opens in this device's browser";
  }
}

export type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> & {
  readonly href: string | undefined;
};

/** An external link: a real anchor that opens in a new tab. */
export function ExternalLink({ href, onClick, download, children, title, ...rest }: ExternalLinkProps) {
  const links = useLinkBehaviour();
  const machine = useViewPlace()?.machine;
  // Where the tap will open, said before it happens, for THIS machine — only when Browsers provides the behaviour: a
  // native link keeps v4's bare anchor (no tooltip). A title the caller gave is kept and the words follow.
  const where = href === undefined || links === NATIVE ? undefined : destinationWords(links.destination(href), machine);
  const anchor = href === undefined ? undefined : links.anchor?.(href);
  const click = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    links.activate(event, { href, download, element: event.currentTarget });
  };
  return (
    <>
      <a
        {...rest}
        aria-controls={anchor?.controls}
        aria-description={where}
        aria-haspopup={anchor?.popup}
        download={download}
        href={href}
        onClick={click}
        rel="noopener noreferrer"
        target="_blank"
        title={title ?? where}
      >
        {children}
      </a>
      {links.sheet}
    </>
  );
}
