import type { StatePort } from '@ferretry/kernel/contract';
import { LOGINS_PASSIVE_ASSIGNMENTS } from '../../../contract/index.ts';
import type { PassiveAssignmentsPort } from '../../lib/credentials/passive-codex.ts';

/**
 * Logins' own durable record of which login each Codex ferret was last seen on and since when, in
 * `state/logins/passive-assignments.json` (the kernel's private, atomic file). Ids and instants only. A document that is
 * missing or damaged reads as none held: the worst it can do is start each ferret's attribution afresh, which only ever
 * makes a reading later, never wrong. A write that fails throws, so the pass tries it again.
 */
export class StatePassiveAssignments implements PassiveAssignmentsPort {
  constructor(private readonly state: Pick<StatePort, 'read' | 'update'>) {}

  async read(): Promise<Readonly<Record<string, { readonly login: string; readonly since: number }>>> {
    const read = await this.state.read(LOGINS_PASSIVE_ASSIGNMENTS).catch(() => undefined);
    return read === undefined || !read.ok || read.value === undefined ? {} : read.value.ferrets;
  }

  async write(ferrets: Readonly<Record<string, { readonly login: string; readonly since: number }>>): Promise<void> {
    const written = await this.state.update(LOGINS_PASSIVE_ASSIGNMENTS, () => ({ format: 1 as const, ferrets }));
    if (!written.ok) throw new Error('the passive login assignments could not be written');
  }
}
