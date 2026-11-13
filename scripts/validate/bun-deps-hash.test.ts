import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repository = join(import.meta.dir, '../..');
const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

// Each case evaluates the flake once, which is a few seconds of Nix, not a unit of work for bun's default 5 s.
const EVALUATION_MS = 120_000;

/**
 * A throwaway git checkout holding the real flake and `nix/` (so the gate evaluates the real
 * `installDigest`) around a tiny workspace: a lockfile, a root manifest that vendors one package by
 * `file:` path, and one workspace package. `pin` is what nix/bun-deps.inputs holds.
 */
function checkout(pin: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'bun-deps-hash-'));
  scratch.push(directory);
  cpSync(join(repository, 'flake.nix'), join(directory, 'flake.nix'));
  cpSync(join(repository, 'flake.lock'), join(directory, 'flake.lock'));
  cpSync(join(repository, 'nix'), join(directory, 'nix'), { recursive: true });
  for (const [file, content] of Object.entries({
    VERSION: '1.0.0\n',
    'bun.lock': '{"lockfileVersion":1}\n',
    'package.json': JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      workspaces: ['packages/*'],
      overrides: { vendored: 'file:./vendor/vendored' },
    }),
    'packages/a/package.json': JSON.stringify({ name: '@fixture/a', version: '1.0.0' }),
    'vendor/vendored/package.json': JSON.stringify({ name: 'vendored', version: '0.0.0' }),
    'vendor/vendored/index.js': 'module.exports = 1;\n',
    'nix/bun-deps.inputs': `${pin}\n`,
  })) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), content);
  }
  const git = Bun.spawnSync(['bash', '-c', 'git init -q . && git add --all'], { cwd: directory });
  if (git.exitCode !== 0) throw new Error(`git setup failed: ${git.stderr.toString()}`);
  return directory;
}

function gate(directory: string) {
  const result = Bun.spawnSync(['bash', join(repository, 'scripts/validate/bun-deps-hash.sh'), '--root', directory], {
    env: process.env,
  });
  return { status: result.exitCode, err: result.stderr.toString(), out: result.stdout.toString() };
}

function edit(directory: string, file: string, change: (text: string) => string): void {
  const path = join(directory, file);
  writeFileSync(path, change(readFileSync(path, 'utf8')));
  Bun.spawnSync(['git', 'add', '--all'], { cwd: directory });
}

/** The digest the gate reports as current, read from a checkout whose pin is deliberately wrong. */
function currentDigest(directory: string): string {
  const match = /current: ([0-9a-f]{64})/.exec(gate(directory).err);
  if (match?.[1] === undefined) throw new Error('the gate printed no current digest');
  return match[1];
}

describe('scripts/validate/bun-deps-hash.sh', () => {
  test(
    'this checkout passes',
    () => {
      expect(Bun.spawnSync(['bash', join(repository, 'scripts/validate/bun-deps-hash.sh')]).exitCode).toBe(0);
    },
    EVALUATION_MS,
  );

  test(
    'a stale pin fails with a sentence naming the fix',
    () => {
      const result = gate(checkout('0'.repeat(64)));
      expect(result.status).toBe(1);
      expect(result.err).toContain('outputHash was not refreshed');
      expect(result.err).toContain('nix/bun-deps.inputs');
      expect(result.err).toContain('nix build .#default --no-link');
    },
    EVALUATION_MS,
  );

  test(
    'a matching pin passes; a changed lockfile with the same pin fails; a changed manifest version alone passes',
    () => {
      const directory = checkout('0'.repeat(64));
      const digest = currentDigest(directory);
      writeFileSync(join(directory, 'nix/bun-deps.inputs'), `${digest}\n`);
      Bun.spawnSync(['git', 'add', '--all'], { cwd: directory });
      expect(gate(directory)).toMatchObject({ status: 0 });

      // The release commit restamps `version` in every manifest; it never reaches node_modules.
      edit(directory, 'package.json', text => text.replace('"version":"1.0.0"', '"version":"2.0.0"'));
      edit(directory, 'packages/a/package.json', text => text.replace('"version":"1.0.0"', '"version":"2.0.0"'));
      expect(gate(directory)).toMatchObject({ status: 0 });

      edit(directory, 'bun.lock', text => text.replace('"lockfileVersion":1', '"lockfileVersion":1,"packages":{}'));
      const stale = gate(directory);
      expect(stale.status).toBe(1);
      expect(stale.err).toContain('outputHash was not refreshed');
      expect(stale.err).toContain(`pinned:  ${digest}`);
    },
    EVALUATION_MS * 2,
  );

  test(
    'a changed dependency in a workspace manifest or a vendored file fails',
    () => {
      const directory = checkout('0'.repeat(64));
      const digest = currentDigest(directory);
      writeFileSync(join(directory, 'nix/bun-deps.inputs'), `${digest}\n`);
      expect(gate(directory).status).toBe(0);

      edit(directory, 'packages/a/package.json', text =>
        text.replace('"version"', '"dependencies":{"left-pad":"1.3.0"},"version"'),
      );
      expect(gate(directory).status).toBe(1);

      edit(directory, 'packages/a/package.json', text => text.replace('"dependencies":{"left-pad":"1.3.0"},', ''));
      expect(gate(directory).status).toBe(0);

      edit(directory, 'vendor/vendored/index.js', () => 'module.exports = 2;\n');
      expect(gate(directory).status).toBe(1);
    },
    EVALUATION_MS * 2,
  );
});
