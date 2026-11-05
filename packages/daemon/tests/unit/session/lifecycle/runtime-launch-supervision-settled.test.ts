/**
 * The supervised launcher's `settled`: delegated untouched when the inner launcher waits on startup, a
 * no-op when it cannot, and a failure explained the same way a ready or deliver failure is.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type PaneScreenReader,
  RuntimeSupervisedLauncher,
} from '../../../../src/adapters/session/lifecycle/runtime-launch-supervision.ts';
import { CODEX_OFFLINE_LAUNCH_ERROR } from '../../../../src/lib/fleet/codex-runtime.ts';
import type { SessionLifecycleLauncher, SessionLifecycleRecord } from '../../../../src/lib/session/lifecycle/index.ts';

const RECORD = {
  config: { id: 'session-1', agent: '/state/fleet/bin/codex-default', tmuxSession: 'fy-session-1' },
} as unknown as SessionLifecycleRecord;
const OFFLINE = 'Error: account/read failed: workspace routing discovery failed (code -32603)';

function inner(settled?: () => Promise<void>): SessionLifecycleLauncher {
  return {
    alive: async () => true,
    launch: async () => undefined,
    ready: async () => undefined,
    deliver: async () => undefined,
    snapshot: async () => undefined,
    stop: async () => undefined,
    ...(settled === undefined ? {} : { settled }),
  };
}

const supervisor = { afterSessionEnded: async () => ({ kind: 'not-a-codex-runtime' as const }) };
const screen = (text: string): PaneScreenReader => ({ text: async () => text });

describe('RuntimeSupervisedLauncher.settled', () => {
  it('should delegate to a launcher that waits on startup', async () => {
    // Arrange
    const calls: string[] = [];
    const subject = new RuntimeSupervisedLauncher(
      inner(async () => void calls.push('settled')),
      supervisor,
      screen(''),
    );

    // Act
    await subject.settled(RECORD);

    // Assert
    should(calls).deepEqual(['settled']);
  });

  it('should do nothing for a launcher that cannot wait on startup', async () => {
    // Arrange
    const subject = new RuntimeSupervisedLauncher(inner(), supervisor, screen(''));

    // Act + Assert
    await should(subject.settled(RECORD)).be.fulfilled();
  });

  it('should explain a Codex that could not reach the network while starting, keeping the original as the cause', async () => {
    // Arrange
    const failure = new Error('pane died during startup');
    const subject = new RuntimeSupervisedLauncher(
      inner(async () => {
        throw failure;
      }),
      supervisor,
      screen(OFFLINE),
    );

    // Act
    const error = (await subject.settled(RECORD).then(
      () => undefined,
      (caught: unknown) => caught,
    )) as Error;

    // Assert
    should(error.message.startsWith(CODEX_OFFLINE_LAUNCH_ERROR)).be.true();
    should(error.cause).equal(failure);
  });

  it('should pass any other failure through unchanged', async () => {
    // Arrange
    const failure = new Error('the interactive harness exited (2)');
    const subject = new RuntimeSupervisedLauncher(
      inner(async () => {
        throw failure;
      }),
      supervisor,
      screen('a normal prompt'),
    );

    // Act
    const error = await subject.settled(RECORD).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    // Assert
    should(error).equal(failure);
  });
});
