/**
 * The local listener's guarantee rows (G14, P89, I74) at the unit tier: the REAL `listenLocal` and `toResponse`, with
 * `Bun.serve` replaced by a recorder so the listener's own `fetch` handler is driven directly, with a peer address of
 * the test's choosing and no socket opened.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { jsonResponse, textResponse } from '../../../contract/http.ts';
import type { ApiRequest, ApiResponse } from '../../../contract/http.ts';
import { DaemonRunSchema, recordedBindAddress } from '../../../contract/run.ts';
import type { RunningHost } from '../../../host/host.ts';
import {
  isLoopbackPeer,
  listenLocal,
  localArrival,
  runBindPath,
  runSocketPath,
  toApiRequest,
  toResponse,
} from '../../../host/listener.ts';

type Fetch = (request: Request, server: unknown) => Promise<Response | undefined>;
interface Served {
  readonly kind: 'unix' | 'tcp';
  readonly fetch: Fetch;
  readonly options: Record<string, unknown>;
}

const originalServe = Bun.serve;
afterEach(() => {
  Bun.serve = originalServe;
});

/** A booted listener whose two servers are recorders; `peer` is what `server.requestIP` reports for a request. */
async function listening(
  dispatch: (request: ApiRequest) => Promise<ApiResponse>,
  options: { readonly hostname?: string; readonly port?: number } = {},
) {
  const served: Served[] = [];
  spyOn(Bun, 'serve').mockImplementation(((config: Record<string, unknown>) => {
    served.push({ kind: 'unix' in config ? 'unix' : 'tcp', fetch: config['fetch'] as Fetch, options: config });
    return { port: (config['port'] as number | undefined) ?? undefined, stop: async () => {} };
  }) as unknown as typeof Bun.serve);
  const written = new Map<string, string>();
  const seen: ApiRequest[] = [];
  const host = {
    dispatch: async (request: ApiRequest) => {
      seen.push(request);
      return await dispatch(request);
    },
    dispatcher: { upgrade: async () => ({ outcome: 'unclaimed' }) },
  } as unknown as RunningHost;
  const listener = await listenLocal(host, {
    home: '/tmp/fy-listener-rows',
    port: options.port ?? 7457,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    pid: 4242,
    version: '5.0.0',
    write: async (path, text) => void written.set(path, text),
    chmod: async () => {},
    remove: async () => {},
  });
  const unix = served.find(item => item.kind === 'unix') as Served;
  const tcp = served.find(item => item.kind === 'tcp') as Served;
  const ask = async (server: Served, peer: string | undefined, headers: Record<string, string> = {}) =>
    await server.fetch(new Request('http://localhost/v1/anything', { headers }), {
      requestIP: () => (peer === undefined ? null : { address: peer }),
    });
  return { listener, unix, tcp, ask, seen, written };
}

describe('G14 loopback means how the request arrived', () => {
  test('G14 local arrival is decided by the listener from the real socket peer, never from a header', async () => {
    const { tcp, ask, seen } = await listening(async request => jsonResponse({ kind: request.arrival.kind }));
    const spoof = { 'x-forwarded-for': '203.0.113.9', forwarded: 'for=203.0.113.9', host: 'evil.example' };
    const response = await ask(tcp, '127.0.0.1', spoof);
    expect(response?.status).toBe(200);
    expect(seen[0]?.arrival).toMatchObject({ kind: 'local', privileged: true });
    // The address the handler sees is the socket's, not the forwarded one.
    expect(seen[0]?.clientAddress).toBe('127.0.0.1');
    expect(seen[0]?.headers.get('x-forwarded-for')).toBe('203.0.113.9');
  });

  test('G14 a non-loopback peer is refused on the loopback port and never reaches dispatch as local', async () => {
    const { tcp, ask, seen } = await listening(async () => jsonResponse({}));
    for (const peer of ['203.0.113.9', '10.0.0.1', '::ffff:203.0.113.9', undefined]) {
      const response = await ask(tcp, peer, { 'x-forwarded-for': '127.0.0.1' });
      expect(response?.status).toBe(403);
      expect(await response?.json()).toEqual({ error: 'not a local caller', code: 'not_local' });
    }
    expect(seen).toHaveLength(0);
    expect(isLoopbackPeer('203.0.113.9')).toBe(false);
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('::1')).toBe(true);
    expect(isLoopbackPeer('127.9.9.9')).toBe(true);
    expect(isLoopbackPeer('10.0.0.1')).toBe(false);
  });

  test('G14 the Unix socket is the other local arrival: privileged, with no peer address at all', async () => {
    const { unix, ask, seen } = await listening(async () => jsonResponse({}));
    await ask(unix, undefined, { 'x-forwarded-for': '203.0.113.9' });
    expect(seen[0]?.arrival).toMatchObject({ kind: 'local', privileged: true });
    expect(seen[0]?.clientAddress).toBeUndefined();
  });

  test('G14 toApiRequest takes the arrival it is GIVEN: nothing in the request, header or URL can change it', () => {
    const forged = new Request('http://127.0.0.1/v1/x', {
      headers: { 'x-forwarded-for': '127.0.0.1', host: 'localhost', arrival: 'local' },
    });
    const carried = { kind: 'carried', carrier: 'relay' } as never;
    expect(toApiRequest(forged, carried, '127.0.0.1').arrival).toEqual(carried);
    expect(toApiRequest(forged, localArrival(false), undefined).arrival).toMatchObject({
      kind: 'local',
      privileged: false,
    });
  });
});

describe('P89 a local client dials the recorded bind', () => {
  test('P89 a wildcard bind resolves to loopback at the recorded port, and the one function is the daemon and the client', async () => {
    expect(recordedBindAddress({ host: '0.0.0.0', port: 7457 })).toBe('http://127.0.0.1:7457');
    expect(recordedBindAddress({ host: '::', port: 7457 })).toBe('http://127.0.0.1:7457');
    expect(recordedBindAddress({ host: '', port: 7457 })).toBe('http://127.0.0.1:7457');
    expect(recordedBindAddress({ host: '127.0.0.1', port: 9 })).toBe('http://127.0.0.1:9');
    expect(recordedBindAddress({ host: '::1', port: 9 })).toBe('http://[::1]:9');
    // The function takes the bind and nothing else: a `publicUrl` can never steer it.
    const withPublic = { host: '0.0.0.0', port: 7457, publicUrl: 'https://machine.example' };
    expect(recordedBindAddress(withPublic)).toBe('http://127.0.0.1:7457');
    expect(DaemonRunSchema.safeParse({ ...withPublic, format: 1, socket: '/s', pid: 1, version: '5' }).success).toBe(
      false,
    );
    // The daemon announces exactly what it records, through the same function.
    const { listener, written } = await listening(async () => jsonResponse({}), { hostname: '0.0.0.0', port: 7457 });
    const bind = DaemonRunSchema.parse(JSON.parse(written.get(runBindPath('/tmp/fy-listener-rows')) as string));
    expect(bind).toMatchObject({ format: 1, host: '0.0.0.0', port: 7457, pid: 4242, version: '5.0.0' });
    expect(bind.socket).toBe(runSocketPath('/tmp/fy-listener-rows'));
    expect(listener.addresses).toEqual([runSocketPath('/tmp/fy-listener-rows'), recordedBindAddress(bind)]);
    expect(listener.addresses[1]).toBe('http://127.0.0.1:7457');
  });
});

describe('I74 the final check is the last synchronous step before bytes leave', () => {
  test('I74 late decides at toResponse, with no await between the check and the Response', () => {
    let held = false;
    const response: ApiResponse = {
      ...textResponse('masked body'),
      late: () => (held ? textResponse('withheld', 409) : textResponse('masked body')),
    };
    held = true;
    const sent = toResponse(response, false);
    expect(sent.status).toBe(409);
    // `toResponse` is synchronous: it returns a Response, not a promise a check could be interleaved with.
    expect(sent).toBeInstanceOf(Response);
    expect(toResponse(response, true).headers.get('content-encoding')).toBeNull();
  });

  test('I74 the listener asks late only after the handler finished: a hold that began during dispatch withholds the answer', async () => {
    let held = false;
    const { tcp, ask } = await listening(async () => {
      const response: ApiResponse = {
        ...textResponse('masked body'),
        late: () => (held ? textResponse('withheld', 409) : textResponse('masked body')),
      };
      // The hold starts while the handler is still answering.
      held = true;
      return response;
    });
    const response = await ask(tcp, '127.0.0.1');
    expect(response?.status).toBe(409);
    expect(await response?.text()).toBe('withheld');
  });
});
