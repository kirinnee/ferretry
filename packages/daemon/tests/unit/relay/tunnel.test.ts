/**
 * The tunnel envelope: what a relay session carries, and what it refuses to carry.
 *
 * The refusals are the interesting half. A request that could smuggle its own `authorization`, or
 * arrive as a loopback peer, or answer with a truncated body, is the difference between a relay that
 * is a carrier and a relay that is a way around the daemon's own authorization boundary.
 */

import { describe, it } from 'bun:test';
import { MAX_PLAINTEXT_BYTES, utf8Bytes } from '@ferretry/relay';
import should from 'should';
import type { ApiResponse } from '../../../src/lib/api/http.ts';
import {
  decodeTunnelClientMessage,
  encodeTunnelMessage,
  tunnelApiRequest,
  tunnelResponseMessage,
} from '../../../src/lib/relay/tunnel.ts';

const record = (value: unknown): Uint8Array => utf8Bytes(JSON.stringify(value));

const request = (patch: Record<string, unknown> = {}): unknown => ({
  t: 'req',
  id: 1,
  method: 'GET',
  path: '/v1/sessions',
  ...patch,
});

describe('the relay tunnel envelope', () => {
  it('should read an authentication record and a request, and refuse everything that is not one', () => {
    // Assert — the two shapes that exist.
    should(
      decodeTunnelClientMessage(record({ t: 'auth', protocol: 'ferretry-relay/1', deviceToken: 'fy_device_x' })),
    ).containDeep({ t: 'auth', deviceToken: 'fy_device_x' });
    should(decodeTunnelClientMessage(record(request()))).containDeep({ t: 'req', id: 1, path: '/v1/sessions' });
    should(
      decodeTunnelClientMessage(
        record(request({ query: [['sessionId', 'a']], headers: { 'content-type': 'application/json' }, body: '{}' })),
      ),
    ).containDeep({ query: [['sessionId', 'a']], body: '{}' });

    // Assert — a relayed request may not carry its own credential.
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

  it('should build a daemon request that carries the session credential and is never loopback', async () => {
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
      'fy_device_token',
      'rendezvous-session-1',
    );

    // Assert
    should(built.method).equal('POST');
    should(built.path).equal('/v1/sessions');
    should(built.headers.get('authorization')).equal('Bearer fy_device_token');
    should(built.headers.get('content-type')).equal('application/json');
    should(built.query.get('sessionId')).deepEqual(['a', 'b']);
    should(built.loopback).be.false();
    should(await built.text()).equal('{"name":"x"}');
    // Assert — a request with no body reads as an empty one rather than throwing on demand.
    should(await tunnelApiRequest({ method: 'GET', path: '/v1/health' }, 'fy_device', 's1').text()).equal('');
  });

  it('should answer with the response, or name the size that did not fit rather than truncating it', () => {
    // Arrange
    const response = (body: string): ApiResponse => ({
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      body,
    });

    // Act + Assert
    should(tunnelResponseMessage(3, response('{"ok":true}'))).deepEqual({
      t: 'res',
      id: 3,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    const oversize = tunnelResponseMessage(4, response('x'.repeat(MAX_PLAINTEXT_BYTES)));
    should(oversize).containDeep({ t: 'oversize', id: 4, status: 200 });
    if (oversize.t !== 'oversize') throw new Error('expected an oversize refusal');
    should(oversize.byteLength).be.greaterThan(MAX_PLAINTEXT_BYTES);
    // Assert — the refusal itself always fits, which is the point of not sending the body.
    should(encodeTunnelMessage(oversize).byteLength).be.lessThan(MAX_PLAINTEXT_BYTES);
  });
});
