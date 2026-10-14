import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { useEffect } from 'react';
import type { FleetClient, FleetClientFactory } from '../../../../../src/features/fleet/fleet-client.ts';
import {
  type MachineReachOptions,
  type MachineReachState,
  useMachineReach,
} from '../../../../../src/features/fleet/shell/use-machine-reach.ts';
import type { DaemonConnectionRecord } from '../../../../../src/lib/connections.ts';
import { type DaemonId, daemonId } from '../../../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
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

const renderReach = async (options: MachineReachOptions) => {
  let latest: MachineReachState | undefined;
  const element = (next: MachineReachOptions) => (
    <Probe
      options={next}
      onState={state => {
        latest = state;
      }}
    />
  );
  const mounted = await mount(element(options));
  const current = (): MachineReachState => must(latest, 'the reach state');
  return {
    current,
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
