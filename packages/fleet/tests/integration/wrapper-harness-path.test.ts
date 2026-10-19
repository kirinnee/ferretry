import { describe, it } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { type RuntimeWrapperInput, renderRuntimeWrapperScript } from '../../src/lib/wrappers.ts';

/**
 * A session runs the harness its wrapper execs, and that must be the one the daemon resolved
 * (docs/harness-paths.md) rather than whichever `claude` a PATH puts first. These run a real `sh`
 * with a decoy `claude` earlier on PATH than the configured one; each fake only prints who it is.
 */

const account = (home: string, harnessCommand: string | undefined): RuntimeWrapperInput => ({
  name: 'claude-auto-work',
  id: '00000000-0000-4000-8000-000000000001',
  harness: 'claude',
  agent: false,
  configDirectory: home,
  env: {},
  args: [],
  fyCommand: 'fy',
  harnessCommand,
});

const fake = async (file: string, name: string): Promise<void> => {
  await Bun.write(file, `#!/bin/sh\nprintf '${name}\\n'\n`);
  await chmod(file, 0o755);
};

const whoRan = async (harnessCommand: (configured: string) => string | undefined): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'fy-harness-path-'));
  try {
    const decoy = path.join(root, 'decoy-bin', 'claude');
    const configured = path.join(root, 'configured', 'claude');
    await fake(decoy, 'decoy');
    await fake(configured, 'configured');
    const script = path.join(root, 'wrapper.sh');
    await Bun.write(script, renderRuntimeWrapperScript(account(path.join(root, 'home'), harnessCommand(configured))));
    const spawned = Bun.spawn({
      cmd: ['/bin/sh', script],
      cwd: root,
      env: { PATH: `${path.dirname(decoy)}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const output = await new Response(spawned.stdout).text();
    await spawned.exited;
    return output.trim();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('the generated wrapper’s harness path', () => {
  it('should run the resolved harness and never a decoy earlier on PATH', async () => {
    // Act
    const ran = await whoRan(configured => configured);

    // Assert
    should(ran).equal('configured');
  });

  it('should fall back to the PATH lookup only when no harness path was resolved', async () => {
    // Act
    const ran = await whoRan(() => undefined);

    // Assert — the control: this is what the decoy test would have seen before the wrapper pinned a path
    should(ran).equal('decoy');
  });
});
