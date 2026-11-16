import type { ConversationApi } from '@ferretry/plugin-conversation/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { PassiveChannelPort } from '../lib/lessons.ts';

/**
 * How a ferret's switch reaches it. The switch is kept in Lessons' own state and read at each launch (`launch.parts`),
 * so nothing is written into a launch environment; a RUNNING ferret is told with a queued, non-interrupting message.
 */
export class ConversationPassiveChannel implements PassiveChannelPort {
  constructor(private readonly conversation: Pick<ConversationApi, 'send'>) {}

  async setEnvironment(): Promise<void> {}

  async reinstruct(ferretId: string, message: string): Promise<string> {
    const sent = await this.conversation.send(ferretId as FerretId, { kind: 'owner' }, { message });
    if (!sent.ok) throw new Error(sent.error.message);
    return sent.value.sendId ?? `lessons-${sent.value.disposition}`;
  }
}
