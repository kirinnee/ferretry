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

export type BoardClientFor = (daemon: DaemonConnection) => Promise<Pick<IFyApiClient, 'send' | 'start' | 'health'>>;

export const boardPorts = (
  clientFor: BoardClientFor,
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
    await upload(daemon, daemonSessionScope(daemon, sessionId), file),
});
