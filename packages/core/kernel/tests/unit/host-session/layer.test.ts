import { describe, expect, test } from 'bun:test';
import { type ApiResponse, jsonResponse } from '../../../contract/http.ts';
import type { SocketDownstream, SocketHandler } from '../../../contract/socket.ts';
import {
  CREDIT_WINDOW_FRAMES,
  devicePairMessage,
  encodeFrame,
  FRAME_KINDS,
  MAX_CONCURRENT_REQUESTS,
  MAX_PLAINTEXT_BYTES,
  MAX_PRE_CREDENTIAL_SESSIONS,
  OLDER_APP_SENTENCE,
  RELAY_SESSION_CONCLUDED_CLOSE_CODE,
  RELAY_SESSION_CONCLUDED_CLOSE_REASON,
  relayDataByteBudget,
  SESSION_CREDENTIAL_DEADLINE_MS,
  SESSION_PROTOCOL_ID,
  signDeviceProof,
  toBase64Url,
  transcriptKey,
  utf8Bytes,
} from '../../../host/session/index.ts';
import { fixture, pairedDevice, serving, settle, TestClient } from './harness.ts';
import { relayCrypto } from './identities.ts';

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const req = (id: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  t: 'req',
  id,
  method: 'GET',
  path: '/v1/health',
  ...extra,
});

describe('the session layer: arrival and principal', () => {
  test('G15 a carried request is never local, whatever the carrier, and nothing in a record changes that', async () => {
    const fx = await fixture();
    for (const carrier of ['relay', 'direct']) {
      const { client } = await serving(fx, carrier);
      await client.send(req(1, { headers: { 'x-forwarded-for': '127.0.0.1', host: 'localhost' } }));
      await client.pump();
    }
    expect(fx.requests).toHaveLength(2);
    for (const request of fx.requests) expect(request.arrival.kind).toBe('carried');
    expect(fx.requests.map(request => String(request.arrival.kind === 'carried' ? request.arrival.carrier : 'local'))).toEqual([
      'relay',
      'direct',
    ]);
  });

  test('R625 a relayed arrival is never local and neither is a direct one (5.0: only the local listener makes local)', async () => {
    const fx = await fixture();
    const { client } = await serving(fx, 'direct', { address: '127.0.0.1' });
    await client.send(req(1));
    await client.pump();
    expect(fx.requests[0]?.arrival).toEqual({ kind: 'carried', carrier: 'direct' } as never);
  });

  test('R263 the arrival a session was opened on is stamped on every request it carries', async () => {
    const fx = await fixture();
    const { client } = await serving(fx, 'tunnel');
    await client.send(req(1));
    await client.send(req(2, { headers: { 'x-fy-arrival': 'local' } }));
    await client.pump();
    expect(fx.requests.map(request => request.arrival)).toEqual([
      { kind: 'carried', carrier: 'tunnel' },
      { kind: 'carried', carrier: 'tunnel' },
    ] as never);
  });

  test('R74 the credential holds no bearer: the kernel stamps the principal from the verified holder', async () => {
    const fx = await fixture();
    const { client, device } = await serving(fx);
    expect(client.last('authenticated')).toBeDefined();
    await client.send(req(1));
    await client.pump();
    const principal = fx.requests[0]?.principal;
    expect(principal?.kind).toBe('device');
    expect(String(principal?.holder)).toBe(device.deviceId);
    expect(String(principal?.session)).toBe(transcriptKey(client.transcript ?? new Uint8Array()));
    // A token field beside the proof is refused by the strict credential schema.
    const other = TestClient.open(fx);
    await other.handshake(fx.daemonId);
    await other.auth(device, { token: 'fyd_bearer' });
    expect(other.end?.code).toBe(4400);
  });

  test('R264 a carried caller is rate-limited by its session, which it cannot choose, or by its socket address', async () => {
    const fx = await fixture();
    const relayed = await serving(fx, 'relay');
    await relayed.client.send(req(1));
    await relayed.client.pump();
    const direct = await serving(fx, 'direct', { address: '192.0.2.7' });
    await direct.client.send(req(1));
    await direct.client.pump();
    expect(fx.requests[0]?.clientAddress).toBe(`relay-session:${relayed.client.sessionId.text}`);
    expect(fx.requests[1]?.clientAddress).toBe('192.0.2.7');
  });
});

describe('the session layer: frames and the handshake', () => {
  test('R16 R21 R629 direct and relay run the identical sealed session: nothing past the handshake is plaintext', async () => {
    const fx = await fixture();
    for (const carrier of ['direct', 'relay']) {
      const { client } = await serving(fx, carrier);
      await client.send(req(1, { path: '/v1/secret-looking-path' }));
      await client.pump();
      const joined = client.wire.map(bytes => new TextDecoder().decode(bytes)).join('');
      expect(joined.includes('secret-looking-path')).toBe(false);
      expect(joined.includes('authenticated')).toBe(false);
      expect(client.last('res')?.['status']).toBe(200);
    }
  });

  test('R29 R65 the handshake answer is sequence 0 and records count from 1', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    expect(client.handshakeSequence).toBe(0);
    const records = client.sequences.filter(sequence => sequence !== 0);
    expect(records[0]).toBe(1);
  });

  test('R24 R27 a frame not starting FE 01, too short or with a reserved byte set ends the session', async () => {
    const fx = await fixture();
    const bad = TestClient.open(fx);
    bad.raw(new Uint8Array([0x00, 0x01, 0x02, 0x00, ...new Uint8Array(24)]));
    await bad.pump();
    expect(bad.end?.code).toBe(4400);
    const short = TestClient.open(fx);
    short.raw(new Uint8Array([0xfe, 0x01]));
    await short.pump();
    expect(short.end?.code).toBe(4400);
    const big = TestClient.open(fx);
    big.raw(new Uint8Array(65_537).fill(0xfe));
    await big.pump();
    expect(big.end?.code).toBe(4413);
  });

  test('R25 an all-zero session id addresses the rendezvous and can never open a session', async () => {
    const fx = await fixture();
    const client = TestClient.open(fx);
    client.raw(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId: { bytes: new Uint8Array(16), text: toBase64Url(new Uint8Array(16)) },
        sequence: 0,
        payload: utf8Bytes('{}'),
      }),
    );
    await client.pump();
    expect(client.end?.code).toBe(4400);
  });

  test('R26 control frames are hop-by-hop: one that reaches a session ends it', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    client.raw(encodeFrame({ kind: FRAME_KINDS.control, sessionId: client.sessionId, sequence: 0, payload: utf8Bytes('{"t":"ready"}') }));
    await client.pump();
    expect(client.end?.code).toBe(4400);
  });

  test('R66 the daemon refuses a hello naming another daemon', async () => {
    const fx = await fixture();
    const client = TestClient.open(fx);
    await client.handshake(`fy_daemon_${'A'.repeat(43)}`);
    expect(client.end?.code).toBe(4400);
    expect(client.channel).toBeUndefined();
  });

  test('R2 R67 a peer speaking the previous dialect gets 4426 and a sentence naming the side to update', async () => {
    const fx = await fixture();
    const client = TestClient.open(fx);
    await client.handshake(fx.daemonId, hello => ({ ...hello, protocol: 'ferretry-relay/1' }));
    expect(client.end).toEqual({ code: 4426, reason: OLDER_APP_SENTENCE });
  });

  test('R72 key agreement aborts on an all-zero X25519 output', async () => {
    const fx = await fixture();
    const client = TestClient.open(fx);
    await client.handshake(fx.daemonId, hello => ({ ...hello, epk: toBase64Url(new Uint8Array(32)) }));
    expect(client.end?.code).toBe(4400);
  });

  test('R31 R85 a repeated sequence ends the session and is never repaired', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    const frame = await client.sendBytes(utf8Bytes(JSON.stringify(req(1))));
    await client.pump();
    client.raw(encodeFrame(frame));
    await client.pump();
    expect(client.end?.code).toBe(4420);
  });

  test('R83 R85 a record whose header a relay edited fails authentication and ends the session', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    const channel = client.channel;
    if (channel === undefined) throw new Error('keyed');
    const { sealRecord } = await import('../../../host/session/index.ts');
    const sealed = await sealRecord(relayCrypto, channel, utf8Bytes(JSON.stringify(req(1))));
    if (!sealed.ok) throw new Error('seal');
    const bytes = encodeFrame(sealed.frame);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0xff;
    client.raw(bytes);
    await client.pump();
    expect(client.end?.code).toBe(4421);
    expect(fx.requests).toHaveLength(0);
  });

  test('R85 a frame for another session ends this one', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    client.raw(
      encodeFrame({ kind: FRAME_KINDS.credit, sessionId: TestClient.open(fx).sessionId, sequence: 0, payload: new Uint8Array(4) }),
    );
    await client.pump();
    expect(client.end?.code).toBe(4400);
  });

  test('R80 a proof made over another session transcript verifies for no other session', async () => {
    const fx = await fixture();
    const device = await pairedDevice(fx.device);
    const first = TestClient.open(fx);
    await first.handshake(fx.daemonId);
    const second = TestClient.open(fx);
    await second.handshake(fx.daemonId);
    const { deviceAuthMessage } = await import('../../../host/session/index.ts');
    const proof = await signDeviceProof(
      relayCrypto,
      relayCrypto.deviceKeyHandle(device.privateKey),
      deviceAuthMessage(first.transcript ?? new Uint8Array(), 'auth', device.deviceId, device.appSession),
    );
    await second.send({ t: 'auth', protocol: SESSION_PROTOCOL_ID, deviceId: device.deviceId, appSession: device.appSession, proof });
    await second.pump();
    expect(second.end?.code).toBe(4403);
  });

  test('R82 R545 R628 the plaintext cap is 65492 and the data byte budget is derived from it by one function', () => {
    expect(MAX_PLAINTEXT_BYTES).toBe(65_492);
    expect(relayDataByteBudget(MAX_PLAINTEXT_BYTES)).toBe(Math.floor(((65_492 - '{"t":"data","bytes":""}'.length) * 3) / 4));
  });

  test('R627 4440 and its reason are one exported constant pair', () => {
    expect(RELAY_SESSION_CONCLUDED_CLOSE_CODE).toBe(4440);
    expect(RELAY_SESSION_CONCLUDED_CLOSE_REASON).toBe('the session concluded');
  });
});

describe('the session layer: flow control', () => {
  test('R94 R95 credit is returned once half a window is owed', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    expect(client.creditReceived).toBe(0);
    for (let id = 1; id <= CREDIT_WINDOW_FRAMES / 2; id += 1) await client.send(req(id));
    await client.pump();
    expect(client.creditReceived).toBe(CREDIT_WINDOW_FRAMES / 2);
  });

  test('R96 a credit grant that would change nothing is a protocol violation', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    client.credit(0);
    await client.pump();
    expect(client.end?.code).toBe(4430);
  });

  test('R97 R536 a peer sending past its allowance ends the session 4430', async () => {
    const fx = await fixture();
    fx.dispatch = () => new Promise<ApiResponse>(() => {});
    const { client } = await serving(fx);
    for (let id = 1; id <= 3 * CREDIT_WINDOW_FRAMES; id += 1) {
      await client.send(req(id));
      if (id % 8 === 0) await settle(3);
    }
    await client.pump();
    expect(client.end?.code).toBe(4430);
  });

  test('R555 the daemon seals only what the peer credited: a full window waits for credit', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    // `authenticated` and the handshake spent two of 32; thirty answers fill the window.
    for (let id = 1; id <= CREDIT_WINDOW_FRAMES + 4; id += 1) await client.send(req(id));
    await client.pump();
    const answered = client.records.filter(record => record['t'] === 'res').length;
    expect(answered).toBe(CREDIT_WINDOW_FRAMES - 2);
    client.credit(16);
    await client.pump();
    expect(client.records.filter(record => record['t'] === 'res').length).toBe(CREDIT_WINDOW_FRAMES + 4);
  });
});

describe('the session layer: one session, one job', () => {
  test('R228 a record that is not one strict JSON object ends the session 4400', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    await client.sendBytes(new Uint8Array([0xff, 0xfe]));
    await client.pump();
    expect(client.end?.code).toBe(4400);
    const second = await serving(fx);
    await second.client.send({ t: 'nope' });
    await second.client.pump();
    expect(second.client.end?.code).toBe(4400);
    const third = await serving(fx);
    await third.client.send(req(1, { extra: true }));
    await third.client.pump();
    expect(third.client.end?.code).toBe(4400);
  });

  test('R229 R230 R624 a second credential, or a request as the first record, ends the session', async () => {
    const fx = await fixture();
    const { client, device } = await serving(fx);
    await client.auth(device);
    expect(client.end?.code).toBe(4400);
    const early = TestClient.open(fx);
    await early.handshake(fx.daemonId);
    await early.send(req(1));
    await early.pump();
    expect(early.end?.code).toBe(4400);
    expect(fx.requests).toHaveLength(0);
  });

  test('R234 nothing but the credential opens a session: a req or stream data before acceptance ends it 4400', async () => {
    const fx = await fixture();
    const early = TestClient.open(fx);
    await early.handshake(fx.daemonId);
    await early.send(req(1));
    await early.pump();
    expect(early.end?.code).toBe(4400);
    const data = TestClient.open(fx);
    await data.handshake(fx.daemonId);
    await data.send({ t: 'data', text: 'x' });
    await data.pump();
    expect(data.end?.code).toBe(4400);
    expect(fx.requests).toHaveLength(0);
  });

  test('R231 a stream session carries one stream only: a request on it ends the session', async () => {
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    const device = await pairedDevice(fx.device);
    const client = TestClient.open(fx);
    await client.handshake(fx.daemonId);
    await client.auth(device, { path: '/v1/events' }, 'stream');
    expect(client.last('stream-opened')).toBeDefined();
    await client.send(req(1));
    await client.pump();
    expect(client.end?.code).toBe(4400);
    expect(handler.closed).toBe(true);
  });

  test('R232 a session with no credential 10 s after it opened ends 4400, and a seventh pre-credential one gets 4429', async () => {
    const fx = await fixture();
    const idle = TestClient.open(fx);
    fx.clock.advance(SESSION_CREDENTIAL_DEADLINE_MS);
    await idle.pump();
    expect(idle.end?.code).toBe(4400);
    const waiting = Array.from({ length: MAX_PRE_CREDENTIAL_SESSIONS }, () => TestClient.open(fx, 'relay'));
    const seventh = TestClient.open(fx, 'relay');
    await seventh.pump();
    expect(seventh.end?.code).toBe(4429);
    // A different carrier has its own bound.
    const other = TestClient.open(fx, 'direct');
    await other.pump();
    expect(other.end).toBeUndefined();
    expect(waiting.every(client => client.end === undefined)).toBe(true);
  });

  test('R233 a 4429 is a busy refusal, retryable once a slot frees', async () => {
    const fx = await fixture();
    const waiting = Array.from({ length: MAX_PRE_CREDENTIAL_SESSIONS }, () => TestClient.open(fx));
    const refused = TestClient.open(fx);
    await refused.pump();
    expect(refused.end?.code).toBe(4429);
    waiting[0]?.link.closed('gone');
    const retried = TestClient.open(fx);
    await retried.pump();
    expect(retried.end).toBeUndefined();
  });
});

describe('the session layer: requests', () => {
  test('R235 R534 answers carry their id and may cross in any order', async () => {
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
    expect(client.records.filter(record => record['t'] === 'res').map(record => record['id'])).toEqual([2, 1]);
  });

  test('R256 R260 a req needs id, method and path; repeated query keys survive and headers are lowercase', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    await client.send(req(1, { query: [['a', '1'], ['a', '2']], headers: { 'x-thing': 'v' }, body: 'hi' }));
    await client.pump();
    const request = fx.requests[0];
    expect(request?.query.get('a')).toEqual(['1', '2']);
    expect(request?.headers.get('x-thing')).toBe('v');
    expect(await request?.text()).toBe('hi');
    const missing = await serving(fx);
    await missing.client.send({ t: 'req', id: 1, path: '/v1/health' });
    await missing.client.pump();
    expect(missing.client.end?.code).toBe(4400);
  });

  test('R258 a repeated request id ends the session, never overwrites', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    await client.send(req(1));
    await client.send(req(1));
    await client.pump();
    expect(client.end?.code).toBe(4400);
  });

  test('R259 a path must start with exactly one slash and is never normalised', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    await client.send(req(1, { path: '/v1/../x%2F' }));
    await client.pump();
    expect(fx.requests[0]?.path).toBe('/v1/../x%2F');
    const bad = await serving(fx);
    await bad.client.send(req(1, { path: '//evil' }));
    await bad.client.pump();
    expect(bad.client.end?.code).toBe(4400);
  });

  test('R261 an authorization header is refused 4400 so a request cannot promote past its grant', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    await client.send(req(1, { headers: { authorization: 'Bearer x' } }));
    await client.pump();
    expect(client.end?.code).toBe(4400);
    expect(fx.requests).toHaveLength(0);
  });

  test('R526 R527 a large answer travels in ordered parts, and a part with no open body ends the session', async () => {
    const fx = await fixture();
    fx.dispatch = async () => jsonResponse({ big: 'é'.repeat(80_000) });
    const { client } = await serving(fx);
    await client.send(req(1));
    await client.pump();
    const head = client.last('res');
    expect(head?.['more']).toBe(true);
    const parts = client.records.filter(record => record['t'] === 'res-more');
    expect(parts.length).toBeGreaterThan(0);
    const body = [head?.['body'], ...parts.map(part => part['body'])].join('');
    expect(JSON.parse(body)).toEqual({ big: 'é'.repeat(80_000) });
    await client.send({ t: 'req-more', id: 9, body: 'x' });
    await client.pump();
    expect(client.end?.code).toBe(4400);
  });

  test('R528 an answer over 32 MiB is 502 answer_too_large, never truncated', async () => {
    const fx = await fixture();
    fx.dispatch = async () => ({ status: 200, headers: new Map(), body: 'x'.repeat(32 * 1024 * 1024 + 1) });
    const { client } = await serving(fx);
    await client.send(req(1));
    await client.pump();
    const res = client.last('res');
    expect(res?.['status']).toBe(502);
    expect(String(res?.['body'])).toContain('answer_too_large');
  });

  test('R529 at most four request bodies are reassembled at once', async () => {
    const fx = await fixture();
    const { client } = await serving(fx);
    for (let id = 1; id <= 5; id += 1) await client.send(req(id, { method: 'POST', body: 'a', more: true }));
    await client.pump();
    expect(client.end?.code).toBe(4400);
  });

  test('R535 at most 16 requests run at once per session; the rest wait in order', async () => {
    const fx = await fixture();
    const running: (() => void)[] = [];
    fx.dispatch = request =>
      new Promise(resolve => {
        running.push(() => resolve(jsonResponse({ path: request.path })));
      });
    const { client } = await serving(fx);
    for (let id = 1; id <= MAX_CONCURRENT_REQUESTS + 3; id += 1) await client.send(req(id));
    await client.pump();
    expect(running).toHaveLength(MAX_CONCURRENT_REQUESTS);
    running[0]?.();
    await client.pump();
    expect(running).toHaveLength(MAX_CONCURRENT_REQUESTS + 1);
  });

  test('R508 R510 a compressed answer crosses as base64url gzip bytes under the two encoding headers', async () => {
    const fx = await fixture();
    const gzip = Bun.gzipSync(new Uint8Array(utf8Bytes('{"a":1}')));
    fx.dispatch = async () => ({ status: 200, headers: new Map([['content-type', 'application/json']]), body: '{"a":1}', gzip });
    const { client } = await serving(fx);
    await client.send(req(1));
    await client.pump();
    const res = client.last('res');
    const headers = res?.['headers'] as Record<string, string>;
    expect(headers['content-encoding']).toBe('gzip');
    expect(headers['content-transfer-encoding']).toBe('base64url');
    expect(res?.['body']).toBe(toBase64Url(gzip));
  });

  test('R516 R517 an answer whose late check changed after it was queued is dropped unsent and the session ends', async () => {
    const fx = await fixture();
    let held = false;
    const plain = jsonResponse({ shown: true });
    const withheld = jsonResponse({ error: 'withheld' });
    fx.dispatch = async () => ({ ...plain, late: () => (held ? withheld : plain) });
    const { client } = await serving(fx);
    const before = client.records.length;
    await client.send(req(1));
    // Let the answer be queued and sealed, but do not pull it yet.
    await wait(60);
    held = true;
    await client.pump();
    expect(client.records.length).toBe(before);
    expect(client.end).toEqual({ code: 4400, reason: 'what it was about to send changed before it left' });
  });

  test('R515 an unchanged late publication passes its permit and is sent', async () => {
    const fx = await fixture();
    const plain = jsonResponse({ shown: true });
    fx.dispatch = async () => ({ ...plain, late: () => plain });
    const { client } = await serving(fx);
    await client.send(req(1));
    await client.pump();
    expect(client.last('res')?.['status']).toBe(200);
    expect(client.end).toBeUndefined();
  });

  test('a handler that throws is answered 500 and the session goes on', async () => {
    const fx = await fixture();
    fx.dispatch = async () => {
      throw new Error('boom');
    };
    const { client } = await serving(fx);
    await client.send(req(1));
    await client.pump();
    expect(client.last('res')?.['status']).toBe(500);
    expect(client.end).toBeUndefined();
  });
});

interface FakeHandler extends SocketHandler {
  closed: boolean;
  received: unknown[];
  downstream?: SocketDownstream;
}

function streamFixture(fx: Awaited<ReturnType<typeof fixture>>, refuse?: ApiResponse): { handler: FakeHandler } {
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

async function streaming(fx: Awaited<ReturnType<typeof fixture>>, path = '/v1/events'): Promise<TestClient> {
  const device = await pairedDevice(fx.device);
  const client = TestClient.open(fx);
  await client.handshake(fx.daemonId);
  await client.auth(device, { path }, 'stream');
  return client;
}

describe('the session layer: streams', () => {
  test('R217 R537 R539 a stream dispatches through the socket table with the stamped principal and carried arrival', async () => {
    const fx = await fixture();
    streamFixture(fx);
    const client = await streaming(fx, '/v1/terminals/x/stream');
    expect(client.last('stream-opened')).toBeDefined();
    const request = fx.streams[0];
    expect(request?.method).toBe('GET');
    expect(request?.path).toBe('/v1/terminals/x/stream');
    expect(request?.arrival.kind).toBe('carried');
    expect(request?.principal?.kind).toBe('device');
  });

  test('R538 R542 a refused stream says its status and body before anything switches, then 4440', async () => {
    const fx = await fixture();
    streamFixture(fx, jsonResponse({ error: 'no' }, 403));
    const client = await streaming(fx);
    const refused = client.last('stream-refused');
    expect(refused?.['status']).toBe(403);
    expect(refused?.['body']).toBe('{"error":"no"}');
    expect(client.end).toEqual({ code: 4440, reason: 'the session concluded' });
  });

  test('R541 a ticket or token in a stream query is refused 4400', async () => {
    const fx = await fixture();
    streamFixture(fx);
    const device = await pairedDevice(fx.device);
    const client = TestClient.open(fx);
    await client.handshake(fx.daemonId);
    await client.auth(device, { path: '/v1/events', query: [['ticket', 'x']] }, 'stream');
    expect(client.end?.code).toBe(4400);
    expect(fx.streams).toHaveLength(0);
  });

  test('R543 R544 a data record carries exactly one of text or bytes; bytes are delivered on arrival', async () => {
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    const client = await streaming(fx);
    await client.send({ t: 'data', bytes: toBase64Url(utf8Bytes('ab')) });
    await client.send({ t: 'data', text: 'hello' });
    await client.pump();
    expect(handler.received[0]).toEqual(utf8Bytes('ab'));
    expect(handler.received[1]).toBe('hello');
    await client.send({ t: 'data', text: 'a', bytes: 'YQ' });
    await client.pump();
    expect(client.end?.code).toBe(4400);
  });

  test('R550 an event too large for one record closes the stream 1009, sealed, then 4440', async () => {
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    const client = await streaming(fx);
    handler.downstream?.send('x'.repeat(MAX_PLAINTEXT_BYTES));
    await client.pump();
    expect(client.last('stream-close')?.['code']).toBe(1009);
    expect(client.end?.code).toBe(4440);
    expect(handler.closed).toBe(true);
  });

  test('R554 R551 an event stream never drops: past the honest buffered bound it closes 1013', async () => {
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    const client = await streaming(fx);
    const chunk = 'y'.repeat(60_000);
    let answer: number | undefined = 0;
    for (let index = 0; index < 60 && answer !== -1; index += 1) answer = handler.downstream?.send(chunk);
    expect(answer).toBe(-1);
    expect(handler.downstream?.bufferedBytes()).toBeLessThan(60_000);
    client.credit(32);
    await client.pump();
    client.credit(32);
    await client.pump();
    expect(client.last('stream-close')?.['code']).toBe(1013);
    expect(client.end?.code).toBe(4440);
  });

  test('R556 R557 stream ends seal the close taxonomy, and the public close is always 4440 with the shared reason', async () => {
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    const client = await streaming(fx);
    handler.downstream?.close(1000, 'the terminal exited');
    await client.pump();
    expect(client.last('stream-close')).toMatchObject({ code: 1000, reason: 'the terminal exited' });
    expect(client.end).toEqual({ code: RELAY_SESSION_CONCLUDED_CLOSE_CODE, reason: RELAY_SESSION_CONCLUDED_CLOSE_REASON });
  });

  test('R558 a client stream-close releases the handler and concludes with no sealed answer of its own', async () => {
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    const client = await streaming(fx);
    await client.send({ t: 'stream-close', protocol: SESSION_PROTOCOL_ID, code: 1000, reason: 'left' });
    await client.pump();
    expect(handler.closed).toBe(true);
    expect(client.end?.code).toBe(4440);
    expect(client.last('stream-close')).toBeUndefined();
  });

  test('a stream frame whose permit changed (§7.3) is dropped unsent and the session ends', async () => {
    const fx = await fixture();
    const { handler } = streamFixture(fx);
    const client = await streaming(fx);
    let allowed = true;
    handler.downstream?.send(utf8Bytes('pane'), () => allowed);
    await wait(60);
    allowed = false;
    await client.pump();
    expect(client.records.filter(record => record['t'] === 'data')).toHaveLength(0);
    expect(client.end?.code).toBe(4400);
  });

  test('a narrowed grant ends an open stream with a sealed 1008, never 4403', async () => {
    const fx = await fixture();
    streamFixture(fx);
    const client = await streaming(fx);
    fx.sockets.reauthorize = () => false;
    for (const watch of fx.device.watches.values()) for (const item of watch) item.regranted();
    await client.pump();
    expect(client.last('stream-close')?.['code']).toBe(1008);
    expect(client.end?.code).toBe(4440);
  });
});

describe('the session layer: pairing and modes', () => {
  async function pairRecord(client: TestClient): Promise<Record<string, unknown>> {
    const key = await relayCrypto.generateDeviceKey();
    const deviceKey = toBase64Url(key.publicKeySpki);
    const proof = await signDeviceProof(
      relayCrypto,
      relayCrypto.deviceKeyHandle(key.privateKey),
      devicePairMessage(client.transcript ?? new Uint8Array(), deviceKey),
    );
    return { t: 'pair', protocol: SESSION_PROTOCOL_ID, code: 'ABCD-1234', deviceName: 'phone', deviceKey, proof };
  }

  test('pairing is one attempt, one sealed outcome, then 4440; the kernel proves the key when the mode asks', async () => {
    const fx = await fixture();
    const client = TestClient.open(fx, 'direct', { address: '192.0.2.9' });
    await client.handshake(fx.daemonId);
    await client.send(await pairRecord(client));
    await client.pump();
    expect(client.last('paired')).toMatchObject({ response: { deviceId: 'fy_device_id_new' } });
    expect(client.end?.code).toBe(4440);
    expect(fx.pair.attempts[0]?.peer).toBe('192.0.2.9');
    expect(fx.pair.attempts[0]?.carrier).toBe('direct' as never);
  });

  test('R662 R675 pairing over the tunnel or WebRTC gets the uniform pair-refused and the mode is never asked', async () => {
    const fx = await fixture();
    for (const carrier of ['tunnel', 'webrtc']) {
      const client = TestClient.open(fx, carrier);
      await client.handshake(fx.daemonId);
      await client.send(await pairRecord(client));
      await client.pump();
      expect(client.last('pair-refused')).toMatchObject({ reason: 'pairing_refused' });
      expect(client.end?.code).toBe(4440);
    }
    expect(fx.pair.attempts).toHaveLength(0);
  });

  test('R79 an unknown device, a revoked one and a mode that is off all get the same 4403', async () => {
    const fx = await fixture();
    const device = await pairedDevice(fx.device);
    fx.device.keys.delete(device.deviceId);
    const unknown = TestClient.open(fx);
    await unknown.handshake(fx.daemonId);
    await unknown.auth(device);
    const fresh = await pairedDevice(fx.device, 'B');
    fx.modesOff.add('device');
    const off = TestClient.open(fx);
    await off.handshake(fx.daemonId);
    await off.auth(fresh);
    expect(unknown.end).toEqual({ code: 4403, reason: 'unknown device credential' });
    expect(off.end).toEqual({ code: 4403, reason: 'unknown device credential' });
  });

  test('a revocation the mode reports ends the session with the same 4403, and endMode ends every session of a mode', async () => {
    const fx = await fixture();
    const first = await serving(fx);
    for (const watch of fx.device.watches.get(first.device.deviceId) ?? []) watch.revoked();
    await first.client.pump();
    expect(first.client.end?.code).toBe(4403);
    const second = await serving(fx);
    fx.layer.endMode('device');
    await second.client.pump();
    expect(second.client.end?.code).toBe(4403);
  });

  test('presence moves the holder idle clock; opening a session does not', async () => {
    const fx = await fixture();
    const { client, device } = await serving(fx);
    expect(fx.device.seenHolders).toHaveLength(0);
    await client.send(req(1, { presence: true }));
    await client.pump();
    expect(fx.device.seenHolders).toEqual([device.deviceId]);
  });

  test('the lease ends a session 4441 unless the holder signs the renewal challenge', async () => {
    const fx = await fixture({ lease: { leaseMs: 60_000, renewLeadMs: 10_000, maxSessionMs: 600_000 } });
    const { client, device } = await serving(fx);
    fx.clock.advance(50_000);
    await client.pump();
    const renew = client.last('renew');
    expect(renew).toBeDefined();
    await client.renew(device, String(renew?.['nonce']));
    fx.clock.advance(15_000);
    await client.pump();
    expect(client.end).toBeUndefined();
    fx.clock.advance(60_000);
    await client.pump();
    expect(client.end).toEqual({ code: 4441, reason: 'the access lease ended' });
  });
});

describe('the session layer: report', () => {
  test('the report counts sessions and never names a holder', async () => {
    const fx = await fixture();
    const device = await pairedDevice(fx.device);
    fx.device.keys.delete(device.deviceId);
    const client = TestClient.open(fx);
    await client.handshake(fx.daemonId);
    await client.auth(device);
    const report = fx.layer.report();
    expect(report.lastRefusal?.includes(device.deviceId)).toBe(false);
    expect(report.sessions).toBe(0);
  });
});
