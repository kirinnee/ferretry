/**
 * WHERE THE BOARD LIVES in the app: the paths of this plugin's own screens (`/board/:project?`, `/card/:id`) and the
 * few other screens a card links to. The shell prefixes the daemon; a path here is the part a plugin owns.
 */
import type { DaemonId } from './machine.ts';

/** The board; a card id after it opens the card as a drawer on the board (`/board/F12`). */
export const boardPath = (_daemonId?: DaemonId): string => '/board';
export const boardCardPath = (_daemonId: DaemonId | undefined, cardId: string): string =>
  `/board/${encodeURIComponent(cardId)}`;
/** One card on its own page. */
export const cardPagePath = (cardId: string): string => `/card/${encodeURIComponent(cardId)}`;
/** A ferret's chat, owned by Conversation. */
export const ferretPath = (_daemonId: DaemonId | undefined, ferret: string): string =>
  `/ferrets/${encodeURIComponent(ferret)}`;
/** A project's lanes, owned by Projects. */
export const projectLanesPath = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}/lanes`;
