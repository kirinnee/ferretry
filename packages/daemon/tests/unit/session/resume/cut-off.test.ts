import { describe, it } from 'bun:test';
import should from 'should';
import { cutOffResume, resumeUnderCutOff } from '../../../../src/lib/session/resume/cut-off.ts';

/** A session a person cut off (`fy session revoke-credential`) comes back only when a person resumes it. */
describe('resuming a session a person cut off', () => {
  it('should restore it for a person, at the CLI or in the app', () => {
    should([cutOffResume(true, 'admin-cli'), cutOffResume(true, 'admin-ui')]).deepEqual(['restore', 'restore']);
  });

  it('should restore it for the owner in the app on a paired device (C4): "Resume session" is a person asking', () => {
    should(cutOffResume(true, 'device')).equal('restore');
  });

  it('should refuse every other reviver: a peer, the Warden, the daemon itself, or anyone it cannot name', () => {
    for (const actor of ['peer', 'warden', 'daemon', 'unknown'] as const)
      should({ actor, answer: cutOffResume(true, actor) }).deepEqual({ actor, answer: 'refuse' });
  });

  it('should leave a session nobody cut off exactly as it was', () => {
    should(cutOffResume(false, 'peer')).equal('proceed');
    should(cutOffResume(false, 'admin-cli')).equal('proceed');
  });
});

describe('bringing a cut-off session back (secrev-1329-delta)', () => {
  /** A session's cut-off mark, and the steps that move it, recorded. */
  const world = (confirm?: () => void) => {
    const state = { cutOff: true, steps: [] as string[] };
    const steps = {
      ...(confirm === undefined ? {} : { confirm }),
      unconfirmed: () => new Error('not asked'),
      restore: async () => {
        state.steps.push('restore');
        state.cutOff = false;
      },
      markAgain: async () => {
        state.steps.push('mark again');
        state.cutOff = true;
      },
    };
    return { state, steps };
  };

  it('should leave the session cut off when the resume refuses after the restore was confirmed (delta 1)', async () => {
    // Arrange — the caller proved what a restore needs, and the guard then refuses the relaunch
    const { state, steps } = world(() => undefined);

    // Act
    const refused = await resumeUnderCutOff('restore', steps, async () => {
      throw new Error('resume_guard_failed');
    }).catch((error: unknown) => error);

    // Assert — the refusal is the resume's own, and the mark is back
    should(refused).match({ message: 'resume_guard_failed' });
    should(state).eql({ cutOff: true, steps: ['restore', 'mark again'] });
  });

  it('should keep the mark cleared once the resume is accepted', async () => {
    const { state, steps } = world(() => undefined);

    const view = await resumeUnderCutOff('restore', steps, async () => 'relaunched');

    should(view).equal('relaunched');
    should(state).eql({ cutOff: false, steps: ['restore'] });
  });

  it('should ask every restore, whatever the actor, and touch nothing when the question refuses (delta 2)', async () => {
    // Arrange — a governed caller with no device (the admin token off loopback) fails the passkey claim
    const { state, steps } = world(() => {
      throw new Error('step_up_required');
    });
    let resumed = false;

    // Act
    const refused = await resumeUnderCutOff('restore', steps, async () => {
      resumed = true;
    }).catch((error: unknown) => error);

    // Assert
    should(refused).match({ message: 'step_up_required' });
    should([resumed, state.cutOff, state.steps]).eql([false, true, []]);
  });

  it('should refuse a restore no route could ask, and resume a session nobody cut off as it is', async () => {
    const unasked = world();
    const refused = await resumeUnderCutOff('restore', unasked.steps, async () => 'never').catch(
      (error: unknown) => error,
    );
    const plain = world();
    const view = await resumeUnderCutOff('proceed', plain.steps, async () => 'resumed');

    should(refused).match({ message: 'not asked' });
    should(unasked.state).eql({ cutOff: true, steps: [] });
    should([view, plain.state.steps]).eql(['resumed', []]);
  });

  it('should ask the route for every restore in the daemon, not only a device’s', async () => {
    const fyd = (await Bun.file(new URL('../../../../bin/fyd.ts', import.meta.url)).text())
      .replaceAll(/\s+/gu, ' ')
      .replaceAll('( ', '(');
    should(fyd.includes('await resumeUnderCutOff(cutOff, { confirm: confirmRestore,')).be.true();
    should(fyd.includes("cutOff === 'restore' && actor === 'device'")).be.false();
  });
});
