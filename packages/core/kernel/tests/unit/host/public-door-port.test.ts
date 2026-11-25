import { expect, test } from 'bun:test';
import type { Manifest } from '../../../manifest/types.ts';
import { publicDoorPort } from '../../../host/public-door.ts';
import { testPublicDoor } from '../../../testing/public-door.ts';
import { testHost } from '../../../testing/index.ts';
import { definePlugin, implementDaemon, route } from '../../../manifest/index.ts';
import { jsonResponse } from '../../../contract/http.ts';

const manifest = (id: string, permission: boolean): Manifest => ({
  id,
  title: id,
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  ...(permission ? { permissions: { publicDoor: true } } : {}),
});

test('neither real nor test publicDoor accepts a missing permission or a self-declared non-allowlisted plugin', async () => {
  let effects = 0;
  for (const claimant of [manifest('connector', false), manifest('intruder', true)]) {
    const real = publicDoorPort({
      manifest: claimant,
      dispatcher: () => {
        effects++;
        throw new Error('unused');
      },
      onStop: () => {
        effects++;
      },
      stopping: () => false,
    });
    const fake = testPublicDoor(claimant, {
      open: async () => {
        effects++;
        throw new Error('unused');
      },
    });
    for (const port of [real, fake]) await expect(port.open({ port: 7489 })).rejects.toThrow(/not permitted/);
  }
  expect(effects).toBe(0);
});

test('a stopped publicDoor and an invalid port bind nothing; a test host binds nothing without a fake', async () => {
  const claimant = manifest('connector', true);
  const base = {
    manifest: claimant,
    dispatcher: () => {
      throw new Error('unused');
    },
    onStop: () => {
      throw new Error('must not register cleanup');
    },
  };
  await expect(publicDoorPort({ ...base, stopping: () => true }).open({ port: 7489 })).rejects.toThrow(/has stopped/);
  await expect(publicDoorPort({ ...base, stopping: () => false }).open({ port: -1 })).rejects.toThrow(/integer/);
  await expect(testPublicDoor(claimant).open({ port: 7489 })).rejects.toThrow(/no publicDoor fake/);
});

test('the test host API hides public routes just like the real kernel', async () => {
  const plugin = implementDaemon(
    definePlugin({
      ...manifest('connector', true),
      actions: {
        routes: [
          route('GET /oauth/authorize', {
            door: 'public',
            minimum: 'none',
            caller: 'any',
            audit: { skip: 'fixture' },
            guard: { none: 'fixture' },
          }),
        ],
      },
    }),
    { build: () => ({ routes: { 'GET /oauth/authorize': async () => jsonResponse({ ok: true }) } }) },
  );
  const host = await testHost({ plugins: [plugin] });
  try {
    expect((await host.request('GET', '/oauth/authorize')).status).toBe(404);
    expect((await host.request('POST', '/oauth/authorize')).status).toBe(404);
  } finally {
    await host.stop();
  }
});
