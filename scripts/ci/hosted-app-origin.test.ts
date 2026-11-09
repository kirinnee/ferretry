import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The script resolves its repository from its own location, so each test runs a COPY inside a throwaway tree. */
const here = import.meta.dir;
const root = join(here, '../..');
const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function tree(options: { readonly previewKey?: string } = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-app-origin-'));
  scratch.push(directory);
  for (const file of ['scripts/ci/hosted-app-origin.sh', 'packages/core/kernel/contract/hosted-app.ts']) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    copyFileSync(join(root, file), join(directory, file));
  }
  chmodSync(join(directory, 'scripts/ci/hosted-app-origin.sh'), 0o755);
  mkdirSync(join(directory, 'packages/app'), { recursive: true });
  if (options.previewKey !== undefined)
    writeFileSync(join(directory, 'packages/app/release-signing-key.preview.pub'), options.previewKey);
  return directory;
}

function run(directory: string, args: readonly string[], origin?: string) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  if (origin !== undefined) env.FY_HOSTED_APP_ORIGIN = origin;
  const result = Bun.spawnSync(['bash', join(directory, 'scripts/ci/hosted-app-origin.sh'), ...args], { env });
  return { status: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

describe('scripts/ci/hosted-app-origin.sh', () => {
  test('unset or blank is the production app, its own key and no define', () => {
    const directory = tree();
    for (const origin of [undefined, '', '  ']) {
      expect(run(directory, [], origin).out).toBe('https://ferretry.pages.dev\n');
      expect(run(directory, ['--defines'], origin).out).toBe('');
      expect(run(directory, ['--key-file'], origin).out).toBe(`${directory}/packages/app/release-signing-key.pub\n`);
      expect(run(directory, ['--next-key-file'], origin).out).toBe(
        `${directory}/packages/app/release-signing-key.next.pub\n`,
      );
    }
  });

  test('a named app has its own origin, key file and daemon defines', () => {
    const pem = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAabc=\n-----END PUBLIC KEY-----\n';
    const directory = tree({ previewKey: pem });
    const named = 'https://ferretry-v5.pages.dev';
    expect(run(directory, [], named).out).toBe(`${named}\n`);
    expect(run(directory, ['--key-file'], named).out).toBe(
      `${directory}/packages/app/release-signing-key.preview.pub\n`,
    );
    expect(run(directory, ['--next-key-file'], named).out).toBe(
      `${directory}/packages/app/release-signing-key.preview.next.pub\n`,
    );
    const defines = run(directory, ['--defines'], named).out.trimEnd().split('\n');
    expect(defines[0]).toBe(`__FY_HOSTED_APP_ORIGIN__="${named}"`);
    expect(defines[1]).toBe(
      '__FY_HOSTED_APP_RELEASE_KEY__="-----BEGIN PUBLIC KEY-----\\nMCowBQYDK2VwAyEAabc=\\n-----END PUBLIC KEY-----\\n"',
    );
    expect(JSON.parse(defines[1]!.slice('__FY_HOSTED_APP_RELEASE_KEY__='.length))).toBe(pem);
  });

  test('a named app with no committed key still sets the origin and says the key is missing', () => {
    const result = run(tree(), ['--defines'], 'https://ferretry-v5.pages.dev');
    expect(result.status).toBe(0);
    expect(result.out).toBe('__FY_HOSTED_APP_ORIGIN__="https://ferretry-v5.pages.dev"\n');
    expect(result.err).toContain('is not committed yet');
  });

  test('anything but a plain https origin is refused before it can become a link', () => {
    const directory = tree();
    for (const bad of [
      'http://ferretry-v5.pages.dev',
      'https://ferretry-v5.pages.dev/pair',
      'https://ferretry-v5.pages.dev?x=1',
      'https://u:p@ferretry-v5.pages.dev',
      'ferretry-v5.pages.dev',
      "https://x.dev';rm -rf /",
    ]) {
      const result = run(directory, [], bad);
      expect(result.status).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).toContain('FY_HOSTED_APP_ORIGIN must be a plain https origin');
    }
  });

  test('--default ignores the switch', () => {
    expect(run(tree(), ['--default'], 'https://ferretry-v5.pages.dev').out).toBe('https://ferretry.pages.dev\n');
  });

  test('an unknown mode is a usage error', () => {
    expect(run(tree(), ['--nope']).status).toBe(1);
  });
});
