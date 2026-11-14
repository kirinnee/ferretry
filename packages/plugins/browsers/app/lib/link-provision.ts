/**
 * `shell.links`, PROVIDED (shell contract S7): where a tap on an external link opens is Browsers' to say. Built PER
 * DAEMON over that daemon's own client, so a link drawn in machine B's view is labelled and opened for B — which is the
 * only thing "per machine" means here: the choice itself is the one this device made (`openLinksIn`, Settings › This
 * device › Open links in), read at the moment of the tap through the shell's controls, never held.
 *
 *   browser   the anchor's own new tab (a real `<a target="_blank">`), or the real Safari from the installed iOS app;
 *   panel     the in-app preview, a sheet drawn once per machine by the frame (`sheet`);
 *   computer  this computer's default browser, asked of THIS machine's daemon (`POST /v1/system/open-url`, which only a
 *             caller on the host may make). A daemon that is elsewhere refuses; the link then opens in a new tab and the
 *             page says why, so a tap always opens somewhere and never silently somewhere else.
 *
 * The decision is `decideLinkAction` (`link-behaviour-model.ts`); this file only carries it out.
 */

import { deviceControls, type OpenLinksIn, type ShellProvides } from '@ferretry/app';
import { createElement, type ReactNode } from 'react';
import { InAppBrowserSheet } from '../features/browser/in-app-browser.tsx';
import { type BrowserActivation, browserDestination } from '../features/browser/in-app-browser-model.ts';
import { decideLinkAction, isIosStandalone } from './link-behaviour-model.ts';
import { LinkSheetHost, LinkSheetStore } from './link-sheet-host.tsx';

type LinkProvision = ReturnType<NonNullable<ShellProvides['links']>>;
type Activate = LinkProvision['activate'];

/** How long the iOS hand-off has to take the reader to Safari before a plain new tab is opened instead. */
export const SAFARI_HANDOFF_MS = 500;

/** What a refused hand-off says: the link opened here instead, and why. */
export const COMPUTER_REFUSED_WORDS =
  "That link could not open on this computer — this machine's daemon is not on it. It opened in this browser instead.";

/** The browser, as a link needs it: a port, so a test proves the iOS hand-off without touching `window`. */
export interface LinkOpener {
  /** The installed app on iOS or iPadOS, read at the moment of the tap. */
  readonly iosStandalone: () => boolean;
  /** Navigate to an address the operating system opens (`x-safari-https://…`). */
  readonly handOff: (href: string) => void;
  /** Open an address in a new browser tab. */
  readonly openTab: (href: string) => void;
  /** Run `then` after `ms` unless the page was hidden or lost focus first — what a hand-off that worked looks like. */
  readonly unlessLeft: (ms: number, then: () => void) => () => void;
}

/** The real browser's `LinkOpener`. Every read is guarded: a missing API is "not standalone". */
const browserLinkOpener = (win: Window = window): LinkOpener => ({
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

/** The click as the decision reads it: a real mouse event has every field, anything less is a plain primary tap. */
const activationOf = (click: Parameters<Activate>[0]): BrowserActivation => {
  const fields = click as Partial<BrowserActivation>;
  return {
    defaultPrevented: click.defaultPrevented,
    button: fields.button ?? 0,
    metaKey: fields.metaKey ?? false,
    ctrlKey: fields.ctrlKey ?? false,
    shiftKey: fields.shiftKey ?? false,
    altKey: fields.altKey ?? false,
  };
};

/** What a provision is built from; a test hands its own. */
export interface LinkProvisionPorts {
  /** This device's choice, read at the moment of the tap. */
  readonly setting: () => OpenLinksIn;
  readonly opener: LinkOpener;
  /** Asks this machine's daemon to open an address on its computer; rejects when it will not. */
  readonly openOnComputer: (href: string) => Promise<void>;
}

/** The provision for one machine over its ports. */
export function createLinkProvision(ports: LinkProvisionPorts, store: LinkSheetStore): LinkProvision {
  const activate: Activate = (click, target) => {
    const action = decideLinkAction({
      setting: ports.setting(),
      activation: activationOf(click),
      href: target.href,
      baseHref: target.element.ownerDocument.baseURI,
      ...(target.download === undefined ? {} : { download: target.download }),
      iosStandalone: ports.setting() !== 'panel' && ports.opener.iosStandalone(),
    });
    if (action.kind === 'native') return false;
    click.preventDefault();
    if (action.kind === 'panel') {
      store.open(action.destination);
      return true;
    }
    if (action.kind === 'computer') {
      ports.openOnComputer(action.href).catch(() => {
        ports.opener.openTab(action.href);
        store.say(COMPUTER_REFUSED_WORDS);
      });
      return true;
    }
    ports.opener.handOff(action.href);
    ports.opener.unlessLeft(SAFARI_HANDOFF_MS, () => ports.opener.openTab(action.fallback));
    return true;
  };
  const sheet: ReactNode = createElement(LinkSheetHost, { store, Sheet: InAppBrowserSheet });
  return {
    activate,
    open: (click, target) => {
      if (activate(click, target)) return;
      if (!click.defaultPrevented) ports.opener.openTab(target.href);
    },
    sheet,
    destination: href => {
      const setting = ports.setting();
      if (browserDestination(href) === null) return 'this-device-browser';
      return setting === 'panel' ? 'in-app' : setting === 'computer' ? 'computer' : 'this-device-browser';
    },
    anchor: href =>
      ports.setting() === 'panel' && browserDestination(href) !== null ? { popup: 'dialog' as const } : {},
  };
}

/** The live provision for one machine: the real browser, this device's controls, and the machine's own client. */
export const linkProvisionFor = ({ client }: Parameters<NonNullable<ShellProvides['links']>>[0]): LinkProvision =>
  createLinkProvision(
    {
      setting: () => deviceControls().snapshot().device.openLinksIn,
      opener: browserLinkOpener(),
      openOnComputer: async href => {
        await client.call('POST /v1/system/open-url', { body: { url: href } });
      },
    },
    new LinkSheetStore(),
  );
