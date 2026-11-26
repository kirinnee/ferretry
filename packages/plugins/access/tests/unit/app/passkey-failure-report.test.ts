import { expect, test } from 'bun:test';
import { PasskeyCeremonyError } from '@ferretry/app';
import { addPasskeyCeremony } from '../../../app/lib/step-up-ceremony.ts';
import type { StepUpClient } from '../../../app/lib/step-up-client.ts';
test('E-24 pre-request browser failure reports only classification and still refuses the ceremony', async () => {
  const sent: { path: string; body: unknown }[] = [];
  const client: StepUpClient = {
    request: async (path, schema, init) => {
      sent.push({ path, body: JSON.parse(String(init?.body)) });
      return schema.parse(
        path === '/v1/passkeys/options'
          ? {
              challenge: 'AQID',
              timeout: 60000,
              excludeCredentials: [],
              rp: { id: 'synthetic.example', name: 'Synthetic' },
              user: { id: 'AQID', name: 'Synthetic', displayName: 'Synthetic' },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            }
          : {},
      );
    },
  };
  await expect(
    addPasskeyCeremony({ create: async () => null, get: async () => null }, client, 'https://synthetic.example', false),
  ).rejects.toBeInstanceOf(PasskeyCeremonyError);
  expect(sent.map(s => s.path)).toEqual(['/v1/passkeys/options', '/v1/passkeys/failure']);
  expect(sent[1]?.body).toEqual({ ceremony: 'register', reason: 'unsupported' });
});

test('E-24 unlock cancellation reports a fixed classification without browser exception text', async () => {
  const { unlockCeremony } = await import('../../../app/lib/step-up-ceremony.ts');
  const { daemonConnection } = await import('../../../app/shell-grants.ts');
  const before = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
  Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: class {} });
  const sent: unknown[] = [];
  const client: StepUpClient = {
    request: async (path, schema, init) => {
      sent.push({ path, body: JSON.parse(String(init?.body)) });
      return schema.parse(
        path === '/v1/unlock/options'
          ? {
              challenge: 'AQID',
              rpId: 'synthetic.example',
              allowCredentials: [{ type: 'public-key', id: 'AQID' }],
              timeout: 60000,
            }
          : {},
      );
    },
  };
  try {
    const run = unlockCeremony({
      client: async () => client,
      origin: 'https://synthetic.example',
      credentials: {
        create: async () => null,
        get: async () => {
          throw Object.assign(new Error('synthetic confidential text'), { name: 'NotAllowedError' });
        },
      },
    });
    await expect(
      run(daemonConnection({ daemonId: 'synthetic', baseUrl: 'https://synthetic.example', deviceId: 'synthetic' })),
    ).rejects.toBeInstanceOf(PasskeyCeremonyError);
    expect(sent[1]).toEqual({ path: '/v1/passkeys/failure', body: { ceremony: 'unlock', reason: 'cancelled' } });
    expect(JSON.stringify(sent)).not.toContain('confidential');
  } finally {
    if (before === undefined) Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
    else Object.defineProperty(globalThis, 'PublicKeyCredential', before);
  }
});
