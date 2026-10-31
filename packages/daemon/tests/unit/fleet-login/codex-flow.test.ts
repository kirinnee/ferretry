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
  CODEX_LINK_LOGIN_ARGV,
  CODEX_LINK_START,
  CODEX_LOGIN_ARGV,
  CODEX_LOGIN_START,
  CODEX_VERIFICATION_HOSTS,
  type CodexLoginStage,
  codexAutomaticLink,
  codexDelivering,
  codexEnding,
  codexProjection,
  codexSharedHostEnding,
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

const BASE = {
  flowId: 'flow-two',
  credentialId: 'codex-kirin',
  identity: 'codex:kirin',
  startedAt: '2026-08-19T10:00:00.000Z',
  expiresAt: '2026-08-19T10:10:00.000Z',
} satisfies HarnessLoginFlowBase;

const awaiting: CodexLoginStage = { stage: 'awaiting-approval', verificationUrl: CODEX_URL, userCode: USER_CODE };
const complete: CodexLoginStage = { stage: 'complete' };
const PASTE = { code: 'pasted-TESTONLY' } as const;
const failed: CodexLoginStage = {
  stage: 'failed',
  reason: 'this host’s codex did not offer a sign-in that can be driven from a browser',
  remedy: 'run `fy credential signin codex-kirin`',
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

  it('should publish exactly the pair from the whole observed transcript, banner and caution included', () => {
    // RE-OBSERVED at codex-cli 0.145.0 on 2026-08-24, running `codex login --device-auth` with piped
    // stdio: the run opens with a version banner these fixtures did not previously carry, and closes with
    // the provider's caution. Fed as a sequence rather than as separate lines, because that is the only
    // way to show that an earlier line neither publishes nor spoils a later one — a banner reading
    // `Welcome to Codex [v0.145.0]` is exactly the kind of line a looser recogniser would take a value out
    // of, and the user code arrives AFTER it.
    const transcript = [
      '',
      `Welcome to Codex [v${ESC}[90m0.145.0${ESC}[0m]`,
      `${ESC}[90mOpenAI's command-line coding agent${ESC}[0m`,
      '',
      HEADING,
      '',
      STEP_ONE,
      URL_LINE,
      '',
      STEP_TWO,
      CODE_LINE,
      '',
      `${ESC}[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.${ESC}[0m`,
    ];

    // Act
    const actual = transcript.reduce(observeCodexLine, CODEX_LOGIN_START);

    // Assert
    should(actual).deepEqual({ stage: 'awaiting-approval', verificationUrl: CODEX_URL, userCode: USER_CODE });
  });

  it('should read a user code whose groups are four and five characters long', () => {
    // `99BS-Z51VR` was what the provider printed when this was re-measured on 2026-08-24, and the
    // fixture code above is 4-5 as well — but the schema admits three to eight per group, so a case that
    // only ever fed one width would not show that the width is not pinned to the one somebody saw.
    // Act
    const actual = observeCodexLine(
      { stage: 'collecting', verificationUrl: CODEX_URL },
      `   ${ESC}[94m99BS-Z51VR${ESC}[0m`,
    );

    // Assert
    should(actual).deepEqual({ stage: 'awaiting-approval', verificationUrl: CODEX_URL, userCode: '99BS-Z51VR' });
  });

  it('should send people only to hosts this provider owns', () => {
    should(CODEX_VERIFICATION_HOSTS).deepEqual(['openai.com', 'chatgpt.com']);
  });
});

describe('decideCodexSubmit', () => {
  it('should refuse every submission, because a device grant has no return trip', () => {
    // Act
    const actual = decideCodexSubmit(awaiting, PASTE);

    // Assert
    should(actual).have.property('decision', 'refused');
    should(actual)
      .have.property('reason')
      .match(/enter the one-time code at the provider/u);
  });

  it('should refuse a submission before the code is even published, and say the same thing', () => {
    // Act
    const actual = decideCodexSubmit(CODEX_LOGIN_START, PASTE);

    // Assert
    should(actual).have.property('decision', 'refused');
  });

  it('should conflict on a finished sign-in rather than explaining the device grant again', () => {
    // Act
    const actual = decideCodexSubmit(complete, PASTE);

    // Assert
    should(actual).deepEqual({ decision: 'conflict', reason: 'this login has already finished' });
  });

  it('should conflict on a failed sign-in and carry the reason it failed', () => {
    // Act
    const actual = decideCodexSubmit(failed, PASTE);

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

    for (const stage of stages) should(decideCodexSubmit(stage, PASTE)).not.have.property('decision', 'write');
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

  it('should say it finished and carry no per-account outcomes', () => {
    // Act
    const actual = codexProjection(BASE, complete);

    // Assert
    should(actual).deepEqual({ harness: 'codex', ...BASE, state: 'complete' });
    should(actual).not.have.property('accounts');
  });

  it('should name the way back on every failure', () => {
    // Act
    const actual = codexProjection(BASE, failed);

    // Assert
    should(actual).have.property('remedy', 'run `fy credential signin codex-kirin`');
  });

  it('should have no state in which it awaits a pasted code', () => {
    const stages: CodexLoginStage[] = [CODEX_LOGIN_START, awaiting, complete, failed];

    for (const stage of stages) should(codexProjection(BASE, stage)).not.have.property('state', 'awaiting-code');
  });
});

/**
 * What codex-cli 0.156.1 prints when it stops polling a device grant nobody approved — the prefix and
 * the message are both strings in the installed binary.
 */
const TIMED_OUT_LINE = `Error logging in with device code: ${ESC}[31mdevice auth timed out after 15 minutes${ESC}[0m`;

describe('a one-time code nobody approved', () => {
  it('should hold that Codex stopped waiting, without publishing it', () => {
    // Act
    const actual = observeCodexLine(awaiting, TIMED_OUT_LINE);

    // Assert
    should(actual).deepEqual({ ...awaiting, timedOut: true });
    should(codexProjection(BASE, actual)).deepEqual(codexProjection(BASE, awaiting));
  });

  it('should not read any other device failure as an expiry, because a status code says nothing of why', () => {
    // Act
    const actual = observeCodexLine(awaiting, 'Error logging in with device code: device auth failed with status 500');

    // Assert
    should(actual).equal(awaiting);
  });

  it('should end as an expired code — never a rejected one — when Codex exits after timing out', () => {
    // Act
    const actual = codexEnding(observeCodexLine(awaiting, TIMED_OUT_LINE), { exit: 1 });

    // Assert
    should(actual).deepEqual({
      stage: 'failed',
      reason: 'the one-time code expired before it was approved',
      remedy: 'Start a new sign-in to get a new code, then enter it on the provider’s page.',
      lastCode: 'expired',
    });
  });

  it('should end as an expired code when the window closes on a code a person holds', () => {
    // Act
    const actual = codexEnding(awaiting, 'window');

    // Assert
    should(actual).have.property('lastCode', 'expired');
  });

  it('should leave an ordinary exit, and every other stage, to the ordinary ending', () => {
    // Act
    const actual = [
      codexEnding(awaiting, { exit: 1 }),
      codexEnding({ ...awaiting, timedOut: true }, { exit: 0 }),
      ...[CODEX_LOGIN_START, complete, failed].flatMap(stage => [
        codexEnding(stage, 'window'),
        codexEnding(stage, { exit: 1 }),
      ]),
    ];

    // Assert
    should(actual.every(ending => ending === undefined)).be.true();
  });

  it('should carry the expiry onto the wire as the one recognised value', () => {
    // Act
    const ending = codexEnding(awaiting, 'window');
    const actual = ending === undefined ? undefined : codexProjection(BASE, ending);

    // Assert
    should(actual).deepEqual({
      harness: 'codex',
      ...BASE,
      state: 'failed',
      reason: 'the one-time code expired before it was approved',
      remedy: 'Start a new sign-in to get a new code, then enter it on the provider’s page.',
      lastCode: 'expired',
    });
  });
});

const LINK_URL =
  'https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=STATE-TESTONLY';
const callback = { port: 1455, path: '/auth/callback', state: 'STATE-TESTONLY' };
const linkAwaiting: CodexLoginStage = { stage: 'awaiting-callback', verificationUrl: LINK_URL, callback };

describe('Codex’s link sign-in stages', () => {
  it('should run Codex’s ordinary login, with no flag, for a link', () => {
    should(CODEX_LINK_LOGIN_ARGV).deepEqual(['login']);
    should(CODEX_LINK_START).deepEqual({ stage: 'linking' });
    should(codexAutomaticLink()).deepEqual({ stage: 'linking', automatic: true });
    should(codexDelivering()).deepEqual({ stage: 'finishing' });
  });

  it('should say why no link was started on its own, and what to do, when the host is shared', () => {
    // Act
    const actual = codexSharedHostEnding();

    // Assert
    should(actual.stage).equal('failed');
    should(actual.reason).containEql('1455 or 1457').and.containEql('shared host');
    should(actual.remedy).containEql('choose the link sign-in yourself');
    should(actual).not.have.property('lastCode');
  });

  it('should move a device flow on when Codex could not get a device code, before or after part of one', () => {
    const lines = [
      'Error logging in with device code: device code login is not enabled for this Codex server.',
      'Error logging in with device code: device code request failed with status 403 Forbidden',
      'Error logging in with device code: failed to request device code: error sending request',
    ];

    for (const line of lines) {
      should(observeCodexLine(CODEX_LOGIN_START, line)).deepEqual({ stage: 'device-unavailable' });
      should(observeCodexLine({ stage: 'collecting', verificationUrl: CODEX_URL }, line)).deepEqual({
        stage: 'device-unavailable',
      });
    }
  });

  it('should publish the authorize URL and its callback, keeping why the link was chosen', () => {
    should(observeCodexLine(CODEX_LINK_START, LINK_URL)).deepEqual(linkAwaiting);
    should(observeCodexLine(codexAutomaticLink(), LINK_URL)).deepEqual({ ...linkAwaiting, automatic: true });
  });

  it('should drop a link line whose host or callback this flow cannot use', () => {
    const untrusted = LINK_URL.replace('auth.openai.com', 'auth.example.com');
    const noCallback = 'https://auth.openai.com/oauth/authorize?state=abc';

    should(observeCodexLine(CODEX_LINK_START, 'Starting local login server on http://localhost:1455.')).equal(
      CODEX_LINK_START,
    );
    should(observeCodexLine(CODEX_LINK_START, untrusted)).equal(CODEX_LINK_START);
    should(observeCodexLine(CODEX_LINK_START, noCallback)).equal(CODEX_LINK_START);
    should(observeCodexLine(linkAwaiting, LINK_URL)).equal(linkAwaiting);
  });

  it('should hold Codex saying its ports are taken, and end on it with the cause', () => {
    const busy = observeCodexLine(CODEX_LINK_START, 'Error logging in: Port 127.0.0.1:1457 is already in use');

    should(busy).deepEqual({ stage: 'linking', portsBusy: true });
    should(codexEnding(busy, { exit: 1 })).match({ reason: /ports 1455 and 1457/u });
    should(codexEnding(busy, { exit: 0 })).be.undefined();
    should(codexEnding(busy, 'window')).be.undefined();
    should(codexEnding(CODEX_LINK_START, { exit: 1 })).be.undefined();
  });

  it('should end on the address only when the address is why', () => {
    should(codexEnding(linkAwaiting, 'window')).match({ lastCode: 'expired' });
    should(codexEnding(linkAwaiting, { exit: 1 })).be.undefined();
    should(codexEnding({ stage: 'finishing' }, { exit: 1 })).match({ lastCode: 'rejected' });
    should(codexEnding({ stage: 'finishing' }, { exit: 0 })).be.undefined();
    should(codexEnding({ stage: 'finishing' }, 'window')).be.undefined();
  });

  it('should decide what a person sent to a link flow by stage', () => {
    const address = 'http://localhost:1455/auth/callback?code=c-TESTONLY&state=STATE-TESTONLY';

    should(decideCodexSubmit(awaiting, { method: 'link' })).deepEqual({ decision: 'switch' });
    should(decideCodexSubmit(CODEX_LOGIN_START, { method: 'link' })).deepEqual({ decision: 'switch' });
    should(decideCodexSubmit(linkAwaiting, { method: 'link' })).have.property('decision', 'conflict');
    should(decideCodexSubmit(linkAwaiting, { code: address })).have.property('decision', 'deliver');
    should(decideCodexSubmit(linkAwaiting, { code: 'nope' })).have.property('decision', 'refused');
    should(decideCodexSubmit({ stage: 'finishing' }, { code: address })).have.property('decision', 'conflict');
    should(decideCodexSubmit({ stage: 'device-unavailable' }, { code: address })).match({
      decision: 'refused',
      reason: /has not shown its link yet/u,
    });
  });

  it('should project the link stages in Codex’s own state names, and never the callback', () => {
    should(codexProjection(BASE, linkAwaiting)).deepEqual({
      harness: 'codex',
      ...BASE,
      state: 'awaiting-callback',
      verificationUrl: LINK_URL,
    });
    should(codexProjection(BASE, { ...linkAwaiting, automatic: true })).have.property('deviceCode', 'unavailable');
    should(codexProjection(BASE, { stage: 'finishing' })).deepEqual({ harness: 'codex', ...BASE, state: 'finishing' });
    should(codexProjection(BASE, CODEX_LINK_START)).have.property('state', 'starting');
  });
});
