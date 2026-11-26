/**
 * `scripts/local/move-repo.sh` and the `repo-owner-single-source` contract, on SYNTHETIC git copies of the files they read.
 * Nothing here touches this checkout, GitHub or another repository: every run is in a throwaway directory.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repository = join(import.meta.dir, '../..');
const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/** Every tracked workspace manifest: the dispatcher derives the names from them. */
function manifests(): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '--', 'packages/*package.json'], { cwd: repository });
  return listed.stdout
    .toString()
    .split('\n')
    .filter(file => file !== '' && !file.includes('node_modules'));
}

const TRACKED = [
  'package.json',
  '.goreleaser.yaml',
  'Casks',
  'INSTALLATION.md',
  'docs/updating.md',
  'scripts/release/install.sh',
  'scripts/validate/cli-contracts.sh',
  'scripts/local/move-repo.sh',
  'packages/plugins/updates/contract/release.ts',
  'packages/plugins/claude-code/daemon/lib/update/recipes.ts',
  'packages/plugins/codex/daemon/lib/update/version.ts',
];

/** A throwaway git checkout of the files the move reads, plus files the move must leave alone. */
function checkout(mutate: (path: (file: string) => string) => void = () => {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'repo-move-'));
  scratch.push(directory);
  const copy = (file: string) => {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    cpSync(join(repository, file), join(directory, file), { recursive: true });
  };
  for (const file of TRACKED) copy(file);
  for (const manifest of manifests()) copy(manifest);
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), text);
  };
  put('Changelog.md', 'see https://github.com/kirinnee/ferretry/pull/1\n');
  put(
    'docs/other.md',
    'https://github.com/kirinnee/pitwall and GitHub · kirinnee and apt.fury.io/kirinnee97/ and kirinnee/ferretry-b168 and kirinnee/ferretry.tools\n',
  );
  put(
    'docs/own.md',
    'ssh github-personal:kirinnee/ferretry.git and https://raw.githubusercontent.com/kirinnee/ferretry/main/x.sh and kirinnee/ferretry.\n',
  );
  put('packages/x/tests/fixture.ts', "export const url = 'https://github.com/kirinnee/ferretry/releases/tag/v1';\n");
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: directory });
  git('init', '-q', '.');
  git('add', '-A');
  mutate(file => join(directory, file));
  git('add', '-A');
  return directory;
}

function run(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(['bash', join(directory, 'scripts/local/move-repo.sh'), ...args], {
    cwd: directory,
    env: process.env,
  });
  return { status: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function contract(directory: string) {
  const result = Bun.spawnSync(
    ['bash', join(directory, 'scripts/validate/cli-contracts.sh'), 'repo-owner-single-source'],
    {
      cwd: directory,
      env: process.env,
    },
  );
  return { status: result.exitCode, err: result.stderr.toString() };
}

const read = (directory: string, file: string) => readFileSync(join(directory, file), 'utf8');

describe('the repo-owner-single-source contract', () => {
  test('this checkout passes', () => {
    expect(contract(checkout()).status).toBe(0);
  });

  test('a hand-written foreign owner on this repository’s name is refused, and named', () => {
    const directory = checkout(p =>
      writeFileSync(p('docs/other.md'), 'brew tap someone-else/ferretry https://github.com/someone-else/ferretry\n'),
    );
    const result = contract(directory);
    expect(result.status).not.toBe(0);
    expect(result.err).toContain('docs/other.md');
    expect(result.err).toContain('someone-else');
  });

  test('a stale RELEASE_OWNER, installer or goreleaser owner is refused', () => {
    const edit = (file: string, from: string, to: string) => (p: (f: string) => string) =>
      writeFileSync(p(file), readFileSync(p(file), 'utf8').replace(from, to));
    expect(
      contract(
        checkout(
          edit('packages/plugins/updates/contract/release.ts', "RELEASE_OWNER = 'kirinnee'", "RELEASE_OWNER = 'other'"),
        ),
      ).status,
    ).not.toBe(0);
    expect(
      contract(checkout(edit('scripts/release/install.sh', 'REPO="kirinnee/ferretry"', 'REPO="other/ferretry"')))
        .status,
    ).not.toBe(0);
    expect(contract(checkout(edit('.goreleaser.yaml', 'owner: kirinnee', 'owner: other'))).status).not.toBe(0);
  });

  test('a foreign owner in a raw.githubusercontent.com installer URL is refused, and named', () => {
    const directory = checkout(p =>
      writeFileSync(
        p('docs/other.md'),
        'curl https://raw.githubusercontent.com/someone-else/ferretry/main/install.sh\n',
      ),
    );
    const result = contract(directory);
    expect(result.status).not.toBe(0);
    expect(result.err).toContain('docs/other.md');
    expect(result.err).toContain('someone-else');
  });

  test('a release URL that spells the PRODUCT name as the repository, or a stale RELEASE_REPO, is refused', () => {
    const edit = (file: string, from: string, to: string) => (p: (f: string) => string) =>
      writeFileSync(p(file), readFileSync(p(file), 'utf8').replace(from, to));
    const release = 'packages/plugins/updates/contract/release.ts';
    expect(contract(checkout(edit(release, "RELEASE_REPO = 'ferretry'", "RELEASE_REPO = 'other'"))).status).not.toBe(0);
    const spelled = contract(
      checkout(p =>
        writeFileSync(
          p('packages/x/release.ts'),
          'export const url = (product: string) => `https://github.com/${RELEASE_OWNER}/${product}/releases`;\n',
        ),
      ),
    );
    expect(spelled.status).not.toBe(0);
    expect(spelled.err).toContain('packages/x/release.ts');
  });

  test('a package.json without a repository is refused', () => {
    const directory = checkout(p =>
      writeFileSync(p('package.json'), readFileSync(p('package.json'), 'utf8').replace(/ {2}"repository".*\n/u, '')),
    );
    expect(contract(directory).status).not.toBe(0);
  });
});

describe('scripts/local/move-repo.sh', () => {
  test('refuses no arguments and a malformed owner or repo, changing nothing', () => {
    const directory = checkout();
    expect(run(directory).status).toBe(2);
    expect(run(directory, '--owner', 'bad owner').status).toBe(2);
    expect(run(directory, '--repo', '-x').status).toBe(2);
    expect(read(directory, 'package.json')).toContain('github:kirinnee/ferretry');
  });

  test('a dry run lists the files and writes nothing', () => {
    const directory = checkout();
    const before = read(directory, 'Casks/ferretry.rb');
    const result = run(directory, '--owner', 'newco');
    expect(result.status).toBe(0);
    expect(result.out).toContain("'kirinnee/ferretry' -> 'newco/ferretry'");
    expect(result.out).toContain('Casks/ferretry.rb');
    expect(result.out).toContain('dry run');
    expect(read(directory, 'Casks/ferretry.rb')).toBe(before);
    expect(read(directory, 'package.json')).toContain('github:kirinnee/ferretry');
    expect(contract(directory).status).toBe(0);
  });

  test('--apply moves the owner everywhere it is spelled, and the contract passes on the new slug', () => {
    const directory = checkout();
    const result = run(directory, '--owner', 'newco', '--repo', 'fy-home', '--apply');
    expect(result.status).toBe(0);
    expect(result.out).toContain('move complete');
    expect(JSON.parse(read(directory, 'package.json')).repository).toBe('github:newco/fy-home');
    expect(read(directory, 'Casks/ferretry.rb')).toContain('https://github.com/newco/fy-home/releases/download/');
    expect(read(directory, 'scripts/release/install.sh')).toContain('REPO="newco/fy-home"');
    expect(read(directory, '.goreleaser.yaml')).toMatch(/owner: newco\n\s+name: fy-home/u);
    expect(read(directory, 'packages/plugins/updates/contract/release.ts')).toContain("RELEASE_OWNER = 'newco'");
    expect(read(directory, 'packages/plugins/codex/daemon/lib/update/version.ts')).toContain(
      'github.com/newco/fy-home/',
    );
    expect(read(directory, 'INSTALLATION.md')).toContain('github:newco/fy-home');
    expect(read(directory, 'packages/x/tests/fixture.ts')).toContain('github.com/newco/fy-home/releases');
    // What is not this repository's slug stays: history, another repository, an account label, a longer repo name, the Gemfury account.
    expect(read(directory, 'Changelog.md')).toContain('kirinnee/ferretry');
    expect(read(directory, 'docs/other.md')).toBe(
      'https://github.com/kirinnee/pitwall and GitHub · kirinnee and apt.fury.io/kirinnee97/ and kirinnee/ferretry-b168 and kirinnee/ferretry.tools\n',
    );
    // The slug is rewritten at a `.git` remote, a raw.githubusercontent.com path and a sentence end — but never at a `.tools` sibling.
    expect(read(directory, 'docs/own.md')).toBe(
      'ssh github-personal:newco/fy-home.git and https://raw.githubusercontent.com/newco/fy-home/main/x.sh and newco/fy-home.\n',
    );
    // The release URLs are built from the repository name, not the product name.
    expect(read(directory, 'packages/plugins/updates/contract/release.ts')).toContain("RELEASE_REPO = 'fy-home'");
    expect(contract(directory).status).toBe(0);
    expect(existsSync(join(directory, 'package.json.tmp'))).toBe(false);
  });

  test('moving only the owner keeps ${product} derived, and a second move is a no-op', () => {
    const directory = checkout();
    expect(run(directory, '--owner', 'newco', '--apply').status).toBe(0);
    expect(read(directory, 'packages/plugins/codex/daemon/lib/update/version.ts')).toContain('newco/${product}');
    const again = run(directory, '--owner', 'newco', '--apply');
    expect(again.status).toBe(0);
    expect(again.out).toContain('nothing to move');
  });
});
