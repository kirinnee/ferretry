import { expect, test } from 'bun:test';
import type { Clock, SpawnPort } from '@ferretry/kernel/contract';
import { GpgSigners } from '../../daemon/features/gpg-keys/signer.ts';
import { makeGpg } from '../../daemon/features/gpg-keys/material.ts';
import type { GpgListen } from '../../daemon/adapters/gpg-socket.ts';
import type { RunFolder } from '../../daemon/features/ssh-keys/agents.ts';

const gate = () => {
  let release = () => {};
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
};
const clock: Pick<Clock, 'after'> = { after: () => () => {} };
const spawn = { run: async () => ({ exitCode: 0, stdout: '', stderr: '', signal: null }) } as Pick<SpawnPort, 'run'>;
const programs = {
  gpg: async () => ({ program: '/usr/bin/gpg', path: '/usr/bin' }),
  curl: async () => ({ program: '/usr/bin/curl', path: '/usr/bin' }),
};
const folder = (): RunFolder => ({
  path: '/tmp/g8-synthetic',
  isPrivate: async () => true,
  remove: async () => {},
  publish: async () => {},
  emptyDirectory: async () => {},
});

test('shutdown waits for a held shim publish and never binds a late signer', async () => {
  const publishing = gate();
  const resume = gate();
  const files = folder();
  files.publish = async () => {
    publishing.release();
    await resume.promise;
  };
  let listens = 0;
  const signer = new GpgSigners(spawn, files, { warn: () => {} }, clock, programs, async () => {
    listens++;
    return { stop: async () => {} };
  });
  const key = await makeGpg({ name: 'Synthetic', email: 'synthetic@example.test' });
  const kit = signer.kit('gha_1', key.secretKey);
  await publishing.promise;
  let stopped = false;
  const stop = signer.stopAll().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  resume.release();
  await expect(kit).rejects.toMatchObject({ status: 503 });
  await stop;
  expect(listens).toBe(0);
});

test('shutdown gates signing immediately even while listener startup is held, then closes the late listener', async () => {
  const listening = gate();
  const resume = gate();
  let sign: Parameters<GpgListen>[1] | undefined;
  let closed = false;
  const signer = new GpgSigners(spawn, folder(), { warn: () => {} }, clock, programs, async (_socket, callback) => {
    sign = callback;
    listening.release();
    await resume.promise;
    return {
      stop: async () => {
        closed = true;
      },
    };
  });
  const key = await makeGpg({ name: 'Synthetic', email: 'synthetic@example.test' });
  const kit = signer.kit('gha_1', key.secretKey);
  await listening.promise;
  const stop = signer.stopAll();
  await expect(sign?.(new Uint8Array([1]))).rejects.toMatchObject({ status: 503 });
  resume.release();
  await expect(kit).rejects.toMatchObject({ status: 503 });
  await stop;
  expect(closed).toBe(true);
});
