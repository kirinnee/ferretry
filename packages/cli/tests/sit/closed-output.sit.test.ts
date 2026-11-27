import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { defaultCommand } from './driver.ts';

// D-98: a reader that has already gone (`fy --help | head`) is not a failure of the command.
const binEntry = Object.values(pkg.bin)[0] ?? 'bin/fy.ts';
const command = defaultCommand(binEntry, join(dirname(import.meta.path), '..', '..'));

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'fy-closed-'));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

/**
 * The CLI's own exit code and stderr when ONE of its streams is a pipe whose reader (`true`) has already exited: stdout
 * (stderr stays ours to read), or stderr (stdout goes to /dev/null, and what we read is the pipeline's exit code).
 */
async function runIntoClosedReader(
  args: readonly string[],
  closed: 'stdout' | 'stderr' = 'stdout',
): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn(
    [
      'bash',
      '-c',
      // `true` exits before the CLI has started writing; pipefail makes the pipeline's code the CLI's.
      closed === 'stdout' ? 'set -o pipefail; "$@" | true' : 'set -o pipefail; "$@" 2>&1 >/dev/null | true',
      'bash',
      ...command,
      ...args,
    ],
    {
      env: { PATH: process.env.PATH ?? '', HOME: home, FY_HOME: join(home, 'fy'), NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    },
  );
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, err };
}

describe('writing to an output whose reader has already gone', () => {
  it('should exit 0 and print no stack when --help goes to a closed pipe', async () => {
    const { code, err } = await runIntoClosedReader(['--help']);
    should(err).not.containEql('EPIPE');
    should(code).equal(0);
  });

  // The guard is for STDOUT only: stderr is where a failure is reported, so a failure that cannot be reported stays one.
  it('should still fail with exit 1 when a missing daemon log is reported to a closed stderr', async () => {
    const { code } = await runIntoClosedReader(['daemon', 'logs'], 'stderr');
    should(code).equal(1);
  });
});
