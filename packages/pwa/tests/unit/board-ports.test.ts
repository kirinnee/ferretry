import { describe, expect, it } from 'bun:test';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import { boardPorts } from '../../src/lib/board-ports.ts';
import type { DaemonFetch } from '../../src/lib/runtime-models.ts';
import { laptop } from './board-support.ts';

const carrier: DaemonFetch = async () => new Response('{}');

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
    }, carrier);
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
      carrier,
    );
    expect(await ports.startFerret(laptop, 'do the thing')).toBe('sess-9');
    expect(started).toEqual([{ mode: 'auto', prompt: 'do the thing' }]);
  });

  it('says a machine takes files with a move back only when its health lists the feature', async () => {
    const answering = (features: readonly string[] | undefined) =>
      boardPorts(async () => ({ health: async () => (features === undefined ? {} : { features }) }) as never, carrier);
    expect(await answering([DAEMON_FEATURES.boardReopenAttachments]).sendBackFiles(laptop)).toBe(true);
    expect(await answering(['agenda.snooze.1']).sendBackFiles(laptop)).toBe(false);
    expect(await answering(undefined).sendBackFiles(laptop)).toBe(false);
  });

  it("uploads a file to the ferret's session on the card's machine", async () => {
    const uploads: unknown[] = [];
    const ports = boardPorts(
      async () => ({}) as never,
      carrier,
      async (daemon, scope, file) => {
        uploads.push([daemon.daemonId, scope, file.name]);
        return { id: 'att_1', filename: file.name, mime: 'image/png', size: 3, sha256: 'x', createdAt: 'now' } as never;
      },
    );
    const view = await ports.uploadAttachment(laptop, 'sess-1', new File(['png'], 'shot.png', { type: 'image/png' }));
    expect(view.id).toBe('att_1');
    expect(uploads).toEqual([[laptop.daemonId, { daemonId: laptop.daemonId, sessionId: 'sess-1' }, 'shot.png']]);
  });

  it("uploads over the carrier the machine's traffic rides, never the raw network", async () => {
    const seen: unknown[] = [];
    const ports = boardPorts(
      async () => ({}) as never,
      carrier,
      async (_daemon, _scope, _file, fetcher) => {
        seen.push(fetcher);
        return {
          id: 'att_1',
          filename: 'shot.png',
          mime: 'image/png',
          size: 3,
          sha256: 'x',
          createdAt: 'now',
        } as never;
      },
    );
    await ports.uploadAttachment(laptop, 'sess-1', new File(['png'], 'shot.png', { type: 'image/png' }));
    expect(seen).toEqual([carrier]);
  });

  it('puts the upload on the carrier as a request for the ferret session, with no credential of its own', async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const answering: DaemonFetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          id: `att_${'a'.repeat(64)}`,
          filename: 'shot.png',
          mime: 'image/png',
          size: 3,
          sha256: 'a'.repeat(64),
          createdAt: '2026-10-31T00:00:00.000Z',
        }),
        { status: 201 },
      );
    };
    const ports = boardPorts(async () => ({}) as never, answering);
    await ports.uploadAttachment(laptop, 'sess-1', new File(['png'], 'shot.png', { type: 'image/png' }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/v1/sessions/sess-1/attachments');
    expect(requests[0]?.init?.method).toBe('POST');
  });
});
