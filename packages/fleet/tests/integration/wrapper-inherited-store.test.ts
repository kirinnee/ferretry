import { describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import type { ResolvedAccount } from '../../src/lib/profiles.ts';
import { renderWrapperScript } from '../../src/lib/wrappers.ts';

/**
 * A version-1 Claude wrapper run by a real `sh` from an environment that carries a version-2
 * runtime's secure-storage pointer — what a daemon started inside one hands every pane. The stand-in
 * harness on `PATH` records only whether the variable reached it. No agent and no credential.
 */
const account = (home: string): ResolvedAccount =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'claude',
    mode: 'auto',
    wrapper: 'claude-auto-work',
    home,
    displayName: 'Claude (work)',
    agent: 'work',
    variant: 'auto',
    identity: 'work',
    auth: 'oauth',
    available: true,
    unavailableReason: null,
    defaultModel: null,
    models: [],
    env: {},
    flags: [],
    settings: [],
    memory: undefined,
    skills: undefined,
    hooks: undefined,
    hooksDir: undefined,
    mcp: undefined,
  }) as ResolvedAccount;

describe('a version-1 Claude wrapper launched from an environment holding a secure-storage pointer', () => {
  it('should launch the harness with the inherited pointer cleared', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fy-inherited-store-'));
    try {
      // Arrange
      const bin = path.join(root, 'bin');
      const seen = path.join(root, 'seen');
      await Bun.write(
        path.join(bin, 'claude'),
        `#!/bin/sh\nprintf '%s' "\${CLAUDE_SECURESTORAGE_CONFIG_DIR-<unset>}" > '${seen}'\n`,
      );
      await chmod(path.join(bin, 'claude'), 0o755);
      const script = path.join(root, 'wrapper.sh');
      await Bun.write(script, renderWrapperScript(account(path.join(root, 'home'))));

      // Act
      const code = await Bun.spawn({
        cmd: ['/bin/sh', script],
        cwd: root,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(root, 'another-credential'),
        },
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited;

      // Assert
      should(code).equal(0);
      should(await readFile(seen, 'utf8')).equal('<unset>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
