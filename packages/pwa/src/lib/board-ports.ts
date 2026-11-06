/**
 * WHAT THE AGENDA'S CARDS TO TRY AND THE SEND-BACK COMPOSER NEED FROM A MACHINE: send pictures with a move back.
 * (The Board and its card detail are read-only and need nothing from a machine but reads.)
 */

import type { SendBackPorts } from '../features/board/board-send-back.tsx';
import { uploadAttachment } from './attachment-upload.ts';
import { daemonSessionScope } from './daemon-scope.ts';
import type { DaemonFetch } from './runtime-models.ts';

/**
 * `fetcher` is the carrier the machine's traffic rides (`useDaemonFetch`). A paired device holds no bearer value, so
 * an upload through the raw network reaches the daemon as nobody and is refused "unauthorized"; it is required so
 * that default cannot come back.
 */
export const boardPorts = (
  fetcher: DaemonFetch,
  upload: typeof uploadAttachment = uploadAttachment,
): Required<SendBackPorts> => ({
  uploadAttachment: async (daemon, sessionId, file) =>
    await upload(daemon, daemonSessionScope(daemon, sessionId), file, fetcher),
});
