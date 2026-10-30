import { describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES } from '@ferretry/protocol';
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

  it('says a machine takes files with a move back only when its health lists the feature', async () => {
    const answering = (features: readonly string[] | undefined) =>
      boardPorts(async () => ({ health: async () => (features === undefined ? {} : { features }) }) as never);
    expect(await answering([DAEMON_FEATURES.boardReopenAttachments]).sendBackFiles(laptop)).toBe(true);
    expect(await answering(['agenda.snooze.1']).sendBackFiles(laptop)).toBe(false);
    expect(await answering(undefined).sendBackFiles(laptop)).toBe(false);
  });

  it("uploads a file to the ferret's session on the card's machine", async () => {
    const uploads: unknown[] = [];
    const ports = boardPorts(
      async () => ({}) as never,
      async (daemon, scope, file) => {
        uploads.push([daemon.daemonId, scope, file.name]);
        return { id: 'att_1', filename: file.name, mime: 'image/png', size: 3, sha256: 'x', createdAt: 'now' } as never;
      },
    );
    const view = await ports.uploadAttachment(laptop, 'sess-1', new File(['png'], 'shot.png', { type: 'image/png' }));
    expect(view.id).toBe('att_1');
    expect(uploads).toEqual([[laptop.daemonId, { daemonId: laptop.daemonId, sessionId: 'sess-1' }, 'shot.png']]);
  });
});
