import { type AgendaId, type AgendaItem, type AgendaSnapshot, MACHINE_AGENDA_ID } from '@ferretry/protocol';
import type { AgendaActor, RaiseAgendaRequest } from './state-machine.ts';
import { agendaSnapshot, emptyAgendaLedger } from './state-machine.ts';
import type { AgendaService } from './service.ts';
import { SerialQueue } from './serial-queue.ts';

/** The only writer: the daemon. Nothing a ferret or the CLI sends reaches this ledger. */
const DAEMON: AgendaActor = { kind: 'daemon', cause: 'system' };

/** The members each cause listed the last time it was raised, so a new one can be told from one the owner saw. */
export interface MachineMembersStore {
  read(): Promise<Readonly<Record<string, readonly string[]>>>;
  write(members: Readonly<Record<string, readonly string[]>>): Promise<void>;
}

/** What other code is given: raise or refresh the item for one cause, close it when the cause clears. */
export interface MachineAgendaPort {
  raiseOrUpdate(ref: string, request: MachineRaise, members?: readonly string[]): Promise<void>;
  resolve(ref: string, note?: string): Promise<void>;
  list(): Promise<AgendaSnapshot>;
}

export type MachineRaise = Omit<RaiseAgendaRequest, 'source' | 'sourceRef'>;

/**
 * THE MACHINE AGENDA (docs/agenda.md § The machine agenda): notices that belong to no live ferret, one item per
 * cause, kept in its own daemon-owned ledger. Only the daemon raises on it and only the owner answers.
 *
 * `members` (the ferrets or cards a cause lists) make the item behave: an update that ADDS a member wakes a
 * snoozed item, a shrink does not, and an item the owner cleared is not raised again for members they have
 * already seen.
 */
export class MachineAgenda implements MachineAgendaPort {
  private readonly queue = new SerialQueue();

  constructor(
    private readonly service: AgendaService,
    private readonly members: MachineMembersStore,
    private readonly clock: { now(): string },
  ) {}

  async list(): Promise<AgendaSnapshot> {
    const listed = await this.service.list(MACHINE_AGENDA_ID);
    if (listed.ok) return listed.value;
    return agendaSnapshot(emptyAgendaLedger(MACHINE_AGENDA_ID, this.clock.now()));
  }

  raiseOrUpdate(ref: string, request: MachineRaise, members?: readonly string[]): Promise<void> {
    return this.queue.run(async () => {
      if (members?.length === 0) return await this.close(ref, undefined);
      const open = await this.open(ref);
      const known = (await this.members.read())[ref];
      const seen = known !== undefined && members !== undefined && members.every(member => known.includes(member));
      if (open === undefined && seen) {
        // The list may have shrunk: remember who is there NOW, so a member that leaves and comes back counts as new.
        if (members.length !== known.length) await this.remember(ref, members);
        return;
      }
      const raised = await this.service.raise(
        MACHINE_AGENDA_ID,
        { ...request, source: 'agent-raised', sourceRef: ref },
        DAEMON,
      );
      if (!raised.ok) throw new Error(raised.error.message);
      if (members === undefined) return;
      const added = known === undefined || members.some(member => !known.includes(member));
      if (open?.parked?.reason === 'snoozed' && added) await this.wake(open.id);
      await this.remember(ref, members);
    });
  }

  private async remember(ref: string, members: readonly string[]): Promise<void> {
    await this.members.write({ ...(await this.members.read()), [ref]: members });
  }

  resolve(ref: string, note?: string): Promise<void> {
    return this.queue.run(async () => await this.close(ref, note));
  }

  private async close(ref: string, note: string | undefined): Promise<void> {
    const store = await this.members.read();
    if (store[ref] !== undefined) {
      const { [ref]: _gone, ...rest } = store;
      await this.members.write(rest);
    }
    if ((await this.open(ref)) === undefined) return;
    const closed = await this.service.resolveSource(MACHINE_AGENDA_ID, 'agent-raised', ref, DAEMON, note);
    if (!closed.ok) throw new Error(closed.error.message);
  }

  private async open(ref: string): Promise<AgendaItem | undefined> {
    return (await this.list()).items.find(item => item.source === 'agent-raised' && item.sourceRef === ref);
  }

  /** A member the owner has not seen ends the snooze: the daemon says so itself, in the item's history. */
  private async wake(id: AgendaId): Promise<void> {
    const woke = await this.service.unsnooze(MACHINE_AGENDA_ID, id, DAEMON);
    if (!woke.ok) throw new Error(woke.error.message);
  }
}
