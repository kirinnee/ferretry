import type { StatePort } from '@ferretry/kernel/contract';
import { REPLY_SPEND_STATE } from '../../contract/index.ts';
import type { SpendPort } from '../lib/reply/elevenlabs.ts';

/** The characters of spoken replies sent to ElevenLabs today, in `state/voice/reply-spend.json`: a day and a count, never a word. */
export class StateReplySpend implements SpendPort {
  constructor(private readonly state: StatePort) {}

  async read(): Promise<{ readonly day: string; readonly chars: number } | undefined> {
    const read = await this.state.read(REPLY_SPEND_STATE);
    return read.ok && read.value !== undefined ? { day: read.value.day, chars: read.value.chars } : undefined;
  }

  async write(record: { readonly day: string; readonly chars: number }): Promise<void> {
    await this.state.write(REPLY_SPEND_STATE, record);
  }
}
