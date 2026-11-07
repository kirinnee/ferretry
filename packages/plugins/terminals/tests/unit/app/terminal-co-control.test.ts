import { describe, test } from 'bun:test';
import should from 'should';
import type { SurfaceOwnership } from '../../src/lib/surface-references.ts';
import {
  describeCoControl,
  shouldReopenTerminalStream,
  TERMINAL_REOPEN_BASE_MS,
  TERMINAL_REOPEN_MAX_MS,
  terminalReopenDelayMs,
  terminalResizeFrame,
} from '../../src/lib/terminal-co-control.ts';

const AGENT: SurfaceOwnership = { by: 'agent', sessionId: 'mse7wwti' };
const HUMAN: SurfaceOwnership = { by: 'human', deviceId: 'device-7f3a' };
const UNRECORDED: SurfaceOwnership = { by: 'unrecorded' };

describe('shouldReopenTerminalStream', () => {
  test('should not reopen a stream this deck closed on purpose', () => {
    // Assert — 1000 is the deck detaching, so reopening would fight itself.
    should(shouldReopenTerminalStream(1000)).be.false();
  });

  test('should not reopen after the daemon refused this client', () => {
    // 1008 is a malformed frame and 1009 is an overflowing input queue. Both are
    // judgements about THIS client, and reconnecting puts the same client back
    // to be refused again.
    // Assert
    should(shouldReopenTerminalStream(1008)).be.false();
    should(shouldReopenTerminalStream(1009)).be.false();
  });

  test('should reopen after a transport failure neither side chose', () => {
    // A phone changing network, a laptop waking, a proxy timing out. Refusing to
    // retry here strands a reader in front of a dead pane that is still running.
    // Assert
    for (const code of [1001, 1006, 1011, 1013, 4000]) should(shouldReopenTerminalStream(code)).be.true();
  });
});

describe('terminalReopenDelayMs', () => {
  test('should keep the original first retry and back off after it', () => {
    // Assert
    should(terminalReopenDelayMs(1)).equal(TERMINAL_REOPEN_BASE_MS);
    should(terminalReopenDelayMs(2)).equal(TERMINAL_REOPEN_BASE_MS * 2);
    should(terminalReopenDelayMs(3)).equal(TERMINAL_REOPEN_BASE_MS * 4);
  });

  test('should never wait longer than the ceiling, however long the daemon is away', () => {
    // A page left open on a desk must not drift into hour-long waits.
    // Assert
    should(terminalReopenDelayMs(50)).equal(TERMINAL_REOPEN_MAX_MS);
  });

  test('should treat a zeroth or fractional attempt as the first', () => {
    // Assert
    should(terminalReopenDelayMs(0)).equal(TERMINAL_REOPEN_BASE_MS);
    should(terminalReopenDelayMs(-3)).equal(TERMINAL_REOPEN_BASE_MS);
    should(terminalReopenDelayMs(1.9)).equal(TERMINAL_REOPEN_BASE_MS);
  });
});

describe('terminalResizeFrame', () => {
  test('should emit the protocol control frame with whole cells only', () => {
    // A fitted terminal measures in fractional cells; the wire schema takes
    // integers, and a rejected frame closes the stream.
    // Assert
    should(terminalResizeFrame(120.7, 40.2)).equal('{"type":"resize","cols":120,"rows":40}');
  });
});

describe('describeCoControl', () => {
  test('should let the reader type whenever the link is live, whoever owns the shell', () => {
    // THE CENTRAL PROPERTY. There is no lock: the daemon writes whatever any
    // attached socket sends. A UI that gated typing on ownership would invent a
    // turn-taking rule the protocol does not have, and co-control would become
    // "one of you at a time".
    // Act
    const driving = describeCoControl('live', 2, AGENT);
    const own = describeCoControl('live', 1, HUMAN);

    // Assert
    should(driving.mayType).be.true();
    should(own.mayType).be.true();
  });

  test('should refuse to promise typing while the link is not attached', () => {
    // Assert
    for (const state of ['idle', 'connecting', 'reconnecting', 'refused'] as const)
      should(describeCoControl(state, 1, HUMAN).mayType).be.false();
  });

  test('should not count the reader own socket as somebody else being there', () => {
    // The daemon's count includes this viewer once attached. Printing it raw
    // would tell a reader alone in a shell that one other viewer is watching.
    // Act
    const alone = describeCoControl('live', 1, HUMAN);
    const shared = describeCoControl('live', 2, HUMAN);
    const crowded = describeCoControl('live', 3, HUMAN);

    // Assert
    should(alone.sharing).equal('no other viewer is attached.');
    should(shared.sharing).equal('1 other viewer is attached.');
    should(crowded.sharing).equal('2 other viewers are attached.');
  });

  test('should report the daemon count as-is before this socket joins it', () => {
    // Not yet attached, so nothing of this reader's is in the number.
    // Assert
    should(describeCoControl('connecting', 2, HUMAN).sharing).equal('2 other viewers are attached.');
  });

  test('should say an agent may be driving even when no second socket is attached', () => {
    // An agent drives the pane through the daemon, not necessarily through a
    // viewer socket. Zero viewers is therefore NOT evidence that nobody is
    // there, and reporting it as "you are alone" would be the benign reading of
    // an ambiguous fact — before the reader types into a live command.
    // Act
    const standing = describeCoControl('live', 1, AGENT);

    // Assert
    should(standing.sharing).startWith('An agent opened this shell and may be driving it');
    should(standing.sharing).containEql('no other viewer is attached');
    should(standing.sharing).endWith('You can type at the same time.');
  });

  test('should say plainly when the daemon cannot name who opened the shell', () => {
    // Assert
    should(describeCoControl('live', 1, UNRECORDED).sharing).startWith('This daemon did not record who opened');
  });

  test('should keep the original link vocabulary and name a refusal as one', () => {
    // Assert
    should(describeCoControl('live', 1, HUMAN).link).equal('live');
    should(describeCoControl('connecting', 0, HUMAN).link).equal('connecting');
    should(describeCoControl('reconnecting', 0, HUMAN).link).equal('reconnecting');
    should(describeCoControl('idle', 0, HUMAN).link).equal('detached');
    // A refusal is new: promising a reconnect that will never happen was the one
    // thing the original's wording could not express.
    should(describeCoControl('refused', 0, HUMAN).link).equal('refused');
  });

  test('should survive a viewer count the daemon could not have meant', () => {
    // Assert
    should(describeCoControl('live', Number.NaN, HUMAN).sharing).equal('no other viewer is attached.');
    should(describeCoControl('live', -4, HUMAN).sharing).equal('no other viewer is attached.');
  });
});
