import { describe, expect, it } from 'bun:test';
import { OPERATOR_UNLOCK_HEADER } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { useMemo } from 'react';
import { z } from 'zod';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { type SetupAccess, useSetupAccess } from '../../../../../src/features/fleet/setup/setup-access.ts';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  type Call,
  machineAnswer,
  NOW,
  PASSWORD,
  STUDIO,
  scriptedClient,
  UNLOCK_TOKEN,
  UNLOCKED,
} from './setup-support.ts';

const PASSWORD_FIRST = 'Type this machine’s operator password to make this change.';
const NO_ANSWER = 'This machine didn’t answer, so nothing was changed. Check it is awake and try again.';

const LOCKED = machineAnswer({ mayApply: false, applyRefusal: 'locked' });
const unlockedAnswer = (call: Call) => (call.headers[OPERATOR_UNLOCK_HEADER] === UNLOCK_TOKEN ? machineAnswer() : LOCKED);

interface Probe {
  current: SetupAccess | null;
}

function Host({
  probe,
  client,
  now,
}: {
  readonly probe: Probe;
  readonly client: FleetClient;
  readonly now: () => number;
}) {
  const createClient = useMemo(() => async () => client, [client]);
  const access = useSetupAccess({ connection: STUDIO, createClient, now });
  probe.current = access;
  return (
    <p data-locked={String(access.locked)} data-authority={access.changes.authority?.kind ?? 'reading'}>
      {access.changes.refusal ?? ''}
    </p>
  );
}

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

const hookView = async (client: FleetClient, now: () => number = NOW) => {
  const probe: Probe = { current: null };
  const view = await mount(<Host probe={probe} client={client} now={now} />);
  await settle();
  return {
    view,
    access: () => must(probe.current, 'hook'),
    locked: () => view.container.querySelector('[data-locked]')?.getAttribute('data-locked'),
    refusal: () => view.container.querySelector('p')?.textContent,
  };
};

describe('useSetupAccess', () => {
  it('reads with no unlock header when the machine is open', async () => {
    const calls: Call[] = [];
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer(), '/v1/probe': { ok: true } }, calls);
    const { view, access, locked } = await hookView(client);
    try {
      expect(locked()).toBe('false');
      let unlockSeen: string | undefined = 'untouched';
      let result: unknown;
      await interact(async () => {
        result = await access().read(async (_client, unlock) => {
          unlockSeen = unlock;
          return 42;
        });
      });
      expect(result).toEqual({ kind: 'done', value: 42 });
      expect(unlockSeen).toBeUndefined();
      expect(calls.map(call => call.path)).toEqual(['/v1/fleet/machine']);
    } finally {
      await view.unmount();
    }
  });

  it('refuses a locked read until the operator password is typed', async () => {
    const calls: Call[] = [];
    const client = scriptedClient({ '/v1/fleet/machine': LOCKED, '/v1/grants/unlock': UNLOCKED }, calls);
    const { view, access, locked, refusal } = await hookView(client);
    try {
      expect(locked()).toBe('true');
      let worked = false;
      let result: unknown;
      await interact(async () => {
        result = await access().read(async () => {
          worked = true;
        });
      });
      expect(result).toMatchObject({ kind: 'refused', sentence: PASSWORD_FIRST, passwordRejected: false });
      expect(worked).toBe(false);
      expect(refusal()).toBe(PASSWORD_FIRST);
      expect(calls.map(call => call.path)).toEqual(['/v1/fleet/machine']);
    } finally {
      await view.unmount();
    }
  });

  it('mints an unlock with the password, sends it as the unlock header, and reuses it for the next read', async () => {
    const calls: Call[] = [];
    const client = scriptedClient(
      {
        '/v1/fleet/machine': unlockedAnswer,
        '/v1/grants/unlock': UNLOCKED,
        '/v1/fleet/setup/scan': { ok: true },
      },
      calls,
    );
    const { view, access, locked } = await hookView(client);
    try {
      expect(locked()).toBe('true');
      const guardedRead = (guarded: FleetClient, unlock: string | undefined) =>
        guarded.request('/v1/fleet/setup/scan', z.object({ ok: z.boolean() }), {
          headers: unlock === undefined ? {} : { [OPERATOR_UNLOCK_HEADER]: unlock },
        });

      // The reader handed out before the unlock still sees it: the unlock lives in a ref, not the closure.
      const staleRead = access().read;
      let first: unknown;
      await interact(async () => {
        first = await staleRead(guardedRead, PASSWORD);
      });
      expect(first).toEqual({ kind: 'done', value: { ok: true } });
      const unlockCalls = calls.filter(call => call.path === '/v1/grants/unlock');
      expect(unlockCalls).toHaveLength(1);
      expect(unlockCalls[0]?.body).toMatchObject({ password: PASSWORD });
      const scanCalls = calls.filter(call => call.path === '/v1/fleet/setup/scan');
      expect(scanCalls[0]?.headers[OPERATOR_UNLOCK_HEADER]).toBe(UNLOCK_TOKEN);
      expect(locked()).toBe('false');

      let second: unknown;
      let unlockSeen: string | undefined;
      await interact(async () => {
        second = await staleRead(async (_client, unlock) => {
          unlockSeen = unlock;
          return 'again';
        });
      });
      expect(second).toEqual({ kind: 'done', value: 'again' });
      expect(unlockSeen).toBe(UNLOCK_TOKEN);
      expect(calls.filter(call => call.path === '/v1/grants/unlock')).toHaveLength(1);

      // A fresh reader taken after the machine re-read its authority sends the same unlock.
      let third: string | undefined;
      await interact(async () => {
        await access().read(async (_client, unlock) => {
          third = unlock;
        });
      });
      expect(third).toBe(UNLOCK_TOKEN);
      expect(calls.filter(call => call.path === '/v1/grants/unlock')).toHaveLength(1);
    } finally {
      await view.unmount();
    }
  });

  it('says a wrong password was rejected and keeps the browser locked', async () => {
    const wrong = new FyHttpError('That password was not right.', 401, 'grant_wrong_password');
    const client = scriptedClient({ '/v1/fleet/machine': LOCKED, '/v1/grants/unlock': wrong });
    const { view, access, locked } = await hookView(client);
    try {
      let result: unknown;
      await interact(async () => {
        result = await access().read(async () => 1, 'not-the-password-at-all');
      });
      expect(result).toMatchObject({ kind: 'refused', passwordRejected: true });
      expect(locked()).toBe('true');
    } finally {
      await view.unmount();
    }
  });

  it('asks for the password again once the unlock has expired', async () => {
    let clock = NOW();
    // The machine stays locked even with the unlock, so only the unlock's own expiry decides.
    const client = scriptedClient({ '/v1/fleet/machine': LOCKED, '/v1/grants/unlock': UNLOCKED });
    const { view, access, locked } = await hookView(client, () => clock);
    try {
      await interact(async () => {
        await access().read(async () => 1, PASSWORD);
      });
      expect(locked()).toBe('false');
      clock = Date.parse(UNLOCKED.expiresAt) + 1;
      let result: unknown;
      await interact(async () => {
        result = await access().read(async () => 2);
      });
      expect(result).toMatchObject({ kind: 'refused', sentence: PASSWORD_FIRST });
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
      expect(result).toEqual({ kind: 'refused', sentence: NO_ANSWER, passwordRejected: false });
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
      expect(result).toEqual({ kind: 'refused', sentence: 'Setup is switched off here.', passwordRejected: false });
    } finally {
      await view.unmount();
    }
  });

  it('hands an act nothing extra on an open machine', async () => {
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer() });
    const { view, access } = await hookView(client);
    try {
      let seen: unknown;
      let result: unknown;
      await interact(async () => {
        result = await access().act(async (_client, authorization) => {
          seen = authorization;
          return 'installed';
        });
      });
      expect(result).toEqual({ kind: 'done', value: 'installed' });
      expect(seen).toEqual({});
    } finally {
      await view.unmount();
    }
  });

  it('refuses an act that owes the operator password until it is typed', async () => {
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer({ confirmation: 'operator-password' }) });
    const { view, access } = await hookView(client);
    try {
      let worked = false;
      let result: unknown;
      await interact(async () => {
        result = await access().act(async () => {
          worked = true;
        });
      });
      expect(result).toMatchObject({ kind: 'refused', sentence: PASSWORD_FIRST });
      expect(worked).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  it('hands the typed operator password to an act that confirms', async () => {
    const client = scriptedClient({ '/v1/fleet/machine': machineAnswer({ confirmation: 'operator-password' }) });
    const { view, access, refusal } = await hookView(client);
    try {
      let seen: unknown;
      let result: unknown;
      await interact(async () => {
        result = await access().act(async (_client, authorization) => {
          seen = authorization;
          return 'migrated';
        }, PASSWORD);
      });
      expect(result).toEqual({ kind: 'done', value: 'migrated' });
      expect(seen).toEqual({ operatorPassword: PASSWORD });
      expect(refusal()).toBe('');
    } finally {
      await view.unmount();
    }
  });

  it('hands a locked act both the minted unlock and no confirmation', async () => {
    const calls: Call[] = [];
    const client = scriptedClient({ '/v1/fleet/machine': unlockedAnswer, '/v1/grants/unlock': UNLOCKED }, calls);
    const { view, access, locked } = await hookView(client);
    try {
      let seen: unknown;
      await interact(async () => {
        await access().act(async (_client, authorization) => {
          seen = authorization;
        }, PASSWORD);
      });
      expect(seen).toEqual({ unlock: UNLOCK_TOKEN });
      expect(locked()).toBe('false');
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
      expect(refusal()).toBe(NO_ANSWER);
    } finally {
      await view.unmount();
    }
  });
});
