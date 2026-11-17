import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// parallel.sh is a POOL: at most <limit> parts at once, and the next part starts the moment ANY running part ends (not
// when the slowest of a fixed batch does). Every part's log and exit code is kept, and one failure fails the run.
const PARALLEL = join(import.meta.dir, 'parallel.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = (script: string): { dir: string; command: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'fy-parallel-'));
  dirs.push(dir);
  const command = join(dir, 'part.sh');
  writeFileSync(command, `#!/usr/bin/env bash\nset -u\nmarks=${JSON.stringify(dir)}/marks\n${script}\n`);
  chmodSync(command, 0o755);
  return { dir, command };
};
const run = (dir: string, limit: string, command: string, parts: string[]) =>
  spawnSync('bash', [PARALLEL, join(dir, 'out'), limit, command, '--', ...parts], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '/dev/null' },
  });

test('the next part starts as soon as any part ends, never waiting for the slow one', () => {
  // `slow` holds its slot until `c` has started: with fixed batches of two, `c` could only start after `slow` ended.
  const { dir, command } = setup(`case $1 in
slow) for _ in $(seq 1 100); do grep -q '^start c$' "$marks" 2>/dev/null && break; sleep 0.05; done; echo "end slow" >>"$marks" ;;
*) echo "start $1" >>"$marks" ;;
esac`);
  const result = run(dir, '2', command, ['slow', 'b', 'c']);
  expect(result.status).toBe(0);
  const marks = readFileSync(join(dir, 'marks'), 'utf8').trim().split('\n');
  expect(marks.indexOf('start c')).toBeLessThan(marks.indexOf('end slow'));
  expect(marks.indexOf('start c')).toBeGreaterThanOrEqual(0);
});

test('never more than <limit> parts run at once', () => {
  const { dir, command } = setup(`echo "+$1" >>"$marks"; sleep 0.2; echo "-$1" >>"$marks"`);
  expect(run(dir, '2', command, ['a', 'b', 'c', 'd', 'e']).status).toBe(0);
  let live = 0;
  let most = 0;
  for (const mark of readFileSync(join(dir, 'marks'), 'utf8').trim().split('\n')) {
    live += mark.startsWith('+') ? 1 : -1;
    most = Math.max(most, live);
  }
  expect(most).toBeLessThanOrEqual(2);
});

test('one failed part fails the run, and every part still reports its own exit code and log', () => {
  const { dir, command } = setup(`echo "log of $1"; [[ $1 == b ]] && exit 3; exit 0`);
  const result = run(dir, '3', command, ['a', 'b', 'c']);
  expect(result.status).toBe(1);
  const rows = readFileSync(join(dir, 'out/results.tsv'), 'utf8').trim().split('\n');
  expect(rows).toEqual([
    'part\texit\tseconds',
    expect.stringMatching(/^a\t0\t/),
    expect.stringMatching(/^b\t3\t/),
    expect.stringMatching(/^c\t0\t/),
  ]);
  expect(result.stdout).toContain('log of b');
  expect(existsSync(join(dir, 'out/c.log'))).toBe(true);
});

test('a part that never wrote its result counts as failed', () => {
  // The part kills its own reporting subshell before it can write the .tsv.
  const { dir, command } = setup(`[[ $1 == lost ]] && kill -9 $PPID; exit 0`);
  const result = run(dir, '2', command, ['ok', 'lost']);
  expect(result.status).toBe(1);
  expect(readFileSync(join(dir, 'out/results.tsv'), 'utf8')).toContain('lost\tmissing');
});
