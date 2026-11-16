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

/** `/d/<daemon>` for the named machine, else for the one the address bar is under. */
const daemonAddress = (daemon: string | undefined): string =>
  daemon === undefined ? daemonPrefix() : `/d/${encodeURIComponent(daemon)}`;

/** The board; a card id after it opens the card as a drawer on the board (`/d/<daemon>/board/F12`). */
export const boardPath = (_daemonId?: DaemonId, daemon?: string): string => `${daemonAddress(daemon)}/board`;
export const boardCardPath = (_daemonId: DaemonId | undefined, cardId: string): string =>
  `${daemonPrefix()}/board/${encodeURIComponent(cardId)}`;
/**
 * One card on its own page. `daemon` names the machine the link is for (an app hook is built for one daemon); without
 * it the page is under the daemon the address bar is under.
 */
export const cardPagePath = (cardId: string, daemon?: string): string =>
  `${daemonAddress(daemon)}/card/${encodeURIComponent(cardId)}`;
/** A ferret's chat, owned by Conversation (`ferrets/:ferret/chat`). */
export const ferretPath = (_daemonId: DaemonId | undefined, ferret: string): string =>
  `${daemonPrefix()}/ferrets/${encodeURIComponent(ferret)}/chat`;
/** A project's lanes, edited on this plugin's own board screen (`/d/<daemon>/board/<project>?lanes=1`). */
export const projectLanesPath = (projectId: string, daemon?: string): string =>
  `${daemonAddress(daemon)}/board/${encodeURIComponent(projectId)}?lanes=1`;
/** One ask in the Agenda, opened at its ferret's agenda (`agenda/:ferret/:ask`, the screen a buzz lands on). */
export const agendaAskPath = (ferret: string, ask: string, daemon?: string): string =>
  `${daemonAddress(daemon)}/agenda/${encodeURIComponent(ferret)}/${encodeURIComponent(ask)}`;
