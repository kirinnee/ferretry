/**
 * THE ONE EXTERNAL LINK. Every link to the outside world the app draws — chat Markdown, a task's PR
 * chip, a file's Open, a media block's Open, the map's attribution — is an `ExternalLink`, and an
 * agent's html fragment routes its anchors through the same `useLinkBehaviour`. So Settings ›
 * Appearance › "Open links in" means one thing everywhere, and a tap is decided by ONE function
 * (`decideLinkAction`, `link-behaviour-model.ts`).
 *
 * The anchor is always a real `<a href target="_blank" rel="noopener noreferrer">`: whatever the
 * setting, a modified click, a middle click and a long press stay the browser's own new tab, and the
 * handler only ever takes an ordinary primary tap. Ferretry references (`%browser:`, `@file`,
 * `:agent`, …) are NOT external links: they go through the reference standard and never reach here.
 *
 * The setting arrives through `LinkBehaviourProvider` (the app root binds it to the device controls);
 * without one, links open in the reader's browser, which is the shipped default. The browser itself
 * is a port (`LinkOpener`), so a test proves the iOS hand-off without touching `window`.
 */

import {
  type AnchorHTMLAttributes,
  createContext,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { OpenLinksIn } from '../../lib/controls.ts';
import { InAppBrowserContext, type InAppBrowserHost, InAppBrowserSheet } from './in-app-browser.tsx';
import { type BrowserActivation, type BrowserDestination, browserDestination } from './in-app-browser-model.ts';
import { decideLinkAction, isIosStandalone } from './link-behaviour-model.ts';
import type { ComputerLinkPort } from './local-computer.ts';

/** How long the iOS hand-off has to take the reader to Safari before a plain new tab is opened instead. */
export const SAFARI_HANDOFF_MS = 500;

/** The browser, as a link needs it. */
export interface LinkOpener {
  /** The installed app on iOS or iPadOS, read at the moment of the tap. */
  readonly iosStandalone: () => boolean;
  /** Navigate to an address the operating system opens (`x-safari-https://…`). */
  readonly handOff: (href: string) => void;
  /** Open an address in a new browser tab. */
  readonly openTab: (href: string) => void;
  /**
   * Run `then` after `ms`, unless the page was hidden or lost focus first — which is what a hand-off
   * that worked looks like from inside the page. Answers a cancel.
   */
  readonly unlessLeft: (ms: number, then: () => void) => () => void;
}

/** The real browser's `LinkOpener`. Every read is guarded: a missing API is "not standalone". */
export const browserLinkOpener = (win: Window = window): LinkOpener => ({
  iosStandalone: () => {
    try {
      const navigator = win.navigator as Navigator & { readonly standalone?: boolean };
      return isIosStandalone({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints ?? 0,
        ...(typeof navigator.standalone === 'boolean' ? { navigatorStandalone: navigator.standalone } : {}),
        standaloneDisplay: win.matchMedia?.('(display-mode: standalone)').matches === true,
      });
    } catch {
      return false;
    }
  },
  handOff: href => win.location.assign(href),
  openTab: href => {
    win.open(href, '_blank', 'noopener,noreferrer');
  },
  unlessLeft: (ms, then) => {
    const document = win.document;
    let left = false;
    const leave = (): void => {
      left = true;
    };
    const visibility = (): void => {
      if (document.visibilityState === 'hidden') left = true;
    };
    const cancel = (): void => {
      win.clearTimeout(timer);
      win.removeEventListener('blur', leave);
      win.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', visibility);
    };
    win.addEventListener('blur', leave);
    win.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', visibility);
    const timer = win.setTimeout(() => {
      cancel();
      if (!left && document.visibilityState !== 'hidden') then();
    }, ms);
    return cancel;
  },
});

interface LinkBehaviourSettings {
  readonly openLinksIn: OpenLinksIn;
  /** Hands a link to this computer's own browser; absent when no daemon on this computer is connected. */
  readonly computer?: ComputerLinkPort;
  /** Absent: the real browser. */
  readonly opener?: LinkOpener;
}

const LinkBehaviourContext = createContext<LinkBehaviourSettings>({ openLinksIn: 'browser' });

export interface LinkBehaviourProviderProps {
  readonly openLinksIn: OpenLinksIn;
  readonly computer?: ComputerLinkPort;
  readonly opener?: LinkOpener;
  readonly children: ReactNode;
}

export function LinkBehaviourProvider({ openLinksIn, opener, computer, children }: LinkBehaviourProviderProps) {
  const value = useMemo<LinkBehaviourSettings>(
    () => ({
      openLinksIn,
      ...(opener === undefined ? {} : { opener }),
      ...(computer === undefined ? {} : { computer }),
    }),
    [openLinksIn, opener, computer],
  );
  return <LinkBehaviourContext.Provider value={value}>{children}</LinkBehaviourContext.Provider>;
}

/** One click, as the handler reads it: a React or a DOM mouse event both qualify. */
type LinkClick = BrowserActivation & { preventDefault(): void };

interface LinkTarget {
  readonly href: string | undefined;
  readonly download?: string | boolean;
  /** The element tapped: focus returns here when the preview closes, and relative hrefs resolve from it. */
  readonly element: HTMLElement;
}

export interface LinkBehaviour {
  readonly openLinksIn: OpenLinksIn;
  /** The in-app browser host around this link, if any — a pane beside the chat or a sheet. */
  readonly host: InAppBrowserHost | null;
  /** Applies the setting to one click. True when it handled the click, which is then default-prevented. */
  readonly activate: (click: LinkClick, target: LinkTarget) => boolean;
  /** The preview sheet a link with no host opens. Render it once, wherever the hook is used. */
  readonly sheet: ReactNode;
}

export function useLinkBehaviour(): LinkBehaviour {
  const { openLinksIn, opener, computer } = useContext(LinkBehaviourContext);
  const host = useContext(InAppBrowserContext);
  const [preview, setPreview] = useState<{ readonly destination: BrowserDestination; readonly open: boolean } | null>(
    null,
  );

  const activate = useCallback(
    (click: LinkClick, target: LinkTarget): boolean => {
      const browser = opener ?? browserLinkOpener();
      const action = decideLinkAction({
        setting: openLinksIn,
        activation: click,
        href: target.href,
        baseHref: target.element.ownerDocument.baseURI,
        ...(target.download === undefined ? {} : { download: target.download }),
        iosStandalone: openLinksIn !== 'panel' && browser.iosStandalone(),
        computerAvailable: computer !== undefined,
      });
      if (action.kind === 'native') return false;
      click.preventDefault();
      if (action.kind === 'panel') {
        if (host === null) setPreview({ destination: action.destination, open: true });
        else host.openDestination(action.destination, target.element);
        return true;
      }
      if (action.kind === 'computer') {
        handOffToComputer(computer, browser, action.href);
        return true;
      }
      browser.handOff(action.href);
      browser.unlessLeft(SAFARI_HANDOFF_MS, () => browser.openTab(action.fallback));
      return true;
    },
    [computer, host, openLinksIn, opener],
  );

  const sheet =
    host === null && preview !== null && typeof document !== 'undefined'
      ? createPortal(
          <InAppBrowserSheet
            destination={preview.destination}
            open={preview.open}
            onClose={() => setPreview(current => (current === null ? null : { ...current, open: false }))}
          />,
          document.body,
        )
      : null;

  return { openLinksIn, host, activate, sheet };
}

export type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'> & {
  readonly href: string | undefined;
};

/** An external link that opens where Settings › Appearance › "Open links in" says. */
export function ExternalLink({ href, onClick, download, children, ...rest }: ExternalLinkProps) {
  const links = useLinkBehaviour();
  // The preview is announced as what it is: a dialog on a phone, a pane beside the chat on a desktop.
  const previews = links.openLinksIn === 'panel' && browserDestination(href, documentBase()) !== null;
  const popup = previews && links.host?.presentation !== 'pane' ? 'dialog' : rest['aria-haspopup'];
  const controls = previews && links.host?.presentation === 'pane' ? links.host.paneId : rest['aria-controls'];

  const click = (event: ReactMouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    links.activate(event, { href, download, element: event.currentTarget });
  };

  return (
    <>
      <a
        {...rest}
        aria-controls={controls}
        aria-haspopup={popup}
        download={download}
        href={href}
        onClick={click}
        rel="noopener noreferrer"
        target="_blank"
      >
        {children}
      </a>
      {links.sheet}
    </>
  );
}

const documentBase = (): string | undefined => (typeof document === 'undefined' ? undefined : document.baseURI);

/**
 * Gives one address to this computer's browser through the daemon, and opens an ordinary new tab if
 * that goes wrong for ANY reason — refused, offline, rate limited, not actually local. The reader asked
 * for a link to open, and a failed convenience must not be the reason it does not. The reason goes to
 * the debug console; the address never does, because a link routinely carries a token in its query.
 */
const handOffToComputer = (computer: ComputerLinkPort | undefined, browser: LinkOpener, href: string): void => {
  if (computer === undefined) {
    browser.openTab(href);
    return;
  }
  computer(href).catch((error: unknown) => {
    console.debug('[links] the daemon could not open the link on this computer; opening a tab instead', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    browser.openTab(href);
  });
};
