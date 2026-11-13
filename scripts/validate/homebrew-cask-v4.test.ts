import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const repository = join(import.meta.dir, '../..');
const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

/** Every `package.json` under packages/ except installed dependencies. */
function manifests(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    if (entry === 'node_modules') return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return manifests(path);
    return entry === 'package.json' ? [path] : [];
  });
}

/** A throwaway git checkout holding only what the `homebrew-cask` contract reads. */
function checkout(mutate: (path: (file: string) => string) => void = () => {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'homebrew-cask-v4-'));
  scratch.push(directory);
  const copy = (file: string) => {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    cpSync(join(repository, file), join(directory, file), { recursive: true });
  };
  for (const file of ['package.json', '.goreleaser.yaml', 'Casks']) copy(file);
  for (const manifest of manifests(join(repository, 'packages'))) copy(relative(repository, manifest));
  const git = Bun.spawnSync(['git', 'init', '-q', '.'], { cwd: directory });
  if (git.exitCode !== 0) throw new Error(`git setup failed: ${git.stderr.toString()}`);
  mutate(file => join(directory, file));
  return directory;
}

function edit(file: string, from: string | RegExp, to: string): void {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(from, to);
  if (after === before) throw new Error(`the test's edit did not apply to ${file}`);
  writeFileSync(file, after);
}

function gate(directory: string) {
  const result = Bun.spawnSync(['bash', join(repository, 'scripts/validate/cli-contracts.sh'), 'homebrew-cask'], {
    cwd: directory,
    env: process.env,
  });
  return { status: result.exitCode, err: result.stderr.toString() };
}

const SKIP_UPLOAD = /\n    skip_upload: '\{\{ ne \.Major 4 \}\}'/u;

describe('the homebrew-cask contract keeps ferretry@4 safe from every other major', () => {
  test('this checkout passes', () => {
    expect(gate(checkout())).toMatchObject({ status: 0 });
  });

  test('a ferretry@4 entry without skip_upload is refused, so a 5.x release could overwrite Casks/ferretry@4.rb', () => {
    expect(gate(checkout(p => edit(p('.goreleaser.yaml'), SKIP_UPLOAD, ''))).status).not.toBe(0);
  });

  test('a skip_upload that no longer gates on major 4 is refused', () => {
    expect(
      gate(checkout(p => edit(p('.goreleaser.yaml'), "'{{ ne .Major 4 }}'", "'{{ ne .Major 5 }}'"))).status,
    ).not.toBe(0);
  });

  test('a plain cask that does not conflict with ferretry@4 is refused', () => {
    expect(
      gate(checkout(p => edit(p('.goreleaser.yaml'), /    conflicts:\n      - cask: ferretry@4\n/u, ''))).status,
    ).not.toBe(0);
  });

  test('a ferretry@4 cask that does not conflict with the plain cask is refused', () => {
    expect(
      gate(checkout(p => edit(p('.goreleaser.yaml'), /    conflicts:\n      - cask: ferretry\n/u, ''))).status,
    ).not.toBe(0);
  });

  test('a committed plain cask that does not conflict with ferretry@4 is refused, one-line or array form', () => {
    expect(gate(checkout(p => edit(p('Casks/ferretry.rb'), '"ferretry@4"', '"ferretry@3"'))).status).not.toBe(0);
  });

  test('a committed ferretry@4 cask that does not conflict with the plain cask is refused', () => {
    expect(gate(checkout(p => edit(p('Casks/ferretry@4.rb'), /"ferretry",/u, '"ferretry-nightly",'))).status).not.toBe(
      0,
    );
  });

  test('a committed ferretry@4 cask that is not a v4 release is refused', () => {
    expect(
      gate(checkout(p => edit(p('Casks/ferretry@4.rb'), /\n  version "4\.[0-9.]+"/u, '\n  version "5.0.0"'))).status,
    ).not.toBe(0);
  });
});
