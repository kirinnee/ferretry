import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { targetWorld } from '../support/target.ts';
import { git, makeRepository } from '../support/real-git.ts';
import { bytes, hostile } from '../support/hostile.ts';
import { world } from '../support/world.ts';
import { FERRET } from '../support/fake-ferrets.ts';
import { newIdentity } from '../support/identity.ts';

/** Include .git objects, refs and metadata; compare booleans so no fixture content is printed on failure. */
function disk(path: string): string {
  const walk = (folder: string): unknown =>
    readdirSync(folder)
      .sort()
      .map(name => {
        const at = join(folder, name);
        const stat = lstatSync(at);
        return [name, stat.mode, stat.isDirectory() ? walk(at) : readFileSync(at).toString('base64')];
      });
  return JSON.stringify(walk(path));
}

async function refused(target: Awaited<ReturnType<typeof targetWorld>>, made: Awaited<ReturnType<typeof hostile>>) {
  const before = disk(target.root);
  await expect(target.importer.import(made.offerId, made.request)).rejects.toBeDefined();
  expect(target.started.length).toBe(0);
  expect(disk(target.root) === before).toBe(true);
}

describe('MUST 1: authenticated source selected independently of the header', () => {
  test('a valid signature from a different machine is refused before writes', async () => {
    const w = await world();
    const t = await targetWorld({}, w.fixture.remote);
    const made = await t.carry(w);
    const before = disk(t.root);
    await expect(
      t.importer.import(made.offerId, { header: made.header, sourceDaemonId: (await newIdentity()).daemonId }),
    ).rejects.toBeDefined();
    expect(t.started.length).toBe(0);
    expect(disk(t.root) === before).toBe(true);
  });
  test('an ephemeral key and ciphertext cannot authenticate a forged claimed sender', async () => {
    const w = await world();
    const t = await targetWorld({}, w.fixture.remote);
    const made = await t.carry(w);
    const forged = (await newIdentity()).daemonId;
    await expect(
      t.importer.import(made.offerId, { header: { ...made.header, sourceDaemonId: forged }, sourceDaemonId: forged }),
    ).rejects.toBeDefined();
    expect(t.started.length).toBe(0);
  });
});

describe('MUST 2: hostile remote, tree, mode, patch and repo-local programs', () => {
  for (const remote of [
    'file:///tmp/hostile.git',
    '/tmp/hostile.git',
    '../hostile.git',
    'ext::sh -c touch-marker',
    'git://127.0.0.1/repo',
    'http://127.0.0.1/repo',
  ])
    test(`refuses remote ${remote.split(':')[0]}`, async () => {
      const fixture = makeRepository();
      const t = await targetWorld({}, fixture.remote);
      const head = git(t.repo, 'rev-parse', 'HEAD').trim();
      const made = await hostile(t, { head, needs: { remote } });
      made.request.cloneInto = t.root;
      await refused(t, made);
    });
  for (const path of ['../outside', '/tmp/escape', '.git/config', 'dir/.git/config'])
    test(`refuses a patch to ${path}`, async () => {
      const fixture = makeRepository();
      const t = await targetWorld({}, fixture.remote);
      const head = git(t.repo, 'rev-parse', 'HEAD').trim();
      const patch = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+hostile\n`;
      await refused(
        t,
        await hostile(t, { head, extra: [{ kind: 'worktree-changes', path: 'changes.diff', bytes: bytes(patch) }] }),
      );
    });
  for (const mode of ['160000', '120000'])
    test(`refuses a hostile ${mode} tree before checkout`, async () => {
      const fixture = makeRepository();
      const t = await targetWorld({}, fixture.remote);
      const source = fixture.folder;
      if (mode === '160000')
        git(
          source,
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,${git(source, 'rev-parse', 'HEAD').trim()},submodule`,
        );
      else {
        const file = join(source, 'link-target');
        writeFileSync(file, '../../outside');
        const hash = git(source, 'hash-object', '-w', file).trim();
        git(source, 'update-index', '--add', '--cacheinfo', `120000,${hash},escape`);
      }
      git(source, 'commit', '-q', '-m', 'hostile tree');
      const head = git(source, 'rev-parse', 'HEAD').trim();
      const bundle = join(source, '..', 'hostile.bundle');
      git(source, 'bundle', 'create', bundle, 'HEAD', '--not', '--remotes');
      await refused(
        t,
        await hostile(t, {
          head,
          extra: [{ kind: 'worktree-commits', path: 'commits.bundle', bytes: new Uint8Array(readFileSync(bundle)) }],
        }),
      );
    });
  test('repo-local checkout filters, fsmonitor and hooks never execute', async () => {
    const w = await world();
    const marker = join(w.fixture.folder, '..', 'marker');
    writeFileSync(join(w.fixture.folder, '.gitattributes'), '*.txt filter=hostile\n');
    git(w.fixture.folder, 'add', '.gitattributes');
    git(w.fixture.folder, 'commit', '-q', '-m', 'attributes');
    const t = await targetWorld({}, w.fixture.remote);
    for (const key of ['filter.hostile.smudge', 'filter.hostile.process', 'core.fsmonitor', 'core.sshCommand'])
      git(t.repo, 'config', key, `touch ${marker}`);
    const hooks = join(t.repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const made = await t.carry(w);
    await t.importer.import(made.offerId, { header: made.header, sourceDaemonId: w.sourceIdentity.daemonId });
    expect(existsSync(marker)).toBe(false);
  });
});

describe('MUST 3: rollback owns only quarantine bytes', () => {
  test('even a successful move leaves the user repo byte-identical, objects included', async () => {
    const w = await world();
    const t = await targetWorld({}, w.fixture.remote);
    const before = disk(t.repo);
    const made = await t.carry(w);
    await t.importer.import(made.offerId, { header: made.header, sourceDaemonId: w.sourceIdentity.daemonId });
    expect(disk(t.repo) === before).toBe(true);
  });
  test('a late failure never prunes an unrelated worktree registration', async () => {
    const w = await world();
    const t = await targetWorld({ start: 'refuse' }, w.fixture.remote);
    const unrelated = join(t.root, 'unrelated');
    git(t.repo, 'worktree', 'add', '-b', 'unrelated', unrelated);
    rmSync(unrelated, { recursive: true });
    const before = disk(t.repo);
    const made = await t.carry(w);
    await expect(
      t.importer.import(made.offerId, { header: made.header, sourceDaemonId: w.sourceIdentity.daemonId }),
    ).rejects.toBeDefined();
    expect(disk(t.repo) === before).toBe(true);
  });
  test('a late launch refusal leaves the existing repo byte-identical, objects included', async () => {
    const w = await world();
    const t = await targetWorld({ start: 'refuse' }, w.fixture.remote);
    const before = disk(t.root);
    const made = await t.carry(w);
    await expect(
      t.importer.import(made.offerId, { header: made.header, sourceDaemonId: w.sourceIdentity.daemonId }),
    ).rejects.toBeDefined();
    expect(disk(t.root) === before).toBe(true);
  });
  test('a branch created concurrently before checkout survives a later failure', async () => {
    const w = await world();
    let repo = '';
    let branch = '';
    const t = await targetWorld(
      {
        wrapCheckout: real => ({
          ...real,
          addWorktree: async (_repo, _path, at) => {
            branch = at.branch as string;
            git(repo, 'branch', branch);
            throw new Error('injected race');
          },
        }),
      },
      w.fixture.remote,
    );
    repo = t.repo;
    const made = await t.carry(w);
    await expect(
      t.importer.import(made.offerId, { header: made.header, sourceDaemonId: w.sourceIdentity.daemonId }),
    ).rejects.toBeDefined();
    expect(git(t.repo, 'branch', '--list', branch)).toContain(branch);
  });
  test('a folder created concurrently at the intended checkout path is never removed', async () => {
    const w = await world();
    let folder = '';
    const t = await targetWorld(
      {
        start: 'refuse',
        wrapCheckout: real => ({
          ...real,
          prepare: async (source, path) => {
            // Simulate the competing creator before the exclusive claim, outside our owned directory.
            folder = path;
            mkdirSync(path);
            writeFileSync(join(path, 'owned-by-other'), 'preserve');
            return await real.prepare(source, path);
          },
        }),
      },
      w.fixture.remote,
    );
    const made = await t.carry(w);
    await expect(
      t.importer.import(made.offerId, { header: made.header, sourceDaemonId: w.sourceIdentity.daemonId }),
    ).rejects.toBeDefined();
    expect(existsSync(join(folder, 'owned-by-other'))).toBe(true);
  });
  test('cleanup failure is reported rather than swallowed', async () => {
    const w = await world();
    const t = await targetWorld(
      {
        start: 'refuse',
        wrapCheckout: real => ({
          ...real,
          prepare: async (...args) => {
            const stage = await real.prepare(...args);
            return {
              ...stage,
              cleanup: async () => {
                throw new Error('cleanup unavailable');
              },
            };
          },
        }),
      },
      w.fixture.remote,
    );
    const made = await t.carry(w);
    await expect(
      t.importer.import(made.offerId, { header: made.header, sourceDaemonId: w.sourceIdentity.daemonId }),
    ).rejects.toMatchObject({ code: 'cleanup_failed' });
  });
});

test('MUST 4: a provenance failure reports the actual admitted launch and keeps its files', async () => {
  const w = await world();
  const t = await targetWorld({ recordFails: true, stopFails: true }, w.fixture.remote);
  const made = await t.carry(w);
  const result = await t.importer.import(made.offerId, {
    header: made.header,
    sourceDaemonId: w.sourceIdentity.daemonId,
  });
  expect(result.recovery?.state).toBe('running');
  expect(result.ferretId).toBeDefined();
  expect(existsSync(join(result.folder, 'new.txt'))).toBe(true);
  expect(t.stopped).toEqual([]);
});

for (const actualState of ['stopped', 'unavailable'] as const)
  test(`MUST 4: post-launch provenance receipt reports ${actualState} honestly`, async () => {
    const w = await world();
    const t = await targetWorld({ recordFails: true, actualState }, w.fixture.remote);
    const made = await t.carry(w);
    const done = await t.importer.import(made.offerId, {
      header: made.header,
      sourceDaemonId: w.sourceIdentity.daemonId,
    });
    expect(done.recovery?.state).toBe(actualState === 'unavailable' ? 'unknown' : 'stopped');
  });

for (const area of ['conversation', 'session', 'journal', 'untracked', 'diff', 'git history'] as const)
  test(`MUST 5: a known secret in ${area} refuses export with name and file only`, async () => {
    const known = 'SYNTHETIC-KNOWN-ONLY-2649';
    const w = await world({
      knownSecrets: new Map([['DEPLOY_TOKEN', known]]),
      ...(area === 'conversation'
        ? {
            conversation: {
              ok: true,
              value: { relPath: 'transcript.jsonl', bytes: bytes(`line ${known}\n`) },
            } as const,
          }
        : {}),
      ...(area === 'session' ? { extra: { 'turns/leak.md': `line ${known}\n` } } : {}),
      ...(area === 'journal' ? { history: `{"text":"${known}"}\n` } : {}),
    });
    if (area === 'untracked') writeFileSync(join(w.fixture.folder, 'innocent.txt'), known);
    if (area === 'diff') writeFileSync(join(w.fixture.folder, 'tracked.txt'), known);
    if (area === 'git history') {
      writeFileSync(join(w.fixture.folder, 'innocent.txt'), known);
      git(w.fixture.folder, 'add', 'innocent.txt');
      git(w.fixture.folder, 'commit', '-q', '-m', 'private blob');
    }
    let error: unknown;
    try {
      await w.relocation.export(FERRET, (await w.offer()).offer);
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof Error).toBe(true);
    const message = error instanceof Error ? error.message : '';
    expect(message.includes(known)).toBe(false);
    expect(message).toContain('DEPLOY_TOKEN');
  });

test('MUST 6: real source launch secret names reach target preflight and import', async () => {
  const w = await world({
    secretNames: ['MCP_TOKEN', 'ENV_TOKEN'],
    profileSecrets: ['PROFILE_TOKEN'],
    runtime: 'source-runtime',
  });
  const t = await targetWorld({}, w.fixture.remote);
  const preflight = await w.relocation.preflight(FERRET, t.daemonId);
  expect(preflight.needs.secrets).toEqual(['ENV_TOKEN', 'MCP_TOKEN', 'PROFILE_TOKEN']);
  const made = await t.carry(w);
  const before = disk(t.root);
  await expect(
    t.importer.import(made.offerId, { header: made.header, sourceDaemonId: w.sourceIdentity.daemonId }),
  ).rejects.toBeDefined();
  expect(t.started.length).toBe(0);
  expect(disk(t.root) === before).toBe(true);
});
