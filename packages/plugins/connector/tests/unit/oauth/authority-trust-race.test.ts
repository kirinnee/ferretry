import { describe, expect, test } from 'bun:test';
import { ConnectorAuthority } from '../../../daemon/lib/oauth/authority.ts';
import { base64url } from '../../../daemon/lib/oauth/model.ts';
import type { ConnectorEndpoints } from '../../../daemon/lib/ports.ts';
import { endpoints, fixture, verifier } from '../../support/oauth-fixture.ts';

/**
 * Trust is judged where the write happens. Every await between "looked" and "wrote" is a window a live config
 * change can slip through, so these tests STOP the authority inside one of those awaits (a digest, a store load),
 * change the trust, release it, and require that nothing at all was written: no code, no token, no grant, no
 * approval audit.
 */
const extraCallback = 'https://callback.example/cb';

interface Gate {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

function world() {
  const f = fixture();
  const live = { issuer: endpoints.issuer, resource: endpoints.resource, extra: [extraCallback] };
  let hold: { readonly matches: (text: string) => boolean; reached: () => void; released: Promise<void> } | undefined;
  let holdLoad: { reached: () => void; released: Promise<void> } | undefined;
  let holdSave: { reached: () => void; released: Promise<void> } | undefined;
  let failing: Set<number> | undefined;
  let sinceArmed = 0;
  /** Fail the nth store write from now (1 = the very next), once each. */
  const failSaves = (...nth: number[]) => {
    failing = new Set(nth);
    sinceArmed = 0;
  };

  const arm = (matches: (text: string) => boolean): Gate => {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>(resolve => (reached = resolve));
    const released = new Promise<void>(resolve => (release = resolve));
    hold = { matches, reached, released };
    return { reached: reachedPromise, release };
  };
  const armLoad = (): Gate => {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>(resolve => (reached = resolve));
    const released = new Promise<void>(resolve => (release = resolve));
    holdLoad = { reached, released };
    return { reached: reachedPromise, release };
  };

  const armSave = (): Gate => {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>(resolve => (reached = resolve));
    const released = new Promise<void>(resolve => (release = resolve));
    holdSave = { reached, released };
    return { reached: reachedPromise, release };
  };

  const crypto = {
    randomBytes: f.options.crypto.randomBytes,
    sha256: async (text: string) => {
      const current = hold;
      if (current?.matches(text)) {
        hold = undefined;
        current.reached();
        await current.released;
      }
      return f.options.crypto.sha256(text);
    },
  };
  const store = {
    save: async (value: Parameters<typeof f.options.store.save>[0]) => {
      if (failing && failing.has(++sinceArmed)) throw new Error('disk full');
      const current = holdSave;
      if (current) {
        holdSave = undefined;
        await f.options.store.save(value);
        current.reached();
        await current.released;
        return;
      }
      await f.options.store.save(value);
    },
    load: async () => {
      const current = holdLoad;
      if (current) {
        holdLoad = undefined;
        const state = await f.options.store.load();
        current.reached();
        await current.released;
        return state;
      }
      return f.options.store.load();
    },
  };
  const moving: ConnectorEndpoints = {
    ...endpoints,
    get issuer() {
      return live.issuer;
    },
    get resource() {
      return live.resource;
    },
    get resourceMetadataUrl() {
      return `${live.issuer}/.well-known/oauth-protected-resource/mcp`;
    },
  };
  const authority = new ConnectorAuthority({
    ...f.options,
    crypto,
    store,
    endpoints: moving,
    get allowedRedirectUris() {
      return live.extra;
    },
  });
  const start = async () => {
    const client = await authority.register({ redirect_uris: [extraCallback] });
    const challenge = base64url(await crypto.sha256(verifier));
    const location = await authority.startAuthorization({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: extraCallback,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    const handle = new URL(location).searchParams.get('h') ?? '';
    return { client, handle };
  };
  const pendingId = async () => (await authority.pending())[0]?.id ?? '';
  const approve = async () => {
    const result = await authority.approve(await pendingId(), 'admin-cli');
    if (!result.ok) throw new Error('approval failed');
  };
  const codeFor = async (handle: string) => {
    const answer = await authority.waitPage(handle);
    if (answer.kind !== 'redirect') throw new Error('missing redirect');
    return new URL(answer.location).searchParams.get('code') ?? '';
  };
  const redeem = (clientId: string, code: string) =>
    authority.exchange({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: extraCallback,
    });
  const noTokens = () =>
    expect(f.state().grants.every(grant => grant.access.length === 0 && grant.refresh.length === 0)).toBe(true);
  const removeCallback = () => {
    live.extra = [];
  };
  const move = () => {
    live.issuer = 'https://moved.example';
    live.resource = 'https://moved.example/mcp';
  };
  return {
    f,
    live,
    authority,
    arm,
    armLoad,
    armSave,
    failSaves,
    start,
    pendingId,
    approve,
    codeFor,
    redeem,
    noTokens,
    removeCallback,
    move,
  };
}

describe('connector authority — trust that changes inside an await', () => {
  test('wait page: a callback removed during the code digest emits no code', async () => {
    const w = world();
    const { handle } = await w.start();
    await w.approve();
    const gate = w.arm(text => text !== handle);
    const answer = w.authority.waitPage(handle);
    const outcome = answer.then(
      () => 'redirect',
      (error: { error?: string }) => error.error,
    );
    await gate.reached;
    w.removeCallback();
    gate.release();
    expect(await outcome).toBe('invalid_request');
    expect(w.f.memory.codes.size).toBe(0);
  });

  test('wait page: an origin changed during the code digest emits no code', async () => {
    const w = world();
    const { handle } = await w.start();
    await w.approve();
    const gate = w.arm(text => text !== handle);
    const outcome = w.authority.waitPage(handle).then(
      () => 'redirect',
      (error: { error?: string }) => error.error,
    );
    await gate.reached;
    w.move();
    gate.release();
    expect(await outcome).toBe('invalid_request');
    expect(w.f.memory.codes.size).toBe(0);
  });

  test('approve: a callback removed while the grants load, then pruned, writes no grant, no approval and no audit', async () => {
    const w = world();
    const { handle } = await w.start();
    const id = await w.pendingId();
    const gate = w.armLoad();
    const outcome = w.authority.approve(id, 'admin-cli');
    await gate.reached;
    w.removeCallback();
    await w.authority.waitPage(handle).catch(() => undefined); // a poll sweeps the request out (it never takes the write queue)
    gate.release();
    expect(await outcome).toMatchObject({ ok: false, code: 'expired' });
    expect(w.f.state().grants).toEqual([]);
    expect(w.f.saves()).toBe(1); // the registration only
    expect(w.f.events.some(event => event.kind === 'connector.grant.approved')).toBe(false);
    expect(await w.authority.pending()).toEqual([]); // and nothing was republished
    expect(w.f.memory.pending.size).toBe(0);
  });

  test('approve: an origin changed while the grants load, request not yet pruned, still writes nothing', async () => {
    const w = world();
    await w.start();
    const id = await w.pendingId();
    const gate = w.armLoad();
    const outcome = w.authority.approve(id, 'admin-cli');
    await gate.reached;
    w.move();
    gate.release();
    expect(await outcome).toMatchObject({ ok: false, code: 'expired' });
    expect(w.f.state().grants).toEqual([]);
    expect(w.f.events.some(event => event.kind === 'connector.grant.approved')).toBe(false);
    expect([...w.f.memory.pending.values()].some(request => request.decision)).toBe(false);
  });

  test('approve: trust lost while the grant is being saved takes the grant back out and audits no approval', async () => {
    const w = world();
    await w.start();
    const id = await w.pendingId();
    const registered = w.f.state();
    const gate = w.armSave();
    const outcome = w.authority.approve(id, 'admin-cli');
    await gate.reached;
    expect(w.f.state().grants).toHaveLength(1); // the grant is durable for the moment the trust is lost
    w.removeCallback();
    gate.release();
    expect(await outcome).toMatchObject({ ok: false, code: 'expired' });
    expect(w.f.state().grants).toEqual([]); // no durable grant remains
    expect(w.f.state()).toEqual(registered); // the store is exactly as before the approval
    expect(w.f.saves()).toBe(3); // registration, the grant, and the rollback
    expect(w.f.events.some(event => event.kind === 'connector.grant.approved')).toBe(false);
    expect([...w.f.memory.pending.values()].some(request => request.decision)).toBe(false); // nothing was approved in memory
  });

  test('approve: a failed grant write writes, decides and audits nothing', async () => {
    const w = world();
    await w.start();
    const id = await w.pendingId();
    const registered = w.f.state();
    w.failSaves(1);
    await expect(w.authority.approve(id, 'admin-cli')).rejects.toThrow('disk full');
    expect(w.f.state()).toEqual(registered);
    expect(w.f.events.some(event => event.kind === 'connector.grant.approved')).toBe(false);
    expect([...w.f.memory.pending.values()].some(request => request.decision)).toBe(false);
    // The sign-in is still waiting, so the owner can approve it again once the disk answers.
    expect(await w.authority.approve(id, 'admin-cli')).toMatchObject({ ok: true });
  });

  test('approve: trust lost during the grant write and the take-back also failing leaves an inert, unapproved grant', async () => {
    const w = world();
    const { handle } = await w.start();
    const id = await w.pendingId();
    const gate = w.armSave();
    w.failSaves(2); // the grant write succeeds, its take-back does not
    const outcome = w.authority.approve(id, 'admin-cli');
    await gate.reached;
    w.removeCallback();
    gate.release();
    expect(await outcome).toMatchObject({ ok: false, code: 'expired' });
    expect(w.f.events.some(event => event.kind === 'connector.grant.approved')).toBe(false);
    expect([...w.f.memory.pending.values()].some(request => request.decision)).toBe(false);
    w.noTokens(); // whatever is left in the store holds no credential
    await expect(w.authority.waitPage(handle)).rejects.toMatchObject({ error: 'invalid_request' });
    expect(w.f.memory.codes.size).toBe(0);
  });

  test('wait page: a callback removed during the exact handle digest answers unknown and emits no code', async () => {
    const w = world();
    const { handle } = await w.start();
    await w.approve();
    const gate = w.arm(text => text === handle); // the HANDLE digest, not the code digest
    const outcome = w.authority.waitPage(handle).then(
      () => 'redirect',
      (error: { error?: string }) => error.error,
    );
    await gate.reached;
    w.removeCallback();
    gate.release();
    expect(await outcome).toBe('invalid_request');
    expect(w.f.memory.codes.size).toBe(0);
  });

  test('wait page: a near-miss handle is unknown and spends nothing of the real one', async () => {
    const w = world();
    const { handle } = await w.start();
    await w.approve();
    const nearMiss = `${handle.slice(0, -1)}${handle.endsWith('A') ? 'B' : 'A'}`;
    await expect(w.authority.waitPage(nearMiss)).rejects.toMatchObject({ error: 'invalid_request' });
    expect(w.f.memory.codes.size).toBe(0);
    expect((await w.authority.waitPage(handle)).kind).toBe('redirect');
  });

  test('redeem: a callback removed during the PKCE digest mints no token', async () => {
    const w = world();
    const { client, handle } = await w.start();
    await w.approve();
    const code = await w.codeFor(handle);
    const gate = w.arm(text => text === verifier);
    const outcome = w.redeem(client.client_id, code).then(
      () => 'minted',
      (error: { error?: string }) => error.error,
    );
    await gate.reached;
    w.removeCallback();
    gate.release();
    expect(await outcome).toBe('invalid_grant');
    w.noTokens();
  });

  test('redeem: an origin changed during the PKCE digest mints no token', async () => {
    const w = world();
    const { client, handle } = await w.start();
    await w.approve();
    const code = await w.codeFor(handle);
    const gate = w.arm(text => text === verifier);
    const outcome = w.redeem(client.client_id, code).then(
      () => 'minted',
      (error: { error?: string }) => error.error,
    );
    await gate.reached;
    w.move();
    gate.release();
    expect(await outcome).toBe('invalid_grant');
    w.noTokens();
  });

  test('redeem: an origin changed during the token digest never mints a pair for the new audience', async () => {
    const w = world();
    const { client, handle } = await w.start();
    await w.approve();
    const code = await w.codeFor(handle);
    const gate = w.arm(text => text.startsWith('fyc_at_'));
    const outcome = w.redeem(client.client_id, code).then(
      () => 'minted',
      (error: { error?: string }) => error.error,
    );
    await gate.reached;
    w.move();
    gate.release();
    expect(await outcome).toBe('invalid_grant');
    w.noTokens();
    for (const grant of w.f.state().grants)
      for (const token of [...grant.access, ...grant.refresh]) expect(token.audience).toBe(endpoints.resource);
  });

  test('redeem: a callback removed during the token digest mints no token', async () => {
    const w = world();
    const { client, handle } = await w.start();
    await w.approve();
    const code = await w.codeFor(handle);
    const gate = w.arm(text => text.startsWith('fyc_at_'));
    const outcome = w.redeem(client.client_id, code).then(
      () => 'minted',
      (error: { error?: string }) => error.error,
    );
    await gate.reached;
    w.removeCallback();
    gate.release();
    expect(await outcome).toBe('invalid_grant');
    w.noTokens();
  });
});
