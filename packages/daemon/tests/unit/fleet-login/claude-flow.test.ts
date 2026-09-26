/**
 * Claude's own flow, proved against the bytes `claude auth login --claudeai` was OBSERVED to write.
 *
 * This file is Claude's and only Claude's. There is deliberately no shared harness with
 * `codex-flow.test.ts` and no parameterised table over both: the two logins have different states,
 * different output and different submission rules, and one test that ran both through one shape would
 * be evidence about the shape rather than about either login.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  CLAUDE_LOGIN_ARGV,
  CLAUDE_LOGIN_START,
  CLAUDE_VERIFICATION_HOSTS,
  type ClaudeLoginStage,
  claudeCodeSent,
  claudeEnding,
  claudeProjection,
  decideClaudeSubmit,
  observeClaudeLine,
} from '../../../src/lib/fleet-login/claude-flow.ts';
import type { HarnessLoginFlowBase } from '../../../src/lib/fleet-login/ports.ts';

const ESC = '\u001b';
const BEL = '\u0007';

/** Observed at claude-code 2.1.220. The PKCE challenge in the query string is part of the fixture. */
const CLAUDE_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&code_challenge=q_Idh9d77EEIpqWrfe-inHoMUkesAiHZhxWFgcmkrng&code_challenge_method=S256&state=QxLN';

/** The line as it actually arrives: the address inside an OSC 8 hyperlink and again as visible text. */
const URL_LINE = `If the browser didn't open, visit: ${ESC}]8;;${CLAUDE_URL}${BEL}${CLAUDE_URL}${ESC}]8;;${BEL}`;

const BASE: HarnessLoginFlowBase = {
  flowId: 'flow-one',
  accountId: '00000000-0000-4000-8000-000000000001',
  identity: 'claude:kirin',
  startedAt: '2026-08-19T10:00:00.000Z',
  expiresAt: '2026-08-19T10:10:00.000Z',
};

const awaiting: ClaudeLoginStage = { stage: 'awaiting-code', verificationUrl: CLAUDE_URL };
const complete: ClaudeLoginStage = {
  stage: 'complete',
  accounts: [{ accountId: BASE.accountId, status: 'logged-in' }],
};
const failed: ClaudeLoginStage = { stage: 'failed', reason: 'the child exited', remedy: 'run `fy fleet login`' };

describe('Claude’s own login argv', () => {
  it('should launch the subcommand verified to work with piped stdio, not the slash command', () => {
    // The CLI path uses `/login`, which hands a slash command to the interactive TUI. `auth login` is
    // what was observed to print a URL and read a paste when stdout is a pipe.
    should(CLAUDE_LOGIN_ARGV).deepEqual(['auth', 'login', '--claudeai']);
    should(CLAUDE_LOGIN_ARGV).not.containEql('/login');
  });

  it('should never carry a flag that would take a secret', () => {
    should(CLAUDE_LOGIN_ARGV.join(' ')).not.match(/--with-(api-key|access-token)/u);
  });
});

describe('observeClaudeLine', () => {
  it('should publish the URL Claude prints, hyperlink escape and all', () => {
    // Act
    const actual = observeClaudeLine(CLAUDE_LOGIN_START, URL_LINE);

    // Assert
    should(actual).deepEqual(awaiting);
  });

  it('should keep the PKCE challenge, because that is what binds the code to this child', () => {
    // Act
    const actual = observeClaudeLine(CLAUDE_LOGIN_START, URL_LINE);

    // Assert
    should(actual)
      .have.property('verificationUrl')
      .match(/code_challenge_method=S256/u);
  });

  it('should drop the line that only says a browser is opening', () => {
    // Act
    const actual = observeClaudeLine(CLAUDE_LOGIN_START, 'Opening browser to sign in…');

    // Assert
    should(actual).equal(CLAUDE_LOGIN_START);
  });

  it('should drop the paste prompt itself, which carries no address', () => {
    // Act
    const actual = observeClaudeLine(CLAUDE_LOGIN_START, 'Paste code here if prompted > ');

    // Assert
    should(actual).equal(CLAUDE_LOGIN_START);
  });

  it('should drop a URL on a host this flow does not send people to', () => {
    // Act
    const actual = observeClaudeLine(CLAUDE_LOGIN_START, 'visit https://sign-in.example.test/oauth to continue');

    // Assert
    should(actual).equal(CLAUDE_LOGIN_START);
  });

  it('should drop a URL that carries credentials in its address', () => {
    // Act
    const actual = observeClaudeLine(CLAUDE_LOGIN_START, 'visit https://user:secret@claude.com/cai/oauth/authorize');

    // Assert
    should(actual).equal(CLAUDE_LOGIN_START);
  });

  it('should not move a flow a person is already acting on', () => {
    // Act
    const actual = observeClaudeLine(awaiting, 'If the browser didn’t open, visit: https://claude.com/other');

    // Assert
    should(actual).equal(awaiting);
  });

  it('should not move a settled flow', () => {
    // Act
    const actual = [observeClaudeLine(complete, URL_LINE), observeClaudeLine(failed, URL_LINE)];

    // Assert
    should(actual).deepEqual([complete, failed]);
  });

  it('should send people only to hosts this product owns', () => {
    should(CLAUDE_VERIFICATION_HOSTS).deepEqual(['claude.com', 'claude.ai', 'anthropic.com']);
  });

  it('should publish the URL when the harness prints it as PLAIN TEXT, with no hyperlink escape', () => {
    // RE-OBSERVED at claude-code 2.1.220 on 2026-08-24, running `claude auth login --claudeai` with
    // piped stdio and `TERM=dumb`: the address arrives ONCE, unwrapped, with no OSC 8 sequence at all.
    // Every other fixture in this file carries the hyperlink form, so without this case the shape the
    // harness actually emitted when measured would be the one shape the recogniser is never asked about.
    // Both forms must work, and which one a run produces is not this flow's business.
    // Act
    const actual = observeClaudeLine(CLAUDE_LOGIN_START, `If the browser didn't open, visit: ${CLAUDE_URL}`);

    // Assert
    should(actual).deepEqual({ stage: 'awaiting-code', verificationUrl: CLAUDE_URL });
  });

  it('should publish exactly one URL from the whole observed transcript, fed line by line', () => {
    // The bytes `claude auth login --claudeai` wrote at 2.1.220, in order, ending with the prompt that
    // carries no newline. A recogniser is only as good as the sequence it is driven with: three separate
    // single-line cases cannot show that an earlier line does not spoil a later one.
    const transcript = [
      'Opening browser to sign in…',
      `If the browser didn't open, visit: ${CLAUDE_URL}`,
      'Paste code here if prompted > ',
    ];

    // Act
    const actual = transcript.reduce(observeClaudeLine, CLAUDE_LOGIN_START);

    // Assert
    should(actual).deepEqual({ stage: 'awaiting-code', verificationUrl: CLAUDE_URL });
  });
});

describe('decideClaudeSubmit', () => {
  it('should allow a write once a sign-in link has been published', () => {
    // Act
    const actual = decideClaudeSubmit(awaiting);

    // Assert
    should(actual).deepEqual({ decision: 'write' });
  });

  it('should refuse rather than conflict before a link exists, because waiting is the right next act', () => {
    // Act
    const actual = decideClaudeSubmit(CLAUDE_LOGIN_START);

    // Assert
    should(actual).have.property('decision', 'refused');
    should(actual)
      .have.property('reason')
      .match(/has not published a sign-in link/u);
  });

  it('should conflict on a finished sign-in rather than inviting a retry', () => {
    // Act
    const actual = decideClaudeSubmit(complete);

    // Assert
    should(actual).deepEqual({ decision: 'conflict', reason: 'this login has already finished' });
  });

  it('should conflict on a failed sign-in and carry the reason it failed', () => {
    // Act
    const actual = decideClaudeSubmit(failed);

    // Assert
    should(actual)
      .have.property('reason')
      .match(/no longer running: the child exited/u);
  });

  it('should take no code as an argument, so no code can be held by a decision', () => {
    // The signature is the proof: a stage in, a decision out. There is no parameter the person's value
    // could arrive through, which is what makes write-only a property of the shape.
    should(decideClaudeSubmit.length).equal(1);
  });
});

describe('claudeProjection', () => {
  it('should publish the URL and nothing else while awaiting a code', () => {
    // Act
    const actual = claudeProjection(BASE, awaiting);

    // Assert
    should(actual).deepEqual({ harness: 'claude', ...BASE, state: 'awaiting-code', verificationUrl: CLAUDE_URL });
  });

  it('should carry no verification URL before one is recognised', () => {
    // Act
    const actual = claudeProjection(BASE, CLAUDE_LOGIN_START);

    // Assert
    should(actual).deepEqual({ harness: 'claude', ...BASE, state: 'starting' });
  });

  it('should carry the fleet’s per-account outcomes when it finishes', () => {
    // Act
    const actual = claudeProjection(BASE, complete);

    // Assert
    should(actual).deepEqual({
      harness: 'claude',
      ...BASE,
      state: 'complete',
      accounts: [{ accountId: BASE.accountId, status: 'logged-in' }],
    });
  });

  it('should name the way back on every failure', () => {
    // Act
    const actual = claudeProjection(BASE, failed);

    // Assert
    should(actual).deepEqual({
      harness: 'claude',
      ...BASE,
      state: 'failed',
      reason: 'the child exited',
      remedy: 'run `fy fleet login`',
    });
  });

  it('should have no state in which it publishes a device code', () => {
    // Claude has no device grant. Every stage is projected and none of them carries a user code, which
    // is the shape difference that makes this a separate flow from Codex's rather than a flag on one.
    const stages: ClaudeLoginStage[] = [CLAUDE_LOGIN_START, awaiting, complete, failed];

    for (const stage of stages) should(claudeProjection(BASE, stage)).not.have.property('userCode');
  });
});

/**
 * Claude's refusal of a code, as the installed CLI writes it.
 *
 * Quoted from `auth login`'s own stdin handler in claude-code 2.1.281 — the same words
 * `docs/design/harness-login.md` §6 captured by driving 2.1.220 with a wrong code. It goes to stderr,
 * which the spawn adapter reads on the same footing as stdout.
 */
const INVALID_CODE_LINE = 'Invalid code. Please make sure the full code was copied.';

describe('a code Claude refuses', () => {
  it('should say the last code was rejected when Claude answers a paste with its refusal', () => {
    // Act
    const actual = observeClaudeLine(claudeCodeSent(awaiting), INVALID_CODE_LINE);

    // Assert
    should(actual).deepEqual({ stage: 'awaiting-code', verificationUrl: CLAUDE_URL, lastCode: 'rejected' });
  });

  it('should recognise the refusal wrapped in colour, as a terminal program may write it', () => {
    // Act
    const actual = observeClaudeLine(awaiting, `${ESC}[31m${INVALID_CODE_LINE}${ESC}[39m`);

    // Assert
    should(actual).have.property('lastCode', 'rejected');
  });

  it('should not read the refusal words anywhere but at the start of a line', () => {
    // A provider page could put any words in a URL; only Claude's own line may move the flow.
    const actual = observeClaudeLine(awaiting, `visit https://claude.com/?q=${INVALID_CODE_LINE}`);

    // Assert
    should(actual).equal(awaiting);
  });

  it('should ignore the refusal before a link exists and after the flow settled', () => {
    // Act
    const actual = [CLAUDE_LOGIN_START, complete, failed].map(stage => observeClaudeLine(stage, INVALID_CODE_LINE));

    // Assert
    should(actual).deepEqual([CLAUDE_LOGIN_START, complete, failed]);
  });

  it('should clear the previous refusal the moment another code is sent', () => {
    // Arrange
    const rejected = observeClaudeLine(awaiting, INVALID_CODE_LINE);

    // Act
    const actual = claudeCodeSent(rejected);

    // Assert
    should(actual).deepEqual({ stage: 'awaiting-code', verificationUrl: CLAUDE_URL, codeSent: true });
  });

  it('should leave a stage that is not waiting for a code alone when one is sent', () => {
    // Act
    const actual = [CLAUDE_LOGIN_START, complete, failed].map(claudeCodeSent);

    // Assert
    should(actual).deepEqual([CLAUDE_LOGIN_START, complete, failed]);
  });

  it('should publish the refusal as the one recognised value and never the child text', () => {
    // Act
    const actual = claudeProjection(BASE, observeClaudeLine(awaiting, INVALID_CODE_LINE));

    // Assert
    should(actual).deepEqual({
      harness: 'claude',
      ...BASE,
      state: 'awaiting-code',
      verificationUrl: CLAUDE_URL,
      lastCode: 'rejected',
    });
    should(JSON.stringify(actual)).not.containEql('Invalid code');
  });

  it('should never publish that a code is in flight', () => {
    // Act
    const actual = claudeProjection(BASE, claudeCodeSent(awaiting));

    // Assert
    should(actual).not.have.property('codeSent');
  });
});

describe('claudeEnding', () => {
  it('should end as a rejected code when Claude exits after a code was sent', () => {
    // Act
    const actual = claudeEnding(claudeCodeSent(awaiting), { exit: 1 });

    // Assert
    should(actual).deepEqual({
      stage: 'failed',
      reason: 'Claude could not sign in with that code',
      remedy: 'Start a new sign-in for a fresh link, then paste the whole code Claude shows you.',
      lastCode: 'rejected',
    });
  });

  it('should not blame a code when none was sent, or when Claude exited cleanly', () => {
    // Act
    const actual = [
      claudeEnding(awaiting, { exit: 1 }),
      claudeEnding(observeClaudeLine(claudeCodeSent(awaiting), INVALID_CODE_LINE), { exit: 1 }),
      claudeEnding(claudeCodeSent(awaiting), { exit: 0 }),
    ];

    // Assert
    should(actual).deepEqual([undefined, undefined, undefined]);
  });

  it('should say the link expired when the window closes on a person holding one', () => {
    // Act
    const actual = claudeEnding(awaiting, 'window');

    // Assert
    should(actual).deepEqual({
      stage: 'failed',
      reason: 'the sign-in link expired before Claude accepted a code',
      remedy: 'Start a new sign-in to get a fresh link.',
      lastCode: 'expired',
    });
  });

  it('should leave every other stage to the ordinary ending', () => {
    // Act
    const actual = [CLAUDE_LOGIN_START, complete, failed].flatMap(stage => [
      claudeEnding(stage, 'window'),
      claudeEnding(stage, { exit: 1 }),
    ]);

    // Assert
    should(actual.every(ending => ending === undefined)).be.true();
  });

  it('should carry the code ending onto the wire', () => {
    // Act
    const ending = claudeEnding(claudeCodeSent(awaiting), { exit: 1 });
    const actual = ending === undefined ? undefined : claudeProjection(BASE, ending);

    // Assert
    should(actual).have.property('lastCode', 'rejected');
  });
});
