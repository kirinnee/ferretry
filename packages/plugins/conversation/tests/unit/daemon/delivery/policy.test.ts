import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId } from '../../../../daemon/seams/ferret-id.ts';
import {
  authorizeSend,
  defaultSessionSendSettings,
  directLimitFor,
  dispositionOf,
  endsPeerWait,
  isDirectPaste,
  isDirectPayload,
  isDirectSend,
  isFileBackedQueue,
  parseSessionSendSettings,
  peerMessageKind,
  peerPreamble,
  queuedPayloadInstruction,
  routeSend,
  type SendPaneObservation,
  SendRefused,
  type SendTarget,
  SendUnavailable,
  sendPayload,
  turnInstruction,
} from '../../../../daemon/delivery/lib/index.ts';

/**
 * The decisions a send makes before it touches anything.
 *
 * The one under the most pressure is `routeSend`: the two mistakes it can make are not symmetric, so
 * the tests state both directions explicitly.
 */

const ID = parseSessionId('session-1');

function target(overrides: Partial<SendTarget> = {}): SendTarget {
  return { id: ID, status: 'running', mode: 'auto', turn: 3, ...overrides };
}

function pane(overrides: Partial<SendPaneObservation> = {}): SendPaneObservation {
  return { alive: true, dead: false, promptReady: false, activeWork: false, ...overrides };
}

describe('authorizeSend', () => {
  it('accepts an ordinary running session with no attachments', () => {
    should(() => authorizeSend(target(), [])).not.throw();
  });

  it('refuses a session whose terminal shutdown was never confirmed', () => {
    should(() => authorizeSend(target({ status: 'kill_failed' }), [])).throw(SendUnavailable, {
      message: /was not confirmed/u,
    });
  });

  it('refuses a quarantined session and names the quarantine', () => {
    should(() => authorizeSend(target({ needsHumanKind: 'codex-picker-unconfirmed' }), [])).throw(SendUnavailable, {
      message: /codex-picker-unconfirmed/u,
    });
  });

  it('refuses an unknown future agenda kind fail-closed', () => {
    should(() => authorizeSend(target({ needsHumanKind: 'future-input-modal' }), [])).throw(SendUnavailable, {
      message: /future-input-modal/u,
    });
  });

  it('allows prose after a structured form was positively released while keeping its advisory', () => {
    should(() => authorizeSend(target({ needsHumanKind: 'structured-answer-released-unconfirmed' }), [])).not.throw();
  });

  it('refuses prose while a structured question is on screen', () => {
    should(() => authorizeSend(target({ pendingQuestion: { toolUseId: 'tool-7' } }), [])).throw(SendUnavailable, {
      message: /tool-7/u,
    });
  });

  it('still refuses an unreleased answer even if its advisory spelling is present', () => {
    should(() =>
      authorizeSend(
        target({
          needsHumanKind: 'structured-answer-unconfirmed',
          pendingQuestion: { toolUseId: 'tool-8' },
        }),
        [],
      ),
    ).throw(SendUnavailable, { message: /structured-answer-unconfirmed/u });
  });

  it('allows attachment ids once the durable attachment routes are mounted', () => {
    should(() => authorizeSend(target(), ['attachment-1'])).not.throw();
  });
});

describe('routeSend', () => {
  it('revives a terminal session rather than typing into whatever pane survived it', () => {
    for (const status of ['failed', 'stopped', 'completed'] as const)
      should(routeSend(target({ status }), pane({ promptReady: true }))).equal('revive');
  });

  it('revives when the pane is gone or its process died', () => {
    should(routeSend(target(), pane({ alive: false, dead: true }))).equal('revive');
    should(routeSend(target(), pane({ alive: true, dead: true }))).equal('revive');
  });

  it('takes the tracked path for a status that is idle by its own account', () => {
    for (const status of ['waiting', 'awaiting_user', 'rate_limited', 'interrupted'] as const)
      should(routeSend(target({ status }), pane())).equal('idle');
  });

  it('does not take a declared wait at its word over a pane visibly at work (&B153)', () => {
    // ryu: `status: waiting`, `promptReady: false`, the agent mid-turn. The idle path waited for a prompt
    // that never came and threw before any key; the harness's own queue is where the message belongs.
    should(routeSend(target({ status: 'waiting' }), pane({ activeWork: true }))).equal('busy');
    should(routeSend(target({ status: 'waiting', promptReady: false }), pane({ activeWork: true }))).equal('busy');
    // The PANE's own prompt still wins; a recorded one no longer does while the pane shows work (&B188); and the
    // other idle statuses keep their word: they are set at a turn's end.
    should(routeSend(target({ status: 'waiting' }), pane({ activeWork: true, promptReady: true }))).equal('idle');
    should(routeSend(target({ status: 'waiting', promptReady: true }), pane({ activeWork: true }))).equal('busy');
    for (const status of ['awaiting_user', 'rate_limited', 'interrupted'] as const)
      should(routeSend(target({ status }), pane({ activeWork: true }))).equal('idle');
  });

  it("takes the tracked path when the document says the composer is ready even though the pane's frame lags", () => {
    should(routeSend(target({ promptReady: true }), pane())).equal('idle');
  });

  it('B188 a stale promptReady record does not route idle while the pane shows work', () => {
    // The record was written when the turn ended; an idle compaction has since begun and the pane shows it.
    should(routeSend(target({ status: 'running', promptReady: true }), pane({ activeWork: true }))).equal('busy');
    should(routeSend(target({ status: 'awaiting_user', promptReady: true }), pane({ activeWork: true }))).equal('idle');
  });

  it('B188 a pane with neither work nor prompt under an idle record still routes idle', () => {
    should(routeSend(target({ status: 'running', promptReady: true }), pane())).equal('idle');
  });

  it('takes the tracked path when the pane itself is at a prompt', () => {
    should(routeSend(target(), pane({ promptReady: true }))).equal('idle');
  });

  it('queues only when nothing at all says the session is free', () => {
    should(routeSend(target({ status: 'thinking' }), pane({ activeWork: true }))).equal('busy');
    // A half-typed human draft: not prompt-ready, not working. Still busy, because nothing proves the
    // composer is free — and queueing merely delays, while typing would submit a ghost turn.
    should(routeSend(target({ status: 'running' }), pane())).equal('busy');
  });
});

describe('peerPreamble', () => {
  it('names the ferret and the session, and states the unblocking command when an answer is awaited', () => {
    const banner = peerPreamble({ id: ID, teammate: 'loge' }, 'question', 'fy');
    should(banner).containEql('[question from ferret loge (session session-1) — not from the owner]');
    should(banner).containEql('loge is waiting for your answer');
    should(banner).containEql('fy send loge "<reply>"');
    // ONE line then the message: a blank line or a second line would make every peer message multi-line.
    should(banner.endsWith('\n')).be.true();
    should(banner.trimEnd()).not.containEql('\n');
  });

  it('never nags a receiver about a note that wants nothing back', () => {
    const banner = peerPreamble({ id: ID }, 'message', 'fy');
    should(banner).containEql('To reply:');
    should(banner).not.containEql('waiting');
    should(banner).not.containEql('No reply needed');
    // With no callsign the session id stands in for it, so the reply command still addresses somebody.
    should(banner).containEql('fy send session-1');
  });
});

describe('peerMessageKind', () => {
  it('calls a message the recipient is parked on a reply, even when it asks something back', () => {
    should(peerMessageKind({ waiting: { peer: 'p1' } }, 'p1', false)).equal('reply');
    should(peerMessageKind({ waiting: { peer: 'p1' } }, 'p1', true)).equal('reply');
  });

  it('calls anything else a question when its sender parks, and a note otherwise', () => {
    should(peerMessageKind({ waiting: { peer: 'someone-else' } }, 'p1', true)).equal('question');
    should(peerMessageKind(undefined, 'p1', false)).equal('message');
    should(peerMessageKind({}, 'p1', false)).equal('message');
  });
});

describe('isDirectPayload', () => {
  it('types a short single-line message verbatim', () => {
    should(isDirectPayload('ship it', 500)).be.true();
  });

  it('refuses anything past the ceiling, and a ceiling of zero refuses everything', () => {
    should(isDirectPayload('x'.repeat(501), 500)).be.false();
    should(isDirectPayload('ship it', 0)).be.false();
    should(isDirectPayload('ship it', -1)).be.false();
  });

  it('refuses an empty payload and a multi-line one', () => {
    should(isDirectPayload('   ', 500)).be.false();
    should(isDirectPayload('first\nsecond', 500)).be.false();
  });

  it('names the paste ceiling next to the other send settings, and refuses a ceiling of zero', () => {
    should(parseSessionSendSettings({ ...defaultSessionSendSettings }).directPasteMaxChars).equal(2_000);
    should(() => parseSessionSendSettings({ ...defaultSessionSendSettings, directPasteMaxChars: 0 })).throw();
  });

  it('refuses control characters, which a TUI composer does not take verbatim', () => {
    should(isDirectPayload(`ship${String.fromCharCode(7)}it`, 500)).be.false();
    should(isDirectPayload(`ship${String.fromCharCode(127)}it`, 500)).be.false();
  });
});

describe('isDirectPaste', () => {
  it('takes a multi-line message, and still refuses an empty one and a ceiling of zero', () => {
    should(isDirectPaste('first\nsecond\n\nthird', 2_000)).be.true();
    should(isDirectPaste('   \n  ', 2_000)).be.false();
    should(isDirectPaste('first\nsecond', 0)).be.false();
  });

  it('keeps the 2,000 boundary inclusive, counting the trimmed message', () => {
    should(isDirectPaste(`${'x'.repeat(999)}\n${'y'.repeat(1_000)}`, 2_000)).be.true();
    should(isDirectPaste(`${'x'.repeat(999)}\n${'y'.repeat(1_001)}`, 2_000)).be.false();
    should(isDirectPaste(`\n${'x'.repeat(999)}\n${'y'.repeat(1_000)}\n  `, 2_000)).be.true();
  });

  it('refuses a tab, a carriage return and every other control character, which a paste rewrites', () => {
    should(isDirectPaste('a\tb\nc', 2_000)).be.false();
    should(isDirectPaste('a\r\nb', 2_000)).be.false();
    should(isDirectPaste(`a${String.fromCharCode(27)}[31mb\nc`, 2_000)).be.false();
    should(isDirectPaste(`a${String.fromCharCode(127)}b\nc`, 2_000)).be.false();
  });

  it('takes quotes, backticks, dollar signs, unicode and shell syntax as plain text', () => {
    const message = [
      '[message from ferret x (session s1) — not from the owner] To reply: fy send x "<reply>"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal `${…}` must survive as text.
      'He said "hi", she said \'bye\'; run `fy status` then echo $HOME ${PATH} $(whoami) !! \\n',
      'unicode: café — naïve ✓ 日本語 🦦',
    ].join('\n');
    should(isDirectPaste(message, 2_000)).be.true();
  });
});

describe('isDirectSend', () => {
  const claude = (overrides: Partial<SendTarget> = {}): SendTarget =>
    target({ harness: 'claude', directSendMaxChars: 4_096, ...overrides });
  const banner = '[message from ferret x (session s1) — not from the owner] To reply: fy send x "<reply>"\n';

  it('types a one-line message verbatim to either harness, as before', () => {
    should(isDirectSend(claude(), 'ship it', defaultSessionSendSettings)).be.true();
    should(
      isDirectSend(target({ harness: 'codex', directSendMaxChars: 4_096 }), 'ship it', defaultSessionSendSettings),
    ).be.true();
  });

  it('pastes a peer message (banner line plus a multi-line body) straight into an idle Claude composer', () => {
    should(isDirectSend(claude(), `${banner}line one\nline two\n\nline three`, defaultSessionSendSettings)).be.true();
  });

  it('sends the same multi-line message to Codex, or a harness nobody named, as a turn file', () => {
    const message = `${banner}line one\nline two`;
    should(
      isDirectSend(target({ harness: 'codex', directSendMaxChars: 4_096 }), message, defaultSessionSendSettings),
    ).be.false();
    should(isDirectSend(target({ directSendMaxChars: 4_096 }), message, defaultSessionSendSettings)).be.false();
  });

  it('holds the multi-line boundary at the named setting, and sends a longer message as a turn file', () => {
    const lines = (length: number): string => `${banner}${'x'.repeat(length - banner.length - 2)}\ny`;
    should(defaultSessionSendSettings.directPasteMaxChars).equal(2_000);
    should(isDirectSend(claude(), lines(2_000), defaultSessionSendSettings)).be.true();
    should(isDirectSend(claude(), lines(2_001), defaultSessionSendSettings)).be.false();
    should(
      isDirectSend(claude(), lines(2_001), { ...defaultSessionSendSettings, directPasteMaxChars: 3_000 }),
    ).be.true();
  });

  it('never lets the paste ceiling widen what a session set for itself', () => {
    const message = `${banner}${'x'.repeat(300)}\ny`;
    should(isDirectSend(claude({ directSendMaxChars: 200 }), message, defaultSessionSendSettings)).be.false();
    should(isDirectSend(claude({ directSendMaxChars: 4_096 }), message, defaultSessionSendSettings)).be.true();
  });

  it('honours directSendMaxChars: 0 as an opt-out of every direct send, one line or many', () => {
    should(isDirectSend(claude({ directSendMaxChars: 0 }), 'ship it', defaultSessionSendSettings)).be.false();
    should(isDirectSend(claude({ directSendMaxChars: 0 }), `${banner}a\nb`, defaultSessionSendSettings)).be.false();
  });

  it('gives an interactive Claude session the paste too, bounded by the same named ceiling', () => {
    const message = `${banner}a\nb`;
    should(
      isDirectSend(claude({ mode: 'interactive', directSendMaxChars: undefined }), message, defaultSessionSendSettings),
    ).be.true();
    should(
      isDirectSend(
        claude({ mode: 'interactive', directSendMaxChars: undefined }),
        'x\n'.repeat(1_001),
        defaultSessionSendSettings,
      ),
    ).be.false();
  });

  it('honours an explicit session ceiling on an interactive Claude session for a multi-line paste', () => {
    const message = `${banner}a\nb`;
    should(
      isDirectSend(claude({ mode: 'interactive', directSendMaxChars: 0 }), message, defaultSessionSendSettings),
    ).be.false();
    should(
      isDirectSend(claude({ mode: 'interactive', directSendMaxChars: 10 }), message, defaultSessionSendSettings),
    ).be.false();
    should(
      isDirectSend(claude({ mode: 'interactive', directSendMaxChars: 4_096 }), message, defaultSessionSendSettings),
    ).be.true();
  });

  it('keeps an interactive session on the single-line rule that has no ceiling', () => {
    should(
      isDirectSend(claude({ mode: 'interactive', directSendMaxChars: 10 }), 'x'.repeat(50), defaultSessionSendSettings),
    ).be.true();
  });

  it('turns a tab or control character in a multi-line message into a turn file', () => {
    should(isDirectSend(claude(), `${banner}col1\tcol2\nrow2`, defaultSessionSendSettings)).be.false();
    should(isDirectSend(claude(), `${banner}a\r\nb`, defaultSessionSendSettings)).be.false();
  });
});

describe('directLimitFor', () => {
  it('gives an interactive session no ceiling: a person is owed a reply, not a file path', () => {
    should(directLimitFor(target({ mode: 'interactive' }), defaultSessionSendSettings)).equal(Number.POSITIVE_INFINITY);
  });

  it("prefers the session's own configured ceiling over the deployment default", () => {
    should(directLimitFor(target({ directSendMaxChars: 12 }), defaultSessionSendSettings)).equal(12);
    should(directLimitFor(target(), defaultSessionSendSettings)).equal(defaultSessionSendSettings.directSendMaxChars);
  });
});

describe('payload composition', () => {
  it('refuses a send with nothing in it', () => {
    should(() => sendPayload('   ')).throw(SendRefused, { message: /requires a message/u });
  });

  it('trims the message it carries', () => {
    should(sendPayload('  ship it \n')).equal('ship it');
  });

  it('sends a payload past the inline ceiling through a file', () => {
    should(isFileBackedQueue('x'.repeat(1_001), defaultSessionSendSettings)).be.true();
    should(isFileBackedQueue('x'.repeat(1_000), defaultSessionSendSettings)).be.false();
  });

  it('points a composer at a file rather than typing what is in it', () => {
    should(turnInstruction('/state/turns/turn-004.md')).containEql('/state/turns/turn-004.md');
    should(queuedPayloadInstruction('/state/channel/queued-a.md')).containEql('/state/channel/queued-a.md');
  });
});

describe('dispositionOf', () => {
  it('states the wire word for every transport path', () => {
    should(dispositionOf('direct')).equal('delivered');
    should(dispositionOf('turn-file')).equal('delivered');
    should(dispositionOf('native-inline')).equal('queued');
    should(dispositionOf('native-file')).equal('queued');
    should(dispositionOf('revive')).equal('revived');
    should(dispositionOf('revive-queue')).equal('queued-for-revive');
  });
});

describe('endsPeerWait', () => {
  it('is true only for the session the recipient is actually parked on', () => {
    should(endsPeerWait(target({ waiting: { peer: 'session-2' } }), 'session-2')).be.true();
    should(endsPeerWait(target({ waiting: { peer: 'session-3' } }), 'session-2')).be.false();
    should(endsPeerWait(target(), 'session-2')).be.false();
  });
});

describe('send settings', () => {
  it('parses a complete settings document', () => {
    should(parseSessionSendSettings(defaultSessionSendSettings)).eql(defaultSessionSendSettings);
  });

  it('refuses a launch wait that is not a positive whole number of milliseconds', () => {
    should(() => parseSessionSendSettings({ ...defaultSessionSendSettings, controlLaunchWaitMs: 0 })).throw();
  });
});
