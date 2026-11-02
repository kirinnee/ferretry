import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileLocalSkillInstallStore } from '../../../src/adapters/local-skill-installs/file-store.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import {
  EMPTY_LOCAL_SKILL_INSTALL_STATE,
  type LocalSkillInstallState,
  LocalSkillInstallStateError,
} from '../../../src/lib/local-skill-installs/store.ts';

const DOCUMENT = 'local-skill-installs.json';
const SHA = 'a'.repeat(64);
const homes = new Set<string>();

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-local-skill-installs-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  return {
    file: join(paths.state, DOCUMENT),
    directory: paths.state,
    store: new FileLocalSkillInstallStore(paths, new StateFileSystem(paths)),
  };
}

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

const SOME_STATE: LocalSkillInstallState = {
  schemaVersion: 1,
  installs: [
    {
      installId: `lsi_${'i'.repeat(22)}` as never,
      installedAt: '2026-11-02T09:00:00.000Z',
      name: 'demo',
      origin: { kind: 'account', owner: 'claude-work', harness: 'claude', path: '/h/skills/demo/SKILL.md' },
      provenance: {
        publisher: `fy_daemon_${'0'.repeat(43)}`,
        publisherName: 'This machine',
        catalogId: `cat_${'0'.repeat(22)}`,
        catalogName: 'Skills on this machine',
        itemId: `itm_${'s'.repeat(22)}`,
        kind: 'skill',
        name: 'demo',
        version: 1,
        digest: `sha256:${SHA}`,
      } as never,
      target: { scope: 'project', projectRoot: '/srv/app', harness: 'claude' },
      destination: '/srv/app/.claude/skills/demo/ (1 file)',
      key: 'project:/srv/app/.claude/skills/demo',
      files: [{ path: '.claude/skills/demo/SKILL.md', sha256: SHA }],
      root: '/srv/app',
      folder: '.claude/skills/demo',
    },
  ],
};

describe('FileLocalSkillInstallStore', () => {
  it('should answer the empty state for a state home that never copied anything', async () => {
    const { store } = await fixture();

    should(await store.read()).deepEqual(EMPTY_LOCAL_SKILL_INSTALL_STATE);
  });

  it('should read back exactly what it wrote, in a file only its owner can read or write', async () => {
    const { store, file } = await fixture();

    await store.write(SOME_STATE);

    should(await store.read()).deepEqual(SOME_STATE);
    should((await stat(file)).mode & 0o777).equal(0o600);
  });

  it('should write by temp and rename, leaving no temporary file beside the record', async () => {
    const { store, directory } = await fixture();

    await store.write(SOME_STATE);
    await store.write(EMPTY_LOCAL_SKILL_INSTALL_STATE);

    should((await readdir(directory)).filter(name => name.includes('local-skill-installs'))).deepEqual([DOCUMENT]);
    should(await readFile(join(directory, DOCUMENT), 'utf8')).equal(
      `${JSON.stringify(EMPTY_LOCAL_SKILL_INSTALL_STATE, undefined, 2)}\n`,
    );
  });

  it('should refuse a file that is not JSON, without echoing any of it', async () => {
    const { store, file } = await fixture();
    await store.write(EMPTY_LOCAL_SKILL_INSTALL_STATE);
    await writeFile(file, '{ secret-looking-garbage', 'utf8');

    const error = await store.read().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    should(error).be.instanceOf(LocalSkillInstallStateError);
    should((error as Error).message).equal(`${DOCUMENT} is not JSON, so no copy was changed`);
    should((error as Error).message).not.containEql('secret-looking-garbage');
  });

  it('should refuse JSON that is not a record of copies, rather than call it empty', async () => {
    const { store, file } = await fixture();
    await store.write(EMPTY_LOCAL_SKILL_INSTALL_STATE);
    await writeFile(file, JSON.stringify({ schemaVersion: 2, installs: [] }), 'utf8');

    const error = await store.read().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    should(error).be.instanceOf(LocalSkillInstallStateError);
    should((error as Error).message).equal(
      `${DOCUMENT} is not a record of copies this daemon writes, so no copy was changed`,
    );
  });
});
