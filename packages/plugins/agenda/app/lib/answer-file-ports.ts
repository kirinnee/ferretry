/**
 * HOW A "NOT GOOD" TAKES FILES: the two ports the Agenda page's answer box reads (`AnswerFilePorts`), made over the
 * clients this half already holds. A card may be another machine's (the Inbox lists every machine), so both go through
 * the client of THE CARD'S machine: the page's own for its machine, the fleet's for any other.
 *
 * The upload is Conversation's route, by its route key, exactly as its composer calls it (`POST
 * /v1/ferrets/:ferretId/attachments`, the bytes inline as base64): the daemon carries the file into the ferret the card
 * belongs to, and its own `AttachmentView` names the id the answer then carries. The answer is parsed against
 * Conversation's contract before its id is trusted. Whether a file's type is accepted is the daemon's say, not this
 * half's: a refusal reaches the box as a file that never attached.
 */

import { AttachmentViewSchema } from '@ferretry/plugin-conversation/contract';
import { type AgendaCall, agendaCall } from './agenda-call.ts';
import type { AgendaFleet } from './agenda-fleet.ts';
import type { DaemonConnection, DaemonId } from './machine.ts';

/** Conversation's route for putting one file into a ferret. */
const ATTACHMENTS_ROUTE = 'POST /v1/ferrets/:ferretId/attachments';

/**
 * How a page takes files with a "Not good" (a picture of what went wrong): whether the card's machine takes them with
 * an answer, and the upload into the item's own conversation (the daemon carries them to the card's ferret). A host
 * that can upload hands these in; absent either, the box is words alone.
 */
export interface AnswerFilePorts {
  /** Whether this machine takes files with an answer: it is one this device holds a client for. */
  readonly answerFiles?: ((daemon: DaemonConnection) => Promise<boolean>) | undefined;
  /** Puts one file into the ferret's attachments on the machine, and names the id the answer carries. */
  readonly uploadAttachment?:
    | ((daemon: DaemonConnection, sessionId: string, file: File) => Promise<{ readonly id: string }>)
    | undefined;
}

/** Bytes to base64 in bounded chunks: a spread of a 20 MiB array would overflow the call stack. */
const base64Of = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
};

export const answerFilePorts = (
  page: { readonly daemon: DaemonId; readonly client: AgendaCall },
  fleet?: AgendaFleet,
): Required<AnswerFilePorts> => {
  const clientOf = (daemon: DaemonConnection): AgendaCall | undefined =>
    daemon.daemonId === page.daemon ? page.client : fleet?.clientOf(daemon.daemonId);
  return {
    // The client guards each route by the daemon's own inventory: a machine that does not serve it refuses the upload,
    // and the box shows that file as never attached. A machine this device holds no client for takes no files.
    answerFiles: async daemon => clientOf(daemon) !== undefined,
    uploadAttachment: async (daemon, sessionId, file) => {
      const client = clientOf(daemon);
      if (client === undefined) throw new Error('This machine is not reachable from this device right now.');
      const body = {
        filename: file.name,
        mime: file.type.trim() === '' ? 'application/octet-stream' : file.type,
        base64: base64Of(new Uint8Array(await file.arrayBuffer())),
      };
      const answer = await agendaCall(client, ATTACHMENTS_ROUTE, { params: { ferretId: sessionId }, body });
      return AttachmentViewSchema.parse(answer);
    },
  };
};
