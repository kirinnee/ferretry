import '../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  DAEMON_FEATURES,
  type SessionAgendaSummary,
  WARDEN_AGENDA_PATH,
  LEGACY_WARDEN_ATTENTION_PATH,
} from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { z } from 'zod';
import {
  AgendaWireDirectory,
  agendaWireOf,
  sessionAgendaPath,
  sessionAgendaRepliesPath,
  sessionAgendaSummary,
  wardenAgendaPath,
} from '../../src/lib/agenda-wire.ts';
import { AgendaWireProbes, useAgendaWire } from '../../src/lib/agenda-wire-react.tsx';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import type { DaemonHealthRead } from '../../src/lib/daemon-health.ts';
import { type AppStore, DaemonClientProvider, StoreProvider } from '../../src/lib/store.tsx';
import { type Mounted, mount } from '../support/dom.ts';
import { healthOf } from '../support/health.ts';
import { runAsync } from '../support/react.ts';
import { settleUntil } from '../support/settle.ts';
import { alpha } from './features/config-files/config-files-support.ts';

const NEW: DaemonHealthRead = { kind: 'read', health: healthOf('4.108.0', [DAEMON_FEATURES.agendaWire]) };
const OLD: DaemonHealthRead = { kind: 'read', health: healthOf('4.84.0') };
const A = daemonId('a');
const B = daemonId('b');

describe('which spelling of the agenda wire a machine speaks', () => {
  it('reads the agenda routes only from a health that lists agenda.wire.1', () => {
    expect(agendaWireOf(NEW)).toBe('agenda');
    expect(agendaWireOf(OLD)).toBe('attention');
    expect(agendaWireOf({ kind: 'read', health: healthOf('4.100.0', ['pack.idea.4000']) })).toBe('attention');
    expect(agendaWireOf({ kind: 'loading' })).toBe('attention');
    expect(agendaWireOf({ kind: 'failed' })).toBe('attention');
  });

  it('spells every path both ways, as the daemon serves them', () => {
    expect(sessionAgendaPath('s 1', 'agenda')).toBe('/v1/sessions/s%201/agenda');
    expect(sessionAgendaPath('s 1', 'attention')).toBe('/v1/sessions/s%201/attention');
    expect(sessionAgendaRepliesPath('s 1', 'agenda')).toBe('/v1/sessions/s%201/agenda/replies');
    expect(sessionAgendaRepliesPath('s 1', 'attention')).toBe('/v1/sessions/s%201/attention/replies');
    expect(wardenAgendaPath('agenda')).toBe(WARDEN_AGENDA_PATH);
    expect(wardenAgendaPath('attention')).toBe(LEGACY_WARDEN_ATTENTION_PATH);
  });
});

describe('AgendaWireDirectory', () => {
  it('speaks the older way to a machine nobody has read', () => {
    expect(new AgendaWireDirectory().wireOf(A)).toBe('attention');
  });

  it('decides per machine: a new and an old daemon at once', () => {
    const wires = new AgendaWireDirectory();
    wires.note(A, NEW);
    wires.note(B, OLD);
    expect(wires.wireOf(A)).toBe('agenda');
    expect(wires.wireOf(B)).toBe('attention');
  });

  it('keeps an earlier answer through a read that has not answered, and lets an answer change it', () => {
    const wires = new AgendaWireDirectory();
    wires.note(A, NEW);
    wires.note(A, { kind: 'failed' });
    wires.note(A, { kind: 'loading' });
    expect(wires.wireOf(A)).toBe('agenda');
    wires.note(A, OLD);
    expect(wires.wireOf(A)).toBe('attention');
  });

  it('tells listeners only when a machine’s spelling really changed, and forgets an unpaired machine', () => {
    const wires = new AgendaWireDirectory();
    let heard = 0;
    const stop = wires.subscribe(() => {
      heard += 1;
    });
    wires.note(A, NEW);
    wires.note(A, NEW);
    expect(heard).toBe(1);
    wires.clearDaemon(B);
    expect(heard).toBe(1);
    wires.clearDaemon(A);
    expect(heard).toBe(2);
    expect(wires.wireOf(A)).toBe('attention');
    stop();
    wires.note(A, NEW);
    expect(heard).toBe(2);
  });
});

describe('whether a machine takes offerClose (agenda.offer-close.1)', () => {
  const OFFERS: DaemonHealthRead = {
    kind: 'read',
    health: healthOf('4.120.0', [DAEMON_FEATURES.agendaWire, DAEMON_FEATURES.agendaOfferClose]),
  };

  it('offers nothing until a machine’s health has been read, then follows its feature list', () => {
    const wires = new AgendaWireDirectory();
    expect(wires.offerCloseOf(A)).toBeUndefined();
    wires.note(A, { kind: 'loading' });
    expect(wires.offerCloseOf(A)).toBeUndefined();
    wires.note(A, OFFERS);
    wires.note(B, NEW);
    expect(wires.offerCloseOf(A)).toBe(true);
    expect(wires.offerCloseOf(B)).toBe(false);
  });

  it('tells listeners when only that answer changes, and forgets it with the machine', () => {
    const wires = new AgendaWireDirectory();
    let heard = 0;
    wires.subscribe(() => {
      heard += 1;
    });
    wires.note(A, NEW);
    expect(heard).toBe(1);
    wires.note(A, {
      kind: 'read',
      health: healthOf('4.120.0', [DAEMON_FEATURES.agendaWire, DAEMON_FEATURES.agendaOfferClose]),
    });
    expect(heard).toBe(2);
    wires.note(A, OFFERS);
    expect(heard).toBe(2);
    wires.clearDaemon(A);
    expect(wires.offerCloseOf(A)).toBeUndefined();
    expect(heard).toBe(3);
  });
});

describe('the session summary', () => {
  const summary = (first: string): SessionAgendaSummary => ({
    open: 1,
    first,
    ask: 'Rebase now?',
    latestAt: '2026-10-23T12:00:00.000Z',
  });

  it('reads whichever name the daemon wrote, and agenda wins when both are there', () => {
    expect(sessionAgendaSummary({ attention: summary('A1') })?.first).toBe('A1');
    expect(sessionAgendaSummary({ agenda: summary('A2') })?.first).toBe('A2');
    expect(sessionAgendaSummary({ attention: summary('A1'), agenda: summary('A2') })?.first).toBe('A2');
    expect(sessionAgendaSummary({})).toBeUndefined();
  });
});

let shown: Mounted | null = null;
afterEach(async () => {
  await shown?.unmount();
  shown = null;
});

const healthClient = (read: Record<string, DaemonHealthRead>) =>
  (async (daemon: { readonly daemonId: string }) => {
    const answer = read[daemon.daemonId];
    return {
      request: async (_path: string, schema: z.ZodType<unknown>) => {
        if (answer?.kind !== 'read') throw new Error('unreachable');
        return schema.parse(answer.health);
      },
    } as unknown as FyApiClient;
  }) as never;

function Wire({ id }: { readonly id: string }) {
  return <span data-wire={useAgendaWire(daemonId(id))} />;
}

const wireShown = (): string | null | undefined => shown?.container.querySelector('span')?.getAttribute('data-wire');

describe('the agenda wire in React', () => {
  it('reads the older spelling outside an app store', async () => {
    shown = await mount(<Wire id="alpha" />);
    expect(wireShown()).toBe('attention');
  });

  it('learns each paired machine’s spelling from the health the probes read, and follows a change', async () => {
    const wires = new AgendaWireDirectory();
    const store = { agendaWire: wires } as unknown as AppStore;
    const machines = [alpha, { ...alpha, daemonId: daemonId('beta') }];
    shown = await mount(
      <StoreProvider store={store}>
        <DaemonClientProvider client={healthClient({ alpha: NEW, beta: OLD })}>
          <AgendaWireProbes machines={machines} />
          <Wire id="alpha" />
        </DaemonClientProvider>
      </StoreProvider>,
    );
    await settleUntil(() => wireShown() === 'agenda', 'alpha to read as speaking the agenda wire', runAsync);
    expect(wires.wireOf(daemonId('alpha'))).toBe('agenda');
    expect(wires.wireOf(daemonId('beta'))).toBe('attention');
    await runAsync(async () => wires.note(daemonId('alpha'), OLD));
    expect(wireShown()).toBe('attention');
  });
});
