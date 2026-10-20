/**
 * Asking a harness binary about itself, against real processes: the "harnesses" are shell scripts that
 * print what they were given, so the isolation (`HOME`, proxies) is observed rather than assumed.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { HostHarnessProbe, probeEnvironment } from '../../../src/adapters/index.ts';
import { runPackageInstall } from '../../../src/adapters/process/package-install.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function harness(body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-harness-probe-test-'));
  directories.push(root);
  const path = join(root, 'claude');
  await writeFile(path, `#!/bin/sh\n${body}`, 'utf8');
  await chmod(path, 0o700);
  return path;
}

const probe = (timeoutMs?: number) => new HostHarnessProbe(runPackageInstall, { PATH: '/usr/bin:/bin' }, timeoutMs);

describe('probeEnvironment', () => {
  it('gives a throwaway home, a proxy that goes nowhere, and the binary’s own directory first on PATH', () => {
    const environment = probeEnvironment('/opt/node/bin/claude', '/tmp/h', { PATH: '/usr/bin', LANG: 'en_GB.UTF-8' });
    should(environment).containDeep({
      HOME: '/tmp/h',
      PATH: '/opt/node/bin:/usr/bin',
      LANG: 'en_GB.UTF-8',
      CLAUDE_CONFIG_DIR: '/tmp/h/.claude',
      CODEX_HOME: '/tmp/h/.codex',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
    });
    should(probeEnvironment('/opt/claude', '/tmp/h', {})).containDeep({ PATH: '/opt', LANG: 'C.UTF-8' });
    should(probeEnvironment('/opt/claude', '/tmp/h', { PATH: '' }).PATH).equal('/opt');
  });
});

describe('HostHarnessProbe', () => {
  it('reads the version, from a home that is not the person’s and is gone afterwards', async () => {
    const path = await harness('case "$1" in --version) echo "2.1.220 (Claude Code)"; echo "home=$HOME" >&2;; esac\n');
    should(await probe().version(path)).deepEqual({ state: 'ok', version: '2.1.220' });
    should(
      (await readdir(tmpdir())).filter(name => name.startsWith('fy-harness-probe-') && !name.includes('test')),
    ).be.empty();
  });

  it('says a version it cannot read, a run that never started, and one that hung', async () => {
    should(await probe().version(await harness('echo nothing\n'))).deepEqual({
      state: 'unreadable',
      reason: 'it exited 0 without printing a version',
    });
    should(await probe().version(await harness('echo 1.2.3; exit 2\n'))).deepEqual({
      state: 'unreadable',
      reason: 'it exited 2 without printing a version',
    });
    should((await probe().version('/nonexistent/claude')).state).equal('unreadable');
    should(await probe(200).version(await harness('sleep 5\n'))).deepEqual({
      state: 'unreadable',
      reason: 'it did not answer within 20 seconds',
    });
  });

  it('checks that it starts with --help, offline', async () => {
    const path = await harness('[ "$1" = --help ] && [ "$HTTPS_PROXY" = http://127.0.0.1:9 ] && exit 0\nexit 1\n');
    should(await probe().startup(path)).deepEqual({ ok: true });
    should(await probe().startup(await harness('exit 4\n'))).deepEqual({ ok: false, reason: '--help exited 4' });
    should((await probe().startup('/nonexistent/claude')).ok).be.false();
    should(await probe(200).startup(await harness('sleep 5\n'))).deepEqual({
      ok: false,
      reason: '--help did not finish within 20 seconds',
    });
  });
});
