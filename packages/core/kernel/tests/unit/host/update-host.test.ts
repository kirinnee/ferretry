/** XX kernel.updateHost: the release, the executable facts, and one narrow detached launch. */
import { describe, expect, test } from 'bun:test';
import type { UpdateHostPort } from '../../../contract/ports.ts';
import { undeclaredUpdateHost, updateHostFor } from '../../../host/adapters/update-host.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const facts = {
  argv0: '/home/owner/.nix-profile/bin/fyd',
  execPath: '/nix/store/abc-ferretry/bin/fyd',
  main: '/$bunfs/root/fyd',
  workingDirectory: '/',
  platform: 'linux',
};

describe('XX kernel.updateHost', () => {
  test('the release, compiled, and the executable with its links resolved', async () => {
    const port = updateHostFor({
      home: '/home/owner/.ferretry',
      binary: 'fy',
      release: '5.0.0',
      process: facts,
      resolveLink: async path => `${path}-resolved`,
      spawn: () => {
        throw new Error('no launch here');
      },
    })('updates');
    expect(port.release).toBe('5.0.0');
    expect(port.compiled).toBe(true);
    expect(await port.executable()).toEqual({ ...facts, resolvedExecPath: '/nix/store/abc-ferretry/bin/fyd-resolved' });
    const failing = updateHostFor({
      home: '/h',
      binary: 'fy',
      release: '5.0.0',
      process: { ...facts, main: '/src/fyd.ts' },
      resolveLink: async () => {
        throw new Error('gone');
      },
    })('updates');
    expect(failing.compiled).toBe(false);
    expect((await failing.executable()).resolvedExecPath).toBe(facts.execPath);
  });

  test('a target that is not a release number is refused without a launch', async () => {
    const launched: unknown[] = [];
    const port = updateHostFor({
      home: '/h',
      binary: 'fy',
      release: '5.0.0',
      process: facts,
      spawn: argv => launched.push(argv),
    })('updates');
    for (const bad of ['latest', '5.1', '5.1.0; rm -rf /', '--yes', '../5.1.0'])
      expect((await port.launchUpdate(bad)).kind).toBe('failed');
    expect(launched).toEqual([]);
  });

  test('a plugin without permissions.updateHost gets facts that refuse and launches that fail', async () => {
    const seen: Record<string, UpdateHostPort> = {};
    const half = (id: string, updateHost?: true) =>
      implementDaemon(
        definePlugin({
          id,
          title: id,
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          ...(updateHost === undefined ? {} : { permissions: { updateHost } }),
        }),
        {
          build: ctx => {
            seen[id] = ctx.kernel.updateHost;
            return {};
          },
        },
      );
    const stand = { ...undeclaredUpdateHost('x', '5.0.0'), launchUpdate: async () => ({ kind: 'started' as const }) };
    const host = await testHost({ plugins: [half('updates', true), half('other')], updateHost: stand });
    expect((await seen['updates']?.launchUpdate('5.1.0'))?.kind).toBe('started');
    expect(await seen['other']?.launchUpdate('5.1.0')).toEqual({
      kind: 'failed',
      reason: 'other did not declare permissions.updateHost.',
    });
    await expect(seen['other']?.executable() ?? Promise.resolve()).rejects.toThrow('permissions.updateHost');
    await host.stop();
  });
});
