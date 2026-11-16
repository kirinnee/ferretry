import type { StatePort } from '@ferretry/kernel/contract';
import { SelfRestartFile } from '../../../../contract/index.ts';
import type { SelfRestartStamp, SelfRestartStampStore } from '../../../lib/session/health/types.ts';

/**
 * The self-restart cooldown, kept in Ferrets' state so it survives the restart it records.
 *
 * A read that fails THROWS rather than answering "no stamp". The distinction is the whole guard: a stamp file that
 * exists but will not parse is the signature of a daemon that keeps restarting, and reading it as an absent stamp
 * grants the very restart the cooldown exists to withhold. An absent file is the only thing that means "nothing has
 * restarted".
 */
export class StateSelfRestartStampStore implements SelfRestartStampStore {
  constructor(private readonly state: Pick<StatePort, 'read' | 'write' | 'remove'>) {}

  async read(): Promise<SelfRestartStamp | undefined> {
    const read = await this.state.read(SelfRestartFile);
    if (!read.ok) throw new Error(read.error.sentence);
    return read.value === undefined ? undefined : { at: read.value.at, sessions: read.value.sessions };
  }

  async write(stamp: SelfRestartStamp): Promise<void> {
    // Atomic, as every state write is: a torn stamp would read as unparseable, which suppresses restarts.
    await this.state.write(SelfRestartFile, { format: 1, at: stamp.at, sessions: [...stamp.sessions] });
  }

  async clear(): Promise<void> {
    await this.state.remove(SelfRestartFile);
  }
}
