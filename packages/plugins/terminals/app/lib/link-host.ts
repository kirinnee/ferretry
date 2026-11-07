/**
 * WHERE A LINK A TERMINAL DRAWS OPENS.
 *
 * Today the one "Open links in" decision (a pane beside the chat, this computer's browser, the reader's own) is a
 * Browsers facility, and a plugin's half may not import another's. So Terminals asks for it through this seam and
 * the shell-side default is the shipped default setting: the reader's browser, in a new tab, with no opener handle.
 * A Browsers facility that offers the setting to halves binds it here.
 */

/** One click, as a link handler reads it: a React or a DOM mouse event both qualify. */
interface LinkClick {
  readonly defaultPrevented?: boolean;
  preventDefault(): void;
}

interface LinkTarget {
  readonly href: string;
  /** The element tapped; relative addresses resolve from it. */
  readonly element: HTMLElement;
}

export interface LinkHost {
  /** Applies the setting to a click on a real anchor. True when it handled the click (which it then prevented). */
  readonly activate: (click: LinkClick, target: LinkTarget) => boolean;
  /** Opens an address that has no anchor to carry the click — a link the emulator draws. */
  readonly open: (click: LinkClick, target: LinkTarget) => void;
}

/**
 * The reader's browser: an anchor already opens its own new tab (so `activate` leaves the click alone), and an
 * anchorless address opens one here — unless something else already took the click.
 */
export const browserLinkHost = (win?: Pick<Window, 'open'>): LinkHost => ({
  activate: () => false,
  open: (click, target) => {
    if (click.defaultPrevented === true) return;
    (win ?? window).open(target.href, '_blank', 'noopener,noreferrer');
  },
});
