import { afterEach, describe, it } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';

/**
 * `scripts/local/move-repo.sh` and its gate `scripts/validate/repo-slug.sh`, on a throwaway repository
 * that carries one file of every kind the real tree has: a source constant, a cask, a doc, a test that
 * asserts a shipped address, a history file, and a link to one pull request.
 */

const MOVE = 'scripts/local/move-repo.sh';
const GATE = 'scripts/validate/repo-slug.sh';
const ALLOWLIST = 'scripts/validate/repo-slug-allowlist.txt';
const REPO_ROOT = join(import.meta.dir, '../../../../..');
const created: string[] = [];

type Files = Readonly<Record<string, string>>;

const FILES: Files = {
  'package.json': `${JSON.stringify({ name: 'ferretry', repository: 'github:oldco/ferretry' }, null, 2)}\n`,
  '.goreleaser.yaml': [
    'release:',
    '  github:',
    '    owner: oldco',
    '    name: ferretry',
    'homebrew_casks:',
    '  - repository:',
    '      owner: oldco',
    '      name: ferretry',
    '    homepage: https://github.com/oldco/ferretry',
    '',
  ].join('\n'),
  'packages/protocol/src/lib/daemon-update.ts': "export const RELEASE_OWNER = 'oldco';\n",
  'Casks/ferretry.rb': 'url "https://github.com/oldco/ferretry/releases/download/v#{version}/fy.tar.gz"\n',
  'INSTALLATION.md': [
    'brew tap oldco/ferretry https://github.com/oldco/ferretry',
    'nix profile install github:oldco/ferretry',
    'Gemfury stays: https://apt.fury.io/oldco97/ and ferretry-hosted-relay.oldco97.workers.dev',
    '',
  ].join('\n'),
  'scripts/release/install.sh': 'REPO="oldco/ferretry"\n',
  // A test that asserts a shipped address follows it in full; a generic fixture does not.
  'packages/protocol/tests/unit/daemon-update.test.ts': [
    "should(tap('ferretry')).equal('oldco/ferretry');",
    "const pr = 'https://github.com/oldco/ferretry/pull/42';",
    '',
  ].join('\n'),
  'packages/daemon/tests/unit/board/service.test.ts': "const pr = 'https://github.com/oldco/ferretry/pull/930';\n",
  'Changelog.md': 'Fixed in https://github.com/oldco/ferretry/issues/12\n',
  'docs/updating.md': 'See [PR](https://github.com/oldco/ferretry/pull/7) and `nix shell github:oldco/ferretry`.\n',
};

const ALLOW = [
  'history Changelog.md',
  'history scripts/validate/*',
  'history scripts/local/move-repo.sh',
  'fixture packages/*/tests/*',
  'follow packages/protocol/tests/unit/daemon-update.test.ts',
  '',
].join('\n');

const sh = (dir: string, args: readonly string[]): { readonly code: number; readonly out: string } => {
  const result = Bun.spawnSync(['bash', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode ?? -1, out: `${result.stdout.toString()}${result.stderr.toString()}` };
};

const repo = async (extra: Files = {}): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'move-repo-'));
  created.push(dir);
  for (const [path, text] of Object.entries({ ...FILES, ...extra, [ALLOWLIST]: ALLOW })) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  for (const script of [MOVE, GATE]) {
    await mkdir(dirname(join(dir, script)), { recursive: true });
    await cp(join(REPO_ROOT, script), join(dir, script));
  }
  const init = Bun.spawnSync(['git', 'init', '--quiet'], { cwd: dir });
  should(init.exitCode).equal(0);
  Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
  return dir;
};

const read = (dir: string, path: string): Promise<string> => readFile(join(dir, path), 'utf8');

const snapshot = async (dir: string): Promise<Readonly<Record<string, string>>> =>
  Object.fromEntries(await Promise.all(Object.keys(FILES).map(async path => [path, await read(dir, path)] as const)));

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('the repository move script', () => {
  it('should rewrite the single source and every address derived from it', async () => {
    const dir = await repo();
    const result = sh(dir, [MOVE, '--owner', 'newco']);
    should(result.code).equal(0);
    should(JSON.parse(await read(dir, 'package.json')).repository).equal('github:newco/ferretry');
    should(await read(dir, '.goreleaser.yaml'))
      .containEql('owner: newco')
      .and.not.containEql('oldco');
    should(await read(dir, 'packages/protocol/src/lib/daemon-update.ts')).equal(
      "export const RELEASE_OWNER = 'newco';\n",
    );
    should(await read(dir, 'Casks/ferretry.rb')).containEql('github.com/newco/ferretry/releases');
    should(await read(dir, 'scripts/release/install.sh')).equal('REPO="newco/ferretry"\n');
    const install = await read(dir, 'INSTALLATION.md');
    should(install).containEql('brew tap newco/ferretry https://github.com/newco/ferretry');
    should(install).containEql('github:newco/ferretry');
  });

  it('should leave the other accounts alone: Gemfury and workers.dev', async () => {
    const dir = await repo();
    should(sh(dir, [MOVE, '--owner', 'newco']).code).equal(0);
    should(await read(dir, 'INSTALLATION.md'))
      .containEql('apt.fury.io/oldco97/')
      .and.containEql('oldco97.workers.dev');
  });

  it('should leave history and links to one pull request alone, but let a shipped-address test follow in full', async () => {
    const dir = await repo();
    should(sh(dir, [MOVE, '--owner', 'newco']).code).equal(0);
    should(await read(dir, 'Changelog.md')).containEql('oldco/ferretry/issues/12');
    should(await read(dir, 'docs/updating.md')).containEql('github.com/oldco/ferretry/pull/7');
    should(await read(dir, 'docs/updating.md')).containEql('github:newco/ferretry');
    should(await read(dir, 'packages/daemon/tests/unit/board/service.test.ts')).containEql('oldco/ferretry/pull/930');
    const asserted = await read(dir, 'packages/protocol/tests/unit/daemon-update.test.ts');
    should(asserted).containEql("equal('newco/ferretry')").and.containEql('newco/ferretry/pull/42');
  });

  it('should change nothing when it runs a second time', async () => {
    const dir = await repo();
    should(sh(dir, [MOVE, '--owner', 'newco']).code).equal(0);
    const once = await snapshot(dir);
    const second = sh(dir, [MOVE, '--owner', 'newco']);
    should(second.code).equal(0);
    should(second.out).containEql('nothing to change');
    should(await snapshot(dir)).deepEqual(once);
  });

  it('should come back byte for byte when the owner is moved there and back', async () => {
    const dir = await repo();
    const before = await snapshot(dir);
    should(sh(dir, [MOVE, '--owner', 'newco']).code).equal(0);
    should(sh(dir, [MOVE, '--owner', 'oldco']).code).equal(0);
    should(await snapshot(dir)).deepEqual(before);
  });

  it('should refuse an owner that is not a GitHub login', async () => {
    const dir = await repo();
    should(sh(dir, [MOVE, '--owner', 'not/valid']).code).equal(2);
    should(sh(dir, [MOVE]).code).equal(2);
    should(await snapshot(dir)).deepEqual(FILES);
  });
});

describe('the repo-slug gate', () => {
  it('should pass a tree that names only the source owner', async () => {
    const dir = await repo();
    const result = sh(dir, [GATE]);
    should(result.out).containEql('oldco/ferretry');
    should(result.code).equal(0);
  });

  it('should fail a shipped file that names another owner, and say where', async () => {
    const dir = await repo({ 'docs/stray.md': 'clone it: git clone https://github.com/strayco/ferretry\n' });
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
    const result = sh(dir, [GATE]);
    should(result.code).equal(1);
    should(result.out).containEql('docs/stray.md:1').and.containEql('strayco/ferretry');
  });

  it('should fail a drifted GoReleaser owner and a drifted RELEASE_OWNER', async () => {
    const goreleaser = await repo({
      '.goreleaser.yaml': FILES['.goreleaser.yaml']?.replace('owner: oldco', 'owner: strayco') ?? '',
    });
    should(sh(goreleaser, [GATE]).out).containEql("GoReleaser owner is 'strayco'");
    const constant = await repo({
      'packages/protocol/src/lib/daemon-update.ts': "export const RELEASE_OWNER = 'strayco';\n",
    });
    const result = sh(constant, [GATE]);
    should(result.code).equal(1);
    should(result.out).containEql("RELEASE_OWNER is 'strayco'");
  });

  it('should not count a stray owner in an allowlisted file, a fixture or a pull-request link', async () => {
    const dir = await repo({
      'Changelog.md': 'https://github.com/strayco/ferretry/issues/1\n',
      'packages/daemon/tests/unit/board/service.test.ts': "const r = 'github.com/acme/ferretry';\n",
      'docs/history.md': 'merged in https://github.com/strayco/ferretry/pull/9\n',
    });
    should(sh(dir, [GATE]).code).equal(0);
  });

  it('should fail when the repository name is not the product name', async () => {
    const dir = await repo({
      'package.json': `${JSON.stringify({ name: 'ferretry', repository: 'github:oldco/other' })}\n`,
    });
    const result = sh(dir, [GATE]);
    should(result.code).equal(1);
    should(result.out).containEql('they stay equal');
  });
});
