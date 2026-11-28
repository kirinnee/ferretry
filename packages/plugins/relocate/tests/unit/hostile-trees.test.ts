import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitInput, makeRepository } from '../support/real-git.ts';
import { targetWorld } from '../support/target.ts';
import { bytes, hostile } from '../support/hostile.ts';

for (const entry of [
  { mode: '100644', path: '.git/config', content: 'unsafe' },
  { mode: '100644', path: '.GiT', content: 'unsafe' },
  { mode: '100644', path: '../escape', content: 'unsafe' },
  { mode: '100600', path: 'unsafe-mode', content: 'unsafe' },
  { mode: '120000', path: 'escaping-link', content: '../../outside' },
  { mode: '120000', path: 'absolute-link', content: '/tmp/outside' },
  { mode: '120000', path: 'dotgit-link', content: '.git/config' },
])
  test(`MUST 2 raw hostile pack: ${entry.mode} ${entry.path}`, async () => {
    const fixture = makeRepository();
    const t = await targetWorld({}, fixture.remote);
    const blob = gitInput(fixture.folder, bytes(entry.content), 'hash-object', '-w', '--stdin');
    const tree = gitInput(
      fixture.folder,
      Buffer.concat([Buffer.from(`${entry.mode} ${entry.path}\0`), Buffer.from(blob, 'hex')]),
      'hash-object',
      '-t',
      'tree',
      '-w',
      '--stdin',
      '--literally',
    );
    const head = gitInput(
      fixture.folder,
      bytes('hostile fixture\n'),
      'commit-tree',
      tree,
      '-p',
      git(fixture.folder, 'rev-parse', 'HEAD').trim(),
    );
    git(fixture.folder, 'update-ref', 'refs/heads/hostile', head);
    const bundle = join(fixture.folder, '..', 'malformed.bundle');
    git(fixture.folder, 'bundle', 'create', bundle, 'hostile');
    const made = await hostile(t, {
      head,
      extra: [{ kind: 'worktree-commits', path: 'commits.bundle', bytes: new Uint8Array(readFileSync(bundle)) }],
    });
    const before = t.shape();
    await expect(t.importer.import(made.offerId, made.request)).rejects.toBeDefined();
    expect(t.shape()).toEqual(before);
    expect(t.started.length).toBe(0);
  });

for (const mode of ['120000', '160000', '100600'])
  test(`MUST 2 hostile patch mode ${mode}`, async () => {
    const fixture = makeRepository();
    const t = await targetWorld({}, fixture.remote);
    const head = git(t.repo, 'rev-parse', 'HEAD').trim();
    const patch = `diff --git a/unsafe b/unsafe\nnew file mode ${mode}\n--- /dev/null\n+++ b/unsafe\n@@ -0,0 +1 @@\n+../../outside\n`;
    const made = await hostile(t, {
      head,
      extra: [{ kind: 'worktree-changes', path: 'changes.diff', bytes: bytes(patch) }],
    });
    const before = t.shape();
    await expect(t.importer.import(made.offerId, made.request)).rejects.toBeDefined();
    expect(t.shape()).toEqual(before);
    expect(t.started.length).toBe(0);
  });

test('MUST 2 allows ordinary executable modes and a symlink wholly within the imported tree', async () => {
  const fixture = makeRepository();
  const t = await targetWorld({}, fixture.remote);
  const head = git(t.repo, 'rev-parse', 'HEAD').trim();
  const patch =
    'diff --git a/readme-link b/readme-link\nnew file mode 120000\n--- /dev/null\n+++ b/readme-link\n@@ -0,0 +1 @@\n+README.md\n\\ No newline at end of file\n';
  const made = await hostile(t, {
    head,
    extra: [{ kind: 'worktree-changes', path: 'changes.diff', bytes: bytes(patch) }],
  });
  const done = await t.importer.import(made.offerId, made.request);
  expect(readFileSync(join(done.folder, 'readme-link'), 'utf8')).toBe('a project\n');
});
