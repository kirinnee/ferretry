import { daemonHomeHref } from '@ferretry/app';
import { newFerretContinueHref } from '@ferretry/core-ferrets/contract';

/** Ferrets' New ferret screen (its manifest's `screen('new-ferret', { path: 'new' })`): where past conversations are continued. */
const NEW_FERRET_PATH = 'new';

/**
 * "Import conversations": New ferret of `daemon` with its "Continue a past conversation" section already open (the
 * Conversations page is gone; that list now lives there). Outside a daemon's pages, the bare path.
 */
export const conversationsHref = (daemon: string | null): string =>
  newFerretContinueHref(daemon === null ? `/${NEW_FERRET_PATH}` : `${daemonHomeHref(daemon)}/${NEW_FERRET_PATH}`);
