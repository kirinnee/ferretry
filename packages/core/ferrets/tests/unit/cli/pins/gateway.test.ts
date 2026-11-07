import { describe, it } from 'bun:test';
import type { PinSnapshot } from '@ferretry/protocol';
import should from 'should';
import { type z } from 'zod';
import { ProtocolPinGateway, pinBoardPath } from '../../../src/lib/pins/gateway';
import type { PinApiClient } from '../../../src/lib/pins/ports';
import { NOTE_ID, SESSION, humanNote, snapshot } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
}

/** A client that answers with a payload and records the call, so the gateway's parsing is real. */
function fakeClient(payload: unknown, calls: Call[]): PinApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

describe('pin board path', () => {
  it('should escape a session id that would otherwise break the route', () => {
    // Act
    const actual = pinBoardPath('a/b?c');

    // Assert
    should(actual).equal('/v1/sessions/a%2Fb%3Fc/pins');
  });
});

describe('protocol pin gateway', () => {
  it('should read the board with a plain GET', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolPinGateway(fakeClient(snapshot([humanNote(NOTE_ID, 'a note')]), calls));

    // Act
    const actual = await gateway.list(SESSION);

    // Assert
    should(calls).have.length(1);
    should(calls[0]?.path).equal(`/v1/sessions/${SESSION}/pins`);
    should(calls[0]?.init).be.undefined();
    should(actual.pins).have.length(1);
  });

  it('should post a mutation as validated protocol JSON', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolPinGateway(fakeClient(snapshot([]), calls));

    // Act
    await gateway.apply(SESSION, { action: 'remove', id: NOTE_ID });

    // Assert
    should(calls[0]?.init?.method).equal('POST');
    should(calls[0]?.init?.headers).deepEqual({ 'content-type': 'application/json' });
    should(JSON.parse(String(calls[0]?.init?.body))).deepEqual({ action: 'remove', id: NOTE_ID });
  });

  it('should refuse to send a request the protocol rejects', async () => {
    // Arrange
    const gateway = new ProtocolPinGateway(fakeClient(snapshot([]), []));

    // Act + Assert — a non-uuid id must fail here, not become an opaque daemon 400.
    await should(gateway.apply(SESSION, { action: 'remove', id: 'not-a-uuid' })).be.rejected();
  });

  it('should reject a daemon answer that is not a pin snapshot', async () => {
    // Arrange
    const gateway = new ProtocolPinGateway(fakeClient({ error: 'boom' }, []));

    // Act + Assert — kteam cast the response, so a bad shape surfaced deep inside rendering.
    await should(gateway.list(SESSION)).be.rejected();
  });

  it('should return the snapshot the daemon left after a mutation', async () => {
    // Arrange
    const result: PinSnapshot = snapshot([humanNote(NOTE_ID, 'kept')]);
    const gateway = new ProtocolPinGateway(fakeClient(result, []));

    // Act
    const actual = await gateway.apply(SESSION, { action: 'add', kind: 'note', text: 'kept' });

    // Assert
    should(actual).deepEqual(result);
  });
});
