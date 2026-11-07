import { describe, expect, test } from 'bun:test';
import {
  type AgendaDefaultPorts,
  type AgendaModeFacts,
  AgendaModeError,
  AgendaModeService,
  adoptAgendaDefault,
  agendaModeNote,
} from '../../../daemon/lib/agenda-mode.ts';

function service(facts: AgendaModeFacts | undefined) {
  const writes: Array<readonly [string, boolean, string]> = [];
  const modes = new AgendaModeService({
    facts: async () => facts,
    write: async (ferret, enabled, at) => {
      writes.push([ferret, enabled, at]);
    },
    now: () => '2026-10-29T10:00:00.000Z',
  });
  return { modes, writes };
}

function defaults(options: { readonly machine: boolean; readonly recorded?: boolean }) {
  const enabled: string[] = [];
  const reads: string[] = [];
  const ports: AgendaDefaultPorts = {
    machineDefault: () => {
      reads.push('machine');
      return options.machine;
    },
    recorded: async () => options.recorded,
    enable: async ferret => {
      enabled.push(ferret);
    },
  };
  return { ports, enabled, reads };
}

describe('AgendaModeService', () => {
  test('reads the switch without a restart', async () => {
    const { modes } = service({ enabled: true, running: true });
    expect(await modes.get('f1')).toEqual({ enabled: true, restartRequired: false, note: 'Agenda mode is on.' });
  });

  test('needs a restart only when a running ferret is changed', async () => {
    const running = service({ enabled: false, running: true });
    const stopped = service({ enabled: false, running: false });
    expect((await running.modes.set('f1', true)).restartRequired).toBe(true);
    expect((await stopped.modes.set('f1', true)).restartRequired).toBe(false);
    expect(running.writes).toEqual([['f1', true, '2026-10-29T10:00:00.000Z']]);
  });

  test('says a switch already in place was already so, and needs no restart', async () => {
    const { modes } = service({ enabled: true, running: true });
    const outcome = await modes.set('f1', true);
    expect(outcome.restartRequired).toBe(false);
    expect(outcome.note).toBe('Agenda mode was already on.');
  });

  test('refuses a ferret that does not exist, and writes nothing', async () => {
    const { modes, writes } = service(undefined);
    await expect(modes.set('ghost', true)).rejects.toBeInstanceOf(AgendaModeError);
    await expect(modes.get('ghost')).rejects.toBeInstanceOf(AgendaModeError);
    expect(writes).toEqual([]);
  });

  test('words the note by what is on, whether it changed and whether the ferret runs', () => {
    expect(agendaModeNote(false, true, false)).toMatch(/next launch/u);
    expect(agendaModeNote(false, true, true)).toMatch(/restarts/u);
    expect(agendaModeNote(true, false, true)).toBe('Agenda mode was already on.');
  });
});

describe('adoptAgendaDefault', () => {
  test('turns agenda mode on for a new ordinary ferret when the machine default is on', async () => {
    const { ports, enabled } = defaults({ machine: true });
    expect(await adoptAgendaDefault(ports, 'f1', true)).toBe(true);
    expect(enabled).toEqual(['f1']);
  });

  test('leaves a ferret alone when the machine default is off', async () => {
    const { ports, enabled } = defaults({ machine: false });
    expect(await adoptAgendaDefault(ports, 'f1', true)).toBe(false);
    expect(enabled).toEqual([]);
  });

  test('never overrules a switch the ferret already recorded, on or off', async () => {
    const off = defaults({ machine: true, recorded: false });
    const on = defaults({ machine: true, recorded: true });
    expect(await adoptAgendaDefault(off.ports, 'f1', true)).toBe(false);
    expect(await adoptAgendaDefault(on.ports, 'f2', true)).toBe(false);
    expect(off.enabled).toEqual([]);
    expect(on.enabled).toEqual([]);
  });

  test('skips a ferret the daemon runs for itself without reading the machine', async () => {
    const { ports, enabled, reads } = defaults({ machine: true });
    expect(await adoptAgendaDefault(ports, 'f1', false)).toBe(false);
    expect(enabled).toEqual([]);
    expect(reads).toEqual([]);
  });
});
