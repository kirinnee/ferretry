/**
 * secure-clip-1 fix1, P1-2: a SEALED child (a secure copy's command capture) sees the sealed allowlist and what its
 * caller handed over, and NOTHING of the host's tool environment (the git/gh overlay with its proxy variables),
 * whatever the executable is called. Synthetic daemon values only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bunSpawn,
  SEALED_ENVIRONMENT_NAMES,
  sealedEnvironment,
  toolEnvironment,
} from '../../../host/adapters/process.ts';

const DAEMON: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/fake',
  USER: 'fake',
  LOGNAME: 'fake',
  SHELL: '/bin/sh',
  LANG: 'C',
  LC_ALL: 'C',
  TMPDIR: '/tmp',
  TERM: 'xterm',
  HTTPS_PROXY: 'http://user:FAKE-PROXY-CRED@proxy.invalid:3128',
  HTTP_PROXY: 'http://user:FAKE-PROXY-CRED@proxy.invalid:3128',
  https_proxy: 'http://user:FAKE-PROXY-CRED@proxy.invalid:3128',
  http_proxy: 'http://user:FAKE-PROXY-CRED@proxy.invalid:3128',
  SSH_AUTH_SOCK: '/run/FAKE-SSH-SOCK',
  GH_CONFIG_DIR: '/home/fake/FAKE-GH-CONFIG',
  FAKE_DAEMON_ONLY: 'FAKE-DAEMON-SECRET',
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sealed-spawn-'));
  // Each prints its whole environment on stdout and on stderr, so any leak shows in both channels.
  for (const name of ['git', 'gh', 'vercel']) {
    await writeFile(join(dir, name), '#!/bin/sh\nenv\nenv >&2\n');
    await chmod(join(dir, name), 0o755);
  }
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const spawn = () =>
  bunSpawn(
    { PATH: DAEMON.PATH as string, HOME: DAEMON.HOME as string },
    undefined,
    toolEnvironment(DAEMON),
    sealedEnvironment(DAEMON),
  );

describe('a sealed child', () => {
  test('the sealed allowlist is the v4 one', () => {
    expect([...SEALED_ENVIRONMENT_NAMES]).toEqual([
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'SHELL',
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'TERM',
    ]);
    expect(Object.keys(sealedEnvironment(DAEMON)).sort()).toEqual([...SEALED_ENVIRONMENT_NAMES].sort());
  });

  for (const name of ['git', 'gh', 'vercel']) {
    test(`${name}: sees the allowlist only, in neither its output nor its stderr is a daemon-only value`, async () => {
      const result = await spawn().run(join(dir, name), [], { sealed: true });
      for (const text of [result.stdout, result.stderr]) {
        expect(text).toContain('HOME=/home/fake');
        for (const leaked of [
          'FAKE-PROXY-CRED',
          'FAKE-SSH-SOCK',
          'FAKE-GH-CONFIG',
          'FAKE-DAEMON-SECRET',
          'PROXY',
          'SSH_AUTH_SOCK',
        ])
          expect(text).not.toContain(leaked);
      }
    });
  }

  test('what the caller hands over still goes in', async () => {
    const result = await spawn().run(join(dir, 'git'), [], { sealed: true, env: { CALLER_VALUE: 'FAKE-CALLER' } });
    expect(result.stdout).toContain('CALLER_VALUE=FAKE-CALLER');
  });

  test('an unsealed git child keeps the tool environment, as every other caller always had', async () => {
    const result = await spawn().run(join(dir, 'git'), [], {});
    expect(result.stdout).toContain('HTTPS_PROXY=');
  });
});
