import { jsonObject } from '../../lib/json.ts';
import { withAutoTitle } from '../../lib/names/auto-title.ts';
import type { SendChannel } from '../../lib/session/send/types.ts';
import type { SessionId } from '../../lib/session-id.ts';
import type { DaemonStorage } from '../storage/session-storage.ts';

type TitleDocuments = Pick<DaemonStorage, 'findSession' | 'readConfig' | 'updateConfig'>;

/**
 * Titles a session from its first owner message, as the message is recorded in its inbox. A teammate's or
 * the daemon's message is not the owner's words, so only an unattributed one counts; a title that cannot
 * be written never fails the send.
 */
export class AutoTitlingSendChannel implements SendChannel {
  constructor(
    private readonly inner: SendChannel,
    private readonly storage: TitleDocuments,
  ) {}

  async recordInbound(id: SessionId, entry: Parameters<SendChannel['recordInbound']>[1]): Promise<void> {
    await this.inner.recordInbound(id, entry);
    if (entry.from !== undefined || entry.reason !== undefined) return;
    await this.title(id, entry.message).catch(() => undefined);
  }

  recordOutbound(id: SessionId, entry: Parameters<SendChannel['recordOutbound']>[1]): Promise<void> {
    return this.inner.recordOutbound(id, entry);
  }

  private async title(id: SessionId, message: string): Promise<void> {
    if (this.storage.findSession(id) === undefined) return;
    const current = jsonObject(await this.storage.readConfig(id)) ?? {};
    if (withAutoTitle(current, 'message', message) === current) return;
    await this.storage.updateConfig(id, latest => withAutoTitle(jsonObject(latest) ?? {}, 'message', message));
  }
}
