import { describe, it } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { HostHarnessFacts } from '../../../src/adapters/index.ts';

const STORE = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-codex-0.145.0';

describe('HostHarnessFacts', () => {
  it('reads a profile link into the store, and asks the nix profile which element holds it', async () => {
    const asked: string[][] = [];
    const facts = new HostHarnessFacts({
      homeDirectory: '/home/kirin',
      platform: 'linux',
      realpath: async () => `${STORE}/bin/codex`,
      readLink: async path =>
        path === '/home/kirin/.nix-profile'
          ? '/nix/var/nix/profiles/per-user/kirin/profile'
          : path === '/nix/var/nix/profiles/per-user/kirin/profile/bin/codex'
            ? `${STORE}/bin/codex`
            : undefined,
      run: async argv => {
        asked.push([...argv]);
        return { code: 0, stdout: JSON.stringify({ elements: { codex: { storePaths: [STORE] } } }) };
      },
    });
    should(await facts.facts('codex', '/home/kirin/.nix-profile/bin/codex')).deepEqual({
      harness: 'codex',
      launchedPath: '/home/kirin/.nix-profile/bin/codex',
      resolvedPath: `${STORE}/bin/codex`,
      homeDirectory: '/home/kirin',
      platform: 'linux',
      nixProfileElement: 'codex',
      homeManagerProfile: false,
      viaHomeManagerPath: false,
    });
    should(asked).deepEqual([['nix', 'profile', 'list', '--json']]);
  });

  it('reads a real npm global through its real links, and never asks nix about a file outside the store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fy-harness-facts-'));
    try {
      const target = join(root, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
      await Bun.write(target, '#!/usr/bin/env node\n');
      await Bun.write(join(root, 'bin', '.keep'), '');
      await symlink(target, join(root, 'bin', 'claude'));
      await writeFile(join(root, 'bin', 'not-a-link'), '');
      const facts = new HostHarnessFacts({
        homeDirectory: '/home/kirin',
        platform: 'darwin',
        run: async () => {
          throw new Error('nix must not be asked');
        },
      });
      const read = await facts.facts('claude', join(root, 'bin', 'claude'));
      should(read.resolvedPath.endsWith('/lib/node_modules/@anthropic-ai/claude-code/cli.js')).be.true();
      should(read).containDeep({ harness: 'claude', homeManagerProfile: false, viaHomeManagerPath: false });
      should((await facts.facts('claude', join(root, 'missing'))).resolvedPath).equal(join(root, 'missing'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
