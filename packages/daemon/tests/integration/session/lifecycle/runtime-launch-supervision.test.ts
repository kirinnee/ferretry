/**
 * The two endings of a session and the one launch failure a Codex runtime needs explained.
 *
 * The claims: a stop and a reap each hand the session's launcher to the Codex supervisor AFTER the
 * pane is gone; a ready or deliver failure whose pane shows the offline signature becomes the
 * "needs a network connection" error, keeping the original as its cause, and any other failure passes
 * through unchanged; every other launcher call is delegated untouched.
 */
import { describe, it } from 'bun:test';
import type { SessionLaunchInstructions } from '@ferretry/protocol';
import should from 'should';
import {
  type PaneScreenReader,
  RuntimeSupervisedLauncher,
  RuntimeSupervisedReaper,
} from '../../../../src/adapters/session/lifecycle/runtime-launch-supervision.ts';
import { CODEX_OFFLINE_LAUNCH_ERROR, type CodexAppServerOutcome } from '../../../../src/lib/fleet/codex-runtime.ts';
import type { SessionLifecycleLauncher, SessionLifecycleRecord } from '../../../../src/lib/session/lifecycle/index.ts';
import type { TerminalReapTarget } from '../../../../src/lib/session/reap.ts';

const WRAPPER = '/state/fleet/bin/codex-default';
const RECORD = {
  config: { id: 'session-1', agent: WRAPPER, tmuxSession: 'fy-session-1' },
} as unknown as SessionLifecycleRecord;
const OFFLINE = 'Error: account/read failed: workspace routing discovery failed (code -32603)';

/** What the inner launcher says its pane was told; the decorator must hand it back untouched. */
const LAUNCHED: SessionLaunchInstructions = { sections: [{ id: 'tools', chars: 1 }], mode: 'auto', questions: false };

class RecordingLauncher implements SessionLifecycleLauncher {
  readonly calls: string[] = [];
  failure: Error | undefined;

  async alive(): Promise<boolean> {
    this.calls.push('alive');
    return true;
  }
  async launch(): Promise<SessionLaunchInstructions> {
    this.calls.push('launch');
    return LAUNCHED;
  }
  async ready(): Promise<void> {
    this.calls.push('ready');
    if (this.failure !== undefined) throw this.failure;
  }
  async deliver(_record: SessionLifecycleRecord, instruction: string): Promise<void> {
    this.calls.push(`deliver ${instruction}`);
    if (this.failure !== undefined) throw this.failure;
  }
  async snapshot(): Promise<void> {
    this.calls.push('snapshot');
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
}

const supervisor = (calls: string[]) => ({
  afterSessionEnded: async (wrapper: string): Promise<CodexAppServerOutcome> => {
    calls.push(`ended ${wrapper}`);
    return { kind: 'not-a-codex-runtime' };
  },
});

const screen = (text: string | Error): PaneScreenReader => ({
  text: async () => {
    if (text instanceof Error) throw text;
    return text;
  },
});

async function caught(work: Promise<unknown>): Promise<Error> {
  return (await work.then(
    () => undefined,
    (error: unknown) => error,
  )) as Error;
}

describe('RuntimeSupervisedLauncher', () => {
  it('should delegate every launcher call and follow a stop with the runtime’s housekeeping', async () => {
    // Arrange
    const inner = new RecordingLauncher();
    const subject = new RuntimeSupervisedLauncher(inner, supervisor(inner.calls), screen(''));

    // Act
    should(await subject.alive(RECORD)).be.true();
    const launched = await subject.launch(RECORD);
    await subject.ready(RECORD);
    await subject.deliver(RECORD, 'go');
    await subject.snapshot(RECORD);
    await subject.stop(RECORD);

    // Assert
    should(inner.calls).deepEqual(['alive', 'launch', 'ready', 'deliver go', 'snapshot', 'stop', `ended ${WRAPPER}`]);
    should(launched).equal(LAUNCHED);
  });

  it('should explain a Codex that could not reach the network while starting', async () => {
    // Arrange
    const inner = new RecordingLauncher();
    inner.failure = new Error('pane died before it was ready');
    const subject = new RuntimeSupervisedLauncher(inner, supervisor([]), screen(OFFLINE));

    // Act
    const ready = await caught(subject.ready(RECORD));
    const deliver = await caught(subject.deliver(RECORD, 'go'));

    // Assert
    for (const error of [ready, deliver]) {
      should(error.message.startsWith(CODEX_OFFLINE_LAUNCH_ERROR)).be.true();
      should(error.cause).equal(inner.failure);
    }
  });

  it('should pass any other failure through unchanged, even when the screen cannot be read', async () => {
    // Arrange
    const inner = new RecordingLauncher();
    inner.failure = new Error('something else');
    const unrelated = new RuntimeSupervisedLauncher(inner, supervisor([]), screen('a normal prompt'));
    const unreadable = new RuntimeSupervisedLauncher(inner, supervisor([]), screen(new Error('tmux gone')));

    // Act + Assert
    should(await caught(unrelated.ready(RECORD))).equal(inner.failure);
    should(await caught(unreadable.deliver(RECORD, 'go'))).equal(inner.failure);
  });
});

describe('RuntimeSupervisedReaper', () => {
  const TARGET = { sessionId: 'session-1' } as TerminalReapTarget;

  it('should follow a reap with the runtime’s housekeeping for the session’s launcher', async () => {
    // Arrange
    const calls: string[] = [];
    const subject = new RuntimeSupervisedReaper(
      { reap: async () => void calls.push('reap') },
      supervisor(calls),
      async id => (id === 'session-1' ? WRAPPER : undefined),
    );

    // Act
    await subject.reap(TARGET);

    // Assert
    should(calls).deepEqual(['reap', `ended ${WRAPPER}`]);
  });

  it('should not follow up a session whose launcher cannot be read', async () => {
    // Arrange
    const calls: string[] = [];
    const unknown = new RuntimeSupervisedReaper(
      { reap: async () => undefined },
      supervisor(calls),
      async () => undefined,
    );
    const broken = new RuntimeSupervisedReaper({ reap: async () => undefined }, supervisor(calls), async () => {
      throw new Error('record unreadable');
    });

    // Act
    await unknown.reap(TARGET);
    await broken.reap(TARGET);

    // Assert
    should(calls).be.empty();
  });
});
