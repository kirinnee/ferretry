import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A throwaway repo holding the real gate and one `*.sh`, added with the file-mode bit the caller picks. */
function repo(options: { readonly diskExecutable: boolean; readonly recordedExecutable: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), 'fy-executable-shells-'));
  temporary.push(directory);
  mkdirSync(join(directory, 'scripts/validate'), { recursive: true });
  copyFileSync(join(import.meta.dir, 'executable-shells.sh'), join(directory, 'scripts/validate/executable-shells.sh'));
  writeFileSync(join(directory, 'tool.sh'), '#!/usr/bin/env bash\n');
  chmodSync(join(directory, 'tool.sh'), options.diskExecutable ? 0o755 : 0o644);
  const git = (...args: string[]) => spawnSync('git', args, { cwd: directory });
  git('init', '-q');
  // The repo's own setting: git ignores the disk bit and records 100644 for a new file.
  git('config', 'core.fileMode', 'false');
  git('add', 'tool.sh');
  if (options.recordedExecutable) git('update-index', '--chmod=+x', 'tool.sh');
  const result = spawnSync('bash', ['scripts/validate/executable-shells.sh'], { cwd: directory, encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test('a *.sh recorded as 100755 passes', () => {
  expect(repo({ diskExecutable: true, recordedExecutable: true }).code).toBe(0);
});

test('a *.sh recorded as 100644 fails even when the disk file is executable (core.fileMode=false)', () => {
  const { code, out } = repo({ diskExecutable: true, recordedExecutable: false });
  expect(code).toBe(1);
  expect(out).toContain("'tool.sh' is tracked but not executable");
});

test('a *.sh recorded as 100644 and not executable on disk fails', () => {
  expect(repo({ diskExecutable: false, recordedExecutable: false }).code).toBe(1);
});
