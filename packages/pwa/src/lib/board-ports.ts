/**
 * WHAT THE BOARD'S CARD DETAIL, "+ CARD" FORM AND SEND-BACK COMPOSER NEED FROM A MACHINE: say something to a
 * ferret, start one, and send pictures with a move back.
 */

import { DAEMON_FEATURES, hasFeature, type IFyApiClient } from '@ferretry/protocol';
import type { SendBackPorts } from '../features/board/board-send-back.tsx';
import type { NewCardPorts } from '../features/board/detail/board-new-card.tsx';
import { uploadAttachment } from './attachment-upload.ts';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonSessionScope } from './daemon-scope.ts';
import type { DaemonFetch } from './runtime-models.ts';

export type BoardClientFor = (daemon: DaemonConnection) => Promise<Pick<IFyApiClient, 'send' | 'start' | 'health'>>;

/**
 * `fetcher` is the carrier the machine's traffic rides (`useDaemonFetch`). A paired device holds no bearer value, so
 * an upload through the raw network reaches the daemon as nobody and is refused "unauthorized"; it is required so
 * that default cannot come back.
 */
export const boardPorts = (
  clientFor: BoardClientFor,
  fetcher: DaemonFetch,
  upload: typeof uploadAttachment = uploadAttachment,
): NewCardPorts & Required<SendBackPorts> => ({
  sendMessage: async (daemon, sessionId, message) => {
    await (await clientFor(daemon)).send(sessionId, { message });
  },
  startFerret: async (daemon, prompt) => (await (await clientFor(daemon)).start({ mode: 'auto', prompt })).config.id,
  // The app ships before the daemon: only a machine that lists the feature takes files with a move back.
  sendBackFiles: async daemon =>
    hasFeature(await (await clientFor(daemon)).health(), DAEMON_FEATURES.boardReopenAttachments),
  uploadAttachment: async (daemon, sessionId, file) =>
    await upload(daemon, daemonSessionScope(daemon, sessionId), file, fetcher),
});
