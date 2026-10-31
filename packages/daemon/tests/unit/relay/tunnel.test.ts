/**
 * The tunnel envelope: what a session carries, and what it refuses to carry.
 *
 * The refusals are the interesting half. A request that could smuggle its own `authorization`, or
 * arrive as a loopback peer, or answer with a truncated body, is the difference between a session
 * that is a carrier and one that is a way around the daemon's own authorization boundary.
 */

import { describe, it } from 'bun:test';
import { MAX_TUNNEL_BODY_BYTES } from '@ferretry/protocol';
import { MAX_PLAINTEXT_BYTES, toBase64Url, utf8Bytes } from '@ferretry/relay';
import should from 'should';
import { type ApiResponse, BodyTooLargeError } from '../../../src/lib/api/http.ts';
import {
  decodeTunnelClientMessage,
  encodeTunnelMessage,
  type RelayTunnelDaemonMessage,
  tunnelApiRequest,
  tunnelResponseMessages,
  tunnelStreamRequest,
} from '../../../src/lib/relay/tunnel.ts';

const record = (value: unknown): Uint8Array => utf8Bytes(JSON.stringify(value));
const DEVICE_ID = `fy_device_id_${'a'.repeat(22)}`;
const APP_SESSION = toBase64Url(new Uint8Array(16).fill(1));
const PROOF = toBase64Url(new Uint8Array(64).fill(2));
const DEVICE = { deviceId: DEVICE_ID, appSession: APP_SESSION } as const;

const request = (patch: Record<string, unknown> = {}): unknown => ({
  t: 'req',
  id: 1,
  method: 'GET',
  path: '/v1/sessions',
  ...patch,
});

describe('the session tunnel envelope', () => {
  it('should read a device claim and a request, and refuse everything that is not one', () => {
    // Assert — the claim is an identity, an app session and a proof; there is no token to carry.
    const claim = {
      t: 'auth',
      protocol: 'ferretry-relay/2',
      deviceId: DEVICE_ID,
      appSession: APP_SESSION,
      proof: PROOF,
    };
    should(decodeTunnelClientMessage(record(claim))).containDeep({ t: 'auth', deviceId: DEVICE_ID });
    should(decodeTunnelClientMessage(record({ ...claim, protocol: 'ferretry-relay/1' }))).be.null();
    should(decodeTunnelClientMessage(record({ ...claim, deviceToken: 'fy_device_x' }))).be.null();
    should(decodeTunnelClientMessage(record({ ...claim, proof: 'short' }))).be.null();
    should(decodeTunnelClientMessage(record(request()))).containDeep({ t: 'req', id: 1, path: '/v1/sessions' });
    should(
      decodeTunnelClientMessage(
        record(request({ query: [['sessionId', 'a']], headers: { 'content-type': 'application/json' }, body: '{}' })),
      ),
    ).containDeep({ query: [['sessionId', 'a']], body: '{}' });
    should(decodeTunnelClientMessage(record(request({ body: 'x', more: true })))).containDeep({ more: true });
    should(decodeTunnelClientMessage(record(request({ more: false })))).be.null();
    should(decodeTunnelClientMessage(record({ t: 'req-more', id: 1, body: 'y' }))).containDeep({ t: 'req-more' });
    should(decodeTunnelClientMessage(record({ t: 'renewed', protocol: 'ferretry-relay/2', proof: PROOF }))).containDeep(
      {
        t: 'renewed',
      },
    );

    // Assert — a request may not carry its own credential.
    should(decodeTunnelClientMessage(record(request({ headers: { authorization: 'Bearer host-token' } })))).be.null();
    // Assert — nothing normalises a path, so nothing may hide a query, a fragment or a scheme in one.
    should(decodeTunnelClientMessage(record(request({ path: 'v1/sessions' })))).be.null();
    should(decodeTunnelClientMessage(record(request({ path: '//evil.example/v1' })))).be.null();
    should(decodeTunnelClientMessage(record(request({ path: '/v1/sessions?token=x' })))).be.null();
    should(decodeTunnelClientMessage(record(request({ path: '/v1/sessions#top' })))).be.null();
    // Assert — a header value carrying CRLF is a splitting attempt and this is the last boundary
    // that can still say no.
    should(decodeTunnelClientMessage(record(request({ headers: { 'x-a': 'one\r\nx-b: two' } })))).be.null();
    should(decodeTunnelClientMessage(record(request({ headers: { 'X-Mixed-Case': 'one' } })))).be.null();
    should(decodeTunnelClientMessage(record(request({ method: 'get' })))).be.null();
    should(decodeTunnelClientMessage(record(request({ id: 0 })))).be.null();
    should(decodeTunnelClientMessage(record(request({ extra: true })))).be.null();
    should(decodeTunnelClientMessage(record({ t: 'res', id: 1, status: 200, headers: {}, body: '' }))).be.null();
    // Assert — bad JSON and bad UTF-8 are refusals, not empty messages.
    should(decodeTunnelClientMessage(utf8Bytes('{'))).be.null();
    should(decodeTunnelClientMessage(new Uint8Array([0xff, 0xfe, 0xfd]))).be.null();
  });

  it('should build a daemon request that carries the proven device, no header credential, and is never loopback', async () => {
    // Act
    const built = tunnelApiRequest(
      {
        method: 'POST',
        path: '/v1/sessions',
        query: [
          ['sessionId', 'a'],
          ['sessionId', 'b'],
        ],
        headers: { 'content-type': 'application/json' },
        body: '{"name":"x"}',
      },
      DEVICE,
      'rendezvous-session-1',
    );

    // Assert
    should(built.method).equal('POST');
    should(built.path).equal('/v1/sessions');
    should(built.device).deepEqual(DEVICE);
    should(built.headers.has('authorization')).be.false();
    should(built.headers.get('content-type')).equal('application/json');
    should(built.query.get('sessionId')).deepEqual(['a', 'b']);
    should(built.loopback).be.false();
    should(built.privilegedLoopback).be.false();
    should(built.clientAddress).equal('relay-session:rendezvous-session-1');
    should(await built.text()).equal('{"name":"x"}');
    // Assert — a request with no body reads as an empty one rather than throwing on demand.
    should(await tunnelApiRequest({ method: 'GET', path: '/v1/health' }, DEVICE, 's1').text()).equal('');
  });

  it('should carry the session’s transcript hash on the request when it is given one, and none otherwise', () => {
    const transcript = new Uint8Array(32).fill(7);

    const carried = tunnelApiRequest({ method: 'GET', path: '/v1/health' }, DEVICE, 's1', undefined, transcript);
    const bare = tunnelApiRequest({ method: 'GET', path: '/v1/health' }, DEVICE, 's1');

    should(carried.transcriptHash).deepEqual(transcript);
    should(carried.device).deepEqual(DEVICE);
    should('transcriptHash' in bare).be.false();
  });

  it('should keep a transcript hash beside an arrival stamp, since a relayed hop supplies both', () => {
    const transcript = new Uint8Array(32).fill(9);
    const arrival = { loopback: false, privilegedLoopback: false, clientAddress: '203.0.113.5' };

    const built = tunnelApiRequest({ method: 'GET', path: '/v1/health' }, DEVICE, 's1', arrival, transcript);

    should(built.transcriptHash).deepEqual(transcript);
    should(built.clientAddress).equal('203.0.113.5');
  });

  it('should refuse to hand a route more of a tunnelled body than the route said it would read', async () => {
    // A route bounds its own body; a tunnelled body is already in memory, but answering the bound the same
    // way a socket body does keeps a route from parsing more than it ever accepts over HTTP.
    const built = tunnelApiRequest({ method: 'POST', path: '/v1/sessions', body: '{"name":"é"}' }, DEVICE, 's1');

    should(await built.text(13)).equal('{"name":"é"}');
    await should(built.text(12)).be.rejectedWith(BodyTooLargeError);
  });

  it('should stamp a direct session with where its socket arrived, and a stream with its claim', () => {
    const arrival = { loopback: true, privilegedLoopback: true, clientAddress: '127.0.0.1' };
    const direct = tunnelApiRequest({ method: 'GET', path: '/v1/health' }, DEVICE, 's1', arrival);
    should(direct).containDeep({ loopback: true, privilegedLoopback: true, clientAddress: '127.0.0.1' });
    const stream = tunnelStreamRequest(
      {
        t: 'stream',
        protocol: 'ferretry-relay/2',
        deviceId: DEVICE_ID,
        appSession: APP_SESSION,
        proof: PROOF,
        path: '/v1/events',
      },
      's2',
      { loopback: false, privilegedLoopback: false },
    );
    should(stream).containDeep({ method: 'GET', path: '/v1/events', device: DEVICE, loopback: false });
    should(stream.clientAddress).equal('relay-session:s2');
  });

  describe('answers', () => {
    const response = (body: string, status = 200): ApiResponse => ({
      status,
      headers: new Map([['content-type', 'application/json']]),
      body,
    });
    const reassemble = (messages: readonly RelayTunnelDaemonMessage[]): string =>
      messages.map(message => ('body' in message ? message.body : '')).join('');

    it('should answer in one record when the answer fits one', () => {
      should(tunnelResponseMessages(3, response('{"ok":true}'))).deepEqual([
        { t: 'res', id: 3, status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
      ]);
    });

    it('should send what the answer last spells, not the body it was built with', () => {
      const answer: ApiResponse = { ...response('{"shown":"first"}'), late: () => response('{"shown":"last"}') };

      should(tunnelResponseMessages(6, answer)).deepEqual([
        { t: 'res', id: 6, status: 200, headers: { 'content-type': 'application/json' }, body: '{"shown":"last"}' },
      ]);
    });

    it('should split an answer too large for one record into ordered parts that each fit, never truncating', () => {
      // Escapes and multi-byte characters cost more than one byte each on the wire, so the parts are
      // cut by their encoded size — and a surrogate pair is never cut in two.
      const body = `${'x'.repeat(MAX_PLAINTEXT_BYTES)}"\\\n\u0001é😀${'y'.repeat(70_000)}`;
      const messages = tunnelResponseMessages(4, response(body));

      should(messages.length).be.greaterThan(2);
      should(messages[0]).containDeep({ t: 'res', id: 4, status: 200, more: true });
      for (const message of messages.slice(1, -1)) should(message).containDeep({ t: 'res-more', id: 4, more: true });
      should(messages.at(-1)).not.have.property('more');
      for (const message of messages)
        should(encodeTunnelMessage(message).byteLength).not.be.greaterThan(MAX_PLAINTEXT_BYTES);
      should(reassemble(messages)).equal(body);
    });

    it('should refuse, with the size named, an answer larger than one session carries', () => {
      const messages = tunnelResponseMessages(5, response('z'.repeat(MAX_TUNNEL_BODY_BYTES + 1)));
      should(messages).have.length(1);
      should(messages[0]).containDeep({ t: 'res', id: 5, status: 502 });
      should(JSON.stringify(messages[0])).match(/answer_too_large/u);
    });
  });
});
