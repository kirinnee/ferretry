import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SignInRulesDocument } from '@ferretry/protocol';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileSignInRuleStore } from '../../../src/adapters/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';

/**
 * The owner's standing sign-in rules over a REAL state home (r3c-plan §5, invariant 8): a private folder, an atomic
 * private file, strict reads, a damaged file moved aside and never deleted, and no symbolic link followed.
 */

const EMPTY: SignInRulesDocument = { v: 1, rules: [] };
const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-sign-in-rules-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const directory = join(paths.state, 'accounts');
  const file = join(directory, 'sign-in-rules.json');
  return { home, paths, directory, file, store: new FileSignInRuleStore(directory, new StateFileSystem(paths)) };
}

const outcome = async (work: Promise<unknown>): Promise<string> =>
  await work.then(
    () => 'done',
    () => 'threw',
  );

describe('FileSignInRuleStore over a real state home', () => {
  it('should read nothing before the first write, then write atomically: folder 0700, file 0600', async () => {
    // Arrange
    const { directory, file, store } = await fixture();

    // Act
    const before = await store.read();
    await store.write(EMPTY);

    // Assert
    should(before).be.undefined();
    should(await store.read()).eql(EMPTY);
    should(JSON.parse(await readFile(file, 'utf8'))).eql(EMPTY);
    should((await stat(directory)).mode & 0o777).equal(0o700);
    should((await stat(file)).mode & 0o777).equal(0o600);
    // Nothing half-written is left beside it.
    should(await readdir(directory)).eql(['sign-in-rules.json']);
  });

  it('should throw on a damaged file, then move it aside before a fresh write, never deleting it', async () => {
    // Arrange
    const { directory, file, store } = await fixture();
    await store.write(EMPTY);
    await writeFile(file, '{"v":1,"rules":[{"body":');

    // Act
    const read = await outcome(store.read());
    await store.setAside('2026-11-01T12-00-00-000Z');
    await store.write(EMPTY);

    // Assert
    should(read).equal('threw');
    should(await readFile(join(directory, 'sign-in-rules.json.damaged-2026-11-01T12-00-00-000Z'), 'utf8')).equal(
      '{"v":1,"rules":[{"body":',
    );
    should(JSON.parse(await readFile(file, 'utf8'))).eql(EMPTY);
    should((await stat(join(directory, 'sign-in-rules.json.damaged-2026-11-01T12-00-00-000Z'))).mode & 0o777).equal(
      0o600,
    );
  });

  it('should refuse a version it does not know, and an unknown key, rather than read them as no rules', async () => {
    const { file, store } = await fixture();
    await store.write(EMPTY);
    for (const text of ['{"v":2,"rules":[]}', '{"v":1,"rules":[],"extra":true}']) {
      await writeFile(file, text);
      should(await outcome(store.read())).equal('threw');
    }
  });

  it('should throw on a read error that is not a missing file', async () => {
    const { file, store } = await fixture();
    await mkdir(file, { recursive: true });
    should(await outcome(store.read())).equal('threw');
  });

  it('should refuse a symlinked rules file, and a symlinked folder, without touching their targets', async () => {
    // Arrange — the targets live outside the state home
    const linkedFile = await fixture();
    const outsideFile = join(linkedFile.home, 'outside.json');
    await writeFile(outsideFile, JSON.stringify(EMPTY));
    await mkdir(linkedFile.directory, { recursive: true });
    await symlink(outsideFile, linkedFile.file);
    const linkedFolder = await fixture();
    const outsideFolder = await mkdtemp(join(tmpdir(), 'ferretry-sign-in-rules-outside-'));
    homes.add(outsideFolder);
    await mkdir(linkedFolder.paths.state, { recursive: true });
    await symlink(outsideFolder, linkedFolder.directory, 'dir');

    // Act
    const results = [
      await outcome(linkedFile.store.read()),
      await outcome(linkedFile.store.write(EMPTY)),
      await outcome(linkedFolder.store.read()),
      await outcome(linkedFolder.store.write(EMPTY)),
      await outcome(linkedFolder.store.setAside('stamp')),
    ];

    // Assert
    should(results).eql(['threw', 'threw', 'threw', 'threw', 'threw']);
    should(await readFile(outsideFile, 'utf8')).equal(JSON.stringify(EMPTY));
    should(await readdir(outsideFolder)).eql([]);
  });
});
