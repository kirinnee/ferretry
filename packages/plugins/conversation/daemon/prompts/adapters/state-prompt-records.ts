import type { StatePort } from '@ferretry/kernel/contract';
import { PROMPT_WAIT_STATE } from '../../../contract/index.ts';
import type { PromptRecords } from './prompt-asks.ts';

/**
 * The prompt records in the plugin's own state dir: one `prompt-wait.json` per ferret, replaced whole and atomically by
 * the state port, so a crash leaves the record before or after a change and never half of one. A record that is
 * damaged is an error, never "no record": a forgotten wait would raise its card a second time.
 */
export class StatePromptRecords implements PromptRecords {
  constructor(private readonly state: StatePort) {}

  async list(): Promise<readonly string[]> {
    return await this.state.list(PROMPT_WAIT_STATE);
  }

  async read(ferret: string) {
    const read = await this.state.read(PROMPT_WAIT_STATE, ferret);
    if (!read.ok) throw new Error(read.error.sentence);
    return read.value;
  }

  async write(ferret: string, record: Parameters<PromptRecords['write']>[1]): Promise<void> {
    await this.state.write(PROMPT_WAIT_STATE, record, ferret);
  }

  async remove(ferret: string): Promise<void> {
    await this.state.remove(PROMPT_WAIT_STATE, ferret);
  }
}
