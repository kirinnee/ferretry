import { describe, expect, it } from 'bun:test';
import {
  type AgendaItem,
  type AgendaSnapshot,
  isMachineAgendaId,
  MACHINE_AGENDA_ID,
} from '@ferretry/core-asks/contract';
import type { SessionView } from '../../../app/shell.ts';
import { type DaemonId, daemonId } from '../../../app/shell.ts';
import { MACHINE_GROUP_NAME, machineSessionView, withMachineAgendas } from '../../../app/lib/machine-agenda.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';
import { sessionView } from '../../support/app/sessions.ts';

const STUDIO = daemonId('studio');
const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 23, 12, minutes)).toISOString();
const item = (id: string, minutes: number, overrides: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem(id, { subject: `Subject ${id}`, waitingSince: at(minutes), ...overrides });
const board = (items: readonly AgendaItem[], resolved: AgendaSnapshot['resolved'] = []): AgendaSnapshot =>
  ({ sessionId: MACHINE_AGENDA_ID, items, resolved, updatedAt: at(30) }) as unknown as AgendaSnapshot;
const parked = (id: string, minutes: number): AgendaItem =>
  item(id, minutes, { parked: { until: at(600), by: 'owner' } } as never);

describe('the machine agenda id', () => {
  it('is reserved, and only it is the machine agenda', () => {
    expect(MACHINE_AGENDA_ID).toBe('machine-agenda');
    expect(isMachineAgendaId('machine-agenda')).toBe(true);
    expect(isMachineAgendaId('ses-1')).toBe(false);
  });
});

describe('machineSessionView', () => {
  it('has nothing to show for an empty board', () => {
    expect(machineSessionView(board([]))).toBeUndefined();
  });

  it('summarises the open items: count, oldest, its ask and the latest wait', () => {
    const view = machineSessionView(board([item('M2', 10), item('M1', 5), item('M3', 20)])) as SessionView;
    expect(view.config.id).toBe('machine-agenda');
    expect(view.config.name).toBe(MACHINE_GROUP_NAME);
    expect(view.state.agenda).toEqual({ open: 3, first: 'M1', ask: 'Subject M1', latestAt: at(20) });
  });

  it('ignores the parked items in the summary, and has none when all are parked', () => {
    const some = machineSessionView(board([item('M1', 10), parked('M2', 1)])) as SessionView;
    expect(some.state.agenda).toMatchObject({ open: 1, first: 'M1' });
    const none = machineSessionView(board([parked('M2', 1)])) as SessionView;
    expect(none.state.agenda).toBeUndefined();
  });

  it('is still listed when only resolved records remain', () => {
    const view = machineSessionView(board([], [{ id: 'M9' }] as never));
    expect(view?.state.agenda).toBeUndefined();
  });

  it('reads an unparseable time as the epoch', () => {
    const view = machineSessionView(board([item('M1', 0, { waitingSince: 'soon' }), item('M2', 5)])) as SessionView;
    expect(view.state.agenda).toMatchObject({ first: 'M1', latestAt: at(5) });
  });
});

describe('withMachineAgendas', () => {
  const real = sessionView('ses-1');
  const machine = (id: DaemonId, sessions: readonly SessionView[] | null) => ({
    connection: { daemonId: id },
    sessions,
  });

  it('lists the machine agenda first among the machine’s conversations', () => {
    const [out] = withMachineAgendas([machine(STUDIO, [real])], () => board([item('M1', 1)]));
    expect(out?.sessions?.map(view => view.config.id)).toEqual(['machine-agenda', 'ses-1']);
  });

  it('lists it on a machine whose conversations are not read yet', () => {
    const [out] = withMachineAgendas([machine(STUDIO, null)], () => board([item('M1', 1)]));
    expect(out?.sessions?.map(view => view.config.id)).toEqual(['machine-agenda']);
  });

  it('asks each machine for its own board, and leaves one without a board (or an empty one) alone', () => {
    const asked: string[] = [];
    const machines = [machine(STUDIO, [real]), machine(daemonId('laptop'), [real])];
    const out = withMachineAgendas(machines, (daemon, session) => {
      asked.push(`${daemon}/${session}`);
      return daemon === STUDIO ? undefined : board([]);
    });
    expect(asked).toEqual(['studio/machine-agenda', 'laptop/machine-agenda']);
    expect(out[0]).toBe(machines[0] as never);
    expect(out[1]).toBe(machines[1] as never);
  });
});
