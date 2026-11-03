import { describe, it } from 'bun:test';
import should from 'should';
import { StorageSendRepository } from '../../../../src/adapters/session/send/index.ts';
import { parseSessionId } from '../../../../src/lib/index.ts';
import {
  defaultSessionSendSettings,
  isDirectSend,
  type SendPaneObservation,
  shouldPressStopKey,
} from '../../../../src/lib/session/send/index.ts';

const ID = parseSessionId('11111111-1111-4111-8111-111111111111');
const NOW = '2026-11-03T00:00:00.000Z';

const IDLE_PANE: SendPaneObservation = { alive: true, dead: false, promptReady: true, activeWork: false };

/**
 * The REAL repository over a storage that hands back the documents a session is written with. Policy
 * tests build their targets by hand, which is how a target that never carried `harness` passed every
 * one of them while every multi-line send in production still took a turn file (2026-11-03).
 */
function repository(config: Record<string, unknown>): StorageSendRepository {
  const storage = {
    readConfig: async () => ({ id: 'session-1', mode: 'auto', turn: 2, ...config }) as never,
    readState: async () => ({ id: 'session-1', status: 'awaiting_user', turn: 2 }) as never,
  };
  return new StorageSendRepository(storage as never, { now: () => NOW });
}

describe('the send target the repository reads', () => {
  it('should carry the harness from the session configuration', async () => {
    // Act
    const actual = await repository({ harness: 'claude' }).read(ID);

    // Assert
    should(actual?.harness).equal('claude');
  });

  it('should leave the harness out when the configuration names none', async () => {
    // Act
    const actual = await repository({}).read(ID);

    // Assert
    should(actual).not.have.property('harness');
  });

  it('should send a short multi-line message to an idle Claude session whole, not as a turn file', async () => {
    // Arrange
    const target = await repository({ harness: 'claude' }).read(ID);
    const message =
      '[message from ferret iris (session s-2) — not from the owner] To reply: fy send iris "<reply>"\nCI is green.';

    // Act / Assert
    should(target).not.be.undefined();
    if (target === undefined) return;
    should(isDirectSend(target, message, defaultSessionSendSettings)).be.true();
  });

  it('should keep a multi-line message to a Codex session on the turn file', async () => {
    // Arrange
    const target = await repository({ harness: 'codex' }).read(ID);

    // Act / Assert
    should(target).not.be.undefined();
    if (target === undefined) return;
    should(isDirectSend(target, 'first line\nsecond line', defaultSessionSendSettings)).be.false();
  });

  it('should press the stop key at an idle prompt only for an interactive Claude session', async () => {
    // Arrange
    const claude = await repository({ harness: 'claude', mode: 'interactive' }).read(ID);
    const codex = await repository({ harness: 'codex', mode: 'interactive' }).read(ID);

    // Act / Assert
    should(claude).not.be.undefined();
    should(codex).not.be.undefined();
    if (claude === undefined || codex === undefined) return;
    should(shouldPressStopKey(claude, IDLE_PANE)).be.true();
    should(shouldPressStopKey(codex, IDLE_PANE)).be.false();
  });
});
