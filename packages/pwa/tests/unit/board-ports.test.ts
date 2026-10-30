import { describe, expect, it } from 'bun:test';
import { boardPorts } from '../../src/lib/board-ports.ts';
import { laptop } from './board-support.ts';

describe('boardPorts', () => {
  it('sends a message to a session through the machine client', async () => {
    const calls: string[] = [];
    const ports = boardPorts(async daemon => {
      calls.push(`client:${daemon.daemonId}`);
      return {
        send: async (sessionId: string, body: { message: string }) => {
          calls.push(`send:${sessionId}:${body.message}`);
        },
      } as never;
    });
    await ports.sendMessage(laptop, 'sess-1', 'hello');
    expect(calls).toEqual([`client:${laptop.daemonId}`, 'send:sess-1:hello']);
  });

  it('starts a ferret in auto mode and answers its session id', async () => {
    const started: unknown[] = [];
    const ports = boardPorts(
      async () =>
        ({
          start: async (request: unknown) => {
            started.push(request);
            return { config: { id: 'sess-9' } };
          },
        }) as never,
    );
    expect(await ports.startFerret(laptop, 'do the thing')).toBe('sess-9');
    expect(started).toEqual([{ mode: 'auto', prompt: 'do the thing' }]);
  });
});
