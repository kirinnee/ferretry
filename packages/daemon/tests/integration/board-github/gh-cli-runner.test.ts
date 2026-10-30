import { describe, it } from 'bun:test';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { GH_TIMEOUT_MS, GhCliRunner } from '../../../src/adapters/board-github/gh-cli-runner.ts';
import { withTempRoot } from '../atomic-file/fixtures.ts';

/** A stand-in `gh`: a shell script, so nothing here reaches GitHub. */
const fakeGh = async (root: string, body: string): Promise<string> => {
  const path = join(root, 'gh');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
};

describe('the gh CLI runner', () => {
  it("should hand back gh's output, run it with the arguments as given, and never let it prompt", async () => {
    await withTempRoot(async root => {
      const gh = await fakeGh(root, 'printf "%s|" "$@"; printf "%s" "$GH_PROMPT_DISABLED"');
      const outcome = await new GhCliRunner(gh).run(['api', 'graphql', '-f', 'b0=a b"c']);
      should(outcome).deepEqual({ kind: 'ok', stdout: 'api|graphql|-f|b0=a b"c|1' });
    });
  });

  it('should call a missing gh missing', async () => {
    await withTempRoot(async root => {
      should(await new GhCliRunner(join(root, 'no-such-gh')).run(['--version'])).deepEqual({ kind: 'missing' });
    });
  });

  it('should call gh signed out when it exits 4 or asks for a sign-in', async () => {
    await withTempRoot(async root => {
      const four = await fakeGh(root, 'echo "authentication required" >&2; exit 4');
      should(await new GhCliRunner(four).run([])).deepEqual({
        kind: 'unauthenticated',
        detail: 'authentication required',
      });
      const asks = await fakeGh(root, 'echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 1');
      should(await new GhCliRunner(asks).run([])).match({ kind: 'unauthenticated' });
    });
  });

  it('should keep what a failed call printed, with the first line of its complaint', async () => {
    await withTempRoot(async root => {
      const partial = await fakeGh(
        root,
        'echo \'{"data":{}}\'; printf "GraphQL: Could not resolve\\nmore\\n" >&2; exit 1',
      );
      should(await new GhCliRunner(partial).run([])).deepEqual({
        kind: 'failed',
        detail: 'GraphQL: Could not resolve',
        stdout: '{"data":{}}\n',
      });
      const silent = await fakeGh(root, 'exit 2');
      should(await new GhCliRunner(silent).run([])).deepEqual({ kind: 'failed', detail: 'gh exited 2', stdout: '' });
    });
  });

  it('should kill a call that runs too long and say so', async () => {
    await withTempRoot(async root => {
      const slow = await fakeGh(root, 'exec sleep 10');
      should(await new GhCliRunner(slow, 100).run([])).deepEqual({
        kind: 'failed',
        detail: 'gh took longer than 100 ms',
        stdout: '',
      });
    });
    should(GH_TIMEOUT_MS).equal(30_000);
  });
});
