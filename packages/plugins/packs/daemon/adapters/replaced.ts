import type { StatePort } from '@ferretry/kernel/contract';
import { PACK_REPLACED, type ReplacedRouting } from '../../contract/index.ts';

/**
 * The routing prompt the last accepted clean-up replaced (`state/packs/replaced.json`), so ONE undo puts it back.
 * A damaged document reads as nothing to undo, which refuses an undo rather than writing a guess over the prompt.
 */
export class StateReplacedRouting {
  constructor(private readonly state: Pick<StatePort, 'read' | 'write' | 'remove'>) {}

  async read(): Promise<ReplacedRouting | undefined> {
    const read = await this.state.read(PACK_REPLACED);
    return read.ok ? read.value : undefined;
  }

  async write(value: ReplacedRouting | undefined): Promise<void> {
    if (value === undefined) await this.state.remove(PACK_REPLACED);
    else await this.state.write(PACK_REPLACED, value);
  }
}
