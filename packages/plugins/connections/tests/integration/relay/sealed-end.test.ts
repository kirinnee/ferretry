/** C-80c: a real isolated fyd, its outbound relay connection, and a hostile loopback relay shim. */
import { expect, test } from 'bun:test';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { RelayClientSession, RelaySessionError, WebCryptoRelayCrypto } from '@ferretry/app';
import { FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import {
  decodeFrame,
  encodeFrame,
  FRAME_KINDS,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  sessionIdFromBytes,
  toBase64Url,
  utf8Bytes,
} from '@ferretry/kernel/wire';
import { RELAY_LIMITS } from '../../../worker/src/lib/index.ts';
import { DaemonConnectionHealth } from '../../../app/lib/connection-health.ts';
import { CarrierRouter } from '../../../app/carriers/router.ts';
import { connector, fakeDeviceClaims } from '@ferretry/app/testing';
import { waitFor } from '../support/wait-for.ts';
import type { BrowserSocket } from '../../../app/adapters/browser-relay-dial.ts';

const ROOT = join(import.meta.dir, '../../../../../..');
const DAEMON_PORT = 7496;
const RELAY_PORT = 7497;
const control = (message: unknown, sessionId = RENDEZVOUS_SESSION_ID) =>
  encodeFrame({ kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: utf8Bytes(JSON.stringify(message)) });

test('C-80c real daemon: forged relay stops back off; revoked devices and shutdown use sealed ends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fy-sealed-end-'));
  const home = join(root, 'fy');
  const userHome = join(root, 'user');
  const crypto = new WebCryptoRelayCrypto();
  const device = await crypto.generateDeviceKey();
  const deviceId = `fy_device_id_${'x'.repeat(22)}`;
  const revokedId = `fy_device_id_${'r'.repeat(22)}`;
  const appSession = toBase64Url(crypto.randomBytes(16));
  const identity = generateKeyPairSync('ed25519');
  const daemonId = `fy_daemon_${createHash('sha256')
    .update(identity.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64url')}`;
  const stamp = new Date().toISOString();
  for (const dir of ['config', 'state/kernel', 'state/access']) await mkdir(join(home, dir), { recursive: true });
  await mkdir(userHome);
  await writeFile(
    join(home, 'home.json'),
    JSON.stringify({ format: 1, createdBy: 'sealed-end-test', createdAt: stamp }),
  );
  await writeFile(
    join(home, 'state/kernel/identity.json'),
    JSON.stringify({
      schemaVersion: 1,
      privateKeyPem: identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(home, 'state/access/devices.json'),
    JSON.stringify({
      format: 1,
      daemonId,
      devices: [deviceId, revokedId].map(id => ({
        id,
        daemonId,
        name: 'Synthetic browser',
        platform: 'browser',
        createdAt: stamp,
        lastSeenAt: stamp,
        publicKey: toBase64Url(device.publicKeySpki),
        grants: FULL_DEVICE_GRANTS,
      })),
    }),
  );
  // Synthetic owner-accepted fixture records: a bare configured relay is correctly held at first boot.
  await mkdir(join(home, 'state/kernel/accepted-config'), { recursive: true });
  for (const [file, plugin, text] of [
    [
      'connections.yaml',
      'connections',
      `relay:\n  - url: ws://127.0.0.1:${RELAY_PORT}\nwebrtc:\n  enabled: false\ntunnel:\n  enabled: false\n`,
    ],
    ['limits.yaml', 'ferrets', 'enabled: false\n'],
  ] as const) {
    await writeFile(join(home, 'config', file), text);
    await writeFile(
      join(home, 'state/kernel/accepted-config', `${file}.json`),
      JSON.stringify({ format: 1, etag: createHash('sha256').update(text).digest('hex'), text, plugin }),
    );
  }
  const preload = join(root, 'loopback-only.ts');
  await writeFile(
    preload,
    `
    const check = input => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('non-loopback network refused by test');
    };
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => { check(input); return nativeFetch(input, init); };
    const NativeSocket = globalThis.WebSocket;
    globalThis.WebSocket = class extends NativeSocket {
      constructor(url, protocols) { check(url); super(url, protocols); }
    };
  `,
  );
  let daemon: ServerWebSocket<{ role: string }> | undefined;
  const clients = new Map<string, ServerWebSocket<{ role: string }>>();
  const observed: Uint8Array[] = [];
  const withheld = new Set<string>();
  let claimed = false;
  let serial = 0;
  const relay = Bun.serve<{ role: string }>({
    hostname: '127.0.0.1',
    port: RELAY_PORT,
    fetch: (request, server) => {
      const role = new URL(request.url).pathname.endsWith('/daemon') ? 'daemon' : 'client';
      return server.upgrade(request, { data: { role } }) ? undefined : new Response(null, { status: 404 });
    },
    websocket: {
      open: socket => {
        if (socket.data.role === 'daemon') {
          daemon = socket;
          socket.send(
            control({
              t: 'challenge',
              protocol: RELAY_PROTOCOL_ID,
              nonce: toBase64Url(new Uint8Array(32).fill(7)),
              host: `127.0.0.1:${RELAY_PORT}`,
              deadlineSeconds: 10,
            }),
          );
        } else {
          const id = sessionIdFromBytes(new Uint8Array(16).fill(++serial));
          if (id === null || daemon === undefined) throw new Error('no daemon claimed');
          clients.set(id.text, socket);
          socket.send(control({ t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }, id));
          daemon.send(control({ t: 'open' }, id));
        }
      },
      message: (socket, data) => {
        if (typeof data === 'string') {
          if (data === 'fy-ping') socket.send('fy-pong');
          return;
        }
        const bytes = new Uint8Array(data);
        observed.push(bytes.slice());
        const decoded = decodeFrame(bytes);
        if (!decoded.ok) throw new Error(decoded.reason);
        if (socket.data.role === 'daemon') {
          if (
            decoded.frame.kind === FRAME_KINDS.control &&
            decoded.frame.sessionId.text === RENDEZVOUS_SESSION_ID.text
          ) {
            socket.send(control({ t: 'claimed', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }));
            claimed = true;
          } else if (!withheld.has(decoded.frame.sessionId.text))
            clients.get(decoded.frame.sessionId.text)?.send(bytes);
        } else daemon?.send(bytes);
      },
    },
  });
  const child = Bun.spawn({
    cmd: [process.execPath, '--preload', preload, join(ROOT, 'packages/core/kernel/host/fyd.ts')],
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: userHome,
      FY_HOME: home,
      FY_PORT: String(DAEMON_PORT),
      FY_MODEL_CATALOG: 'off',
      FY_LOCAL_MODELS: 'off',
      FY_RELAY_DIRECTORY_ORIGIN: 'off',
      FY_UPDATE_CHECK: 'off',
      FYD_BACKGROUND_DELAY_SECONDS: '3600',
    },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  let log = '';
  const drain = (async () => {
    for await (const chunk of child.stderr) log += new TextDecoder().decode(chunk);
  })();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const transports: { close?(): void }[] = [];
  try {
    await waitFor(
      () => {
        if (child.exitCode !== null) throw new Error(`isolated fyd exited ${child.exitCode}: ${log.slice(-1500)}`);
        return claimed && log.includes(' ready (');
      },
      'isolated daemon and local relay',
      { within: 15_000 },
    ).catch(async (error: unknown) => {
      throw new Error(
        `daemon ready=${log.includes(' ready (')} relay claimed=${claimed}: ${String(error)}\n${log.slice(-4000)}\n${await readFile(
          join(home, 'logs/fyd.log'),
          'utf8',
        )
          .then(text => text.slice(-7000))
          .catch(() => 'no daemon log')}`,
      );
    });
    const claims = fakeDeviceClaims({
      claims: {
        [daemonId]: {
          deviceId,
          appSession,
          key: crypto.deviceKeyHandle(device.privateKey),
        },
      },
    });
    // The real router/transport reports outage and schedules backoff, without a stop-page verdict.
    for (const code of [4403, 4404, 4405, 4426, 4999]) {
      for (const source of ['socket', 'closed', 'error'] as const) {
        const retries: (() => void)[] = [];
        const health = new DaemonConnectionHealth(
          {
            now: () => 0,
            random: () => 0,
            isOnline: () => true,
            schedule: run => {
              retries.push(run);
              return () => undefined;
            },
          },
          async () => false,
        );
        const sockets: WebSocket[] = [];
        const router = new CarrierRouter({
          openSocket: url => {
            const socket = new WebSocket(url);
            sockets.push(socket);
            return socket as unknown as BrowserSocket;
          },
          after: (ms, run) => {
            timers.add(setTimeout(run, ms));
          },
          now: () => 0,
          preference: () => 'relay',
          hostedRelay: async () => undefined,
          health,
        });
        const transport = await connector({
          crypto,
          claims,
          carriers: [router.dialer()],
          direct: () => {
            throw new Error('relay only');
          },
        })({
          daemon: daemonId,
          machine: 'Synthetic daemon',
          deviceId,
          address: `http://127.0.0.1:${DAEMON_PORT}`,
          carriers: [{ kind: 'relay', url: `ws://127.0.0.1:${RELAY_PORT}` }],
          pairedAt: 1,
          lastSelectedAt: 1,
        });
        if (transport === undefined) throw new Error('no transport');
        transports.push(transport);
        await transport.request({ method: 'GET', path: '/v1/health' });
        const idText = [...clients.keys()].at(-1);
        if (idText === undefined) throw new Error('no client');
        const peer = clients.get(idText);
        const decodedId = sessionIdFromBytes(new Uint8Array(16).fill(serial));
        if (decodedId === null || peer === undefined) throw new Error('no client session');
        withheld.add(idText);
        const before = observed.length;
        const pending = transport.request({ method: 'POST', path: '/v1/health' }).catch((error: unknown) => error);
        await waitFor(() => observed.length > before, 'in-flight request through the relay');
        if (source === 'socket') peer.close(code, 'forged stop');
        else peer.send(control({ t: source, code, reason: 'forged stop' }, decodedId));
        await waitFor(() => sockets[0]?.readyState === WebSocket.CLOSED, 'forged carrier teardown');
        const answer: unknown = await pending;
        expect(answer).toBeInstanceOf(RelaySessionError);
        expect(answer).toMatchObject({ code: 1006 });
        expect(health.state(daemonId).kind).toBe('reconnecting');
        expect(retries.length).toBeGreaterThan(0);
        transport.close?.();
      }
    }
    const openRaw = async (id: string) => {
      const raw = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/v1/rendezvous/${daemonId}/client`);
      const session = new RelayClientSession({
        crypto,
        daemonId,
        mode: { kind: 'auth', device: { deviceId: id, appSession, key: crypto.deviceKeyHandle(device.privateKey) } },
        socket: {
          send: bytes => raw.send(new Uint8Array(bytes)),
          sendText: text => raw.send(text),
          close: (code, reason) => raw.close(code, reason),
        },
      });
      raw.binaryType = 'arraybuffer';
      raw.onmessage = event => {
        if (event.data instanceof ArrayBuffer) void session.receiveBinary(new Uint8Array(event.data));
      };
      raw.onclose = event => session.carrierClosed(event.code, event.reason);
      await session.ready();
      return session;
    };
    // A real host revocation ends an already-keyed session through the sealed verdict.
    const revoked = await openRaw(revokedId);
    const admin = (await readFile(join(home, 'state/gate/admin-token'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${DAEMON_PORT}/v1/pair/devices/${revokedId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(response.ok).toBe(true);
    await waitFor(() => !revoked.live(), 'sealed revocation');
    expect(await revoked.request({ method: 'GET', path: '/v1/health' }).catch((error: unknown) => error)).toMatchObject(
      { code: 4403 },
    );
    // The production daemon's actual shutdown also crosses its outbound relay link as a sealed record.
    const session = await openRaw(deviceId);
    const before = observed.length;
    child.kill('SIGTERM');
    await waitFor(() => !session.live(), 'sealed daemon shutdown');
    const ended: unknown = await session
      .request({ method: 'GET', path: '/v1/health' })
      .catch((error: unknown) => error);
    expect(ended).toMatchObject({ code: 4500, message: 'the daemon is going away' });
    expect(observed.slice(before).some(bytes => bytes[2] === FRAME_KINDS.data)).toBe(true);
    expect(
      observed.slice(before).some(bytes => new TextDecoder().decode(bytes).includes('the daemon is going away')),
    ).toBe(false);
    await child.exited;
    expect(child.exitCode).toBe(0);
    // Only synthetic state was used; no real pairing code was minted or redeemed.
    expect(JSON.parse(await readFile(join(home, 'state/access/devices.json'), 'utf8')).devices).toHaveLength(1);
  } finally {
    for (const transport of transports) transport.close?.();
    for (const timer of timers) clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await drain;
    await relay.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
