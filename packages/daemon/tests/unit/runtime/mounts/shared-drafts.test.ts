import { describe, it } from 'bun:test';
import { SHARED_DRAFT_MAX_CHARS } from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import { assertDraftOwner, SHARED_DRAFT_MAX_BODY_BYTES, sharedDraftRoutes } from '../../../../src/lib/runtime/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { AT, agentIn, CREDENTIALS, human, sharedDraftService } from './support.ts';

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

    // Assert — refused before the draft is looked at, so not a word of it reaches the body.
    for (const response of [read, write]) {
      should(response.status).equal(403);
      should(jsonBody(response)).have.property('code', 'shared_draft_owner_only');
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
      should(jsonBody(response)).have.property('code', 'shared_draft_owner_only');
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
