import { StartSessionRequestSchema } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import { SessionCommandError } from '../../../src/lib/session/errors.ts';
import type { SessionEnvironment } from '../../../src/lib/session/ports.ts';
import {
  buildStartRequest,
  resolveParent,
  type StartFlags,
  TURN_TIMEOUT_HINT_SECONDS,
} from '../../../src/lib/session/start-request.ts';

const HERE: SessionEnvironment = { cwd: '/work/repo' };
const auto: StartFlags = { agent: 'claude-alpha', mode: 'auto', prompt: 'do the thing' };

describe('resolveParent', () => {
  const cases: readonly (readonly [string, Parameters<typeof resolveParent>[0], string | undefined])[] = [
    ['an explicit parent always wins', { explicit: 'ses-x', callerSessionId: 'ses-env', mode: 'auto' }, 'ses-x'],
    ['an auto session inherits the calling pane', { callerSessionId: 'ses-env', mode: 'auto' }, 'ses-env'],
    [
      'an interactive session never inherits the caller',
      { callerSessionId: 'ses-env', mode: 'interactive' },
      undefined,
    ],
    ['an explicit parent still applies to interactive', { explicit: 'ses-x', mode: 'interactive' }, 'ses-x'],
    ['a blank explicit value is not a parent', { explicit: '  ', mode: 'auto' }, undefined],
    ['a blank caller id is not a parent', { callerSessionId: ' ', mode: 'auto' }, undefined],
    ['no lineage at all', { mode: 'auto' }, undefined],
  ];

  for (const [name, input, expected] of cases) {
    it(`should resolve ${name}`, () => {
      // Arrange / Act
      const actual = resolveParent(input);

      // Assert
      should(actual).equal(expected);
    });
  }
});

describe('buildStartRequest', () => {
  it('should build a wire request the protocol schema accepts', () => {
    // Arrange
    const flags: StartFlags = {
      ...auto,
      name: 'Fix Transcript Scrolling',
      teammate: 'Hayden',
      teammateFallback: true,
      label: 'batch',
      model: 'opus-5',
      remoteControl: true,
      harnessFlags: ['--verbose'],
      interval: 30,
      turnTimeout: 3600,
      nudgeAfter: 180,
      stallKillAfter: 300,
      directMax: 0,
      maxSnapshots: 5,
      detach: true,
      attachments: [{ filename: 'shot.png', mime: 'image/png', base64: 'AAAA' }],
    };

    // Act
    const plan = buildStartRequest(flags, { cwd: '/work/repo', callerSessionId: 'ses-lead' });

    // Assert
    should(StartSessionRequestSchema.safeParse(plan.request).success).be.true();
    should(plan.request).containDeep({
      mode: 'auto',
      prompt: 'do the thing',
      agent: 'claude-alpha',
      boardAccess: 'none',
      cwd: '/work/repo',
      parent: 'ses-lead',
      teammateFallback: true,
      remoteControl: true,
      intervalSeconds: 30,
      timeoutSeconds: 3600,
      nudgeAfterSeconds: 180,
      killAfterSeconds: 300,
      directSendMaxChars: 0,
      maxSnapshots: 5,
      detach: true,
    });
    should(plan.warnings).be.empty();
    should(plan.boardCapability).be.undefined();
  });

  it('should leave every unset flag off the wire rather than sending a default', () => {
    // Arrange / Act
    const plan = buildStartRequest(auto, HERE);

    // Assert
    should(Object.keys(plan.request).sort()).deepEqual([
      'agent',
      'boardAccess',
      'cwd',
      'harnessFlags',
      'mode',
      'prompt',
    ]);
  });

  it('should prefer an explicit --cwd over the working directory', () => {
    // Arrange / Act
    const plan = buildStartRequest({ ...auto, cwd: '/elsewhere' }, HERE);

    // Assert
    should(plan.request.cwd).equal('/elsewhere');
  });

  it('should refuse an auto session with no task', () => {
    // Arrange / Act / Assert
    should(() => buildStartRequest({ ...auto, prompt: '   ' }, HERE)).throw(/provide a prompt/);
  });

  it('should allow an interactive session to start bare', () => {
    // Arrange / Act
    const plan = buildStartRequest({ agent: 'claude-alpha', mode: 'interactive' }, HERE);

    // Assert
    should(StartSessionRequestSchema.safeParse(plan.request).success).be.true();
    should(plan.request).not.have.property('prompt');
  });

  it('should still carry a prompt an interactive session was given', () => {
    // Arrange / Act
    const plan = buildStartRequest({ agent: 'claude-alpha', mode: 'interactive', prompt: 'look at this' }, HERE);

    // Assert
    should(plan.request).have.property('prompt', 'look at this');
  });

  it('should warn that a small turn timeout kills healthy work', () => {
    // Arrange / Act
    const plan = buildStartRequest({ ...auto, turnTimeout: TURN_TIMEOUT_HINT_SECONDS - 1 }, HERE);

    // Assert
    should(plan.warnings).have.length(1);
    should(plan.warnings[0]).match(/hard KILL timer/);
  });

  it('should not warn about a turn timeout that reads as a work ceiling', () => {
    // Arrange / Act
    const plan = buildStartRequest({ ...auto, turnTimeout: TURN_TIMEOUT_HINT_SECONDS }, HERE);

    // Assert
    should(plan.warnings).be.empty();
  });

  const numericCases: readonly (readonly [string, Partial<StartFlags>, RegExp])[] = [
    ['a non-numeric interval', { interval: Number.NaN }, /--interval must be an integer of at least 1/],
    ['a zero interval', { interval: 0 }, /--interval must be an integer of at least 1/],
    ['a fractional turn timeout', { turnTimeout: 1.5 }, /--turn-timeout must be an integer of at least 1/],
    ['a negative nudge window', { nudgeAfter: -1 }, /--nudge-after must be an integer of at least 0/],
    ['a non-numeric stall kill', { stallKillAfter: Number.NaN }, /--stall-kill-after/],
    ['a negative direct-send ceiling', { directMax: -5 }, /--direct-max must be an integer of at least 0/],
    ['a zero snapshot budget', { maxSnapshots: 0 }, /--max-snapshots must be an integer of at least 1/],
  ];

  for (const [name, overrides, expected] of numericCases) {
    it(`should reject ${name} by naming the flag the caller typed`, () => {
      // Arrange / Act / Assert
      should(() => buildStartRequest({ ...auto, ...overrides }, HERE)).throw(expected);
    });
  }

  it('should accept a zero-valued flag the schema allows', () => {
    // Arrange / Act
    const plan = buildStartRequest({ ...auto, nudgeAfter: 0, directMax: 0 }, HERE);

    // Assert
    should(plan.request).containDeep({ nudgeAfterSeconds: 0, directSendMaxChars: 0 });
  });

  it('should refuse a board-access start with no capability to grant it with', () => {
    // Arrange / Act / Assert
    should(() => buildStartRequest({ ...auto, boardAccess: 'worker', parent: 'ses-lead' }, HERE)).throw(
      /needs the caller's own board capability/,
    );
  });

  it('should carry the capability when a board grant is requested', () => {
    // Arrange / Act
    const plan = buildStartRequest(
      { ...auto, boardAccess: 'worker', parent: 'ses-lead' },
      { cwd: '/work/repo', boardCapability: ' cap-token ' },
    );

    // Assert
    should(plan.boardCapability).equal('cap-token');
    should(plan.request.boardAccess).equal('worker');
  });

  it('should report a usage error with exit code 2', () => {
    // Arrange / Act
    const error = (() => {
      try {
        buildStartRequest({ ...auto, prompt: '' }, HERE);
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();

    // Assert
    should(error).be.instanceof(SessionCommandError);
    should((error as SessionCommandError).exitCode).equal(2);
  });
});
