/**
 * The nix tool, over the kernel's real spawn: a stand-in `nix` script on a private PATH answers the way the real one was
 * measured to (including Determinate's metadata, which omits `narHash` and needs a prefetch), so every call here is a
 * real child process with real exit codes and real streams.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunSpawn } from '@ferretry/kernel/host';
import { nixTool } from '../../daemon/adapters/nix.ts';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

/** A nix tool whose `nix` is this shell body; `undefined` is a machine without nix. */
async function nixWith(body: string | undefined) {
  const bin = await mkdtemp(join(tmpdir(), 'fy-shells-nix-'));
  folders.push(bin);
  if (body !== undefined) {
    await writeFile(join(bin, 'nix'), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, 'nix'), 0o755);
  }
  return nixTool(bunSpawn({ PATH: `${bin}:/usr/bin:/bin` }));
}

const metadata = await Bun.file(new URL('../fixtures/determinate-git-metadata.json', import.meta.url)).text();
const fixturePath = new URL('../fixtures/determinate-git-metadata.json', import.meta.url).pathname;
const doc = JSON.parse(metadata) as { originalUrl: string; url: string; locked: { rev: string } };
const HASH = 'sha256-3niVhq1s0yt4PCQ/vnnVMv/RA0yXMf/eBWWJQmQiZfQ=';
const REV = 'fcae1995c9d9ab67322ec3cf44c17e05bfde035a';

describe('which nix is on the machine', () => {
  test('a nix that answers its version is present, with that version', async () => {
    const tool = await nixWith('echo "nix (Nix) 2.24.1"');

    expect(await tool.facts()).toEqual({ present: true, version: '2.24.1', path: 'nix' });
  });

  test('no nix, a nix that fails and a nix that prints no version all say what ferrets use instead', async () => {
    for (const body of [undefined, 'exit 1', 'echo "something else entirely"']) {
      const facts = await (await nixWith(body)).facts();

      expect(facts.present).toBe(false);
      expect(!facts.present && facts.consequence).toContain('tools already on this machine');
      expect(!facts.present && facts.remedy).toContain('install nix');
    }
  });
});

describe('reading a flake', () => {
  test('metadata that carries its hash is read at once, from a nix asked with the features on', async () => {
    const tool = await nixWith(
      `case "$*" in *"--extra-experimental-features nix-command flakes flake metadata --json github:me/shells") echo '{"url":"github:me/shells/${REV}","locked":{"rev":"${REV}","narHash":"${HASH}"}}';; *) exit 9;; esac`,
    );

    const result = await tool.flakeMetadata('github:me/shells');

    expect(result.ok && result.value.rev).toBe(REV);
    expect(result.ok && result.value.narHash).toBe(HASH);
  });

  test('metadata without a hash prefetches the resolved revision and pins the hash it returns', async () => {
    const tool = await nixWith(`case "$*" in *prefetch*) echo '{"hash":"${HASH}"}';; *) cat '${fixturePath}';; esac`);

    const result = await tool.flakeMetadata(doc.originalUrl);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rev).toBe(doc.locked.rev);
    expect(new URL(result.value.url).searchParams.get('narHash')).toBe(HASH);
  });

  test('a failing nix answers with the end of its own words, bounded', async () => {
    const tool = await nixWith(
      `i=0; while [ $i -lt 200 ]; do echo noise >&2; i=$((i+1)); done; echo 'error: flake not found' >&2; exit 1`,
    );

    const result = await tool.flakeMetadata('github:me/nope');

    expect(!result.ok && result.error).toContain('error: flake not found');
    expect(!result.ok && result.error.length).toBeLessThanOrEqual(600);
  });

  test('a failing nix with nothing to say still answers a sentence', async () => {
    const tool = await nixWith('exit 1');

    const result = await tool.flakeMetadata('github:me/silent');

    expect(!result.ok && result.error).toBe('nix could not read it');
  });

  test('metadata that is not metadata, or no nix to ask, never makes a usable flake', async () => {
    const garbage = await nixWith('echo "not json at all"');
    const absent = await nixWith(undefined);

    expect((await garbage.flakeMetadata('github:me/x')).ok).toBe(false);
    const missing = await absent.flakeMetadata('github:me/x');
    expect(!missing.ok && missing.error).toBe('nix could not be run');
  });

  test('prefetch failures, absent hashes and invalid hashes never make a usable flake', async () => {
    const prefetchAnswers = [
      "echo 'fetch failed' >&2; exit 1",
      'exit 1',
      "echo 'not json'",
      "echo '{}'",
      `echo '{"hash":"md5-no"}'`,
      "echo 'null'",
    ];
    for (const answer of prefetchAnswers) {
      const tool = await nixWith(`case "$*" in *prefetch*) ${answer};; *) cat '${fixturePath}';; esac`);

      expect((await tool.flakeMetadata('git+file:///fixture')).ok).toBe(false);
    }
  });
});

describe('building a shell', () => {
  test('a build answers the environment it exported', async () => {
    const tool = await nixWith(`echo '{"variables":{"PATH":{"type":"exported","value":"/p"}}}'`);

    expect(await tool.devEnv(['print-dev-env'])).toEqual({ ok: true, value: { PATH: '/p' } });
  });

  test('a failed build answers the end of its words, or a plain sentence when it said nothing', async () => {
    const loud = await nixWith("echo 'error: build of x failed' >&2; exit 1");
    const quiet = await nixWith('exit 1');
    const absent = await nixWith(undefined);

    const failed = await loud.devEnv(['print-dev-env']);
    const silent = await quiet.devEnv(['print-dev-env']);
    const missing = await absent.devEnv(['print-dev-env']);

    expect(!failed.ok && failed.error).toContain('error: build of x failed');
    expect(!silent.ok && silent.error).toBe('the build failed');
    expect(!missing.ok && missing.error).toBe('nix could not be run');
  });
});
