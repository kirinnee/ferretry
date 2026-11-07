import type { AgendaSnapshot } from '../protocol/agenda.ts';
import type { AgendaMutation, RaiseAgendaRequest } from './state-machine.ts';

/**
 * THE MACHINE AGENDA as the Asks service reaches it (docs/agenda.md § The machine agenda): notices that belong to no
 * live ferret, one item per cause, in their own daemon-owned ledger. The port only; the machine agenda itself (its
 * members and its one-item-per-cause rule) is the Agenda plugin's, today's `daemon/src/lib/agenda/machine-agenda.ts`.
 */
export interface MachineAgendaPort {
  raiseOrUpdate(ref: string, request: MachineRaise, members?: readonly string[]): Promise<AgendaMutation | undefined>;
  resolve(ref: string, note?: string): Promise<AgendaMutation | undefined>;
  list(): Promise<AgendaSnapshot>;
}

export type MachineRaise = Omit<RaiseAgendaRequest, 'source' | 'sourceRef'>;
