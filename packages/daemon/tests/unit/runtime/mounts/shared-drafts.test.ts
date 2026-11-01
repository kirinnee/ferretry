import { describe, it } from 'bun:test';
import { SHARED_DRAFT_MAX_CHARS } from '@ferretry/protocol';
import should from 'should';
import { type CapabilityGuard, NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { sessionSendRoutes } from '../../../../src/lib/runtime/mounts/session-send.ts';
import { ApiDispatcher, type ApiResponse, ApiRouter, ApiSocketDispatcher } from '../../../../src/lib/api/index.ts';
import { SharedDraftPresence, sharedDraftOrigin } from '../../../../src/lib/shared-drafts/index.ts';
import {
  assertDraftOwner,
  SHARED_DRAFT_MAX_BODY_BYTES,
  sentDraftClearer,
  sharedDraftRoutes,
  sharedDraftSocketRoutes,
} from '../../../../src/lib/runtime/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { AT, agentIn, CREDENTIALS, FakeSessionSend, human, sharedDraftService } from './support.ts';

const DEVICE = { deviceId: `fy_device_id_${'d'.repeat(22)}`, appSession: 'app-one' } as const;
const MEMBER = { memberId: 'mbr_x', keyId: 'mk_x', appSession: 'app-one', sessionId: 'relay-1' } as const;
const PATH = '/v1/sessions/s1/shared-draft';

function fixture() {
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...sharedDraftRoutes(sharedDraftService(['s1']))]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  return {
    dispatch: async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
      await dispatcher.dispatch(request(overrides)),
    dispatchAsMember: async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
      await dispatcher.dispatch({ ...request(overrides), member: MEMBER }),
  };
}

/** An edit in the generation every draft in this fixture is loaded in. */
const edit = (body: Readonly<Record<string, unknown>>, headers: Readonly<Record<string, string>> = human) => ({
  method: 'POST',
  path: PATH,
  headers,
  body: JSON.stringify({ generation: 'gen-1', ...body }),
});

/** The admin token with no client header: what a bare request with a found token looks like. */
const bareAdmin = { authorization: `Bearer ${CREDENTIALS.admin}` } as const;

describe('assertDraftOwner', () => {
  it("should admit only the owner's shell, the owner's app and the owner's paired devices", () => {
    for (const actor of ['admin-cli', 'device:d1']) should(() => assertDraftOwner(actor)).not.throw();
    for (const actor of ['admin-ui', 'peer:s1', 'warden:s1', 'warden', 'device-like:x', '', undefined])
      should(() => assertDraftOwner(actor)).throw({ status: 403, code: 'shared_draft_owner_only' });
  });
});

describe('shared draft routes', () => {
  it('should hand the owner an empty draft for a session nobody has typed into, never cached', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch({ path: PATH, headers: human });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).deepEqual({
      v: 1,
      sessionId: 's1',
      generation: 'gen-1',
      epoch: 0,
      rev: 0,
      text: '',
      items: [],
      updatedAt: AT,
    });
    should(response.headers.get('cache-control')).equal('no-store');
  });

  it('should let a paired device edit, and answer with the edit as sequenced', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch({ ...edit({ epoch: 0, base: 0, text: ['hi'] }, {}), device: DEVICE });

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).match({
      applied: { generation: 'gen-1', epoch: 0, rev: 1, text: ['hi'], add: [], remove: [] },
      snapshot: { rev: 1, text: 'hi' },
    });
  });

  it('should NEVER show a draft to an agent, even one holding the admin bearer inside its pane', async () => {
    // Arrange
    const { dispatch } = fixture();
    await dispatch(edit({ epoch: 0, base: 0, text: ['secret plan'] }));

    // Act
    const read = await dispatch({ path: PATH, headers: agentIn('s1') });
    const write = await dispatch(edit({ epoch: 0, base: 1, text: [11, '!'] }, agentIn('s1')));

    // Assert — refused at the boundary (`caller: 'person'`) before the draft is looked at, so not a word of
    // it reaches the body. A bare admin token, which the boundary takes for a person, is refused by the
    // route's own narrower gate below.
    for (const response of [read, write]) {
      should(response.status).equal(403);
      should(jsonBody(response)).have.property('code', 'owner_only');
      should(JSON.stringify(jsonBody(response))).not.containEql('secret');
    }
  });

  it('should refuse the warden token and a member session outright', async () => {
    // Arrange
    const { dispatch, dispatchAsMember } = fixture();

    // Act
    const warden = await dispatch({ path: PATH, headers: { authorization: `Bearer ${CREDENTIALS.warden}` } });
    const member = await dispatchAsMember({ path: PATH, device: DEVICE });

    // Assert
    should(warden.status).equal(403);
    should(member.status).equal(403);
  });

  it('should refuse an unknown session and a traversal in the path', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const missing = await dispatch({ path: '/v1/sessions/nope/shared-draft', headers: human });
    const traversal = await dispatch({ path: '/v1/sessions/%2e%2e/shared-draft', headers: human });

    // Assert
    should(missing.status).equal(404);
    should(traversal.status).equal(400);
    should(jsonBody(traversal)).have.property('code', 'invalid_session_id');
  });

  it('should refuse a bare admin-token request that names no client', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch({ path: PATH, headers: bareAdmin });

    // Assert
    should(response.status).equal(403);
    should(jsonBody(response)).have.property('code', 'shared_draft_owner_only');
  });

  it('should refuse an agent BEFORE reading its body: malformed or oversized, the answer is the same 403', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const malformed = await dispatch({ method: 'POST', path: PATH, headers: agentIn('s1'), body: '{not json' });
    const oversized = await dispatch({
      method: 'POST',
      path: PATH,
      headers: agentIn('s1'),
      body: 'x'.repeat(SHARED_DRAFT_MAX_BODY_BYTES + 1),
    });

    // Assert
    for (const response of [malformed, oversized]) {
      should(response.status).equal(403);
      should(jsonBody(response)).have.property('code', 'owner_only');
    }
  });

  it("should hold the owner's edit to a draft-sized body", async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch({
      method: 'POST',
      path: PATH,
      headers: human,
      body: JSON.stringify({ generation: 'gen-1', epoch: 0, base: 0, text: ['x'.repeat(SHARED_DRAFT_MAX_BODY_BYTES)] }),
    });

    // Assert
    should(response.status).equal(413);
  });

  it('should refuse a malformed edit at the boundary', async () => {
    // Arrange
    const { dispatch } = fixture();

    // Act
    const response = await dispatch(edit({ epoch: 0, base: 0, text: [0] }));

    // Assert
    should(response.status).equal(400);
  });

  it('should answer each refusal with its own status and code', async () => {
    // Arrange
    const { dispatch } = fixture();
    await dispatch(edit({ epoch: 0, base: 0, text: ['abc'] }));

    // Act
    const stale = await dispatch(edit({ epoch: 3, base: 1, text: [3, 'x'] }));
    const invalid = await dispatch(edit({ epoch: 0, base: 1, text: [9, 'x'] }));
    const tooLong = await dispatch(edit({ epoch: 0, base: 1, text: [3, 'x'.repeat(SHARED_DRAFT_MAX_CHARS)] }));
    const tooMany = await dispatch(
      edit({
        epoch: 0,
        base: 1,
        add: Array.from({ length: 20 }, (_, index) => ({
          kind: 'attachment',
          id: `a${index}`,
          name: 'x.png',
          mime: 'image/png',
          bytes: 1,
        })),
      }),
    );
    const oneMore = await dispatch(
      edit({ epoch: 0, base: 2, add: [{ kind: 'attachment', id: 'a20', name: 'x.png', mime: 'image/png', bytes: 1 }] }),
    );

    // Assert
    should([stale.status, jsonBody(stale)]).match([409, { code: 'shared_draft_stale' }]);
    should([invalid.status, jsonBody(invalid)]).match([422, { code: 'shared_draft_invalid' }]);
    should([tooLong.status, jsonBody(tooLong)]).match([413, { code: 'shared_draft_too_long' }]);
    should(tooMany.status).equal(200);
    should([oneMore.status, jsonBody(oneMore)]).match([413, { code: 'shared_draft_too_many_items' }]);
  });

  it('should let a genuine bug surface as a server error rather than the caller’s fault', async () => {
    // Arrange
    const dispatcher = new ApiDispatcher(
      new ApiRouter([
        ...sharedDraftRoutes({
          read: async () => {
            throw new Error('disk on fire');
          },
        } as never),
      ]),
      CREDENTIALS,
      NO_GOVERNED_ROUTES_GUARD,
    );

    // Act
    const response = await dispatcher.dispatch(request({ path: PATH, headers: human }));

    // Assert
    should(response.status).equal(500);
  });
});

describe('shared draft stream route', () => {
  const STREAM = '/v1/sessions/s1/shared-draft/stream';

  /** A socket a test reads back, as the transport would hand one to the handler. */
  const recording = () => {
    const frames: Record<string, unknown>[] = [];
    return {
      frames,
      downstream: {
        send: (frame: string | Uint8Array) => {
          frames.push(JSON.parse(String(frame)) as Record<string, unknown>);
          return 1;
        },
        close: () => undefined,
        bufferedBytes: () => 0,
      },
    };
  };

  function socketFixture(names: Readonly<Record<string, string>> = {}) {
    let peer = 0;
    const drafts = sharedDraftService(['s1']);
    const dispatcher = new ApiSocketDispatcher(
      new ApiRouter([
        ...sharedDraftSocketRoutes(drafts, {
          presence: new SharedDraftPresence(),
          deviceName: async deviceId => names[deviceId],
          nextPeer: () => `peer-${++peer}`,
          clock: { nowMs: () => 0 },
        }),
      ]),
      CREDENTIALS,
      NO_GOVERNED_ROUTES_GUARD,
    );
    /** Upgrades, attaches and opens: the stream as a composer would hold it. */
    const connect = async (overrides: Parameters<typeof request>[0]) => {
      const decision = await dispatcher.upgrade(request({ path: STREAM, ...overrides }));
      if (decision.outcome !== 'accepted') return { decision, frames: [] as Record<string, unknown>[] };
      const socket = recording();
      const handler = await decision.attach(socket.downstream);
      await handler.open();
      return { decision, frames: socket.frames, handler };
    };
    return { connect, drafts };
  }

  it('opens for the owner with the whole draft, and for a reconnect with only what it missed', async () => {
    // Arrange
    const { connect, drafts } = socketFixture();
    await drafts.edit('s1', { generation: 'gen-1', epoch: 0, base: 0, text: ['a'] });
    await drafts.edit('s1', { generation: 'gen-1', epoch: 0, base: 1, text: [1, 'b'] });

    // Act
    const fresh = await connect({ headers: human });
    const back = await connect({
      headers: human,
      query: [
        ['generation', 'gen-1'],
        ['epoch', '0'],
        ['rev', '1'],
      ],
    });

    // Assert
    should(fresh.frames).match([{ kind: 'snapshot', snapshot: { text: 'ab', rev: 2 } }]);
    should(back.frames).match([{ kind: 'edit', rev: 2 }]);
  });

  it('refuses an agent, a bare admin token, an unknown session and half a position before switching', async () => {
    // Arrange
    const { connect } = socketFixture();
    const status = (decision: Awaited<ReturnType<typeof connect>>['decision']) =>
      decision.outcome === 'refused' ? decision.response.status : 0;

    // Act
    const agent = await connect({ headers: agentIn('s1') });
    const bare = await connect({ headers: bareAdmin });
    const missing = await connect({ path: '/v1/sessions/nope/shared-draft/stream', headers: human });
    const half = await connect({ headers: human, query: [['rev', '1']] });
    const twice = await connect({
      headers: human,
      query: [
        ['generation', 'g'],
        ['generation', 'h'],
      ],
    });
    const notANumber = await connect({
      headers: human,
      query: [
        ['generation', 'g'],
        ['epoch', 'x'],
        ['rev', '1'],
      ],
    });

    // Assert
    should([agent, bare, missing, half, twice, notANumber].map(({ decision }) => status(decision))).deepEqual([
      403, 403, 404, 400, 400, 400,
    ]);
  });

  it("names each composer by the device the owner paired, so the others can say where they're typing", async () => {
    // Arrange
    const named = `fy_device_id_${'n'.repeat(22)}`;
    const unnamed = `fy_device_id_${'u'.repeat(22)}`;
    const { connect } = socketFixture({ [named]: 'Kirin’s iPhone' });
    const watcher = await connect({ headers: human });

    // Act
    for (const deviceId of [named, unnamed]) {
      const stream = await connect({ device: { deviceId, appSession: 'app-one' } });
      stream.handler?.fromClient(JSON.stringify({ kind: 'presence', typing: true }));
    }
    const cli = await connect({ headers: human });
    cli.handler?.fromClient(JSON.stringify({ kind: 'presence', typing: true }));

    // Assert
    should(watcher.frames.filter(frame => frame.kind === 'presence').map(frame => frame.device)).deepEqual([
      'Kirin’s iPhone',
      'another device',
      'this computer',
    ]);
  });
});

describe('sentDraftClearer (&F331 H1)', () => {
  it("takes out exactly what was sent, keeps words typed since, and only for the owner's own sends", async () => {
    // Arrange — "hello" at revision 1; the person sends it; another device then adds " world".
    const drafts = sharedDraftService(['s1']);
    await drafts.edit('s1', { generation: 'gen-1', epoch: 0, base: 0, text: ['hello'] });
    await drafts.edit('s1', { generation: 'gen-1', epoch: 0, base: 1, text: [5, ' world'] });
    const clear = sentDraftClearer(drafts);
    const sent = { generation: 'gen-1', epoch: 0, base: 1, text: [-5] };

    // Act — a ferret's send is ignored; the owner's takes out "hello" only, once however often.
    await clear('s1', 'peer:s1', 'req-1', sent);
    await clear('s1', undefined, 'req-1', sent);
    should((await drafts.read('s1')).text).equal('hello world');
    await clear('s1', 'device:phone', 'req-1', sent);
    await clear('s1', 'device:phone', 'req-1', sent);

    // Assert
    should(await drafts.read('s1')).match({ text: ' world', epoch: 0 });
  });

  it('is the same edit as the composer clearing it on its stream: whichever lands first, it applies once', async () => {
    const drafts = sharedDraftService(['s1']);
    await drafts.edit('s1', { generation: 'gen-1', epoch: 0, base: 0, text: ['sent'] });
    // The composer's stream clear lands first, under the send's request id.
    await drafts.edit(
      's1',
      { generation: 'gen-1', epoch: 0, base: 1, text: [-4], sent: true },
      sharedDraftOrigin('device:phone', 'stream-7', 'req-9'),
    );
    const after = await drafts.read('s1');
    should(after).match({ text: '', epoch: 1 });

    // Then the send's own copy arrives: a repeat of the stream's, or a draft already moved on — never a second clear.
    await sentDraftClearer(drafts)('s1', 'device:phone', 'req-9', {
      generation: 'gen-1',
      epoch: 0,
      base: 1,
      text: [-4],
    }).catch(() => undefined);
    should(await drafts.read('s1')).match({ text: '', epoch: 1, rev: 0 });
  });
});

describe('shared drafts are ungoverned by grants, like sends (docs/grants.md, deliberately)', () => {
  /** A guard that refuses every demand it is asked: a device whose grants deny everything. */
  const denyEverything: CapabilityGuard = {
    decide: () => ({ allowed: false, refusal: 'denied' }),
    governance: () => ({ governed: true, decide: () => ({ allowed: false, refusal: 'denied' }) }),
  } as unknown as CapabilityGuard;
  const DEVICE_ID = `fy_device_id_${'g'.repeat(22)}`;
  const device = { deviceId: DEVICE_ID, appSession: 'app-one' } as const;

  it('declares no capability on the draft routes or the stream, the same as the send route', () => {
    const drafts = sharedDraftService(['s1']);
    const routes = [
      ...sharedDraftRoutes(drafts),
      ...sharedDraftSocketRoutes(drafts, {
        presence: new SharedDraftPresence(),
        deviceName: async () => undefined,
        nextPeer: () => 'p',
        clock: { nowMs: () => 0 },
      }),
    ];
    should(routes.map(route => route.capability)).deepEqual([undefined, undefined, undefined]);
    should(
      sessionSendRoutes(new FakeSessionSend()).find(route => route.path.endsWith('/send'))?.capability,
    ).be.undefined();
  });

  it('serves a paired device whose grants deny everything, on direct and relayed arrival alike', async () => {
    const drafts = sharedDraftService(['s1']);
    const dispatcher = new ApiDispatcher(new ApiRouter([...sharedDraftRoutes(drafts)]), CREDENTIALS, denyEverything);
    for (const loopback of [true, false]) {
      const read = await dispatcher.dispatch(request({ path: PATH, device, loopback }));
      should(read.status).equal(200);
    }
  });
});
