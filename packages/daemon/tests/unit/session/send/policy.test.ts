import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId } from '../../../../src/lib/index.ts';
import {
  authorizeSend,
  defaultSessionSendSettings,
  directLimitFor,
  dispositionOf,
  endsPeerWait,
  isDirectPayload,
  isFileBackedQueue,
  parseSessionSendSettings,
  peerPreamble,
  queuedPayloadInstruction,
  routeSend,
  type SendPaneObservation,
  SendRefused,
  type SendTarget,
  SendUnavailable,
  sendPayload,
  shouldPressStopKey,
  turnInstruction,
} from '../../../../src/lib/session/send/index.ts';

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

  it('refuses prose while a structured question is on screen', () => {
    should(() => authorizeSend(target({ pendingQuestion: { toolUseId: 'tool-7' } }), [])).throw(SendUnavailable, {
      message: /tool-7/u,
    });
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

  it("takes the tracked path when the document says the composer is ready even though the pane's frame lags", () => {
    should(routeSend(target({ promptReady: true }), pane())).equal('idle');
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
  it('names the callsign and the session, and states the unblocking command when a reply is awaited', () => {
    const banner = peerPreamble({ id: ID, teammate: 'loge' }, true, 'fy');
    should(banner).containEql('[peer message from teammate loge (session session-1) — not from the human lead]');
    should(banner).containEql('fy send loge "<your reply>"');
    should(banner).containEql('PARKED');
    should(banner.endsWith('\n\n')).be.true();
  });

  it('never nags a receiver about a note that wants nothing back', () => {
    const banner = peerPreamble({ id: ID }, false, 'fy');
    should(banner).containEql('No reply is required');
    should(banner).not.containEql('PARKED');
    // With no callsign the session id stands in for it, so the reply command still addresses somebody.
    should(banner).containEql('fy send session-1');
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

  it('refuses control characters, which a TUI composer does not take verbatim', () => {
    should(isDirectPayload(`ship${String.fromCharCode(7)}it`, 500)).be.false();
    should(isDirectPayload(`ship${String.fromCharCode(127)}it`, 500)).be.false();
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

describe('shouldPressStopKey', () => {
  it('presses the stop key whenever the pane is visibly working', () => {
    should(shouldPressStopKey(target(), pane({ activeWork: true }))).be.true();
    should(shouldPressStopKey(target({ mode: 'interactive', harness: 'codex' }), pane({ activeWork: true }))).be.true();
  });

  it('suppresses it at an idle prompt, where it is one of the ways a TUI quits', () => {
    should(shouldPressStopKey(target(), pane())).be.false();
    should(shouldPressStopKey(target({ mode: 'interactive', harness: 'codex' }), pane())).be.false();
    should(shouldPressStopKey(target({ mode: 'auto', harness: 'claude' }), pane())).be.false();
  });

  it("sends it at an idle interactive claude prompt, where it is the human's own stop key", () => {
    should(shouldPressStopKey(target({ mode: 'interactive', harness: 'claude' }), pane())).be.true();
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
