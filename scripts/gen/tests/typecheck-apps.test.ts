import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const coverage = join(root, 'scripts/validate/typecheck-apps.ts');
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(config: string): string {
  const base = join(import.meta.dir, '.tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'typecheck-apps-'));
  temporary.push(dir);
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'tsconfig.json'), config);
  const git = Bun.spawnSync(['git', 'init', '--quiet'], { cwd: dir });
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  return dir;
}

function source(dir: string, path: string, contents: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), contents);
}

test('the root typecheck catches errors in unimported core and plugin TSX views with DOM types', async () => {
  const dir = fixture(await Bun.file(join(root, 'tsconfig.json')).text());
  source(dir, 'packages/core/example/app/view.tsx', 'export const view = <button disabled="yes" />;\n');
  source(
    dir,
    'packages/plugins/example/app/views/panel.tsx',
    'export const view = <div title={42} />;\nexport const node: HTMLDivElement = document.createElement("div");\n',
  );
  for (const group of ['core', 'plugins'])
    symlinkSync(join(root, 'packages/app/node_modules'), join(dir, `packages/${group}/example/node_modules`), 'dir');
  const checked = Bun.spawnSync(['./node_modules/.bin/tsc', '--noEmit', '-p', '.'], { cwd: dir, timeout: 60_000 });
  const output = checked.stdout.toString() + checked.stderr.toString();
  expect(checked.exitCode).toBe(1);
  expect(output).toContain('packages/core/example/app/view.tsx');
  expect(output).toContain('packages/plugins/example/app/views/panel.tsx');
  expect(output).toContain('TS2322');
  expect(output).not.toContain('Cannot find');
  expect(output).not.toContain('--jsx');
});

test('coverage refuses a wildcard app exclusion even when the package manifest is checked', async () => {
  const dir = fixture(JSON.stringify({ include: ['packages/**/*'], exclude: ['packages/plugins/*/app/**/*.tsx'] }));
  source(dir, 'packages/plugins/example/manifest.ts', 'export {};\n');
  source(dir, 'packages/plugins/example/app/views/panel.tsx', 'export {};\n');
  const checked = Bun.spawnSync(['bun', coverage], {
    cwd: dir,
    stdin: Buffer.from('packages/plugins/example/manifest.ts\n'),
    timeout: 60_000,
  });
  expect(checked.exitCode).toBe(1);
  expect(checked.stderr.toString()).toContain('app/views/panel.tsx: app source is missing');
});

test('coverage accepts a documented exact pending-port file and checks neighbouring views', () => {
  const pending = 'packages/plugins/example/app/pending.tsx';
  const checkedPath = 'packages/plugins/example/app/views/ready.tsx';
  const dir = fixture(`{
    "include": ["packages/**/*"],
    "exclude": [
      // pending app port: example owner contract member
      "${pending}"
    ]
  }`);
  source(dir, pending, 'export {};\n');
  source(dir, checkedPath, 'export {};\n');
  writeFileSync(
    join(dir, 'ports-pending.json'),
    JSON.stringify({
      format: 1,
      pendingAppPorts: [{ plugin: 'example', path: pending, reason: 'owner contract member' }],
    }),
  );
  const checked = Bun.spawnSync(['bun', coverage], {
    cwd: dir,
    stdin: Buffer.from(`${checkedPath}\n`),
    timeout: 60_000,
  });
  expect(checked.exitCode).toBe(0);
  source(dir, 'packages/plugins/example/app/views/new.tsx', 'export {};\n');
  const uncovered = Bun.spawnSync(['bun', coverage], {
    cwd: dir,
    stdin: Buffer.from(`${checkedPath}\n`),
    timeout: 60_000,
  });
  expect(uncovered.exitCode).toBe(1);
  expect(uncovered.stderr.toString()).toContain('views/new.tsx: app source is missing');
});
