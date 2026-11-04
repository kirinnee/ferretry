/**
 * WHAT THE AGENDA'S CARDS TO TRY AND THE SEND-BACK COMPOSER NEED FROM A MACHINE: send pictures with a move back.
 * (The Board and its card detail are read-only and need nothing from a machine but reads.)
 */

import { DAEMON_FEATURES, hasFeature, type IFyApiClient } from '@ferretry/protocol';
import type { SendBackPorts } from '../features/board/board-send-back.tsx';
import { uploadAttachment } from './attachment-upload.ts';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonSessionScope } from './daemon-scope.ts';
import type { DaemonFetch } from './runtime-models.ts';

export type BoardClientFor = (daemon: DaemonConnection) => Promise<Pick<IFyApiClient, 'health'>>;

/**
 * `fetcher` is the carrier the machine's traffic rides (`useDaemonFetch`). A paired device holds no bearer value, so
 * an upload through the raw network reaches the daemon as nobody and is refused "unauthorized"; it is required so
 * that default cannot come back.
 */
export const boardPorts = (
  clientFor: BoardClientFor,
  fetcher: DaemonFetch,
  upload: typeof uploadAttachment = uploadAttachment,
): Required<SendBackPorts> => ({
  // The app ships before the daemon: only a machine that lists the feature takes files with a move back.
  sendBackFiles: async daemon =>
    hasFeature(await (await clientFor(daemon)).health(), DAEMON_FEATURES.boardReopenAttachments),
  answerFiles: async daemon =>
    hasFeature(await (await clientFor(daemon)).health(), DAEMON_FEATURES.agendaGateAttachments),
  uploadAttachment: async (daemon, sessionId, file) =>
    await upload(daemon, daemonSessionScope(daemon, sessionId), file, fetcher),
});
