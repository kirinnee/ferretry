import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { type ReactElement, useEffect } from 'react';
import type { FleetClient, FleetClientFactory } from '../../../../../src/features/fleet/fleet-client.ts';
import {
  type MachineReachOptions,
  type MachineReachState,
  useMachineReach,
} from '../../../../../src/features/fleet/shell/use-machine-reach.ts';
import type { DaemonConnectionRecord } from '../../../../../src/lib/connections.ts';
import { type DaemonId, daemonId } from '../../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import { configChangeHarness } from '../../../config-change-support.tsx';
import { machineClient, machineView, pairing } from './machine-support.ts';

const alpha = pairing('alpha', 'Alpha');
const beta = pairing('beta');
const gamma = pairing('gamma');

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const deferred = <T,>(): Deferred<T> => {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let step = 0; step < 5; step += 1) await Promise.resolve();
  });
};

/** A factory that answers per daemon as told, and records who it was asked for, in order. */
const answering = (
  answers: Readonly<Record<string, Error | ReturnType<typeof machineView>>>,
): { readonly asked: string[]; readonly createClient: FleetClientFactory } => {
  const asked: string[] = [];
  return {
    asked,
    createClient: async (connection): Promise<FleetClient> => {
      asked.push(String(connection.daemonId));
      return machineClient(answers[String(connection.daemonId)] ?? new Error('no answer'));
    },
  };
};

const Probe = ({
  options,
  onState,
}: {
  readonly options: MachineReachOptions;
  readonly onState: (state: MachineReachState) => void;
}) => {
  const state = useMachineReach(options);
  useEffect(() => onState(state));
  return null;
};

const renderReach = async (options: MachineReachOptions, wrap: (element: ReactElement) => ReactElement = e => e) => {
  let latest: MachineReachState | undefined;
  const seen: string[] = [];
  const element = (next: MachineReachOptions) =>
    wrap(
      <Probe
        options={next}
        onState={state => {
          latest = state;
          seen.push(state.reachOf(next.daemonId).kind);
        }}
      />,
    );
  const mounted = await mount(element(options));
  const current = (): MachineReachState => must(latest, 'the reach state');
  return {
    current,
    seen,
    kind: (id: DaemonId): string => current().reachOf(id).kind,
    rerender: (next: MachineReachOptions) => mounted.render(element(next)),
    unmount: () => mounted.unmount(),
  };
};

describe('useMachineReach', () => {
  it('asks this page’s own machine first, then every other pairing once', async () => {
    const { asked, createClient } = answering({
      alpha: machineView({ name: 'alpha-host' }),
      beta: machineView({ name: 'beta-host' }),
      gamma: machineView({ name: 'gamma-host' }),
    });
    const view = await renderReach({ daemonId: beta.daemonId, connections: [alpha, beta, gamma], createClient });
    try {
      await settle();
      expect(asked).toEqual(['beta', 'alpha', 'gamma']);
      expect(view.kind(alpha.daemonId)).toBe('online');
      expect(view.kind(beta.daemonId)).toBe('online');
    } finally {
      await view.unmount();
    }
  });

  it('shows a machine as checking until its answer arrives', async () => {
    const answer = deferred<FleetClient>();
    const view = await renderReach({
      daemonId: alpha.daemonId,
      connections: [alpha],
      createClient: () => answer.promise,
    });
    try {
      expect(view.kind(alpha.daemonId)).toBe('checking');
      answer.resolve(machineClient(machineView()));
      await settle();
      expect(view.current().reachOf(alpha.daemonId)).toEqual({ kind: 'online', machine: machineView() });
    } finally {
      await view.unmount();
    }
  });

  it('calls a machine that cannot be reached offline, and one that refuses unreadable, with its reason', async () => {
    const { createClient } = answering({
      alpha: new Error('network down'),
      beta: new FyHttpError('not found', 404, undefined),
    });
    const view = await renderReach({ daemonId: alpha.daemonId, connections: [alpha, beta], createClient });
    try {
      await settle();
      expect(view.current().reachOf(alpha.daemonId)).toEqual({ kind: 'offline' });
      expect(view.current().reachOf(beta.daemonId)).toEqual({
        kind: 'unreadable',
        reason: 'This machine runs an older Ferretry that cannot show its setup here yet.',
      });
    } finally {
      await view.unmount();
    }
  });

  it('asks nothing without a client, and every machine stays checking', async () => {
    const view = await renderReach({ daemonId: alpha.daemonId, connections: [alpha, beta] });
    try {
      await settle();
      expect(view.kind(alpha.daemonId)).toBe('checking');
      expect(view.kind(beta.daemonId)).toBe('checking');
      // Asking again has nothing to ask with.
      await interact(() => view.current().check(alpha.daemonId));
      expect(view.kind(alpha.daemonId)).toBe('checking');
    } finally {
      await view.unmount();
    }
  });

  it('shows a machine waiting on an unlock as locked, whatever its read said', async () => {
    const { createClient } = answering({ alpha: machineView(), beta: machineView() });
    const view = await renderReach({
      daemonId: alpha.daemonId,
      connections: [alpha, beta],
      createClient,
      locked: [beta.daemonId],
    });
    try {
      await settle();
      expect(view.kind(alpha.daemonId)).toBe('online');
      expect(view.current().reachOf(beta.daemonId)).toEqual({ kind: 'locked' });
    } finally {
      await view.unmount();
    }
  });

  it('passes on the name each answering machine goes by, and nothing for one that did not answer', async () => {
    const named: string[] = [];
    const { createClient } = answering({ alpha: machineView({ name: 'alpha-host' }), beta: new Error('down') });
    const view = await renderReach({
      daemonId: alpha.daemonId,
      connections: [alpha, beta],
      createClient,
      onNamed: (id, name) => named.push(`${String(id)}=${name}`),
    });
    try {
      await settle();
      expect(named).toEqual(['alpha=alpha-host']);
    } finally {
      await view.unmount();
    }
  });

  it('asks quietly after a save, keeping the last answer on screen until the new one lands', async () => {
    // A loud re-check swapped the Machine tab for "Checking…" after every save made on it, which unmounted
    // what the person was editing and moved the page under them.
    let gate: Deferred<FleetClient> | null = null;
    const createClient: FleetClientFactory = async () => await (gate?.promise ?? machineClient(machineView()));
    const view = await renderReach({ daemonId: alpha.daemonId, connections: [alpha], createClient });
    try {
      await settle();
      expect(view.kind(alpha.daemonId)).toBe('online');
      const pending = deferred<FleetClient>();
      gate = pending;
      await interact(() => view.current().check(alpha.daemonId, true));
      await settle();
      expect(view.kind(alpha.daemonId)).toBe('online');
      await interact(() => view.current().check(alpha.daemonId));
      expect(view.kind(alpha.daemonId)).toBe('checking');
      gate = null;
      pending.resolve(machineClient(machineView()));
      await settle();
      expect(view.kind(alpha.daemonId)).toBe('online');
    } finally {
      await view.unmount();
    }
  });

  it('asks one machine again on check, and ignores a check for a machine that is not paired', async () => {
    const { asked, createClient } = answering({ alpha: machineView(), beta: machineView() });
    const view = await renderReach({ daemonId: alpha.daemonId, connections: [alpha, beta], createClient });
    try {
      await settle();
      expect(asked).toEqual(['alpha', 'beta']);
      await interact(() => view.current().check(beta.daemonId));
      await settle();
      expect(asked).toEqual(['alpha', 'beta', 'beta']);
      await interact(() => view.current().check(daemonId('nobody')));
      await settle();
      expect(asked).toEqual(['alpha', 'beta', 'beta']);
      expect(view.kind(daemonId('nobody'))).toBe('checking');
    } finally {
      await view.unmount();
    }
  });

  it('re-reads this page’s machine quietly when it says its setup moved, keeping the old answer until the new one lands', async () => {
    // A hand edit, another device or `fy` changes the machine; the page must show the new answer without a reload.
    const second = deferred<FleetClient>();
    const reads: Promise<FleetClient>[] = [
      Promise.resolve(machineClient(machineView({ name: 'before' }))),
      second.promise,
    ];
    const asked: string[] = [];
    const named: string[] = [];
    const createClient: FleetClientFactory = connection => {
      asked.push(String(connection.daemonId));
      return must(reads.shift(), 'a read');
    };
    const harness = configChangeHarness(alpha.daemonId);
    const view = await renderReach(
      {
        daemonId: alpha.daemonId,
        connections: [alpha],
        createClient,
        onNamed: (id, name) => named.push(`${String(id)}=${name}`),
      },
      harness.wrap,
    );
    try {
      await settle();
      expect(view.current().reachOf(alpha.daemonId)).toEqual({
        kind: 'online',
        machine: machineView({ name: 'before' }),
      });
      expect(asked).toEqual(['alpha']);
      const shown = view.seen.length;

      await harness.move(['machine']);
      // Asked again, and the previous answer is still what the page shows while it waits.
      expect(asked).toEqual(['alpha', 'alpha']);
      expect(view.current().reachOf(alpha.daemonId)).toEqual({
        kind: 'online',
        machine: machineView({ name: 'before' }),
      });

      second.resolve(machineClient(machineView({ name: 'after' })));
      await settle();
      expect(view.current().reachOf(alpha.daemonId)).toEqual({
        kind: 'online',
        machine: machineView({ name: 'after' }),
      });
      expect(named).toEqual(['alpha=before', 'alpha=after']);
      // At no point between the two answers did the page fall back to "checking".
      expect(view.seen.slice(shown)).not.toContain('checking');
    } finally {
      await view.unmount();
    }
  });

  it('re-reads on a runtimes or credentials move too, and ignores a move of something its answer does not hold', async () => {
    const { asked, createClient } = answering({ alpha: machineView() });
    const harness = configChangeHarness(alpha.daemonId);
    const view = await renderReach({ daemonId: alpha.daemonId, connections: [alpha], createClient }, harness.wrap);
    try {
      await settle();
      expect(asked).toEqual(['alpha']);

      await harness.move(['runtimes']);
      await settle();
      expect(asked).toEqual(['alpha', 'alpha']);

      await harness.move(['credentials']);
      await settle();
      expect(asked).toEqual(['alpha', 'alpha', 'alpha']);

      await harness.move(['warden']);
      await settle();
      expect(asked).toEqual(['alpha', 'alpha', 'alpha']);
    } finally {
      await view.unmount();
    }
  });

  it('shows a quiet re-read that fails as offline straight from the old answer, without passing through checking', async () => {
    const reads: (() => Promise<FleetClient>)[] = [
      async () => machineClient(machineView({ name: 'before' })),
      async () => {
        throw new Error('network down');
      },
    ];
    const harness = configChangeHarness(alpha.daemonId);
    const view = await renderReach(
      { daemonId: alpha.daemonId, connections: [alpha], createClient: () => must(reads.shift(), 'a read')() },
      harness.wrap,
    );
    try {
      await settle();
      const shown = view.seen.length;
      await harness.move(['machine']);
      await settle();
      expect(view.current().reachOf(alpha.daemonId)).toEqual({ kind: 'offline' });
      expect(view.seen.slice(shown)).not.toContain('checking');
    } finally {
      await view.unmount();
    }
  });

  it('does nothing when its own machine is not among the pairings, or when nothing can be asked', async () => {
    const { asked, createClient } = answering({ beta: machineView() });
    const harness = configChangeHarness(alpha.daemonId);
    const view = await renderReach({ daemonId: alpha.daemonId, connections: [beta], createClient }, harness.wrap);
    try {
      await settle();
      expect(asked).toEqual(['beta']);
      await harness.move(['machine']);
      await settle();
      // The move concerns a machine this page does not hold a pairing for: nothing is asked, nothing changes.
      expect(asked).toEqual(['beta']);
      expect(view.kind(alpha.daemonId)).toBe('checking');
      expect(view.kind(beta.daemonId)).toBe('online');
    } finally {
      await view.unmount();
    }

    const quiet = configChangeHarness(alpha.daemonId);
    const without = await renderReach({ daemonId: alpha.daemonId, connections: [alpha] }, quiet.wrap);
    try {
      await settle();
      await quiet.move(['machine']);
      await settle();
      expect(without.kind(alpha.daemonId)).toBe('checking');
    } finally {
      await without.unmount();
    }
  });

  it('does not ask again for a new list of the same pairings, but asks a machine that was just paired', async () => {
    const { asked, createClient } = answering({ alpha: machineView(), beta: machineView(), gamma: machineView() });
    const view = await renderReach({ daemonId: alpha.daemonId, connections: [alpha, beta], createClient });
    try {
      await settle();
      expect(asked).toEqual(['alpha', 'beta']);

      // Learning a name republishes the connections as new objects; that is not a reason to ask again.
      const renamed: DaemonConnectionRecord[] = [{ ...alpha, label: 'Alpha renamed' }, { ...beta }];
      await view.rerender({ daemonId: alpha.daemonId, connections: renamed, createClient });
      await settle();
      expect(asked).toEqual(['alpha', 'beta']);

      await view.rerender({ daemonId: alpha.daemonId, connections: [...renamed, gamma], createClient });
      await settle();
      expect(asked.slice(2)).toContain('gamma');
      expect(view.kind(gamma.daemonId)).toBe('online');
    } finally {
      await view.unmount();
    }
  });
});
