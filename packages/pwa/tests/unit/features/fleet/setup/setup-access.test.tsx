import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { useMemo } from 'react';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { type SetupAccess, useSetupAccess } from '../../../../../src/features/fleet/setup/setup-access.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import { machineAnswer, STUDIO, scriptedClient } from './setup-support.ts';

interface Probe {
  current: SetupAccess | null;
}

function Host({ probe, client }: { readonly probe: Probe; readonly client: FleetClient }) {
  const createClient = useMemo(() => async () => client, [client]);
  const access = useSetupAccess({ connection: STUDIO, createClient });
  probe.current = access;
  return <p data-authority={access.changes.authority?.kind ?? 'reading'}>{access.changes.refusal ?? ''}</p>;
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

const hookView = async (client: FleetClient) => {
  const probe: Probe = { current: null };
  const view = await mount(<Host probe={probe} client={client} />);
  await settle();
  return {
    view,
    access: () => must(probe.current, 'hook'),
    authority: () => view.container.querySelector('[data-authority]')?.getAttribute('data-authority'),
    refusal: () => view.container.querySelector('p')?.textContent,
  };
};

describe('useSetupAccess', () => {
  it('runs a read with the connection’s client and reports it done', async () => {
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer() });
    const { view, access, authority } = await hookView(client);
    try {
      expect(authority()).toBe('open');
      let seen: FleetClient | undefined;
      let result: unknown;
      await interact(async () => {
        result = await access().read(async guarded => {
          seen = guarded;
          return 42;
        });
      });
      expect(result).toEqual({ kind: 'done', value: 42 });
      expect(seen).toBe(client);
    } finally {
      await view.unmount();
    }
  });

  it('reads on a machine that wants a passkey: the carrier asks for it, so nothing is held back here', async () => {
    const client = scriptedClient({
      '/v1/fleet/machine': machineAnswer({ mayApply: false, applyRefusal: 'step-up-required' }),
    });
    const { view, access, authority } = await hookView(client);
    try {
      expect(authority()).toBe('step-up');
      let result: unknown;
      await interact(async () => {
        result = await access().read(async () => 'scan');
      });
      expect(result).toEqual({ kind: 'done', value: 'scan' });
    } finally {
      await view.unmount();
    }
  });

  it('words a read that throws a non-HTTP error as the machine not answering', async () => {
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer() });
    const { view, access } = await hookView(client);
    try {
      let result: unknown;
      await interact(async () => {
        result = await access().read(async () => {
          throw new Error('socket hang up');
        });
      });
      expect(result).toEqual({
        kind: 'refused',
        sentence: 'This machine didn’t answer (socket hang up). Check it is awake and try again.',
      });
    } finally {
      await view.unmount();
    }
  });

  it('words a read the daemon refused with the daemon’s own sentence', async () => {
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer() });
    const { view, access } = await hookView(client);
    try {
      let result: unknown;
      await interact(async () => {
        result = await access().read(async () => {
          throw new FyHttpError('Setup is switched off here.', 409, 'fleet_change_disabled');
        });
      });
      expect(result).toEqual({ kind: 'refused', sentence: 'Setup is switched off here.' });
    } finally {
      await view.unmount();
    }
  });

  it('runs an act and shows nothing when it worked', async () => {
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer() });
    const { view, access, refusal } = await hookView(client);
    try {
      let result: unknown;
      await interact(async () => {
        result = await access().act(async () => 'installed');
      });
      expect(result).toEqual({ kind: 'done', value: 'installed' });
      expect(refusal()).toBe('');
    } finally {
      await view.unmount();
    }
  });

  it('shows the refusal of an act’s own work through changes.refusal', async () => {
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer() });
    const { view, access, refusal } = await hookView(client);
    try {
      let result: unknown;
      await interact(async () => {
        result = await access().act(async () => {
          throw new FyHttpError('No package manager was found.', 409, 'fleet_install_unavailable');
        });
      });
      expect(result).toMatchObject({ kind: 'refused', sentence: 'No package manager was found.' });
      expect(refusal()).toBe('No package manager was found.');
    } finally {
      await view.unmount();
    }
  });

  it('shows the machine not answering when an act throws a non-HTTP error', async () => {
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer() });
    const { view, access, refusal } = await hookView(client);
    try {
      await interact(async () => {
        await access().act(async () => {
          throw new Error('connection reset');
        });
      });
      expect(refusal()).toBe('This machine didn’t answer (connection reset). Check it is awake and try again.');
    } finally {
      await view.unmount();
    }
  });
});
