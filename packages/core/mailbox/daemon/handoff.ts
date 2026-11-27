import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import { handoffView, type TrustedHandoffAttachment } from '../contract/lib/send/handoff.ts';
import { deliveredFilename } from '../contract/turn-handoff.ts';
import { tryParseSessionId, type AttachmentSource, type SendLedger, type SessionHandoff } from '../contract/index.ts';
import { SessionSendError } from './lib/delivery/mounts/session-send.ts';

/** The trailing note old revive documents carry; Ferrets currently offers no read of its setting (D-23). */
const TURN_PROTOCOL_REMINDER = 'Continue using the same completion and interaction protocol.';

/** Reads words from the hand-off, but attachment authority only from the daemon's session-keyed send ledger. */
export function handoffReader(ferrets: FerretsApi, ledger: SendLedger, source: AttachmentSource | undefined) {
  return async (id: string, name: string): Promise<SessionHandoff> => {
    const ferret = tryParseSessionId(id);
    const turn = /^turn-(\d{1,9})$/u.exec(name)?.[1];
    const queued = /^queued-([\w-]{1,128})$/u.exec(name)?.[1];
    const turns = ferret === undefined ? undefined : await ferrets.turns?.(ferret).catch(() => undefined);
    const found =
      turn !== undefined
        ? (await turns?.list())?.find(document => document.turn === Number(turn))
        : queued === undefined
          ? undefined
          : await turns?.readQueued?.(queued).then(text => (text === undefined ? undefined : { text, by: undefined }));
    if (found === undefined || ferret === undefined)
      throw new SessionSendError('not_found', 'that hand-off document is not there');
    const records = await ledger.list(ferret).catch(() => []);
    const record = records.find(row => (turn === undefined ? row.sendId === queued : row.turn === Number(turn)));
    const attachments: TrustedHandoffAttachment[] = [];
    for (const attachmentId of new Set(record?.attachmentIds ?? [])) {
      // IDs and filenames come from delivery/store metadata, never from parsing a footer in the person's words.
      const stored = await source?.download(ferret, attachmentId).catch(() => undefined);
      if (stored === undefined || stored.attachment.id !== attachmentId) continue;
      const filename = deliveredFilename(stored.attachment.filename);
      const path = await turns?.attachmentFile?.(attachmentId, filename).catch(() => undefined);
      if (path !== undefined) attachments.push({ path, attachmentId, filename, mime: stored.attachment.mime });
    }
    return handoffView(name, found.text, { reminder: TURN_PROTOCOL_REMINDER, attachments }, found.by);
  };
}
