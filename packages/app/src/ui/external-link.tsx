/**
 * THE ONE EXTERNAL LINK. Every link to the outside world the app draws — chat Markdown, a media block's Open, the
 * map's attribution — is an `ExternalLink`, and an agent's html fragment routes its anchors through the same
 * `useLinkBehaviour`, so a tap is decided in ONE place.
 *
 * The anchor is always a real `<a href target="_blank" rel="noopener noreferrer">`: a modified click, a middle click
 * and a long press stay the browser's own new tab. Ferretry references (`%browser:`, `@file`, `:agent`, …) are NOT
 * external links: they go through the reference standard and never reach here.
 *
 * GAP(browsers): today's "Open links in" setting (the in-app browser pane or sheet, the iOS hand-off, this computer's
 * browser) is the Browsers plugin's app half. Until it provides the behaviour, every link keeps the shipped default,
 * which is the reader's own browser: `activate` leaves the click to the anchor and `sheet` draws nothing.
 */

import type { AnchorHTMLAttributes, MouseEvent as ReactMouseEvent, ReactNode } from 'react';

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

const NATIVE: LinkBehaviour = {
  activate: () => false,
  open: (_click, target) => {
    globalThis.open?.(target.href, '_blank', 'noopener,noreferrer');
  },
  sheet: null,
};

export function useLinkBehaviour(): LinkBehaviour {
  return NATIVE;
}

export type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> & {
  readonly href: string | undefined;
};

/** An external link: a real anchor that opens in a new tab. */
export function ExternalLink({ href, onClick, download, children, ...rest }: ExternalLinkProps) {
  const links = useLinkBehaviour();
  const click = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    links.activate(event, { href, download, element: event.currentTarget });
  };
  return (
    <>
      <a {...rest} download={download} href={href} onClick={click} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
      {links.sheet}
    </>
  );
}
