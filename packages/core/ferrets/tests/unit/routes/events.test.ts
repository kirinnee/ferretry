/**
 * R-0424 `WS GET /v1/events` through a booted host: the socket is opened with `host.socket`, so the manifest's descriptor
 * (operator minimum, any caller) reaches admission as declared and Ferrets' real accept runs over its real journals.
 * Gate is stood in for by `StandInAdmission`, which applies the descriptor's minimum honestly.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ferretStanding, ownerStanding, wardenStanding } from '@ferretry/core-gate/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import type { TestHost } from '@ferretry/kernel/testing';
import { FyEventStreamFrameSchema } from '../../../daemon/lib/protocol/session.ts';
import { ferretId } from '../../../contract/testing/index.ts';
import { host, record } from '../daemon/ferrets/route-fixture.ts';

let open: TestHost | undefined;
afterEach(async () => {
  await open?.stop();
  open = undefined;
});

async function serving(standing: () => CallStanding | undefined) {
  open = await host([record('wren')], { standing });
  return open;
}

const kinds = (frames: readonly (string | Uint8Array)[]) =>
  frames.map(frame => FyEventStreamFrameSchema.parse(JSON.parse(String(frame))).kind);

describe('R-0424 the journal stream is a socket served by Ferrets', () => {
  test('R-0424 the owner at the machine opens it for a ferret and is told the replay is over (idle)', async () => {
    const h = await serving(() => ownerStanding());

    const socket = await h.socket('/v1/events', { query: { sessionId: 'wren', after: '0' } });

    expect(socket.response).toBeUndefined();
    expect(kinds(socket.frames)).toEqual(['idle']);
    expect(socket.closed).toBeUndefined();
  });

  test('R-0424 a fleet stream with no ferret named opens too, and a client frame ends it (server-only)', async () => {
    const h = await serving(() => ownerStanding());

    const socket = await h.socket('/v1/events', { query: { tail: '5' } });

    expect(socket.response).toBeUndefined();
    socket.handler?.fromClient('hello');
    expect(socket.closed).toEqual({ code: 1008, reason: 'event stream is server-only' });
  });

  test('R-0424 a caller with no credential is refused 401 and no stream opens', async () => {
    const h = await serving(() => undefined);

    const socket = await h.socket('/v1/events', { query: { sessionId: 'wren' } });

    expect(socket.response?.status).toBe(401);
    expect(socket.handler).toBeUndefined();
    expect(socket.frames).toEqual([]);
  });

  test('R-0424 a ferret’s own credential may open it (the descriptor says caller any, as today), and gets the same frames', async () => {
    const h = await serving(() => ferretStanding(ferretId('wren')));

    const socket = await h.socket('/v1/events', { query: { sessionId: 'wren' } });

    expect(socket.response).toBeUndefined();
    expect(kinds(socket.frames)).toEqual(['idle']);
  });

  test('R-0424 a warden credential is refused 403 (the operator minimum excludes it) and no stream opens', async () => {
    const h = await serving(() => wardenStanding(ferretId('wren')));

    const socket = await h.socket('/v1/events', { query: { sessionId: 'wren' } });

    expect(socket.response?.status).toBe(403);
    expect(socket.handler).toBeUndefined();
    expect(socket.frames).toEqual([]);
  });

  test('R-0424 a ferret nobody holds is a 404 and a stream asking for one that is not there opens nothing', async () => {
    const h = await serving(() => ownerStanding());

    const socket = await h.socket('/v1/events', { query: { sessionId: 'nobody' } });

    expect(socket.response?.status).toBe(404);
    expect(socket.frames).toEqual([]);
  });

  test('R-0424 a query the stream does not take is refused 400 before it opens', async () => {
    const h = await serving(() => ownerStanding());

    const socket = await h.socket('/v1/events', { query: { sessionId: 'wren', surprise: '1' } });

    expect(socket.response?.status).toBe(400);
    expect(socket.frames).toEqual([]);
  });
});
