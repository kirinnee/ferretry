import { describe, expect, test } from 'bun:test';
import { CAPABILITIES, STEP_UP_ACTS } from '@ferretry/core-gate/contract';
import { ownerRoutes } from '../../daemon/routes/owner.ts';
import manifest from '../../manifest.ts';
import { owner, signIn, world } from '../support/world.ts';

const ON = { enabled: true, publicUrl: 'https://mcp.example.com', port: 7490 };
const json = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

async function waiting(w: ReturnType<typeof world>) {
  await signIn(w);
  const [pending] = await w.service.authority.pending();
  if (pending === undefined) throw new Error('nothing waiting');
  return pending;
}

describe("the owner routes are declared as a person's", () => {
  const routes = manifest.actions?.routes ?? [];
  const owned = routes.filter(declared => declared.path.startsWith('/v1/connector'));

  test('every owner route is caller person, operator minimum, and carries a pairing capability', () => {
    expect(owned.map(r => r.key).toSorted()).toEqual([
      'GET /v1/connector',
      'POST /v1/connector/grants/:id/revoke',
      'POST /v1/connector/requests/:id/approve',
      'POST /v1/connector/requests/:id/deny',
      'PUT /v1/connector',
    ]);
    for (const route of owned) {
      expect(route.caller).toBe('person');
      expect(route.minimum).toBe('operator');
      expect(route.capability?.capability).toBe(CAPABILITIES.pairing);
      expect(route.door).toBeUndefined();
    }
  });

  test('approving is `configure` and names its own act; denying and revoking only take away (`use`, narrowing)', () => {
    const by = (key: string) => owned.find(r => r.key === key)?.capability;
    expect(by('POST /v1/connector/requests/:id/approve')).toMatchObject({
      axis: 'configure',
      act: STEP_UP_ACTS.approveConnector,
    });
    expect(by('POST /v1/connector/requests/:id/deny')).toMatchObject({ axis: 'use', narrowing: true });
    expect(by('POST /v1/connector/grants/:id/revoke')).toMatchObject({ axis: 'use', narrowing: true });
    expect(by('PUT /v1/connector')).toMatchObject({ axis: 'configure' });
    expect(by('GET /v1/connector')).toMatchObject({ axis: 'use' });
  });

  test('the door routes carry no capability, no grants, and are exactly the nine OAuth/MCP paths and the two /mcp refusals', () => {
    const doors = routes.filter(declared => declared.door === 'public');
    expect(doors.map(r => r.key as string).toSorted()).toEqual(
      [
        'DELETE /mcp',
        'GET /.well-known/oauth-authorization-server',
        'GET /.well-known/oauth-protected-resource',
        'GET /.well-known/oauth-protected-resource/mcp',
        'GET /mcp',
        'GET /oauth/authorize',
        'GET /oauth/authorize/wait',
        'POST /mcp',
        'POST /oauth/register',
        'POST /oauth/revoke',
        'POST /oauth/token',
      ].toSorted(),
    );
    for (const route of doors) {
      expect(route.minimum).toBe('none');
      expect(route.caller).toBe('any');
      expect(route.capability).toBeUndefined();
      expect(route.noStore).toBe(true);
    }
    expect(manifest.permissions?.publicDoor).toBe(true);
  });
});

describe('GET /v1/connector', () => {
  test('answers off with the sentence, then on with the MCP URL and what is waiting', async () => {
    const w = world();
    const handlers = ownerRoutes(w.service);
    expect(json(await handlers['GET /v1/connector']())).toMatchObject({ enabled: false, switchedOn: false });
    w.config.set(ON);
    await w.service.start();
    const pending = await waiting(w);
    const status = json(await handlers['GET /v1/connector']());
    expect(status).toMatchObject({
      enabled: true,
      switchedOn: true,
      publicUrlSource: 'configured',
      mcpUrl: 'https://mcp.example.com/mcp',
    });
    expect(status.pending).toEqual([
      expect.objectContaining({ id: pending.id, matchCode: pending.matchCode, clientName: 'Claude' }),
    ]);
    // The strict schema has no field for a handle, a code or a token.
    expect(JSON.stringify(status)).not.toMatch(/fyc_|handle|secret/u);
  });
});

describe('approving (S7)', () => {
  test('at the machine (ungoverned) needs no passkey, by id or by match code in any case', async () => {
    const w = world(ON);
    await w.service.start();
    const handlers = ownerRoutes(w.service);
    const pending = await waiting(w);
    const approved = await handlers['POST /v1/connector/requests/:id/approve'](
      owner({ params: { id: pending.matchCode.toLowerCase().replace('-', '') } }),
    );
    expect(approved.status).toBe(200);
    expect(json(approved)).toMatchObject({
      clientName: 'Claude',
      approvedBy: 'admin-cli',
      scopes: ['fleet:read', 'fleet:write'],
    });
  });

  test('a governed device with no fresh approve-connector proof is told which act to confirm, and nothing is approved', async () => {
    const w = world(ON);
    await w.service.start();
    const handlers = ownerRoutes(w.service);
    const pending = await waiting(w);
    const refused = await handlers['POST /v1/connector/requests/:id/approve'](
      owner({ params: { id: pending.id }, governed: true, actor: 'device:d1' }),
    );
    expect(refused.status).toBe(403);
    expect(json(refused)).toMatchObject({
      code: 'grant_step_up_required',
      demand: { capability: 'pairing', axis: 'configure', act: 'approve-connector' },
    });
    expect(await w.service.authority.pending()).toHaveLength(1);
    expect(w.events.some(event => event.kind === 'connector.grant.approved')).toBe(false);
  });

  test('a catalog-install proof, an add-device proof or the unlock never buys a connector', async () => {
    const w = world(ON);
    await w.service.start();
    const handlers = ownerRoutes(w.service);
    const pending = await waiting(w);
    for (const proofs of [['catalog-install'], ['add-device'], ['loosen-config'], ['show-terminals']]) {
      const refused = await handlers['POST /v1/connector/requests/:id/approve'](
        owner({ params: { id: pending.id }, governed: true, actor: 'device:d1', proofs }),
      );
      expect(refused.status, proofs.join()).toBe(403);
    }
    expect(await w.service.authority.pending()).toHaveLength(1);
  });

  test('a governed device with a fresh approve-connector proof approves, and the proof is spent: one confirmation, one sign-in', async () => {
    const w = world(ON);
    await w.service.start();
    const handlers = ownerRoutes(w.service);
    const first = await waiting(w);
    await signIn(w, 'Second app');
    const call = owner({ params: { id: first.id }, governed: true, actor: 'device:d1', proofs: ['approve-connector'] });
    expect((await handlers['POST /v1/connector/requests/:id/approve'](call)).status).toBe(200);
    expect(w.events).toContainEqual(expect.objectContaining({ kind: 'connector.grant.approved', actor: 'device:d1' }));
    const [second] = await w.service.authority.pending();
    const again = await handlers['POST /v1/connector/requests/:id/approve'](
      owner({ params: { id: second?.id ?? '' }, governed: true, actor: 'device:d1' }),
    );
    expect(again.status).toBe(403);
  });

  test("a body naming an approver is refused, not ignored (who acts is the route's, never the caller's)", async () => {
    const w = world(ON);
    await w.service.start();
    const handlers = ownerRoutes(w.service);
    const pending = await waiting(w);
    await expect(
      handlers['POST /v1/connector/requests/:id/approve'](
        owner({ params: { id: pending.id }, body: { approvedBy: 'host' } }),
      ),
    ).rejects.toBeDefined();
  });

  test('unknown or malformed references are 404 with a code; a connector that is off is 409 connector_disabled', async () => {
    const w = world(ON);
    await w.service.start();
    const handlers = ownerRoutes(w.service);
    const unknown = await handlers['POST /v1/connector/requests/:id/approve'](owner({ params: { id: 'zzzzzz' } }));
    expect(unknown.status).toBe(404);
    expect(json(unknown)).toMatchObject({ code: 'connector_not_found' });
    const odd = await handlers['POST /v1/connector/requests/:id/approve'](owner({ params: { id: 'not a ref!' } }));
    expect(odd.status).toBe(404);
    w.config.set({ ...ON, enabled: false });
    const off = await handlers['POST /v1/connector/requests/:id/approve'](owner({ params: { id: 'abc-def' } }));
    expect(off.status).toBe(409);
    expect(json(off)).toMatchObject({ code: 'connector_disabled' });
  });
});

describe('denying and revoking only take away', () => {
  test('deny ends the request and answers it; revoke ends a grant, also while the connector is off', async () => {
    const w = world(ON);
    await w.service.start();
    const handlers = ownerRoutes(w.service);
    const first = await waiting(w);
    const denied = await handlers['POST /v1/connector/requests/:id/deny'](
      owner({ params: { id: first.id }, governed: true, actor: 'device:d1' }),
    );
    expect(denied.status).toBe(200);
    expect(json(denied)).toMatchObject({ id: first.id });
    expect(w.events).toContainEqual(expect.objectContaining({ kind: 'connector.grant.denied' }));

    const second = await waiting(w);
    const grant = json(await handlers['POST /v1/connector/requests/:id/approve'](owner({ params: { id: second.id } })));
    w.config.set({ ...ON, enabled: false });
    const revoked = await handlers['POST /v1/connector/grants/:id/revoke'](owner({ params: { id: String(grant.id) } }));
    expect(revoked.status).toBe(200);
    expect(json(revoked).revokedAt).toBeDefined();
    // Revoking again is idempotent, and an unknown id is a 404 in the connector's own words.
    expect(
      (await handlers['POST /v1/connector/grants/:id/revoke'](owner({ params: { id: String(grant.id) } }))).status,
    ).toBe(200);
    await expect(
      handlers['POST /v1/connector/grants/:id/revoke'](owner({ params: { id: 'nope' } })),
    ).rejects.toMatchObject({
      status: 404,
      code: 'connector_not_found',
    });
  });
});

describe('PUT /v1/connector', () => {
  test('switches on and answers the status read after the change', async () => {
    const w = world({ publicUrl: 'https://mcp.example.com', port: 7491 });
    const handlers = ownerRoutes(w.service);
    const answer = await handlers['PUT /v1/connector'](
      owner({ body: { enabled: true }, actor: 'device:d1', governed: true }),
    );
    expect(answer.status).toBe(200);
    expect(json(answer)).toMatchObject({ enabled: true, switchedOn: true });
    expect(w.config.writes).toEqual([{ enabled: true }]);
  });

  test('a switch that cannot happen is 409 connector_cannot_switch with its sentence', async () => {
    const w = world({ publicUrl: 'https://mcp.example.com', port: 7492 });
    w.failOpen = 'EADDRINUSE';
    const handlers = ownerRoutes(w.service);
    const answer = await handlers['PUT /v1/connector'](owner({ body: { enabled: true } }));
    expect(answer.status).toBe(409);
    expect(json(answer)).toMatchObject({ code: 'connector_cannot_switch' });
  });

  test('takes ONLY { enabled }: an address or a redirect list in the body is refused, never applied', async () => {
    const w = world();
    const handlers = ownerRoutes(w.service);
    await expect(
      handlers['PUT /v1/connector'](owner({ body: { enabled: true, publicUrl: 'https://evil.example' } })),
    ).rejects.toBeDefined();
    expect(w.config.writes).toEqual([]);
  });
});
