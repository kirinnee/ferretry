/**
 * Codex's own flow, proved against the bytes `codex login --device-auth` was OBSERVED to write.
 *
 * This file is Codex's and only Codex's. There is deliberately no shared harness with
 * `claude-flow.test.ts`: the interesting properties here — two values arriving on two lines, and a
 * submission that can never be accepted — have no counterpart there, and a shared table would have had
 * to express both as options on one shape.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  CODEX_LOGIN_ARGV,
  CODEX_LOGIN_START,
  CODEX_VERIFICATION_HOSTS,
  type CodexLoginStage,
  codexProjection,
  decideCodexSubmit,
  observeCodexLine,
} from '../../../src/lib/fleet-login/codex-flow.ts';
import type { HarnessLoginFlowBase } from '../../../src/lib/fleet-login/ports.ts';

const ESC = '\u001b';

/** The four lines observed at codex-cli 0.145.0, colour and indentation included. */
const HEADING = 'Follow these steps to sign in with ChatGPT using device code authorization:';
const STEP_ONE = '1. Open this link in your browser and sign in to your account';
const URL_LINE = `   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`;
const STEP_TWO = `2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m`;
const CODE_LINE = `   ${ESC}[94m0IER-FFQW6${ESC}[0m`;

const CODEX_URL = 'https://auth.openai.com/codex/device';
const USER_CODE = '0IER-FFQW6';

const BASE: HarnessLoginFlowBase = {
  flowId: 'flow-two',
  accountId: '00000000-0000-4000-8000-000000000002',
  identity: 'codex:kirin',
  startedAt: '2026-08-19T10:00:00.000Z',
  expiresAt: '2026-08-19T10:10:00.000Z',
};

const awaiting: CodexLoginStage = { stage: 'awaiting-approval', verificationUrl: CODEX_URL, userCode: USER_CODE };
const complete: CodexLoginStage = { stage: 'complete', accounts: [{ accountId: BASE.accountId, status: 'logged-in' }] };
const failed: CodexLoginStage = {
  stage: 'failed',
  reason: 'this host’s codex did not offer a sign-in that can be driven from a browser',
  remedy: 'run `fy fleet login`',
};

describe('Codex’s own login argv', () => {
  it('should ask for the device grant, which is the whole reason this leg is remotable', () => {
    should(CODEX_LOGIN_ARGV).deepEqual(['login', '--device-auth']);
  });

  it('should never carry a flag that would take a secret', () => {
    // `--with-api-key` and `--with-access-token` both read a credential from stdin. They are fine for a
    // person at the host and they would make this daemon a credential conduit, so they are excluded from
    // this flow at every layer — starting with the argv, where the exclusion is checkable.
    should(CODEX_LOGIN_ARGV.join(' ')).not.match(/--with-(api-key|access-token)/u);
  });
});

describe('observeCodexLine', () => {
  it('should publish nothing from the URL alone, because half a device grant cannot be acted on', () => {
    // Act
    const actual = observeCodexLine(CODEX_LOGIN_START, URL_LINE);

    // Assert
    should(actual).deepEqual({ stage: 'collecting', verificationUrl: CODEX_URL });
  });

  it('should publish nothing from the code alone either', () => {
    // Act
    const actual = observeCodexLine(CODEX_LOGIN_START, CODE_LINE);

    // Assert
    should(actual).deepEqual({ stage: 'collecting', userCode: USER_CODE });
  });

  it('should publish once both values have arrived, in the order the provider prints them', () => {
    // Act
    const actual = [HEADING, STEP_ONE, URL_LINE, '', STEP_TWO, CODE_LINE].reduce(observeCodexLine, CODEX_LOGIN_START);

    // Assert
    should(actual).deepEqual(awaiting);
  });

  it('should publish when the two values arrive in the other order', () => {
    // Act
    const actual = [CODE_LINE, URL_LINE].reduce(observeCodexLine, CODEX_LOGIN_START);

    // Assert
    should(actual).deepEqual(awaiting);
  });

  it('should not read a code out of the sentence that introduces it', () => {
    // Act
    const actual = observeCodexLine(CODEX_LOGIN_START, STEP_TWO);

    // Assert
    should(actual).equal(CODEX_LOGIN_START);
  });

  it('should not read a code out of a line that merely contains one', () => {
    // The whole trimmed line must BE the code. A line with words around it is prose, and publishing a
    // fragment of prose as a one-time code would put unclassified child output on the wire.
    // Act
    const actual = observeCodexLine(CODEX_LOGIN_START, 'your code is 0IER-FFQW6 — type it at the page');

    // Assert
    should(actual).equal(CODEX_LOGIN_START);
  });

  it('should drop the provider’s own warning line, which names no value', () => {
    // Act
    const actual = observeCodexLine(
      CODEX_LOGIN_START,
      'Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.',
    );

    // Assert
    should(actual).equal(CODEX_LOGIN_START);
  });

  it('should drop a URL on a host this flow does not send people to', () => {
    // Act
    const actual = observeCodexLine(CODEX_LOGIN_START, 'visit https://device.example.test/activate');

    // Assert
    should(actual).equal(CODEX_LOGIN_START);
  });

  it('should not move a flow a person is already acting on', () => {
    // Act
    const actual = observeCodexLine(awaiting, `   ${ESC}[94mZZZZ-99999${ESC}[0m`);

    // Assert
    should(actual).equal(awaiting);
  });

  it('should not move a settled flow', () => {
    // Act
    const actual = [observeCodexLine(complete, CODE_LINE), observeCodexLine(failed, URL_LINE)];

    // Assert
    should(actual).deepEqual([complete, failed]);
  });

  it('should send people only to hosts this provider owns', () => {
    should(CODEX_VERIFICATION_HOSTS).deepEqual(['openai.com', 'chatgpt.com']);
  });
});

describe('decideCodexSubmit', () => {
  it('should refuse every submission, because a device grant has no return trip', () => {
    // Act
    const actual = decideCodexSubmit(awaiting);

    // Assert
    should(actual).have.property('decision', 'refused');
    should(actual)
      .have.property('reason')
      .match(/enter the one-time code at the provider/u);
  });

  it('should refuse a submission before the code is even published, and say the same thing', () => {
    // Act
    const actual = decideCodexSubmit(CODEX_LOGIN_START);

    // Assert
    should(actual).have.property('decision', 'refused');
  });

  it('should conflict on a finished sign-in rather than explaining the device grant again', () => {
    // Act
    const actual = decideCodexSubmit(complete);

    // Assert
    should(actual).deepEqual({ decision: 'conflict', reason: 'this login has already finished' });
  });

  it('should conflict on a failed sign-in and carry the reason it failed', () => {
    // Act
    const actual = decideCodexSubmit(failed);

    // Assert
    should(actual)
      .have.property('reason')
      .match(/no longer running: this host/u);
  });

  it('should never answer `write`, in any stage it can be in', () => {
    const stages: CodexLoginStage[] = [
      CODEX_LOGIN_START,
      { stage: 'collecting', verificationUrl: CODEX_URL },
      awaiting,
      complete,
      failed,
    ];

    for (const stage of stages) should(decideCodexSubmit(stage)).not.have.property('decision', 'write');
  });
});

describe('codexProjection', () => {
  it('should publish both values together, because a device grant needs both', () => {
    // Act
    const actual = codexProjection(BASE, awaiting);

    // Assert
    should(actual).deepEqual({
      harness: 'codex',
      ...BASE,
      state: 'awaiting-approval',
      verificationUrl: CODEX_URL,
      userCode: USER_CODE,
    });
  });

  it('should report a half-collected grant as running, never as something to act on', () => {
    // Act
    const actual = codexProjection(BASE, { stage: 'collecting', verificationUrl: CODEX_URL });

    // Assert
    should(actual).deepEqual({ harness: 'codex', ...BASE, state: 'starting' });
    should(actual).not.have.property('verificationUrl');
  });

  it('should report a flow with neither value yet as running', () => {
    // Act
    const actual = codexProjection(BASE, CODEX_LOGIN_START);

    // Assert
    should(actual).deepEqual({ harness: 'codex', ...BASE, state: 'starting' });
  });

  it('should carry the fleet’s per-account outcomes when it finishes', () => {
    // Act
    const actual = codexProjection(BASE, complete);

    // Assert
    should(actual)
      .have.property('accounts')
      .deepEqual([{ accountId: BASE.accountId, status: 'logged-in' }]);
  });

  it('should name the way back on every failure', () => {
    // Act
    const actual = codexProjection(BASE, failed);

    // Assert
    should(actual).have.property('remedy', 'run `fy fleet login`');
  });

  it('should have no state in which it awaits a pasted code', () => {
    const stages: CodexLoginStage[] = [CODEX_LOGIN_START, awaiting, complete, failed];

    for (const stage of stages) should(codexProjection(BASE, stage)).not.have.property('state', 'awaiting-code');
  });
});
