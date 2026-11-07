import { daemonHomeHref } from '@ferretry/app';

/** Conversation's `links` screen (its manifest's `screen('links', { path: 'links' })`): where `fy link` is drawn (V-0285). */
export const CONVERSATIONS_PATH = 'links';

/** The links screen of `daemon` (a per-daemon screen, so under `/d/<daemon>/`); outside a daemon's pages, the bare path. */
export const conversationsHref = (daemon: string | null): string =>
  daemon === null ? `/${CONVERSATIONS_PATH}` : `${daemonHomeHref(daemon)}/${CONVERSATIONS_PATH}`;
