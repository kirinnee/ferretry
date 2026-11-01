/**
 * The member request client: one session per publisher, the walk that opens it, and what each refusal means.
 */

import { describe, it } from 'bun:test';
import { RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import { z } from 'zod';
import { MemberRefusedError, MemberUnreachableError, openMemberClient } from '../../src/lib/member-client.ts';
import { RelaySessionError } from '../../src/lib/relay-session.ts';
import { testSubscription } from '../support/member-keys.ts';
import { autoDial, dialByHost, newDaemonIdentity, relayCrypto, type ScriptedSocket } from '../support/relay.ts';

const HOSTED = 'wss://relay.ferretry.test';
const noHeartbeat = () => () => undefined;
const Answer = z.object({ ok: z.literal(true) });

const reasonOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

const clientFor = async (
  dial: (url: string) => ScriptedSocket,
  daemonId: string,
  extra: Partial<Parameters<typeof openMemberClient>[0]> = {},
) =>
  openMemberClient({
    crypto: relayCrypto,
    subscription: await testSubscription(daemonId),
    hostedRelayUrl: HOSTED,
    dial,
    heartbeat: noHeartbeat,
    directTimeoutMs: 30,
    relayTimeoutMs: 30,
    ...extra,
  });

describe('a member request client', () => {
  it('should open one member session on the first request and reuse it for the next', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { body: JSON.stringify({ ok: true }) });
    const client = await clientFor(auto.dial, id.daemonId);
    should(await client.request('/v1/shared/me', Answer)).eql({ ok: true });
    should(await client.request('/v1/shared/me', Answer)).eql({ ok: true });
    should(auto.sockets).have.length(1);
    should(auto.requests).have.length(2);
  });

  it('should send the method, path and JSON body it was given', async () => {
    const id = await newDaemonIdentity();
    const seen: { method: string; path: string; body?: string }[] = [];
    const auto = autoDial(id, {
      respond: request => {
        seen.push({
          method: request.method,
          path: request.path,
          ...(request.body === undefined ? {} : { body: request.body }),
        });
        return { body: { ok: true } };
      },
    });
    const client = await clientFor(auto.dial, id.daemonId);
    await client.request('/v1/shared/redeem', Answer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'x' }),
    });
    should(seen).eql([{ method: 'POST', path: '/v1/shared/redeem', body: '{"code":"x"}' }]);
  });

  it('should surface a publisher refusal with its top-level code', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, {
      respond: () => ({ status: 403, body: { error: 'unlock first', code: 'member_locked' } }),
    });
    const client = await clientFor(auto.dial, id.daemonId);
    const reason = await reasonOf(client.request('/v1/shared/me', Answer));
    should(reason).be.instanceof(FyHttpError);
    should((reason as FyHttpError).code).equal('member_locked');
    should((reason as FyHttpError).status).equal(403);
  });

  it('should still say something when the refusal is not the publisher’s own shape', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { respond: () => ({ status: 502, body: 'bad gateway' }) });
    const client = await clientFor(auto.dial, id.daemonId);
    const reason = (await reasonOf(client.request('/v1/shared/me', Answer))) as FyHttpError;
    should(reason).be.instanceof(FyHttpError);
    should(reason.code).be.undefined();
    should(reason.message).match(/502/u);
  });

  it('should read a 401 unauthorized on an open session as the key being refused', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, {
      respond: () => ({
        status: 401,
        body: { error: 'this browser is no longer registered here', code: 'unauthorized' },
      }),
    });
    const client = await clientFor(auto.dial, id.daemonId);
    should(await reasonOf(client.request('/v1/shared/me', Answer))).be.instanceof(MemberRefusedError);
  });

  it('should not read any other 401 as a refused key', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, {
      respond: () => ({ status: 401, body: { error: 'that passkey did not check out', code: 'member_not_verified' } }),
    });
    const client = await clientFor(auto.dial, id.daemonId);
    const reason = await reasonOf(client.request('/v1/shared/unlock', Answer, { method: 'POST' }));
    should(reason).be.instanceof(FyHttpError);
    should((reason as FyHttpError).code).equal('member_not_verified');
  });

  it('should treat a 4403 on a new session as a refused key and stop walking', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { rejectMember: true });
    const dialled = dialByHost({ 'studio.example.test': auto.dial, 'relay.ferretry.test': auto.dial });
    const client = await clientFor(dialled.dial, id.daemonId);
    should(await reasonOf(client.request('/v1/shared/me', Answer))).be.instanceof(MemberRefusedError);
    should(dialled.dialled).have.length(1);
  });

  it('should walk on to the rendezvous when the publisher’s own address does not answer', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { body: JSON.stringify({ ok: true }) });
    const dialled = dialByHost({ 'relay.ferretry.test': auto.dial });
    const client = await clientFor(dialled.dial, id.daemonId);
    should(await client.request('/v1/shared/me', Answer)).eql({ ok: true });
    should(dialled.dialled).have.length(2);
  });

  it('should say nothing reached the publisher, and how many ways it tried', async () => {
    const id = await newDaemonIdentity();
    const dialled = dialByHost({});
    const client = await clientFor(dialled.dial, id.daemonId);
    const reason = await reasonOf(client.request('/v1/shared/me', Answer));
    should(reason).be.instanceof(MemberUnreachableError);
    should((reason as MemberUnreachableError).tried).equal(2);
  });

  it('should open a new session after a lease ended, for a read, and not replay a write', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, {
      body: JSON.stringify({ ok: true }),
      closeOnRequest: index =>
        index === 0 ? { code: RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE, reason: 'lease ended' } : undefined,
    });
    const client = await clientFor(auto.dial, id.daemonId);
    should(await client.request('/v1/shared/me', Answer)).eql({ ok: true });
    should(auto.sockets).have.length(2);

    const writing = autoDial(id, {
      closeOnRequest: () => ({ code: RELAY_ACCESS_LEASE_ENDED_CLOSE_CODE, reason: 'lease ended' }),
    });
    const other = await clientFor(writing.dial, id.daemonId);
    should(await reasonOf(other.request('/v1/shared/redeem', Answer, { method: 'POST' }))).be.instanceof(
      RelaySessionError,
    );
    should(writing.sockets).have.length(1);
  });

  it('should drop the session and fail when the publisher does not answer in time', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { respond: () => new Promise(() => undefined) });
    const client = await clientFor(auto.dial, id.daemonId, { requestTimeoutMs: 20 });
    should(await reasonOf(client.request('/v1/shared/me', Answer))).not.be.undefined();
    should(auto.sockets[0]?.closed).not.be.undefined();
  });

  it('should accept an answer with no body when the schema expects none', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { respond: () => ({ status: 204, body: '' }) });
    const client = await clientFor(auto.dial, id.daemonId);
    should(await client.request('/v1/shared/me/keys/self', z.undefined(), { method: 'DELETE' })).be.undefined();
  });

  it('should close its session, and refuse to open another, once it is closed', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { body: JSON.stringify({ ok: true }) });
    const client = await clientFor(auto.dial, id.daemonId);
    await client.request('/v1/shared/me', Answer);
    client.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    should(auto.sockets[0]?.closed).not.be.undefined();
    should(await reasonOf(client.request('/v1/shared/me', Answer))).be.instanceof(MemberUnreachableError);
    client.close();
  });

  it('should read a 4403 that ends an open session as the key being refused', async () => {
    const id = await newDaemonIdentity();
    const auto = autoDial(id, { closeOnRequest: () => ({ code: 4403, reason: 'unknown device credential' }) });
    const client = await clientFor(auto.dial, id.daemonId);
    should(await reasonOf(client.request('/v1/shared/me', Answer))).be.instanceof(MemberRefusedError);
  });

  it('should close while a session is still opening and let that attempt fail on its own', async () => {
    const id = await newDaemonIdentity();
    const client = await clientFor(dialByHost({}).dial, id.daemonId);
    const pending = reasonOf(client.request('/v1/shared/me', Answer));
    client.close();
    should(await pending).be.instanceof(MemberUnreachableError);
  });

  it('should close quietly when it never opened a session', async () => {
    const id = await newDaemonIdentity();
    const client = await clientFor(autoDial(id).dial, id.daemonId);
    client.close();
  });
});
