import type { BoardReopenAttachments } from '@ferretry/protocol';
import type { ReopenDelivery, ReopenMessenger } from '../../lib/board/index.ts';
import { NO_SUB_FERRETS, nudgeTarget, type SubFerretDirectory } from '../../lib/sub-ferret/index.ts';
import type { SessionSendService } from '../../lib/session/send/service.ts';
import { SendUnconfirmed } from '../../lib/session/send/types.ts';
import { tryParseSessionId } from '../../lib/session-id.ts';
import type { ReopenAttachmentCarrier } from './board-attachments.ts';

/** The sentence a ferret reads when the owner's files could not be copied to it: the reopen itself still lands. */
export const uncarriedFilesLine = (count: number): string =>
  `The owner also attached ${count === 1 ? 'a file' : `${count} files`} that could not be copied to this chat.`;

/**
 * A reopen's line through the ORDINARY send path, as an owner message (no `from`): the send service types
 * it into a live ferret or queues it behind its turn, revives a stopped or finished one with it as its
 * turn, and holds it for an explicit revive when the relaunch is refused. Its disposition is read back as
 * which of those happened, so the ladder knows whether to try the card's owner too. A sub-ferret is never the
 * recipient: its lead is (docs/pack-mode.md § Sub-ferret limits).
 *
 * Files the owner attached go as the send's attachments, so the ferret gets them the way it gets a chat's: the
 * carrier first copies them into the recipient's own session. A file that cannot be carried does not stop the
 * reopen — the ferret is told in a plain sentence that there were files it did not get.
 */
export class SendReopenMessenger implements ReopenMessenger {
  constructor(
    private readonly sends: Pick<SessionSendService, 'send'>,
    private readonly subFerrets: SubFerretDirectory = NO_SUB_FERRETS,
    private readonly carrier?: ReopenAttachmentCarrier,
  ) {}

  async deliver(
    sessionId: string,
    message: string,
    key: string,
    attachments?: BoardReopenAttachments,
  ): Promise<ReopenDelivery> {
    const id = tryParseSessionId(await nudgeTarget(this.subFerrets, sessionId));
    if (id === undefined) return 'absent';
    const files = attachments === undefined ? null : await this.carry(attachments, id);
    try {
      const outcome = await this.sends.send({
        id,
        sendId: key,
        message: files === null || files.ok ? message : `${message}\n\n${uncarriedFilesLine(files.count)}`,
        ...(files?.ok === true ? { attachmentIds: files.ids } : {}),
      });
      if (outcome.disposition === 'revived') return 'resumed';
      if (outcome.disposition === 'queued-for-revive') return 'held';
      return 'delivered';
    } catch (error) {
      // Typed, and not yet proven to have landed: its receipt decides, and nothing would type it twice.
      if (error instanceof SendUnconfirmed) return 'delivered';
      return 'absent';
    }
  }

  private async carry(
    attachments: BoardReopenAttachments,
    to: string,
  ): Promise<{ readonly ok: true; readonly ids: readonly string[] } | { readonly ok: false; readonly count: number }> {
    if (attachments.from === to) return { ok: true, ids: attachments.ids };
    if (this.carrier === undefined) return { ok: false, count: attachments.ids.length };
    return await this.carrier.carry(attachments.from, to, attachments.ids).then(
      ids => ({ ok: true as const, ids }),
      () => ({ ok: false as const, count: attachments.ids.length }),
    );
  }
}
