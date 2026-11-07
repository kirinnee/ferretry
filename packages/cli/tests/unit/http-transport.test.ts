import { describe, expect, it } from 'bun:test';
import { type Fetcher, HttpTransport } from '../../src/adapters/daemon/http-transport.ts';
import { assertOwnLoopbackListener, type ListenerGuardPorts } from '../../src/adapters/daemon/listener-guard.ts';
import { isLocalDaemonUrl } from '../../src/lib/address.ts';

// Synthetic fixtures only: a fake fetch, a fake socket table and a placeholder credential. No daemon, no network.
const OWN_UID = 1000;
const OTHER_UID = 2000;
const CREDENTIAL = 'Bearer unit-test-only';
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const listening = (port: number, uid: number): string =>
  `   0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${String(uid)}        0 12345 1 0000000000000000 100 0 0 10 0`;
const refused = (): Error => Object.assign(new Error('connection refused'), { code: 'ConnectionRefused' });

interface Rig {
  base: string;
  table: string;
  readonly checked: string[];
  readonly sent: { readonly url: string; readonly authorization: string | null }[];
  tokenReads: number;
  sleeps: number;
}

/** The admin transport's real wiring shape (`world.ts`): locality, then the own-listener check, then the token. */
function transportFor(rig: Rig, fetcher: Fetcher): HttpTransport {
  const ports: ListenerGuardPorts = { tables: async () => [rig.table], uid: () => OWN_UID };
  return new HttpTransport({
    baseUrl: async () => rig.base,
    authorization: async () => {
      rig.tokenReads += 1;
      return CREDENTIAL;
    },
    beforeSend: async base => {
      rig.checked.push(base);
      if (!isLocalDaemonUrl(base)) throw new Error(`refusing to send the daemon admin token to ${base}`);
      await assertOwnLoopbackListener(base, 'the daemon admin token', ports);
    },
    fetcher: async (url, init) => {
      rig.sent.push({ url, authorization: new Headers(init.headers).get('authorization') });
      return await fetcher(url, init);
    },
    restart: {
      patience: { expected: () => true, waiting: () => {} },
      nowMs: () => 0,
      sleep: async () => {
        rig.sleeps += 1;
      },
    },
  });
}

const rigAt = (base: string, table: string): Rig => ({
  base,
  table,
  checked: [],
  sent: [],
  tokenReads: 0,
  sleeps: 0,
});

describe('the transport checks every attempt (S57)', () => {
  it('S57 a resend after a refused connection finds a foreign listener on the freed port: no second send, the token is not sent again', async () => {
    const rig = rigAt('http://127.0.0.1:7457', [HEADER, listening(7457, OWN_UID)].join('\n'));
    let fetches = 0;
    const transport = transportFor(rig, async () => {
      fetches += 1;
      // The daemon stops and another local user binds the port it left free.
      rig.table = [HEADER, listening(7457, OTHER_UID)].join('\n');
      throw refused();
    });
    // The inventory read: repeatable and with no recheck of its own, exactly as `world.ts` sends it.
    await expect(transport.send({ method: 'GET', path: '/v1/plugins' }, { repeatable: true })).rejects.toThrow(
      'held by another user (uid 2000)',
    );
    expect(fetches).toBe(1);
    expect(rig.sent).toEqual([{ url: 'http://127.0.0.1:7457/v1/plugins', authorization: CREDENTIAL }]);
    expect(rig.checked).toEqual(['http://127.0.0.1:7457', 'http://127.0.0.1:7457']);
    expect(rig.tokenReads).toBe(1);
    // A refusal is final: the wait stops at it instead of trying again for a minute.
    expect(rig.sleeps).toBe(1);
  });

  it('S57 a daemon back on another port is sent to at the freshly read and checked address, never the old one', async () => {
    const rig = rigAt('http://127.0.0.1:7457', [HEADER, listening(7457, OWN_UID)].join('\n'));
    const transport = transportFor(rig, async url => {
      if (url.startsWith('http://127.0.0.1:7457')) {
        // The daemon restarts on another port; the run record now names it and the old port is someone else's.
        rig.base = 'http://127.0.0.1:7460';
        rig.table = [HEADER, listening(7457, OTHER_UID), listening(7460, OWN_UID)].join('\n');
        throw refused();
      }
      return Response.json({ ok: true });
    });
    let rechecks = 0;
    const reply = await transport.send(
      { method: 'GET', path: '/v1/plugins' },
      {
        repeatable: true,
        recheck: async () => {
          rechecks += 1;
        },
      },
    );
    expect(reply).toEqual({ status: 200, body: { ok: true } });
    expect(rechecks).toBe(1);
    expect(rig.checked).toEqual(['http://127.0.0.1:7457', 'http://127.0.0.1:7460']);
    expect(rig.sent.map(sent => sent.url)).toEqual([
      'http://127.0.0.1:7457/v1/plugins',
      'http://127.0.0.1:7460/v1/plugins',
    ]);
  });

  it('S57 an address that turns remote while the daemon is away is refused before the resend', async () => {
    const rig = rigAt('http://127.0.0.1:7457', [HEADER, listening(7457, OWN_UID)].join('\n'));
    const transport = transportFor(rig, async () => {
      rig.base = 'http://192.0.2.10:7457';
      throw refused();
    });
    await expect(transport.send({ method: 'GET', path: '/v1/plugins' }, { repeatable: true })).rejects.toThrow(
      'refusing to send the daemon admin token to http://192.0.2.10:7457',
    );
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent.every(sent => sent.url.startsWith('http://127.0.0.1:7457'))).toBe(true);
  });

  it('S57 a refusal on the first attempt sends nothing, reads no token and does not wait', async () => {
    const rig = rigAt('http://127.0.0.1:7457', [HEADER, listening(7457, OTHER_UID)].join('\n'));
    const transport = transportFor(rig, async () => Response.json({ ok: true }));
    await expect(transport.send({ method: 'GET', path: '/v1/plugins' }, { repeatable: true })).rejects.toThrow(
      'held by another user',
    );
    expect(rig.sent).toEqual([]);
    expect(rig.tokenReads).toBe(0);
    expect(rig.sleeps).toBe(0);
  });

  it('S57 a daemon that is merely away (its port free) is still waited out and then reached', async () => {
    const rig = rigAt('http://127.0.0.1:7457', HEADER);
    let fetches = 0;
    const transport = transportFor(rig, async () => {
      fetches += 1;
      if (fetches < 3) throw refused();
      rig.table = [HEADER, listening(7457, OWN_UID)].join('\n');
      return Response.json({ ok: true });
    });
    const reply = await transport.send({ method: 'GET', path: '/v1/plugins' }, { repeatable: true });
    expect(reply.status).toBe(200);
    expect(fetches).toBe(3);
    expect(rig.checked).toHaveLength(3);
    expect(rig.tokenReads).toBe(1);
  });
});

describe('the event feed goes through the same checks as a request (S57)', () => {
  class FakeFeedSocket {
    onmessage: ((event: { readonly data: unknown }) => void) | null = null;
    onclose: ((event: { readonly reason?: string; readonly code?: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed: string | undefined;
    close(_code?: number, reason?: string): void {
      this.closed = reason ?? '';
    }
  }

  function feedRig(base: string, table: string, opened: { url: string; authorization: string | undefined }[]) {
    const rig: Rig = { base, table, checked: [], sent: [], tokenReads: 0, sleeps: 0 };
    const socket = new FakeFeedSocket();
    const ports: ListenerGuardPorts = { tables: async () => [rig.table], uid: () => OWN_UID };
    const transport = new HttpTransport({
      baseUrl: async () => rig.base,
      authorization: async () => {
        rig.tokenReads += 1;
        return CREDENTIAL;
      },
      beforeSend: async checked => {
        rig.checked.push(checked);
        if (!isLocalDaemonUrl(checked)) throw new Error(`refusing to send the daemon admin token to ${checked}`);
        await assertOwnLoopbackListener(checked, 'the daemon admin token', ports);
      },
      headers: { 'x-ferretry-client': 'cli', authorization: 'Bearer not-this-one' },
      feedSocket: (url, headers) => {
        opened.push({ url, authorization: headers.authorization });
        return socket;
      },
    });
    return { rig, socket, transport };
  }

  const settle = () => Bun.sleep(5);

  it('S57 opens the feed at the freshly read address with the credential read after the check, and hands frames over raw', async () => {
    const opened: { url: string; authorization: string | undefined }[] = [];
    const { rig, socket, transport } = feedRig(
      'http://127.0.0.1:7431',
      [HEADER, listening(7431, OWN_UID)].join('\n'),
      opened,
    );
    const heard: unknown[] = [];
    transport.events(
      event => heard.push(event),
      () => {},
    );
    await settle();
    expect(opened).toEqual([{ url: 'ws://127.0.0.1:7431/v1/events', authorization: CREDENTIAL }]);
    expect(rig.checked).toEqual(['http://127.0.0.1:7431']);
    socket.onmessage?.({ data: JSON.stringify({ name: 'ferrets.changed', payload: { ferret: 'ada' } }) });
    socket.onmessage?.({ data: 'not json' });
    socket.onmessage?.({ data: JSON.stringify({ name: 'x'.repeat(129), payload: {} }) });
    expect(heard).toEqual([{ name: 'ferrets.changed', payload: { ferret: 'ada' } }]);
  });

  it('S57 a foreign listener on the daemon address ends the feed unopened and the token is never read', async () => {
    const opened: { url: string; authorization: string | undefined }[] = [];
    const { rig, transport } = feedRig(
      'http://127.0.0.1:7431',
      [HEADER, listening(7431, OTHER_UID)].join('\n'),
      opened,
    );
    const reasons: string[] = [];
    transport.events(
      () => {},
      reason => reasons.push(reason),
    );
    await settle();
    expect(opened).toEqual([]);
    expect(rig.tokenReads).toBe(0);
    expect(reasons.length).toBe(1);
  });

  it('S57 a remote address ends the feed unopened', async () => {
    const opened: { url: string; authorization: string | undefined }[] = [];
    const { rig, transport } = feedRig('http://example.test:7431', '', opened);
    const reasons: string[] = [];
    transport.events(
      () => {},
      reason => reasons.push(reason),
    );
    await settle();
    expect(opened).toEqual([]);
    expect(rig.tokenReads).toBe(0);
    expect(reasons[0]).toContain('refusing to send the daemon admin token');
  });

  it('says why the daemon closed the feed once, and says nothing after a cancel', async () => {
    const opened: { url: string; authorization: string | undefined }[] = [];
    const { socket, transport } = feedRig(
      'http://127.0.0.1:7431',
      [HEADER, listening(7431, OWN_UID)].join('\n'),
      opened,
    );
    const reasons: string[] = [];
    const cancel = transport.events(
      () => {},
      reason => reasons.push(reason),
    );
    await settle();
    socket.onclose?.({ reason: '' });
    socket.onerror?.();
    expect(reasons).toEqual(['the daemon closed the event feed']);
    cancel();
    expect(socket.closed).toBe('cancelled');
  });
});
