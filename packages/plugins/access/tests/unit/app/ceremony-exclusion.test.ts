import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { CredentialsPort } from '@ferretry/app';
import { addPasskeyCeremony, stepUpCeremony, unlockCeremony } from '../../../app/lib/step-up-ceremony.ts';
import type { StepUpClient } from '../../../app/lib/step-up-client.ts';
import { daemonConnection } from '../../../app/shell-grants.ts';
const machine = daemonConnection({
  daemonId: 'synthetic-exclusion',
  baseUrl: 'https://synthetic.example',
  deviceId: 'synthetic',
});
const origin = 'https://synthetic.example';
const at = '2026-11-26T00:00:00.000Z';
const options = {
  challenge: 'AQID',
  rpId: 'synthetic.example',
  allowCredentials: [{ type: 'public-key', id: 'AQID' }],
  timeout: 60000,
};
const bytes = () => Uint8Array.of(1, 2, 3).buffer;
const assertion = () =>
  ({
    type: 'public-key',
    rawId: bytes(),
    response: { clientDataJSON: bytes(), authenticatorData: bytes(), signature: bytes() },
  }) as unknown as Credential;
const had = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
beforeEach(() => Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: class {} }));
afterEach(() => {
  if (had === undefined) Reflect.deleteProperty(globalThis, 'PublicKeyCredential');
  else Object.defineProperty(globalThis, 'PublicKeyCredential', had);
});
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

test('E-397 an options request may finish its prerequisite unlock before the act gets its own proof', async () => {
  let unlock: () => Promise<void> = async () => {};
  const sent: string[] = [];
  const client: StepUpClient = {
    request: async (path, schema) => {
      sent.push(path);
      if (path === '/v1/step-up/options') {
        await unlock();
        return schema.parse(options);
      }
      return schema.parse(
        path.endsWith('/options') ? options : path === '/v1/unlock' ? { unlockedUntil: at } : { expiresAt: at },
      );
    },
  };
  let sheets = 0;
  const credentials: CredentialsPort = {
    create: async () => null,
    get: async () => {
      sheets++;
      return assertion();
    },
  };
  const deps = { client: async () => client, credentials, origin };
  unlock = () => unlockCeremony(deps)(machine);
  await stepUpCeremony(deps)(machine);
  expect(sheets).toBe(2);
  expect(sent).toEqual(['/v1/step-up/options', '/v1/unlock/options', '/v1/unlock', '/v1/step-up']);
});

test('E-397 independent registration and an act cannot open a browser ceremony while unlock is in flight', async () => {
  let finish: ((credential: Credential) => void) | undefined;
  let sheets = 0;
  let creates = 0;
  const client: StepUpClient = {
    request: async (path, schema) =>
      schema.parse(
        path === '/v1/passkeys/options'
          ? {
              challenge: 'AQID',
              timeout: 60000,
              excludeCredentials: [],
              rp: { id: 'synthetic.example', name: 'Synthetic' },
              user: { id: 'AQID', name: 'Synthetic', displayName: 'Synthetic' },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            }
          : path.endsWith('/options')
            ? options
            : { unlockedUntil: at },
      ),
  };
  const credentials: CredentialsPort = {
    create: async () => {
      creates++;
      return null;
    },
    get: async () => {
      sheets++;
      return await new Promise(resolve => {
        finish = resolve;
      });
    },
  };
  const deps = { client: async () => client, credentials, origin };
  const running = unlockCeremony(deps)(machine);
  await flush();
  expect(sheets).toBe(1);
  await expect(addPasskeyCeremony(credentials, client, origin, true, machine.daemonId)).rejects.toThrow(
    'already running',
  );
  await expect(stepUpCeremony(deps)(machine)).rejects.toThrow('already running');
  expect(sheets).toBe(1);
  expect(creates).toBe(0);
  finish?.(assertion());
  await running;
});

test('E-397 a competing registration cannot replace the challenge before being refused as busy', async () => {
  let finish: ((credential: Credential) => void) | undefined;
  let optionsAsked = 0;
  const client: StepUpClient = {
    request: async (path, schema) => {
      if (path === '/v1/passkeys/options') {
        optionsAsked++;
        return schema.parse({
          challenge: 'AQID',
          timeout: 60000,
          excludeCredentials: [],
          rp: { id: 'synthetic.example', name: 'Synthetic' },
          user: { id: 'AQID', name: 'Synthetic', displayName: 'Synthetic' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        });
      }
      return schema.parse({ id: 'AQID', origin, createdAt: at });
    },
  };
  const credentials: CredentialsPort = {
    get: async () => null,
    create: async () =>
      await new Promise(resolve => {
        finish = resolve;
      }),
  };
  const first = addPasskeyCeremony(credentials, client, origin, true, machine.daemonId);
  await flush();
  await expect(addPasskeyCeremony(credentials, client, origin, true, machine.daemonId)).rejects.toThrow(
    'already running',
  );
  expect(optionsAsked).toBe(1);
  finish?.({
    type: 'public-key',
    rawId: bytes(),
    response: { clientDataJSON: bytes(), attestationObject: bytes() },
  } as unknown as Credential);
  await first;
});
