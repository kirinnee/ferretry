/** WHAT THE BOARD'S CARD DETAIL AND "+ CARD" FORM NEED FROM A MACHINE: say something to a ferret, start one. */

import type { IFyApiClient } from '@ferretry/protocol';
import type { NewCardPorts } from '../features/board/detail/board-new-card.tsx';
import type { DaemonConnection } from './daemon-connection.ts';

export type BoardClientFor = (daemon: DaemonConnection) => Promise<Pick<IFyApiClient, 'send' | 'start'>>;

export const boardPorts = (clientFor: BoardClientFor): NewCardPorts => ({
  sendMessage: async (daemon, sessionId, message) => {
    await (await clientFor(daemon)).send(sessionId, { message });
  },
  startFerret: async (daemon, prompt) => (await (await clientFor(daemon)).start({ mode: 'auto', prompt })).config.id,
});
