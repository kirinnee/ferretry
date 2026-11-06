import '../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES, type SessionAgendaSummary } from '@ferretry/protocol';
import type { FyApiClient } from '@ferretry/protocol/client';
import type { z } from 'zod';
import {
  AgendaWireDirectory,
  sessionAgendaPath,
  sessionAgendaRepliesPath,
  sessionAgendaSummary,
} from '../../src/lib/agenda-wire.ts';
import { AgendaWireProbes, useWorkSearchOffered } from '../../src/lib/agenda-wire-react.tsx';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import type { DaemonHealthRead } from '../../src/lib/daemon-health.ts';
import { type AppStore, DaemonClientProvider, StoreProvider } from '../../src/lib/store.tsx';
import { type Mounted, mount } from '../support/dom.ts';
import { healthOf } from '../support/health.ts';
import { runAsync } from '../support/react.ts';
import { settleUntil } from '../support/settle.ts';
import { alpha } from './features/config-files/config-files-support.ts';

const featured = (...features: string[]): DaemonHealthRead => ({
  kind: 'read',
  health: healthOf('4.150.0', features),
});
const PLAIN = featured();
const A = daemonId('a');
const B = daemonId('b');

describe('the agenda paths', () => {
  it('spells every path as the daemon serves it', () => {
    expect(sessionAgendaPath('s 1')).toBe('/v1/sessions/s%201/agenda');
    expect(sessionAgendaRepliesPath('s 1')).toBe('/v1/sessions/s%201/agenda/replies');
  });
});

describe('AgendaWireDirectory', () => {
  it('says nothing about a machine nobody has read', () => {
    const wires = new AgendaWireDirectory();
    expect(wires.workSearchOf(A)).toBeUndefined();
    expect(wires.gateItemsOf(A)).toBeUndefined();
    expect(wires.cardAsksOf(A)).toBeUndefined();
  });

  it('tells listeners only when a machine’s answers really changed, and forgets an unpaired machine', () => {
    const wires = new AgendaWireDirectory();
    let heard = 0;
    const stop = wires.subscribe(() => {
      heard += 1;
    });
    wires.note(A, PLAIN);
    wires.note(A, PLAIN);
    expect(heard).toBe(1);
    wires.clearDaemon(B);
    expect(heard).toBe(1);
    wires.clearDaemon(A);
    expect(heard).toBe(2);
    stop();
    wires.note(A, PLAIN);
    expect(heard).toBe(2);
  });
});

describe('whether a machine searches work by words (work.search.1)', () => {
  const SEARCHES = featured(DAEMON_FEATURES.workSearch);

  it('says nothing until health answered, then follows the feature list, and forgets it with the machine', () => {
    const wires = new AgendaWireDirectory();
    expect(wires.workSearchOf(A)).toBeUndefined();
    wires.note(A, { kind: 'failed' });
    expect(wires.workSearchOf(A)).toBeUndefined();
    wires.note(A, SEARCHES);
    wires.note(B, PLAIN);
    expect(wires.workSearchOf(A)).toBe(true);
    expect(wires.workSearchOf(B)).toBe(false);
    wires.clearDaemon(A);
    expect(wires.workSearchOf(A)).toBeUndefined();
  });

  it('tells listeners when only that answer changes', () => {
    const wires = new AgendaWireDirectory();
    let heard = 0;
    wires.subscribe(() => {
      heard += 1;
    });
    wires.note(A, PLAIN);
    expect(heard).toBe(1);
    wires.note(A, SEARCHES);
    expect(heard).toBe(2);
    wires.note(A, SEARCHES);
    expect(heard).toBe(2);
  });
});

describe('whether a machine takes card asks (agenda.card-asks.1)', () => {
  it('tells listeners when only the card-asks answer changes after a machine is already read', () => {
    const wires = new AgendaWireDirectory();
    let heard = 0;
    wires.subscribe(() => {
      heard += 1;
    });
    wires.note(A, PLAIN);
    const before = heard;
    wires.note(A, PLAIN);
    expect(heard).toBe(before);
    wires.note(A, featured(DAEMON_FEATURES.agendaCardAsks));
    expect(wires.cardAsksOf(A)).toBe(true);
    expect(heard).toBe(before + 1);
    wires.note(A, featured(DAEMON_FEATURES.agendaCardAsks));
    expect(heard).toBe(before + 1);
    wires.clearDaemon(A);
    expect(wires.cardAsksOf(A)).toBeUndefined();
    expect(heard).toBeGreaterThan(before + 1);
  });
});

describe('the session summary', () => {
  const summary = (first: string): SessionAgendaSummary => ({
    open: 1,
    first,
    ask: 'Rebase now?',
    latestAt: '2026-10-23T12:00:00.000Z',
  });

  it('reads the agenda summary the daemon wrote', () => {
    expect(sessionAgendaSummary({ agenda: summary('A2') })?.first).toBe('A2');
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

function Search({ id }: { readonly id: string }) {
  return <span data-search={String(useWorkSearchOffered(daemonId(id)))} />;
}

const searchShown = (): string | null | undefined =>
  shown?.container.querySelector('span')?.getAttribute('data-search');

describe('the agenda wire in React', () => {
  it('offers nothing outside an app store', async () => {
    shown = await mount(<Search id="alpha" />);
    expect(searchShown()).toBe('undefined');
  });

  it('learns each paired machine’s features from the health the probes read, and follows a change', async () => {
    const wires = new AgendaWireDirectory();
    const store = { agendaWire: wires } as unknown as AppStore;
    const machines = [alpha, { ...alpha, daemonId: daemonId('beta') }];
    shown = await mount(
      <StoreProvider store={store}>
        <DaemonClientProvider client={healthClient({ alpha: featured(DAEMON_FEATURES.workSearch), beta: PLAIN })}>
          <AgendaWireProbes machines={machines} />
          <Search id="alpha" />
        </DaemonClientProvider>
      </StoreProvider>,
    );
    await settleUntil(() => searchShown() === 'true', 'alpha to read as searching work', runAsync);
    expect(wires.workSearchOf(daemonId('alpha'))).toBe(true);
    expect(wires.workSearchOf(daemonId('beta'))).toBe(false);
    await runAsync(async () => wires.note(daemonId('alpha'), PLAIN));
    expect(searchShown()).toBe('false');
  });
});
