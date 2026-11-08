/**
 * Relay-protocol rows the KERNEL's session layer owns, one test per row id (the guarantees check credits a row
 * only when a test NAME STARTS with its id). Every test drives the real layer over real WebCrypto through the
 * harness, or the real wire function the row names; none loosens what the layer asks.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { type ApiResponse, jsonResponse } from '../../../contract/http.ts';
import type { CarrierKey } from '../../../contract/ids.ts';
import type { SocketDownstream, SocketHandler } from '../../../contract/socket.ts';
import {
  CREDIT_WINDOW_FRAMES,
  creditToReturn,
  daemonIdFromPublicKey,
  decodeFrame,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FRAME_KINDS,
  grantCredit,
  MAX_CONCURRENT_REQUESTS,
  MAX_DATA_BYTES,
  MAX_PLAINTEXT_BYTES,
  MAX_TUNNEL_BODY_BYTES,
  newReceiveWindow,
  newSendWindow,
  parseDaemonId,
  publicKeyMatchesDaemonId,
  RELAY_SESSION_CONCLUDED_CLOSE_CODE,
  RELAY_SESSION_CONCLUDED_CLOSE_REASON,
  recordConsumed,
  relayDataByteBudget,
  SESSION_CLOSE_CODES,
  SESSION_PROTOCOL_ID,
  sealRecord,
  startClientHandshake,
  toBase64Url,
  utf8Bytes,
} from '../../../host/session/index.ts';
import { fixture, pairedDevice, serving, settle, TestClient } from './harness.ts';
import { newDaemonIdentity, relayCrypto } from './identities.ts';

const CARRIERS = ['relay', 'direct', 'tunnel', 'webrtc'] as const;

const req = (id: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  t: 'req',
  id,
  method: 'GET',
  path: '/v1/health',
  ...extra,
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

interface FakeHandler extends SocketHandler {
  closed: boolean;
  received: unknown[];
  downstream?: SocketDownstream;
}

function streamFixture(fx: Fixture, refuse?: ApiResponse): { handler: FakeHandler } {
  const handler: FakeHandler = {
    closed: false,
    received: [],
    open: async () => {},
    fromClient: frame => {
      handler.received.push(frame);
    },
    close: () => {
      handler.closed = true;
    },
  };
  fx.sockets = {
    upgrade: async request => {
      fx.streams.push(request);
      if (refuse !== undefined) return { outcome: 'refused', response: refuse };
      return {
        outcome: 'accepted',
        attach: async downstream => {
          handler.downstream = downstream;
          return handler;
        },
      };
    },
    reauthorize: () => true,
  };
  return { handler };
}

async function streaming(fx: Fixture, path = '/v1/events', carrier = 'relay'): Promise<TestClient> {
  const device = await pairedDevice(fx.device);
  const client = TestClient.open(fx, carrier);
  await client.handshake(fx.daemonId);
  await client.auth(device, { path }, 'stream');
  return client;
}

/** Seals `record` as the client's next frame and returns its bytes WITHOUT delivering them. */
async function sealed(client: TestClient, record: unknown): Promise<Uint8Array> {
  const channel = client.channel;
  if (channel === undefined) throw new Error('not keyed');
  const result = await sealRecord(relayCrypto, channel, utf8Bytes(JSON.stringify(record)));
  if (!result.ok) throw new Error(result.reason);
  client.channel = result.state;
  return encodeFrame(result.frame);
}

const kinds = (client: TestClient): unknown[] => client.records.map(record => record['t']);

describe('R21 R629 one sealed session on every carrier', () => {
  async function transcriptOn(fx: Fixture, carrier: string) {
    const { client } = await serving(fx, carrier);
    await client.send(req(1, { path: '/v1/secret-looking-path' }));
    await client.pump();
    return client;
  }

  test('R21 direct and relay run the identical session: the same records in the same order, and the LAN is encrypted too', async () => {
    const fx = await fixture();
    const direct = await transcriptOn(fx, 'direct');
    const relay = await transcriptOn(fx, 'relay');
    expect(kinds(direct)).toEqual(kinds(relay));
    expect(direct.sequences).toEqual(relay.sequences);
    expect(direct.wire.map(bytes => bytes.length)).toEqual(relay.wire.map(bytes => bytes.length));
    for (const client of [direct, relay]) {
      const joined = client.wire.map(bytes => new TextDecoder().decode(bytes)).join('');
      expect(joined.includes('secret-looking-path')).toBe(false);
      expect(joined.includes('"status"')).toBe(false);
      expect(client.last('res')?.['status']).toBe(200);
    }
  });

  test('R629 every carrier runs the handshake and the sealed records, which no operator can read, alter or insert into', async () => {
    const fx = await fixture();
    for (const carrier of CARRIERS) {
      const client = await transcriptOn(fx, carrier);
      expect(client.handshakeSequence).toBe(0);
      expect(client.wire.map(bytes => new TextDecoder().decode(bytes)).join('')).not.toContain('secret-looking-path');
      // ALTER: one flipped ciphertext byte fails authentication and ends the session; nothing is dispatched for it.
      const before = fx.requests.length;
      const altered = await sealed(client, req(2));
      altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 0x01;
      client.raw(altered);
      await client.pump();
      expect(client.end?.code).toBe(SESSION_CLOSE_CODES.frameForged);
      expect(fx.requests).toHaveLength(before);
    }
    // INSERT: a frame an operator made up, in the right session at the next sequence, is forged.
    const { client } = await serving(fx, 'relay');
    const next = decodeFrame(await sealed(client, req(3)));
    if (!next.ok) throw new Error(next.reason);
    client.raw(encodeFrame({ ...next.frame, payload: relayCrypto.randomBytes(next.frame.payload.length) }));
    await client.pump();
    expect(client.end?.code).toBe(SESSION_CLOSE_CODES.frameForged);
  });
});

describe('frames, handshake and flow', () => {
  test('R27 a frame too short, too long, not starting FE 01, of unknown kind or with a reserved byte set is refused and closes the connection', async () => {
    const fx = await fixture();
    const header = (patch: (bytes: Uint8Array) => void, length = FRAME_HEADER_BYTES): Uint8Array => {
      const bytes = new Uint8Array(length);
      bytes[0] = 0xfe;
      bytes[1] = 0x01;
      bytes[2] = FRAME_KINDS.credit;
      patch(bytes);
      return bytes;
    };
    const cases: [string, Uint8Array, number][] = [
      ['too short', new Uint8Array([0xfe, 0x01, FRAME_KINDS.credit]), 4400],
      ['too long', new Uint8Array(65_537).fill(0xfe), 4413],
      [
        'wrong magic',
        header(bytes => {
          bytes[0] = 0x00;
        }),
        4400,
      ],
      [
        'wrong version',
        header(bytes => {
          bytes[1] = 0x02;
        }),
        4426,
      ],
      [
        'unknown kind',
        header(bytes => {
          bytes[2] = 0x7f;
        }),
        4400,
      ],
      [
        'reserved byte set',
        header(bytes => {
          bytes[3] = 0x01;
        }),
        4400,
      ],
    ];
    for (const [name, bytes, code] of cases) {
      const client = TestClient.open(fx);
      client.raw(bytes);
      await client.pump();
      expect(client.end?.code, name).toBe(code);
      // The refusal is the frame decoder's own, named: not some later check that happens to close the session.
      const refusal = decodeFrame(bytes);
      expect(refusal.ok, name).toBe(false);
      if (!refusal.ok) {
        expect(Number(refusal.code), name).toBe(code);
        expect(client.end?.reason, name).toBe(refusal.reason);
      }
    }
    // Control: the same header, well formed, is accepted by the frame decoder, and the session is not ended
    // with ANY of the decoder's refusal reasons (a decoder that refused every frame 4400 would fail here).
    const wellFormed = header(() => {});
    expect(decodeFrame(wellFormed).ok).toBe(true);
    const refusalReasons = new Set<string>();
    for (const [, bytes] of cases) {
      const refusal = decodeFrame(bytes);
      if (!refusal.ok) refusalReasons.add(refusal.reason);
    }
    expect(refusalReasons.size).toBeGreaterThan(0);
    const fine = TestClient.open(fx);
    fine.raw(wellFormed);
    await fine.pump();
    expect(fine.end?.code).not.toBe(4413);
    expect(refusalReasons.has(fine.end?.reason ?? '')).toBe(false);
  });

  test('R65 the handshake is exactly two frames, one each way, both at sequence 0', async () => {
    const fx = await fixture();
    const client = TestClient.open(fx);
    await client.handshake(fx.daemonId);
    expect(client.wire).toHaveLength(1);
    expect(client.handshakeSequence).toBe(0);
    const answer = decodeFrame(client.wire[0] as Uint8Array);
    expect(answer.ok && answer.frame.kind).toBe(FRAME_KINDS.handshake);
    // A third handshake frame is out of turn; so is one that is not at sequence 0.
    const again = TestClient.open(fx);
    await again.handshake(fx.daemonId);
    const second = await startClientHandshake(relayCrypto, again.sessionId, fx.daemonId);
    again.raw(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId: again.sessionId,
        sequence: 0,
        payload: utf8Bytes(JSON.stringify(second.hello)),
      }),
    );
    await again.pump();
    expect(again.end?.code).toBe(SESSION_CLOSE_CODES.protocolError);
    const wrongSequence = TestClient.open(fx);
    const pending = await startClientHandshake(relayCrypto, wrongSequence.sessionId, fx.daemonId);
    wrongSequence.raw(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId: wrongSequence.sessionId,
        sequence: 1,
        payload: utf8Bytes(JSON.stringify(pending.hello)),
      }),
    );
    await wrongSequence.pump();
    expect(wrongSequence.end?.code).toBe(SESSION_CLOSE_CODES.protocolError);
    expect(wrongSequence.wire).toHaveLength(0);
  });

  test('R95 a receiver returns credit once it owes at least half a window, and a grant is clamped to one window', async () => {
    const half = CREDIT_WINDOW_FRAMES / 2;
    let owed = newReceiveWindow();
    for (let frame = 1; frame < half; frame += 1) {
      owed = recordConsumed(owed);
      expect(creditToReturn(owed)).toBe(0);
    }
    owed = recordConsumed(owed);
    expect(creditToReturn(owed)).toBe(half);
    // CLAMP, on the wire function and on a live session: a huge grant never lifts the allowance past one window.
    const window = grantCredit(newSendWindow(), 1_000_000);
    expect(window.allowed).toBe(CREDIT_WINDOW_FRAMES);
    const fx = await fixture();
    const { client } = await serving(fx);
    client.credit(1_000_000);
    for (let id = 1; id <= CREDIT_WINDOW_FRAMES + 8; id += 1) {
      await client.send(req(id));
      if (id % 8 === 0) await client.pump();
    }
    await client.pump();
    expect(client.end).toBeUndefined();
    expect(client.records.filter(record => record['t'] === 'res').length).toBeLessThanOrEqual(CREDIT_WINDOW_FRAMES);
    expect(client.records.filter(record => record['t'] === 'res').length).toBeGreaterThan(0);
    // The live session returns credit in half-window batches.
    const second = await serving(fx);
    for (let id = 1; id <= half; id += 1) await second.client.send(req(id));
    await second.client.pump();
    expect(second.client.creditReceived).toBe(half);
  });

  test('R536 a request waiting past the concurrency bound keeps its record credit until it starts; more waiting than a window carries ends the session 4430', async () => {
    const fx = await fixture();
    fx.dispatch = () => new Promise<ApiResponse>(() => {});
    const { client } = await serving(fx);
    for (let id = 1; id <= MAX_CONCURRENT_REQUESTS; id += 1) await client.send(req(id));
    await client.pump();
    expect(fx.requests).toHaveLength(0);
    const running = client.creditReceived;
    expect(running).toBeGreaterThan(0);
    // These wait behind the sixteen running ones: no credit comes back for them.
    for (let id = MAX_CONCURRENT_REQUESTS + 1; id <= MAX_CONCURRENT_REQUESTS + 10; id += 1) await client.send(req(id));
    await client.pump();
    expect(client.creditReceived).toBe(running);
    expect(client.end).toBeUndefined();
    // More waiting requests than one window carries: the peer is past its allowance.
    for (
      let id = MAX_CONCURRENT_REQUESTS + 11;
      id <= MAX_CONCURRENT_REQUESTS + 11 + 3 * CREDIT_WINDOW_FRAMES;
      id += 1
    ) {
      await client.send(req(id));
      if (client.end !== undefined) break;
      if (id % 8 === 0) await settle(3);
    }
    await client.pump();
    expect(client.end?.code).toBe(SESSION_CLOSE_CODES.flowViolation);
    expect(client.end?.code).toBe(4430);
  });
});

describe('one session, one job', () => {
  test('R230 any other message at sequence 1, a second credential, or a message the mode does not list ends the session 4400', async () => {
    const fx = await fixture();
    const first = TestClient.open(fx);
    await first.handshake(fx.daemonId);
    await first.send(req(1));
    await first.pump();
    expect(first.end?.code).toBe(4400);
    const second = await serving(fx);
    await second.client.auth(second.device);
    expect(second.client.end?.code).toBe(4400);
    // The mode is enforced by the union: a stream session lists no `req`, a request session no `data`.
    streamFixture(fx);
    const stream = await streaming(fx);
    await stream.send(req(1));
    await stream.pump();
    expect(stream.end?.code).toBe(4400);
    const requests = await serving(fx);
    await requests.client.send({ t: 'data', text: 'hello' });
    await requests.client.pump();
    expect(requests.client.end?.code).toBe(4400);
    expect(fx.requests).toHaveLength(0);
  });

  test('R624 a second credential is refused by schema on every session', async () => {
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    // A request session: a second `auth`, a `stream` credential and a `pair` credential.
    for (const second of ['auth', 'stream', 'pair'] as const) {
      const { client, device } = await serving(fx);
      if (second === 'pair')
        await client.send({
          t: 'pair',
          protocol: SESSION_PROTOCOL_ID,
          code: 'ABCD-1234',
          deviceName: 'phone',
          deviceKey: 'k',
          proof: 'p',
        });
      else await client.auth(device, second === 'stream' ? { path: '/v1/events' } : {}, second);
      await client.pump();
      expect(client.end?.code).toBe(4400);
    }
    // A stream session: a second `stream` credential.
    const client = await streaming(fx);
    expect(handler.downstream).toBeDefined();
    const device = await pairedDevice(fx.device, 'B');
    await client.auth(device, { path: '/v1/events' }, 'stream');
    expect(client.end?.code).toBe(4400);
    expect(fx.streams).toHaveLength(1);
    expect(fx.requests).toHaveLength(0);
  });
});

describe('requests', () => {
  test('R534 answers carry an id; sequence numbers order the wire, not the work', async () => {
    const fx = await fixture();
    const gates = new Map<string, () => void>();
    fx.dispatch = request =>
      new Promise(resolve => {
        gates.set(request.path, () => resolve(jsonResponse({ path: request.path })));
      });
    const { client } = await serving(fx);
    await client.send(req(1, { path: '/slow' }));
    await client.send(req(2, { path: '/fast' }));
    await client.pump();
    gates.get('/fast')?.();
    await client.pump();
    gates.get('/slow')?.();
    await client.pump();
    const answers = client.records.filter(record => record['t'] === 'res');
    expect(answers.map(record => record['id'])).toEqual([2, 1]);
    for (const answer of answers) expect(typeof answer['id']).toBe('number');
    const records = client.sequences.filter(sequence => sequence !== 0);
    expect(records).toEqual([...records].sort((a, b) => a - b));
    expect(new Set(records).size).toBe(records.length);
  });

  test('R260 query is a list of pairs, so repeated keys survive in order, and a non-list query ends the session', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    await client.send(
      req(1, {
        query: [
          ['a', '1'],
          ['b', 'x'],
          ['a', '2'],
        ],
      }),
    );
    await client.pump();
    const request = fx.requests[0];
    expect(request?.query.get('a')).toEqual(['1', '2']);
    expect(request?.query.get('b')).toEqual(['x']);
    const object = await serving(fx);
    await object.client.send(req(1, { query: { a: '1' } }));
    await object.client.pump();
    expect(object.client.end?.code).toBe(4400);
    expect(fx.requests).toHaveLength(1);
  });

  test('R527 parts of one body are consecutive in sequence order; a part with no open body, or a second start for an open one, is 4400', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    await client.send(req(1, { method: 'POST', body: 'ab', more: true }));
    await client.send({ t: 'req-more', id: 1, body: 'cd', more: true });
    await client.send({ t: 'req-more', id: 1, body: 'ef' });
    await client.pump();
    expect(await fx.requests[0]?.text()).toBe('abcdef');
    expect(client.end).toBeUndefined();
    // The daemon's own answer parts are one run, in order, `more` only until the last.
    fx.dispatch = async () => jsonResponse({ big: 'é'.repeat(80_000) });
    await client.send(req(2));
    await client.pump();
    const at = client.records.findIndex(record => record['t'] === 'res' && record['id'] === 2);
    const parts = client.records.slice(at).filter(record => record['t'] === 'res-more');
    expect(parts.length).toBeGreaterThan(0);
    expect(client.records.slice(at + 1, at + 1 + parts.length).every(record => record['t'] === 'res-more')).toBe(true);
    expect(parts.slice(0, -1).every(part => part['more'] === true)).toBe(true);
    expect(parts.at(-1)?.['more']).toBeUndefined();
    // No open body: a part for an id nobody started.
    const orphan = await serving(fx);
    await orphan.client.send({ t: 'req-more', id: 7, body: 'x' });
    await orphan.client.pump();
    expect(orphan.client.end?.code).toBe(4400);
    // A second start for an open body.
    const twice = await serving(fx);
    await twice.client.send(req(1, { method: 'POST', body: 'a', more: true }));
    await twice.client.send(req(1, { method: 'POST', body: 'b' }));
    await twice.client.pump();
    expect(twice.client.end?.code).toBe(4400);
  });

  test('R510 the 32 MiB bound applies to the body as it travels, which is the base64url text', async () => {
    const fx = await fixture();
    // A small plain body whose gzip bytes, as base64url TEXT, pass 32 MiB: refused, though the plain body is tiny.
    const traveling = new Uint8Array(25 * 1024 * 1024);
    for (let offset = 0; offset < traveling.length; offset += 65_536)
      traveling.set(relayCrypto.randomBytes(Math.min(65_536, traveling.length - offset)), offset);
    expect(Math.ceil((traveling.length * 4) / 3)).toBeGreaterThan(MAX_TUNNEL_BODY_BYTES);
    expect(traveling.length).toBeLessThan(MAX_TUNNEL_BODY_BYTES);
    fx.dispatch = async () => ({
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      body: '{"a":1}',
      gzip: traveling,
    });
    const { client } = await serving(fx);
    await client.send(req(1));
    await client.pump();
    const refused = client.last('res');
    expect(refused?.['status']).toBe(502);
    expect(String(refused?.['body'])).toContain('answer_too_large');
    // The same bound on the PLAIN body, as it travels: just over 32 MiB is refused.
    fx.dispatch = async () => ({ status: 200, headers: new Map(), body: 'x'.repeat(MAX_TUNNEL_BODY_BYTES + 1) });
    await client.send(req(2));
    await client.pump();
    expect(client.records.filter(record => record['t'] === 'res' && record['id'] === 2)[0]?.['status']).toBe(502);
  });

  test('R510 a request body streamed in parts whose base64url text passes 32 MiB is answered 413 and never dispatched', async () => {
    const fx = await fixture();
    let dispatched = 0;
    fx.dispatch = async () => {
      dispatched += 1;
      return jsonResponse({ ok: true });
    };
    const { client } = await serving(fx);
    // Valid base64url text. Decoded, it is three quarters of its length: under the bound, while the text is over.
    const part = 'A'.repeat(60_000);
    const parts = Math.ceil(MAX_TUNNEL_BODY_BYTES / part.length) + 1;
    expect(part.length * parts).toBeGreaterThan(MAX_TUNNEL_BODY_BYTES);
    expect(Math.floor((part.length * parts * 3) / 4)).toBeLessThan(MAX_TUNNEL_BODY_BYTES);
    await client.send(req(1, { method: 'POST', body: part, more: true }));
    // The peer honours the daemon's credit window: send half a window, then collect the credit it returns.
    let inFlight = 1;
    for (let index = 1; index < parts; index += 1) {
      const last = index === parts - 1;
      await client.send({ t: 'req-more', id: 1, body: part, ...(last ? {} : { more: true }) });
      inFlight += 1;
      if (inFlight >= CREDIT_WINDOW_FRAMES / 2 && !last) {
        await client.pump();
        inFlight = 0;
      }
    }
    await client.pump();
    // Refused by the bound itself: the session lives, the answer is 413, and dispatch never saw the request.
    expect(client.end).toBeUndefined();
    const refused = client.records.filter(record => record['t'] === 'res' && record['id'] === 1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.['status']).toBe(413);
    expect(String(refused[0]?.['body'])).toContain('request_too_large');
    expect(dispatched).toBe(0);
    expect(fx.requests).toHaveLength(0);
    // A body just under the bound is not refused: the bound is the only thing that refused the one above.
    await client.send(req(2, { method: 'POST', body: part }));
    await client.pump();
    expect(dispatched).toBe(1);
    // A first part alone cannot be over the bound on the wire (a record carries at most MAX_PLAINTEXT_BYTES), so
    // the start-of-body check is only reachable through the parts above.
    expect(part.length).toBeLessThan(MAX_TUNNEL_BODY_BYTES);
  });
});

describe('streams', () => {
  test('R537 a stream session carries exactly one protocol-switching surface: a second stream is refused and only one upgrade is asked', async () => {
    const fx = await fixture();
    streamFixture(fx);
    for (const path of ['/v1/events', '/v1/terminals/x/stream', '/v1/browsers/x/stream']) {
      const before = fx.streams.length;
      const client = await streaming(fx, path);
      expect(client.last('stream-opened')).toBeDefined();
      expect(fx.streams[before]?.path).toBe(path);
      const device = await pairedDevice(fx.device, 'C');
      await client.auth(device, { path: '/v1/events' }, 'stream');
      expect(client.end?.code).toBe(4400);
      expect(fx.streams).toHaveLength(before + 1);
    }
  });

  test('R539 streams dispatch against the daemon socket table with the stamped principal and a carried arrival; a stream refused on one carrier is refused on all', async () => {
    const fx = await fixture();
    streamFixture(fx, jsonResponse({ error: 'no' }, 403));
    for (const carrier of CARRIERS) {
      const client = await streaming(fx, '/v1/terminals/x/stream', carrier);
      expect(client.last('stream-refused')).toMatchObject({ status: 403, body: '{"error":"no"}' });
      expect(client.last('stream-opened')).toBeUndefined();
    }
    expect(fx.streams).toHaveLength(CARRIERS.length);
    for (const [index, request] of fx.streams.entries()) {
      expect(request.arrival.kind).toBe('carried');
      expect(request.arrival.kind === 'carried' ? String(request.arrival.carrier) : '').toBe(CARRIERS[index] as string);
      expect(request.principal?.kind).toBe('device');
      expect(request.method).toBe('GET');
    }
  });

  test('R542 the daemon answers exactly one of stream-opened or stream-refused; a refusal carries the direct status and body and is followed by 4440', async () => {
    const opened = await fixture();
    streamFixture(opened);
    const accepted = await streaming(opened);
    expect(
      accepted.records.filter(record => ['stream-opened', 'stream-refused'].includes(String(record['t']))),
    ).toHaveLength(1);
    expect(accepted.last('stream-opened')).toBeDefined();
    expect(accepted.end).toBeUndefined();
    const refusing = await fixture();
    streamFixture(refusing, jsonResponse({ error: 'no' }, 403));
    const refused = await streaming(refusing);
    expect(
      refused.records.filter(record => ['stream-opened', 'stream-refused'].includes(String(record['t']))),
    ).toHaveLength(1);
    expect(refused.last('stream-refused')).toMatchObject({ status: 403, body: '{"error":"no"}' });
    expect(refused.end).toEqual({ code: 4440, reason: 'the session concluded' });
    // A path no stream route claims is refused the same way, never left unanswered.
    const unclaimed = await fixture();
    const nobody = await streaming(unclaimed, '/v1/nothing-here');
    expect(
      nobody.records.filter(record => ['stream-opened', 'stream-refused'].includes(String(record['t']))),
    ).toHaveLength(1);
    expect(nobody.last('stream-opened')).toBeUndefined();
    expect(nobody.end?.code).toBe(4440);
  });

  test('R544 a text record is one complete text frame; a bytes record is a run of an ordered byte stream, delivered on arrival with no reassembly', async () => {
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    const client = await streaming(fx);
    await client.send({ t: 'data', bytes: toBase64Url(utf8Bytes('ab')) });
    await client.send({ t: 'data', text: 'a whole frame' });
    await client.send({ t: 'data', bytes: toBase64Url(utf8Bytes('cd')) });
    await client.pump();
    // Each record is delivered as it arrived: runs are never joined, a text frame never split.
    expect(handler.received).toEqual([utf8Bytes('ab'), 'a whole frame', utf8Bytes('cd')]);
    // The daemon's own frames keep their kind and order.
    handler.downstream?.send(utf8Bytes('xy'));
    handler.downstream?.send('event');
    handler.downstream?.send(utf8Bytes('z'));
    await client.pump();
    const data = client.records.filter(record => record['t'] === 'data');
    expect(data).toEqual([
      { t: 'data', bytes: toBase64Url(utf8Bytes('xy')) },
      { t: 'data', text: 'event' },
      { t: 'data', bytes: toBase64Url(utf8Bytes('z')) },
    ]);
  });

  test('R551 stream flow control is the session credit window with no second layer, and buffered bytes are reported honestly', async () => {
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    const client = await streaming(fx);
    const text = 'x'.repeat(1_000);
    const encoded = JSON.stringify({ t: 'data', text }).length;
    const total = 3 * CREDIT_WINDOW_FRAMES;
    for (let index = 0; index < total; index += 1) expect(handler.downstream?.send(text)).toBe(text.length);
    await client.pump();
    const delivered = client.records.filter(record => record['t'] === 'data').length;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(total);
    // Honest: exactly the plaintext bytes of what the credit window is still holding back.
    expect(handler.downstream?.bufferedBytes()).toBe((total - delivered) * encoded);
    client.credit(CREDIT_WINDOW_FRAMES);
    await client.pump();
    const more = client.records.filter(record => record['t'] === 'data').length;
    expect(more).toBeGreaterThan(delivered);
    expect(handler.downstream?.bufferedBytes()).toBe((total - more) * encoded);
    expect(client.end).toBeUndefined();
  });

  test('R557 a stream ends with a sealed close first and the public close is always 4440 with the shared reason, never the inner code', async () => {
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    const client = await streaming(fx);
    handler.downstream?.close(1011, 'the terminal crashed');
    await client.pump();
    expect(client.last('stream-close')).toMatchObject({ code: 1011, reason: 'the terminal crashed' });
    expect(client.end).toEqual({
      code: RELAY_SESSION_CONCLUDED_CLOSE_CODE,
      reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON,
    });
    expect(client.end?.reason).not.toContain('crashed');
    // The sealed outcome was already handed over when 4440 came: no 4440 without one.
    expect(client.records.at(-1)?.['t']).toBe('stream-close');
    // A refusal and a pairing refusal follow the same order.
    const refusing = await fixture();
    streamFixture(refusing, jsonResponse({ error: 'no' }, 403));
    const refused = await streaming(refusing);
    expect(refused.records.at(-1)?.['t']).toBe('stream-refused');
    expect(refused.end?.code).toBe(4440);
    const pairing = TestClient.open(fx, 'tunnel');
    await pairing.handshake(fx.daemonId);
    await pairing.send({
      t: 'pair',
      protocol: SESSION_PROTOCOL_ID,
      code: 'ABCD-1234',
      deviceName: 'phone',
      deviceKey: 'k',
      proof: 'p',
    });
    await pairing.pump();
    expect(pairing.records.at(-1)?.['t']).toBe('pair-refused');
    expect(pairing.end).toEqual({ code: 4440, reason: 'the session concluded' });
  });

  test('R559 reconnection is a new session, never a resumption: a record of an ended session revives nothing on the same id', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    const replayable = await sealed(client, req(1));
    client.raw(replayable);
    await client.pump();
    expect(fx.requests).toHaveLength(1);
    client.raw(replayable);
    await client.pump();
    expect(client.end?.code).toBe(SESSION_CLOSE_CODES.sequenceBroken);
    // The same session id on a fresh link is not resumed: its old sealed record is out of turn there.
    const resumed = new TestClient(fx.layer.open('relay' as CarrierKey), client.sessionId);
    resumed.raw(replayable);
    await resumed.pump();
    expect(resumed.end?.code).toBe(4400);
    expect(fx.requests).toHaveLength(1);
    // What it CAN do is open a brand-new session, with fresh keys and a fresh transcript.
    const again = new TestClient(fx.layer.open('relay' as CarrierKey), client.sessionId);
    await again.handshake(fx.daemonId);
    expect(again.channel).toBeDefined();
    expect(again.transcript).not.toEqual(client.transcript);
  });
});

describe('identity and the byte budget', () => {
  test('R41 daemonId is fy_daemon_ + base64url(SHA-256(Ed25519 SPKI DER)), 43 chars, over a 44-byte SPKI', async () => {
    const identity = await newDaemonIdentity();
    expect(identity.publicKeySpki.length).toBe(44);
    const digest = toBase64Url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(identity.publicKeySpki))),
    );
    expect(digest).toHaveLength(43);
    expect(identity.daemonId).toBe(`fy_daemon_${digest}`);
    expect(await daemonIdFromPublicKey(relayCrypto, identity.publicKeySpki)).toBe(identity.daemonId);
    expect(await daemonIdFromPublicKey(relayCrypto, identity.publicKeySpki.slice(1))).toBeNull();
    expect(await publicKeyMatchesDaemonId(relayCrypto, identity.publicKeySpki, identity.daemonId)).toBe(true);
    const other = await newDaemonIdentity();
    expect(await publicKeyMatchesDaemonId(relayCrypto, other.publicKeySpki, identity.daemonId)).toBe(false);
    expect(parseDaemonId(`fy_daemon_${digest.slice(1)}`)).toBeNull();
    expect(parseDaemonId(`fy_other_${digest}`)).toBeNull();
  });

  test('R545 the raw byte budget is derived from the 65492-byte plaintext cap, not hard-coded', async () => {
    const envelope = JSON.stringify({ t: 'data', bytes: '' }).length;
    for (const cap of [1_000, 4_096, 65_492, 100_000])
      expect(relayDataByteBudget(cap)).toBe(Math.floor(((cap - envelope) * 3) / 4));
    expect(relayDataByteBudget(envelope)).toBe(0);
    expect(MAX_DATA_BYTES).toBe(relayDataByteBudget(MAX_PLAINTEXT_BYTES));
    // The boundary on the wire: a full budget fits one record, one more group of bytes does not.
    const fits = JSON.stringify({ t: 'data', bytes: toBase64Url(new Uint8Array(MAX_DATA_BYTES)) }).length;
    const over = JSON.stringify({ t: 'data', bytes: toBase64Url(new Uint8Array(MAX_DATA_BYTES + 3)) }).length;
    expect(fits).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES);
    expect(over).toBeGreaterThan(MAX_PLAINTEXT_BYTES);
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    await streaming(fx);
    expect(handler.downstream?.send(new Uint8Array(MAX_DATA_BYTES))).toBe(MAX_DATA_BYTES);
    expect(handler.downstream?.send(new Uint8Array(MAX_DATA_BYTES + 3))).toBe(0);
  });

  test('R628 both ends derive the byte budget from one function: the shared session subpath and the daemon layer export the same one', async () => {
    const shared = (await import('@ferretry/kernel/session')) as unknown as {
      relayDataByteBudget: unknown;
      MAX_DATA_BYTES: number;
      MAX_PLAINTEXT_BYTES: number;
    };
    expect(shared.relayDataByteBudget).toBe(relayDataByteBudget);
    expect(shared.MAX_DATA_BYTES).toBe(MAX_DATA_BYTES);
    expect(shared.MAX_PLAINTEXT_BYTES).toBe(MAX_PLAINTEXT_BYTES);
    // The daemon's enforcement edge is that function's answer, byte for byte.
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    const client = await streaming(fx);
    await client.send({ t: 'data', bytes: toBase64Url(new Uint8Array(shared.MAX_DATA_BYTES)) });
    await client.pump();
    expect(client.end).toBeUndefined();
    expect((handler.received[0] as Uint8Array).byteLength).toBe(MAX_DATA_BYTES);
  });
});

describe('pairing, the whole protocol, and the written contract', () => {
  test('R675 pairing never crosses WebRTC: a pair record on that carrier (or the tunnel) is refused uniformly and the mode is never asked', async () => {
    const fx = await fixture();
    for (const carrier of ['webrtc', 'tunnel']) {
      const client = TestClient.open(fx, carrier);
      await client.handshake(fx.daemonId);
      await client.send({
        t: 'pair',
        protocol: SESSION_PROTOCOL_ID,
        code: 'ABCD-1234',
        deviceName: 'phone',
        deviceKey: 'k',
        proof: 'p',
      });
      await client.pump();
      expect(client.last('pair-refused')).toMatchObject({ reason: 'pairing_refused' });
      expect(client.end?.code).toBe(4440);
    }
    expect(fx.pair.attempts).toHaveLength(0);
  });

  test('R127 a full carried session on real WebCrypto works end to end, and a tampered record is refused', async () => {
    const fx = await fixture();
    const { client } = await serving(fx, 'relay');
    await client.send(req(1, { path: '/v1/health' }));
    await client.pump();
    expect(client.last('res')).toMatchObject({ id: 1, status: 200 });
    const tampered = await sealed(client, req(2));
    tampered[FRAME_HEADER_BYTES + 3] = (tampered[FRAME_HEADER_BYTES + 3] ?? 0) ^ 0xff;
    client.raw(tampered);
    await client.pump();
    expect(client.end?.code).toBe(SESSION_CLOSE_CODES.frameForged);
    expect(fx.requests).toHaveLength(1);
  });

  test('R3 the document is the contract: every close code, protocol identifier and limit the kernel enforces is stated in docs/relay-protocol.md', () => {
    const doc = readFileSync(new URL('../../../../../../docs/relay-protocol.md', import.meta.url), 'utf8');
    for (const [name, code] of Object.entries(SESSION_CLOSE_CODES))
      expect(doc.includes(String(code)), `close code ${name} (${code}) is in the document`).toBe(true);
    for (const text of ['ferretry-relay/1', SESSION_PROTOCOL_ID, String(MAX_PLAINTEXT_BYTES), '32 MiB'])
      expect(doc.includes(text), `${text} is in the document`).toBe(true);
    expect(doc.includes(String(CREDIT_WINDOW_FRAMES))).toBe(true);
    expect(doc.includes(String(FRAME_HEADER_BYTES))).toBe(true);
  });
});

describe('the kernel part of rows the carriers and the browser also hold', () => {
  test('R23 (kernel part) one inbound delivery is exactly one binary frame and every outbound item is exactly one frame; frames glued together are forged, never split', async () => {
    const fx = await fixture();
    for (const carrier of CARRIERS) {
      const { client } = await serving(fx, carrier);
      await client.send(req(1));
      await client.pump();
      expect(client.wire.length).toBeGreaterThan(1);
      for (const bytes of client.wire) {
        const decoded = decodeFrame(bytes);
        expect(decoded.ok).toBe(true);
        if (decoded.ok) expect(bytes.length).toBe(FRAME_HEADER_BYTES + decoded.frame.payload.length);
      }
    }
    // Two well-formed frames delivered as ONE message are one frame with a longer payload: the seal refuses it.
    const { client } = await serving(fx, 'relay');
    const first = await sealed(client, req(1));
    const second = await sealed(client, req(2));
    const glued = new Uint8Array(first.length + second.length);
    glued.set(first);
    glued.set(second, first.length);
    const before = fx.requests.length;
    client.raw(glued);
    await client.pump();
    expect(client.end?.code).toBe(SESSION_CLOSE_CODES.frameForged);
    expect(fx.requests).toHaveLength(before);
    // The heartbeat text and direct's `ready` control frame are the carrier's, never a message the layer reads.
  });

  test('R40 (kernel part) where a direct session arrived is the carrier peer it was opened with, and nothing inside the session changes it', async () => {
    const fx = await fixture();
    const { client } = await serving(fx, 'direct', { address: '127.0.0.1' });
    await client.send(
      req(1, { headers: { 'x-forwarded-for': '203.0.113.9', forwarded: 'for=203.0.113.9', host: 'attacker.example' } }),
    );
    await client.send(req(2, { query: [['clientAddress', '203.0.113.9']] }));
    await client.pump();
    expect(fx.requests).toHaveLength(2);
    for (const request of fx.requests) {
      expect(request.clientAddress).toBe('127.0.0.1');
      // Even a direct peer that LOOKS like loopback is a carried arrival: only the local listener makes local.
      expect(request.arrival).toMatchObject({ kind: 'carried', carrier: 'direct' });
    }
    const unknown = await serving(fx, 'direct');
    await unknown.client.send(req(1, { headers: { 'x-forwarded-for': '203.0.113.9' } }));
    await unknown.client.pump();
    expect(fx.requests[2]?.clientAddress).toBe(`direct-session:${unknown.client.sessionId.text}`);
  });

  test('R76 (kernel part) appSession is exactly 16 random bytes, base64url: any other length or alphabet is refused 4400', async () => {
    const fx = await fixture();
    const good = await serving(fx);
    await good.client.send(req(1));
    await good.client.pump();
    expect(good.client.end).toBeUndefined();
    expect(good.device.appSession).toHaveLength(22);
    for (const appSession of [
      toBase64Url(relayCrypto.randomBytes(15)),
      toBase64Url(relayCrypto.randomBytes(17)),
      '',
      `${toBase64Url(relayCrypto.randomBytes(16)).slice(0, 21)}+`,
    ]) {
      const device = await pairedDevice(fx.device, 'R');
      const client = TestClient.open(fx);
      await client.handshake(fx.daemonId);
      await client.auth(device, { appSession });
      expect(client.end?.code).toBe(4400);
    }
  });
});
