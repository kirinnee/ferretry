import { expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { kernelWorkingTree } from '../../daemon/lib/git-bundle.ts';
import { assertSnapshotSize, plan } from '../../daemon/lib/snapshot.ts';
import { FERRET, fakeSource, summaryOf } from '../support/fake-ferrets.ts';
import { git, realKernel } from '../support/real-git.ts';
import { crypto } from '../support/identity.ts';
import { world } from '../support/world.ts';

for (const path of ['tokens.json', 'environment.json', '.claude/settings.json', 'nested/.codex/log']) {
  test(`MUST 1 refuses tracked credential path ${path} even in deleted history`, async () => {
    const w = await world();
    mkdirSync(join(w.fixture.folder, path, '..'), { recursive: true });
    writeFileSync(join(w.fixture.folder, path), 'SYNTHETIC-DO-NOT-EXPORT');
    git(w.fixture.folder, 'add', '-f', path);
    git(w.fixture.folder, 'commit', '-qm', 'synthetic private file');
    git(w.fixture.folder, 'rm', '-q', path);
    git(w.fixture.folder, 'commit', '-qm', 'remove private file');
    const view = await w.relocation.preflight(FERRET, w.targetIdentity.daemonId);
    expect(view.ok).toBe(false);
    await expect(w.relocation.export(FERRET, (await w.offer()).offer)).rejects.toThrow();
    expect(w.ferrets.calls).toEqual([]);
  });
}

test('MUST 1 refuses tracked links and repository scope above the working folder', async () => {
  const w = await world();
  symlinkSync('tracked.txt', join(w.fixture.folder, 'link'));
  git(w.fixture.folder, 'add', 'link');
  git(w.fixture.folder, 'commit', '-qm', 'link');
  expect((await w.relocation.preflight(FERRET, w.targetIdentity.daemonId)).ok).toBe(false);
  mkdirSync(join(w.fixture.folder, 'sub'));
  await expect(kernelWorkingTree(realKernel(), join(w.fixture.folder, 'sub')).head()).rejects.toThrow();
});

test('MUST 1 withholds environment, tokens and harness homes in untracked paths', async () => {
  const w = await world();
  for (const path of ['nested/environment.json', 'tokens.json', '.claude/settings.json', '.codex/log']) {
    mkdirSync(join(w.fixture.folder, path, '..'), { recursive: true });
    writeFileSync(join(w.fixture.folder, path), 'SYNTHETIC');
  }
  const view = await w.relocation.preflight(FERRET, w.targetIdentity.daemonId);
  expect(view.withheld).toEqual(
    expect.arrayContaining(['nested/environment.json', 'tokens.json', '.claude/settings.json', '.codex/log']),
  );
});

test('MUST 2 a busy source starts no conversation, listing or git read', async () => {
  let reads = 0;
  const source = {
    ...fakeSource({ busy: ['busy'] }),
    conversation: async () => {
      reads++;
      throw new Error('read');
    },
    files: async () => {
      reads++;
      return [];
    },
  };
  const found = await plan({ summary: summaryOf('idle'), source, tree: undefined });
  expect(found.refusals).toEqual(['busy']);
  expect(reads).toBe(0);
});

test('MUST 2 an unsupported harness starts no listing or git read', async () => {
  let reads = 0;
  const source = {
    ...fakeSource({ conversation: { ok: false, error: { reason: 'unsupported' } } }),
    files: async () => {
      reads++;
      return [];
    },
  };
  expect((await plan({ summary: summaryOf('idle'), source, tree: undefined })).refusals).toEqual(['unsupported']);
  expect(reads).toBe(0);
});

test('MUST 2 configured fsmonitor cannot run during preflight', async () => {
  const w = await world();
  const marker = join(w.fixture.folder, 'executed');
  const monitor = join(w.fixture.folder, '.git', 'monitor');
  writeFileSync(monitor, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o700 });
  git(w.fixture.folder, 'config', 'core.fsmonitor', monitor);
  await w.relocation.preflight(FERRET, w.targetIdentity.daemonId);
  expect(existsSync(marker)).toBe(false);
});

test('MUST 3 concurrent attempts consume one offer exactly once', async () => {
  const w = await world();
  const made = await w.offer();
  const results = await Promise.allSettled([
    w.relocation.export(FERRET, made.offer),
    w.relocation.export(FERRET, made.offer),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(w.ferrets.calls.filter(call => call === 'stop:polite')).toHaveLength(1);
});

test('MUST 3 a failed preflight still spends a verified offer', async () => {
  const w = await world({ busy: ['busy'] });
  const made = await w.offer();
  await expect(w.relocation.export(FERRET, made.offer)).rejects.toThrow('busy');
  await expect(w.relocation.export(FERRET, made.offer)).rejects.toThrow('already used');
});

test('MUST 4 refuses an unreadable or oversize untracked file by name', async () => {
  const source = fakeSource();
  const tree = {
    inspect: async () => {},
    remote: async () => undefined,
    head: async () => ({ head: 'a'.repeat(40) }),
    commits: async () => undefined,
    changes: async () => new Uint8Array(),
    untracked: async () => ['huge.bin'],
    ignoredTopLevel: async () => [],
    size: async () => undefined,
    read: async () => undefined,
  };
  const found = await plan({ summary: summaryOf('idle'), source, tree });
  expect(found.refusals.join(' ')).toContain('huge.bin');
});

test('MUST 4 final bytes including framing are capped before sealing despite growth', async () => {
  const w = await world({
    noTree: true,
    crypto: Object.assign(Object.create(crypto), {
      deriveSharedSecret: async () => {
        throw new Error('sealing started without a final cap check');
      },
    }) as typeof crypto,
  });
  const large = new Uint8Array(64 * 1024 * 1024);
  Object.assign(w.ferrets.port, {
    relocationSource: async () => ({
      ...fakeSource(),
      files: async () =>
        Array.from({ length: 8 }, (_, i) => ({ area: 'session', path: `attachments/${String(i)}`, size: 0 })),
      read: async () => large,
    }),
  });
  await expect(w.relocation.export(FERRET, (await w.offer()).offer)).rejects.toThrow('500');
  expect(w.ferrets.calls).toContain('resume');
}, 30_000);

test('MUST 5 a stop which throws after stopping is recovered', async () => {
  const w = await world();
  Object.assign(w.ferrets.port, {
    stop: async () => {
      w.ferrets.state = 'stopped';
      throw new Error('partial stop');
    },
  });
  await expect(w.relocation.export(FERRET, (await w.offer()).offer)).rejects.toThrow('partial stop');
  expect(w.ferrets.state).toBe('idle');
});

test('MUST 5 expiry resumes an unfinished export and releases capacity', async () => {
  const w = await world();
  const made = await w.relocation.export(FERRET, (await w.offer()).offer);
  w.now += 20 * 60_000;
  await expect(Promise.resolve().then(() => w.relocation.chunk(made.exportId, 0))).rejects.toThrow();
  // Trigger the expiry sweep through a public operation and allow recovery to finish.
  await w.relocation.preflight(FERRET, w.targetIdentity.daemonId);
  expect(w.ferrets.state).toBe('idle');
});

test('MUST 5 refused recovery stays reserved and is retried until resume succeeds', async () => {
  const w = await world();
  const made = await w.relocation.export(FERRET, (await w.offer()).offer);
  const resume = w.ferrets.port.resume;
  Object.assign(w.ferrets.port, { resume: async () => ({ ok: false, error: { reason: 'synthetic refusal' } }) });
  w.now += 20 * 60_000;
  await w.relocation.expire();
  expect(w.ferrets.state).toBe('stopped');
  await expect(w.relocation.export(FERRET, (await w.offer()).offer)).rejects.toThrow('another move');
  Object.assign(w.ferrets.port, { resume });
  await w.relocation.expire();
  expect(w.ferrets.state).toBe('idle');
  expect(() => w.relocation.chunk(made.exportId, 0)).toThrow();
});

test('MUST 2 timed out git is refused with the existing hardened controls and a held cwd', async () => {
  const w = await world();
  const kernel = realKernel();
  Object.assign(kernel.spawn, {
    runBytes: async (
      _program: string,
      args: readonly string[],
      options: { timeout: number; sealed: boolean; cwd: unknown },
    ) => {
      expect(args).toContain('core.fsmonitor=false');
      expect(args).toContain('core.hooksPath=/dev/null');
      expect(args).toContain('protocol.allow=never');
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.sealed).toBe(true);
      expect(typeof options.cwd).toBe('object');
      return {
        exitCode: -1,
        stdout: new Uint8Array(),
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: true,
      };
    },
  });
  await expect(kernelWorkingTree(kernel, w.fixture.folder).head()).rejects.toThrow('within its limits');
});

test('MUST 4 the manifest and length prefix count toward the final 500 MiB cap', () => {
  const bytes = new Uint8Array(10 * 1024 * 1024);
  const entries = Array.from({ length: 50 }, (_, index) => ({ kind: 'session' as const, path: String(index), bytes }));
  expect(() => assertSnapshotSize(entries)).not.toThrow();
  expect(() => assertSnapshotSize(entries, 4)).toThrow('500');
});

test('MUST 4 an untracked file growing after lstat is refused instead of truncated', async () => {
  const w = await world();
  const kernel = realKernel();
  const rootOf = kernel.roots.root.bind(kernel.roots);
  Object.assign(kernel.roots, {
    root: (...args: Parameters<typeof rootOf>) => {
      const root = rootOf(...args);
      return {
        ...root,
        lstat: async (path: Parameters<typeof root.lstat>[0]) => {
          const stat = await root.lstat(path);
          return stat?.kind === 'file' ? { ...stat, size: 1 } : stat;
        },
      };
    },
  });
  await expect(kernelWorkingTree(kernel, w.fixture.folder).read('new.txt', 4)).rejects.toThrow('new.txt');
});

test('MUST 1 replacement refs cannot conceal a credential-bearing historical tree from the audit', async () => {
  const w = await world();
  const folder = w.fixture.folder;
  const clean = git(folder, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(folder, 'tokens.json'), 'SYNTHETIC');
  git(folder, 'add', 'tokens.json');
  git(folder, 'commit', '-qm', 'synthetic private file');
  const privateCommit = git(folder, 'rev-parse', 'HEAD').trim();
  git(folder, 'rm', '-q', 'tokens.json');
  git(folder, 'commit', '-qm', 'remove private file');
  git(folder, 'replace', privateCommit, clean);
  expect((await w.relocation.preflight(FERRET, w.targetIdentity.daemonId)).ok).toBe(false);
  await expect(w.relocation.export(FERRET, (await w.offer()).offer)).rejects.toThrow();
  expect(w.ferrets.calls).toEqual([]);
});

test('MUST 1 tracked files with a second name outside the tree cannot enter a diff', async () => {
  const w = await world();
  linkSync(join(w.fixture.folder, 'tracked.txt'), join(w.fixture.folder, '..', 'synthetic-second-name'));
  expect((await w.relocation.preflight(FERRET, w.targetIdentity.daemonId)).ok).toBe(false);
  await expect(w.relocation.export(FERRET, (await w.offer()).offer)).rejects.toThrow();
  expect(w.ferrets.calls).toEqual([]);
});

test('MUST 2 repository clean filters cannot execute while reading a tracked diff', async () => {
  const w = await world();
  const marker = join(w.fixture.folder, '.git', 'filter-ran');
  const filter = join(w.fixture.folder, '.git', 'fixture-filter');
  writeFileSync(filter, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o700 });
  writeFileSync(join(w.fixture.folder, '.gitattributes'), '*.txt filter=fixture\n');
  git(w.fixture.folder, 'config', 'filter.fixture.clean', filter);
  const view = await w.relocation.preflight(FERRET, w.targetIdentity.daemonId);
  expect(existsSync(marker)).toBe(false);
  expect(view.ok).toBe(false);
});
