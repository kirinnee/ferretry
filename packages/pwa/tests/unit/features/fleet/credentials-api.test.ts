import { describe, expect, it } from 'bun:test';
import { type FleetCredentialView, OPERATOR_UNLOCK_HEADER } from '@ferretry/protocol';
import type { z } from 'zod';

import {
  checkFleetCredential,
  FLEET_CREDENTIALS_PATH,
  readFleetCredentials,
} from '../../../../src/features/fleet/credentials-api.ts';
import type { FleetClient } from '../../../../src/features/fleet/fleet-client.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

const TOKEN = `fy_unlock_${'A'.repeat(22)}`;

const VIEW = {
  id: 'codex-work',
  harness: 'codex',
  store: 'ferretry',
  needsLabel: false,
  sharedWithTerminal: false,
  status: {
    word: 'refresh_due',
    label: 'Refresh due',
    reason: 'access_expiring',
    explanation: 'The access token expires within five minutes. It renews the next time it is used.',
    lastCheckInconclusive: false,
  },
  usage: { fiveHour: {}, weekly: {} },
  usedBy: ['codex-review'],
  signIn: { available: true },
  checkNow: { available: true },
  signOut: {
    available: true,
    sentence: 'Sign out of codex-work? 1 runtime will need sign-in.',
    runtimesAffected: 1,
    signsOutTerminal: false,
  },
} satisfies FleetCredentialView;

const clientFor = (answer: unknown): { client: FleetClient; calls: Call[] } => {
  const calls: Call[] = [];
  const client: FleetClient = {
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return schema.parse(answer);
    },
  };
  return { client, calls };
};

describe('the credentials wire client', () => {
  it('reads every login from the credentials path, on the verb a read uses', async () => {
    const { client, calls } = clientFor({ format: 2, machine: 'studio', credentials: [VIEW] });

    const list = await readFleetCredentials(client);

    expect(list.credentials.map(credential => credential.id)).toEqual(['codex-work']);
    expect(calls[0]?.path).toBe(FLEET_CREDENTIALS_PATH);
    expect(calls[0]?.init?.method).toBeUndefined();
    expect(calls[0]?.init?.headers).toEqual({});
  });

  it('presses Check now with POST on the encoded id, the password in the body', async () => {
    const { client, calls } = clientFor(VIEW);

    const view = await checkFleetCredential(client, 'codex/work', { operatorPassword: 'the password' }, TOKEN);

    expect(view.status.word).toBe('refresh_due');
    expect(calls[0]?.path).toBe(`${FLEET_CREDENTIALS_PATH}/codex%2Fwork/check`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ operatorPassword: 'the password' });
    expect(calls[0]?.path).not.toContain('the password');
    expect(((calls[0]?.init?.headers ?? {}) as Record<string, string>)[OPERATOR_UNLOCK_HEADER]).toBe(TOKEN);
  });

  it('sends an empty body when a loopback caller owes no confirmation', async () => {
    const { client, calls } = clientFor(VIEW);

    await checkFleetCredential(client, 'codex-work');

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({});
  });

  it('carries the unlock on the list read too', async () => {
    const { client, calls } = clientFor({ format: 2, machine: 'studio', credentials: [] });

    await readFleetCredentials(client, TOKEN);

    expect(((calls[0]?.init?.headers ?? {}) as Record<string, string>)[OPERATOR_UNLOCK_HEADER]).toBe(TOKEN);
  });

  it('refuses an answer that carries a token, rather than handing it to a surface', async () => {
    const { client } = clientFor({ ...VIEW, accessToken: 'fake' });

    await expect(checkFleetCredential(client, 'codex-work')).rejects.toThrow();
  });
});
