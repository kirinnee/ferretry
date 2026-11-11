/**
 * The recorded commands of the sessions still alive.
 *
 * The claims: only a session that has not ended contributes its command; an unbound source raises (so a sweep keeps
 * everything) instead of answering "nobody is alive".
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  BoundLiveLaunchCommands,
  type SessionCommandSource,
} from '../../../../../daemon/adapters/session/launch/live-launch-commands.ts';
import type { SessionId } from '../../../../../daemon/lib/session-id.ts';

const id = (value: string): SessionId => value as SessionId;

describe('BoundLiveLaunchCommands', () => {
  it('should answer the commands of sessions that have not ended', async () => {
    // Arrange
    const configs = new Map<string, unknown>([
      ['a', { command: ['/w', '--settings', '/s/a.json'] }],
      ['b', { command: ['/w', '--settings', '/s/b.json'] }],
      ['c', { command: ['/w', '--settings', '/s/c.json'] }],
      ['d', { nothing: true }],
    ]);
    const source: SessionCommandSource = {
      listSessions: () => [
        { id: id('a'), status: 'running' },
        { id: id('b'), status: 'stopped' },
        { id: id('c') },
        { id: id('d'), status: 'stalled' },
      ],
      readConfig: async session => configs.get(session),
    };
    const live = new BoundLiveLaunchCommands();
    live.bind(source);

    // Act
    const commands = await live.commands();

    // Assert
    should(commands).deepEqual([['/w', '--settings', '/s/a.json'], ['/w', '--settings', '/s/c.json'], []]);
  });

  it('should raise until a source is bound', async () => {
    // Act / Assert
    await should(new BoundLiveLaunchCommands().commands()).rejectedWith(/not open yet/u);
  });
});
