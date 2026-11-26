import { afterEach, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createNodeHostFs } from '../../../host/state/host-fs.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

test('appending to a log somebody loosened by hand tightens it back to the requested mode', async () => {
  const home = await mkdtemp(`${tmpdir()}/fy-append-mode-`);
  homes.push(home);
  const path = `${home}/calls.jsonl`;
  await writeFile(path, '{"a":1}\n');
  await chmod(path, 0o666);
  await createNodeHostFs().appendLine(path, '{"b":2}', 0o600);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect(await readFile(path, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
});

test('the in-memory filesystem tightens an appended log the same way', async () => {
  const fs = createMemoryHostFs();
  fs.seed('/h/calls.jsonl', '{"a":1}\n', 0o666);
  await fs.appendLine('/h/calls.jsonl', '{"b":2}', 0o600);
  expect(fs.modeOf('/h/calls.jsonl')).toBe(0o600);
});
