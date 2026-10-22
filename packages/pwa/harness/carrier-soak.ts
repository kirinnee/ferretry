/**
 * HOW OFTEN DOES A HELD SESSION DROP, PER CARRIER — measured against a real daemon, not argued.
 *
 *   cd packages/pwa && bun harness/carrier-soak.ts [--minutes 30] [--out soak.jsonl] [--traffic-seconds 15]
 *
 * Manual, and never in CI: it pairs a LIMITED test device with the daemon on THIS host (`fy pair
 * --no-wait --limited`, redeemed over loopback), then holds one session per lane — every published
 * carrier, idle and with light traffic — for the whole run, redialling each the instant it closes. Every
 * open and close is one JSON line: the carrier, the close code and reason, how long the session lived,
 * how long since anything arrived on it, the bytes each way, and how long the redial took.
 *
 * What it runs is the PWA's own code: `redeemPairingInSession`, `openRelaySession`, `browserRelayDial`
 * and its keepalive (a `fy-ping` every 20 s, 10 s to hear anything back), over Bun's WebSocket and
 * WebCrypto. The only thing it adds is a tap on the socket, so a close is seen exactly as the session
 * saw it.
 *
 * THE CREDENTIALS NEVER LEAVE THIS PROCESS. The pairing code is read from `fy pair`'s output and handed
 * to the daemon's own pairing session; it is never printed. The device key is minted here and exists
 * only in memory. At the end the device id is printed so it can be revoked (`fy device revoke <id>`),
 * which the run does itself unless `--keep-device` is given.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parsePairingFragment } from '@ferretry/protocol';
import { APP_SESSION_BYTES, type ConnectionMethod, RELAY_CLOSE_CODES, toBase64Url } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import { mintDeviceKey } from '../src/lib/device-keys.ts';
import { pairedDaemonConnection } from '../src/lib/pairing.ts';
import { browserRelayDial, openRelaySession, type RelayCarrierSocket } from '../src/lib/relay-carrier.ts';
import { redeemPairingInSession } from '../src/lib/relay-pairing.ts';
import type { RelayClientSession, SessionDeviceClaim } from '../src/lib/relay-session.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const MINUTES = Number(flag('--minutes') ?? 30);
const TRAFFIC_MS = Number(flag('--traffic-seconds') ?? 15) * 1_000;
const OUT = flag('--out');
const KEEP_DEVICE = argv.includes('--keep-device');
const FY = process.env['FY_BIN'] ?? 'fy';

const now = (): number => Date.now();
const emit = (line: Record<string, unknown>): void => {
  const text = JSON.stringify({ at: new Date().toISOString(), ...line });
  console.log(text);
  if (OUT !== undefined) appendFileSync(OUT, `${text}\n`);
};

/* ---------- pair one limited test device over loopback --------------------- */

const minted = spawnSync(FY, ['pair', '--no-wait', '--limited'], { encoding: 'utf8' });
const fragment = /#v1;\S+/u.exec(minted.stdout)?.[0];
if (minted.status !== 0 || fragment === undefined) {
  console.error('`fy pair --no-wait --limited` did not print a pairing link');
  process.exit(1);
}
const seed = parsePairingFragment(fragment);
const crypto = new WebCryptoRelayCrypto();
const deviceKey = await mintDeviceKey(crypto);
const key = crypto.deviceKeyHandle(deviceKey.privateKey);
const pairing: ConnectionMethod & { kind: 'direct' } = { kind: 'direct', daemonUrl: seed.daemonUrl };
const response = await redeemPairingInSession({
  crypto,
  seed,
  deviceName: 'Ferretry soak test - removes itself after 45 min',
  method: pairing,
  publicKey: deviceKey.publicKey,
  key,
});
const daemon = pairedDaemonConnection(seed, response);
emit({ event: 'paired', deviceId: daemon.deviceId, carriers: daemon.carriers.map(carrier => carrier.kind) });
const device: SessionDeviceClaim = {
  deviceId: daemon.deviceId,
  key,
  appSession: toBase64Url(crypto.randomBytes(APP_SESSION_BYTES)),
};

/* ---------- one lane: a session held for the run, redialled on every close -- */

interface Lane {
  readonly name: string;
  readonly method: ConnectionMethod;
  readonly traffic: boolean;
}

interface Tap {
  lastInboundAt: number;
  bytesIn: number;
  bytesOut: number;
  closed: Promise<{ readonly code: number; readonly reason: string }>;
}

/** {@link browserRelayDial}, with every inbound message and the close observed on the way through. */
const tappedDial = (tap: Tap) => {
  let settle: (close: { code: number; reason: string }) => void = () => undefined;
  tap.closed = new Promise(resolve => {
    settle = resolve;
  });
  return (url: string): RelayCarrierSocket => {
    const inner = browserRelayDial(url);
    const outer: RelayCarrierSocket = {
      onOpen: null,
      onText: null,
      onBinary: null,
      onClose: null,
      send: bytes => {
        tap.bytesOut += bytes.byteLength;
        inner.send(bytes);
      },
      sendText: text => {
        tap.bytesOut += text.length;
        inner.sendText(text);
      },
      close: (code, reason) => inner.close(code, reason),
    };
    inner.onOpen = () => outer.onOpen?.();
    inner.onText = text => {
      tap.lastInboundAt = now();
      tap.bytesIn += text.length;
      outer.onText?.(text);
    };
    inner.onBinary = bytes => {
      tap.lastInboundAt = now();
      tap.bytesIn += bytes.byteLength;
      outer.onBinary?.(bytes);
    };
    inner.onClose = (code, reason) => {
      settle({ code, reason });
      outer.onClose?.(code, reason);
    };
    return outer;
  };
};

const ends = now() + MINUTES * 60_000;
const tally = new Map<string, { opens: number; drops: number; codes: Record<string, number>; failedOpens: number }>();

const runLane = async (lane: Lane): Promise<void> => {
  const count = { opens: 0, drops: 0, codes: {} as Record<string, number>, failedOpens: 0 };
  tally.set(lane.name, count);
  let droppedAt: number | undefined;
  while (now() < ends) {
    const tap: Tap = {
      lastInboundAt: now(),
      bytesIn: 0,
      bytesOut: 0,
      closed: Promise.resolve({ code: 0, reason: '' }),
    };
    const dialledAt = now();
    let session: RelayClientSession;
    try {
      session = await openRelaySession({
        crypto,
        daemon,
        method: lane.method,
        mode: { kind: 'auth', device },
        dial: tappedDial(tap),
        ...(lane.method.kind === 'relay' ? {} : { deadlineMs: 4_000 }),
      });
    } catch (reason) {
      count.failedOpens += 1;
      emit({ lane: lane.name, event: 'open-failed', ms: now() - dialledAt, reason: String(reason) });
      // A refused device (removed at the machine) will never open again: stop rather than loop.
      if (reason instanceof Error && reason.message.includes(String(RELAY_CLOSE_CODES.authRejected))) return;
      await Bun.sleep(1_000);
      continue;
    }
    count.opens += 1;
    const openedAt = now();
    emit({
      lane: lane.name,
      event: 'open',
      connectMs: openedAt - dialledAt,
      ...(droppedAt === undefined ? {} : { outageMs: openedAt - droppedAt }),
    });
    let requests = 0;
    let failedRequests = 0;
    const traffic = lane.traffic
      ? setInterval(() => {
          requests += 1;
          session.request({ method: 'GET', path: '/v1/tunnel' }).catch(() => {
            failedRequests += 1;
          });
        }, TRAFFIC_MS)
      : undefined;
    const stop = new Promise<'stop'>(resolve => setTimeout(() => resolve('stop'), Math.max(0, ends - now())));
    const outcome = await Promise.race([tap.closed, stop]);
    if (traffic !== undefined) clearInterval(traffic);
    if (outcome === 'stop') {
      session.close('the soak is over');
      emit({ lane: lane.name, event: 'held-to-end', durationMs: now() - openedAt, requests, failedRequests });
      return;
    }
    droppedAt = now();
    count.drops += 1;
    count.codes[String(outcome.code)] = (count.codes[String(outcome.code)] ?? 0) + 1;
    emit({
      lane: lane.name,
      event: 'close',
      code: outcome.code,
      reason: outcome.reason,
      durationMs: droppedAt - openedAt,
      lastInboundAgeMs: droppedAt - tap.lastInboundAt,
      bytesIn: tap.bytesIn,
      bytesOut: tap.bytesOut,
      requests,
      failedRequests,
      heartbeatTimeout: outcome.code === RELAY_CLOSE_CODES.heartbeatTimeout,
    });
  }
};

const carrierName = (method: ConnectionMethod): string => method.kind;
const lanes: Lane[] = daemon.carriers
  .filter(method => method.kind === 'tunnel' || method.kind === 'relay' || method.kind === 'direct')
  .flatMap(method => [
    { name: `${carrierName(method)}-idle`, method, traffic: false },
    { name: `${carrierName(method)}-traffic`, method, traffic: true },
  ]);
emit({ event: 'start', minutes: MINUTES, lanes: lanes.map(lane => lane.name) });
await Promise.all(lanes.map(runLane));

const hours = MINUTES / 60;
for (const [name, count] of tally)
  emit({ event: 'summary', lane: name, ...count, dropsPerHour: Number((count.drops / hours).toFixed(2)) });

if (!KEEP_DEVICE) {
  const revoked = spawnSync(FY, ['device', 'revoke', '--yes', daemon.deviceId], { encoding: 'utf8' });
  emit({ event: 'revoked', deviceId: daemon.deviceId, ok: revoked.status === 0 });
} else emit({ event: 'kept-device', deviceId: daemon.deviceId, revokeWith: `fy device revoke ${daemon.deviceId}` });
process.exit(0);
