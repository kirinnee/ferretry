import { afterEach, describe, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
