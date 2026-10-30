import { describe, it } from 'bun:test';
import type { SessionConfig } from '@ferretry/protocol';
import should from 'should';
import { SessionConfigAgendaModes } from '../../../src/adapters/agenda/session-agenda-modes.ts';

function modes(configs: Readonly<Record<string, Pick<SessionConfig, 'agenda'>>>, fault = false) {
  return new SessionConfigAgendaModes({
    get: async id => {
      if (fault) throw new Error('document damaged');
      const config = configs[id];
      return config === undefined ? undefined : { config: config as SessionConfig };
    },
  });
}

describe('SessionConfigAgendaModes', () => {
  it('should be on only when the session document records the switch on', async () => {
    // Arrange
    const reader = modes({ 'session-1': {}, 'session-2': { agenda: true }, 'session-3': { agenda: false } });

    // Act
    const answers = [
      await reader.enabled('session-1'),
      await reader.enabled('session-2'),
      await reader.enabled('session-3'),
    ];

    // Assert
    should(answers).deepEqual([false, true, false]);
  });

  it('should be off for a session that does not exist, a damaged document, or an id the layout refuses', async () => {
    // Arrange
    const reader = modes({ 'session-1': { agenda: true } });

    // Act + Assert
    should(await reader.enabled('session-9')).be.false();
    should(await modes({ 'session-1': { agenda: true } }, true).enabled('session-1')).be.false();
    should(await reader.enabled('../escape')).be.false();
  });
});
