/**
 * `scripts/local/move-repo.sh`, `scripts/local/rename.sh` and the `repo-owner-single-source` contract.
 * Most tests use SYNTHETIC git copies of the files the scripts read; the end-to-end ones copy the whole tracked tree.
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

// The SOURCE of every move below is this checkout's own repository slug and product, read from the root manifest, and the
// DESTINATION is chosen to differ from it: a hard-coded pair stops testing anything the day the repository really moves to it.
const rootManifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')) as {
  name: string;
  repository: string;
};
const [SOURCE_OWNER = '', SOURCE_REPO = ''] = rootManifest.repository.replace(/^github:/u, '').split('/');
const PRODUCT = rootManifest.name;
const SOURCE = `${SOURCE_OWNER}/${SOURCE_REPO}`;
const DEST_OWNER = SOURCE_OWNER === 'newco' ? 'otherco' : 'newco';
const DEST_REPO = SOURCE_REPO === 'fy-home' ? 'fy-away' : 'fy-home';
const DEST = `${DEST_OWNER}/${DEST_REPO}`;
const DEST_OWNER_ONLY = `${DEST_OWNER}/${SOURCE_REPO}`;

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
  put('Changelog.md', `see https://github.com/${SOURCE}/pull/1\n`);
  put(
    'docs/other.md',
    `https://github.com/${SOURCE_OWNER}/pitwall and GitHub · ${SOURCE_OWNER} and apt.fury.io/${SOURCE_OWNER}97/ and ${SOURCE}-b168 and ${SOURCE}.tools and ${SOURCE}.git.tools and ${SOURCE}.git-tools\n`,
  );
  put(
    'docs/own.md',
    `ssh github-personal:${SOURCE}.git and https://raw.githubusercontent.com/${SOURCE}/main/x.sh and ${SOURCE}.\n`,
  );
  // A shell default `${VAR:-<slug>}` is a slug too: the `-` after the colon is not part of a name.
  put('docs/default.sh', `repo="\${FY_REPO:-${SOURCE}}"\n`);
  put('packages/x/tests/fixture.ts', `export const url = 'https://github.com/${SOURCE}/releases/tag/v1';\n`);
  const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: directory });
  git('init', '-q', '.');
  git('add', '-A');
  mutate(file => join(directory, file));
  git('add', '-A');
  return directory;
}

/**
 * A throwaway git checkout of EVERY tracked file — what the repository's own gates run against — so the move and the
 * rename can be followed by the real contracts. Offline by construction: nothing here reads a network.
 */
function wholeCheckout(): string {
  const directory = mkdtempSync(join(tmpdir(), 'repo-move-whole-'));
  scratch.push(directory);
  const listed = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: repository }).stdout;
  const copied = Bun.spawnSync(['rsync', '-a', '--from0', '--files-from=-', '.', `${directory}/`], {
    cwd: repository,
    stdin: listed,
  });
  if (copied.exitCode !== 0) throw new Error(`rsync failed: ${copied.stderr.toString()}`);
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd: directory });
  git('init', '-q', '.');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'base');
  return directory;
}

/** Offline, on any machine: no gate below may reach for a network. */
const OFFLINE_ENV = { ...process.env, NIX_CONFIG: 'offline = true' };

function run(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(['bash', join(directory, 'scripts/local/move-repo.sh'), ...args], {
    cwd: directory,
    env: OFFLINE_ENV,
  });
  return { status: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function contract(directory: string, name = 'repo-owner-single-source') {
  const result = Bun.spawnSync(['bash', join(directory, 'scripts/validate/cli-contracts.sh'), name], {
    cwd: directory,
    env: OFFLINE_ENV,
  });
  return { status: result.exitCode, err: result.stderr.toString() };
}

/**
 * Every contract the dispatcher registers, but `release-notes-render`, which renders notes with npm packages a copy of
 * the tracked files has not installed — it reads no address, so a move cannot change it.
 */
function gates(directory: string): string[] {
  const listed = Bun.spawnSync(['bash', join(directory, 'scripts/validate/cli-contracts.sh'), 'list'], {
    cwd: directory,
  });
  return listed.stdout
    .toString()
    .split('\n')
    .filter(name => name !== '' && name !== 'release-notes-render');
}

/** The names of the gates that fail, with what they said. */
function failing(directory: string): string[] {
  return gates(directory).flatMap(name => {
    const result = contract(directory, name);
    return result.status === 0 ? [] : [`${name}: ${result.err.trim().split('\n').slice(0, 3).join(' / ')}`];
  });
}

/** The digest gate, exactly as pre-commit runs it. */
function digest(directory: string) {
  const result = Bun.spawnSync(['bash', join(directory, 'scripts/validate/bun-deps-hash.sh')], {
    cwd: directory,
    env: OFFLINE_ENV,
  });
  return { status: result.exitCode, err: result.stderr.toString() };
}

const read = (directory: string, file: string) => readFileSync(join(directory, file), 'utf8');

const edit = (file: string, from: string, to: string) => (p: (f: string) => string) =>
  writeFileSync(p(file), readFileSync(p(file), 'utf8').replace(from, to));

describe('the repo-owner-single-source contract', () => {
  test('this checkout passes', () => {
    expect(contract(checkout()).status).toBe(0);
  });

  test('a hand-written foreign owner on this repository’s name is refused, and named', () => {
    const directory = checkout(p =>
      writeFileSync(
        p('docs/other.md'),
        `brew tap someone-else/${SOURCE_REPO} https://github.com/someone-else/${SOURCE_REPO}\n`,
      ),
    );
    const result = contract(directory);
    expect(result.status).not.toBe(0);
    expect(result.err).toContain('docs/other.md');
    expect(result.err).toContain('someone-else');
  });

  test('a stale RELEASE_OWNER, installer or goreleaser owner is refused', () => {
    expect(
      contract(
        checkout(
          edit(
            'packages/plugins/updates/contract/release.ts',
            `RELEASE_OWNER = '${SOURCE_OWNER}'`,
            "RELEASE_OWNER = 'other'",
          ),
        ),
      ).status,
    ).not.toBe(0);
    expect(
      contract(checkout(edit('scripts/release/install.sh', `REPO="${SOURCE}"`, `REPO="other/${SOURCE_REPO}"`))).status,
    ).not.toBe(0);
    expect(contract(checkout(edit('.goreleaser.yaml', `owner: ${SOURCE_OWNER}`, 'owner: other'))).status).not.toBe(0);
  });

  test('a foreign owner in a raw.githubusercontent.com installer URL is refused, and named', () => {
    const directory = checkout(p =>
      writeFileSync(
        p('docs/other.md'),
        `curl https://raw.githubusercontent.com/someone-else/${SOURCE_REPO}/main/install.sh\n`,
      ),
    );
    const result = contract(directory);
    expect(result.status).not.toBe(0);
    expect(result.err).toContain('docs/other.md');
    expect(result.err).toContain('someone-else');
  });

  test('a release URL that spells the PRODUCT name as the repository, or a stale RELEASE_REPO, is refused', () => {
    const release = 'packages/plugins/updates/contract/release.ts';
    expect(
      contract(checkout(edit(release, `RELEASE_REPO = '${SOURCE_REPO}'`, "RELEASE_REPO = 'other'"))).status,
    ).not.toBe(0);
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
    expect(read(directory, 'package.json')).toContain(`github:${SOURCE}`);
  });

  test('a dry run lists the files and writes nothing', () => {
    const directory = checkout();
    const before = read(directory, `Casks/${PRODUCT}.rb`);
    const result = run(directory, '--owner', DEST_OWNER);
    expect(result.status).toBe(0);
    expect(result.out).toContain(`'${SOURCE}' -> '${DEST_OWNER_ONLY}'`);
    expect(result.out).toContain(`Casks/${PRODUCT}.rb`);
    expect(result.out).toContain('dry run');
    expect(read(directory, `Casks/${PRODUCT}.rb`)).toBe(before);
    expect(read(directory, 'package.json')).toContain(`github:${SOURCE}`);
    expect(contract(directory).status).toBe(0);
  });

  test('--apply moves the owner and the repository everywhere they are spelled, and the contracts pass on the new slug', () => {
    const directory = checkout();
    const result = run(directory, '--owner', DEST_OWNER, '--repo', DEST_REPO, '--apply');
    expect(result.status).toBe(0);
    expect(result.out).toContain('move complete');
    expect(JSON.parse(read(directory, 'package.json')).repository).toBe(`github:${DEST}`);
    expect(read(directory, `Casks/${PRODUCT}.rb`)).toContain(`https://github.com/${DEST}/releases/download/`);
    expect(read(directory, 'scripts/release/install.sh')).toContain(`REPO="${DEST}"`);
    expect(read(directory, '.goreleaser.yaml')).toMatch(
      new RegExp(`owner: ${DEST_OWNER}\\n\\s+name: ${DEST_REPO}`, 'u'),
    );
    expect(read(directory, 'packages/plugins/updates/contract/release.ts')).toContain(
      `RELEASE_OWNER = '${DEST_OWNER}'`,
    );
    expect(read(directory, 'packages/plugins/codex/daemon/lib/update/version.ts')).toContain(`'${DEST}'`);
    expect(read(directory, 'packages/plugins/claude-code/daemon/lib/update/recipes.ts')).toContain(`'${DEST}'`);
    expect(read(directory, 'INSTALLATION.md')).toContain(`github:${DEST}`);
    expect(read(directory, 'packages/x/tests/fixture.ts')).toContain(`github.com/${DEST}/releases`);
    // What is not this repository's slug stays: history, another repository, an account label, a longer repo name, the Gemfury account.
    expect(read(directory, 'Changelog.md')).toContain(SOURCE);
    // A `.tools`, `.git.tools` or `.git-tools` sibling is another repository, whatever precedes the dot.
    expect(read(directory, 'docs/other.md')).toBe(
      `https://github.com/${SOURCE_OWNER}/pitwall and GitHub · ${SOURCE_OWNER} and apt.fury.io/${SOURCE_OWNER}97/ and ${SOURCE}-b168 and ${SOURCE}.tools and ${SOURCE}.git.tools and ${SOURCE}.git-tools\n`,
    );
    // The slug is rewritten at a `.git` remote, a raw.githubusercontent.com path and a sentence end.
    expect(read(directory, 'docs/own.md')).toBe(
      `ssh github-personal:${DEST}.git and https://raw.githubusercontent.com/${DEST}/main/x.sh and ${DEST}.\n`,
    );
    // The release URLs are built from the repository name, not the product name.
    expect(read(directory, 'packages/plugins/updates/contract/release.ts')).toContain(`RELEASE_REPO = '${DEST_REPO}'`);
    expect(read(directory, 'docs/default.sh')).toBe(`repo="\${FY_REPO:-${DEST}}"\n`);
    expect(contract(directory).status).toBe(0);
    expect(contract(directory, 'homebrew-cask').status).toBe(0);
    expect(existsSync(join(directory, 'package.json.tmp'))).toBe(false);
  });

  test('moving only the owner leaves the repository name, and a second move is a no-op', () => {
    const directory = checkout();
    expect(run(directory, '--owner', DEST_OWNER, '--apply').status).toBe(0);
    expect(read(directory, 'packages/plugins/codex/daemon/lib/update/version.ts')).toContain(`'${DEST_OWNER_ONLY}'`);
    const again = run(directory, '--owner', DEST_OWNER, '--apply');
    expect(again.status).toBe(0);
    expect(again.out).toContain('nothing to move');
  });

  test('a repository whose install digest cannot be recomputed ends INCOMPLETE and names the exact command to run', () => {
    // A pin with no flake beside it: nix cannot evaluate the digest, which is what a machine without nix looks like.
    const directory = checkout(p => {
      mkdirSync(dirname(p('nix/bun-deps.inputs')), { recursive: true });
      writeFileSync(p('nix/bun-deps.inputs'), `${'0'.repeat(64)}\n`);
    });
    const result = run(directory, '--owner', DEST_OWNER, '--apply');
    expect(result.status).not.toBe(0);
    expect(result.out + result.err).toContain('incomplete');
    expect(result.err).toContain('next: ');
    expect(result.err).toContain('nix eval --raw .#packages.x86_64-linux.bunDeps.installDigest');
    expect(result.err).toContain('nix/bun-deps.inputs');
    expect(result.out + result.err).not.toContain('move complete');
    // The files themselves did move: the move is applied, only the pin is left to refresh.
    expect(JSON.parse(read(directory, 'package.json')).repository).toBe(`github:${DEST_OWNER_ONLY}`);
  });
});

describe('the move and the rename, then the repository’s own gates', () => {
  test('a move to another owner AND repository name, then every contract and the Nix digest gate, all pass', () => {
    const directory = wholeCheckout();
    expect(failing(directory)).toEqual([]);
    expect(digest(directory).status).toBe(0);

    const moved = run(directory, '--owner', DEST_OWNER, '--repo', DEST_REPO, '--apply');
    expect(moved.out + moved.err).toContain('move complete');
    expect(moved.status).toBe(0);
    expect(JSON.parse(read(directory, 'package.json')).repository).toBe(`github:${DEST}`);
    // The release repository is the new NAME while the product is unchanged: the cask keeps its name, the tap follows the repository.
    expect(read(directory, 'packages/plugins/updates/contract/release.ts')).toContain(`RELEASE_REPO = '${DEST_REPO}'`);
    expect(JSON.parse(read(directory, 'package.json')).name).toBe(PRODUCT);

    expect(failing(directory)).toEqual([]);
    const pin = digest(directory);
    expect(pin.err).toBe('');
    expect(pin.status).toBe(0);
    // A second run changes nothing: the move is repeatable.
    const again = run(directory, '--owner', DEST_OWNER, '--repo', DEST_REPO, '--apply');
    expect(again.out).toContain('nothing to move');
  }, 300_000);

  test('a product-only rename leaves the repository addresses alone, and every contract still passes', () => {
    const directory = wholeCheckout();
    const renamed = Bun.spawnSync(['bash', join(directory, 'scripts/local/rename.sh'), '--product', 'newproduct'], {
      cwd: directory,
      env: OFFLINE_ENV,
    });
    expect(renamed.stderr.toString()).not.toContain('❌');
    expect(JSON.parse(read(directory, 'package.json')).name).toBe('newproduct');
    // The repository is a separate fact: nothing about the product's new name reaches an address.
    expect(JSON.parse(read(directory, 'package.json')).repository).toBe(`github:${SOURCE}`);
    expect(read(directory, 'Casks/newproduct.rb')).toContain(`https://github.com/${SOURCE}/releases/download/`);
    expect(read(directory, 'scripts/release/install.sh')).toContain(`REPO="${SOURCE}"`);
    expect(failing(directory)).toEqual([]);
  }, 300_000);
});
