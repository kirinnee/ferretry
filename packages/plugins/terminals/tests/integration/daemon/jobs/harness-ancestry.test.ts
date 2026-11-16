import { afterEach, describe, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { harnessAncestor } from '../../../../daemon/adapters/jobs/harness-ancestry.ts';
import { waitForValue } from '../support/wait-for.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const undo of cleanups.splice(0)) undo();
});

describe('finding the harness an attachment sits under (Linux procfs)', () => {
  it('should find the nearest ancestor that runs a harness CLI and its start', async () => {
    // Arrange — `bun <dir>/claude.ts` is a harness by its script's name; it starts a shell that starts the "attachment".
    const dir = mkdtempSync(join(tmpdir(), 'fy-harness-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = join(dir, 'child.pid');
    writeFileSync(
      join(dir, 'claude.ts'),
      `const child = Bun.spawn(['sh', '-c', 'sleep 60 & echo $! > ${pidFile}; wait'], { stdout: 'ignore' });
setInterval(() => undefined, 1000);
void child;
`,
    );
    const harness = Bun.spawn([Bun.which('bun') ?? 'bun', join(dir, 'claude.ts')], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    cleanups.push(() => harness.kill('SIGKILL'));
    const attachment = await waitForValue(async () => {
      const text = await Bun.file(pidFile)
        .text()
        .catch(() => '');
      return /^\d+/u.test(text) ? Number(text.trim()) : undefined;
    }, 'the attachment stand-in to start');
    cleanups.push(() => process.kill(attachment, 'SIGKILL'));

    // Act
    const found = await harnessAncestor(attachment);

    // Assert
    should(found?.pid).equal(harness.pid);
    should(found?.start).match(/^\d+$/u);
  });
});

describe('finding the harness: what the walk does with a process tree it cannot fully read', () => {
  /** A fake /proc: `<pid>/stat` names the parent, `<pid>/cmdline` the command (absent when `command` is undefined). */
  function fakeProc(rows: ReadonlyArray<{ pid: number; ppid: number; command?: string }>): string {
    const root = mkdtempSync(join(tmpdir(), 'fy-proc-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    for (const row of rows) {
      mkdirSync(join(root, String(row.pid)));
      writeFileSync(join(root, String(row.pid), 'stat'), `${row.pid} (x) S ${row.ppid} ${'0 '.repeat(30)}`);
      if (row.command !== undefined) writeFileSync(join(root, String(row.pid), 'cmdline'), row.command);
    }
    return root;
  }

  it('should find nothing for a process that cannot be read', async () => {
    should(await harnessAncestor(5, fakeProc([]))).be.undefined();
  });

  it('should find nothing when the walk reaches init without meeting a harness', async () => {
    const root = fakeProc([{ pid: 5, ppid: 1 }]);
    should(await harnessAncestor(5, root)).be.undefined();
  });

  it('should find nothing when a parent’s command line cannot be read', async () => {
    const root = fakeProc([
      { pid: 5, ppid: 6 },
      { pid: 6, ppid: 2 },
    ]);
    should(await harnessAncestor(5, root)).be.undefined();
  });

  it('should give up on a tree deeper than it will walk', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ pid: 10 + index, ppid: 11 + index, command: 'sh\0' }));
    rows.push({ pid: 50, ppid: 2, command: 'sh\0' });
    should(await harnessAncestor(10, fakeProc(rows))).be.undefined();
  });
});
