/**
 * WHERE THE BOARD LIVES in the app: the addresses of this plugin's own screens (`board/:project?`, `card/:id`) and the
 * few other screens a card links to. Those screens are per daemon, so an address is `/d/<daemon>/<screen path>`.
 *
 * This half is built once per daemon and knows its machine only as THIS_MACHINE, a placeholder; the daemon that
 * matters is the one in the address the reader is on (the router's own source of truth), so a builder reads it from
 * there. Outside a daemon's address (a unit test with no document) there is nothing to prefix and the bare path comes
 * back.
 */
import type { DaemonId } from './machine.ts';

const DAEMON_ADDRESS = /^\/d\/([^/]+)(?:\/|$)/;

/** `/d/<daemon>` for the daemon the address bar is under, or '' when it is under none. */
const daemonPrefix = (): string => {
  const pathname = (globalThis as { readonly location?: { readonly pathname?: string } }).location?.pathname ?? '';
  const match = DAEMON_ADDRESS.exec(pathname);
  return match === null ? '' : `/d/${match[1]}`;
};

/** The board; a card id after it opens the card as a drawer on the board (`/d/<daemon>/board/F12`). */
export const boardPath = (_daemonId?: DaemonId): string => `${daemonPrefix()}/board`;
export const boardCardPath = (_daemonId: DaemonId | undefined, cardId: string): string =>
  `${daemonPrefix()}/board/${encodeURIComponent(cardId)}`;
/** One card on its own page. */
export const cardPagePath = (cardId: string): string => `${daemonPrefix()}/card/${encodeURIComponent(cardId)}`;
/** A ferret's chat, owned by Conversation (`ferrets/:ferret/chat`). */
export const ferretPath = (_daemonId: DaemonId | undefined, ferret: string): string =>
  `${daemonPrefix()}/ferrets/${encodeURIComponent(ferret)}/chat`;
/** A project's lanes, edited on this plugin's own board screen (`/d/<daemon>/board/<project>?lanes=1`). */
export const projectLanesPath = (projectId: string): string =>
  `${daemonPrefix()}/board/${encodeURIComponent(projectId)}?lanes=1`;
