import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AdmissionPort } from '@ferretry/core-gate/contract';
import { deviceStanding, FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { GatePort } from '@ferretry/core-gate/contract';
import { RelayClientSession, WebCryptoRelayCrypto } from '@ferretry/app';
import { readyFrame, testSessionId } from '@ferretry/app/testing';
import {
  headersFrom,
  isSessionEnd,
  queryFrom,
  type ApiRequest,
  type CarrierKey,
  type HolderId,
} from '@ferretry/kernel/contract';
import { bootHost, realAdapters, type RunningHost } from '@ferretry/kernel/host';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testArrival, owner } from '@ferretry/kernel/testing';
import { HOSTED_APP_ORIGIN } from '../../../../contract/index.ts';
import access from '../../../../daemon/index.ts';

/**
 * THE NAME TYPED ON THE PAIR SCREEN, THROUGH THE REAL ACCESS HALF ON THE REAL HOST: a real minted code, a real `pair`
 * session, and the REAL first-passkey options route a freshly paired device asks next. Nothing here mints a name:
 * the label on the passkey a phone's password manager saves is built by Access from what the host answers.
 *
 *  - a name typed while pairing is in the paired answer AND in both first-passkey labels (`user.name`, `user.displayName`);
 *  - no name typed: the host name, in the answer and in the labels;
 *  - a name the owner already holds survives: the answer and the labels carry it, never the typed one.
 */

const HOSTNAME = 'ip-172-27-76-90';

const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort, gate: GatePort },
});

const homes: string[] = [];
const running: RunningHost[] = [];
afterEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** The owner at the machine mints; the freshly paired device (whose id the test learns) asks for its passkey options. */
let deviceId: string | undefined;
const admission = new StandInAdmission(request =>
  request.path === '/v1/pair/code' ? ownerStanding() : deviceId === undefined ? undefined : deviceStanding(deviceId),
);

async function boot(): Promise<{ readonly host: RunningHost; readonly home: string }> {
  deviceId = undefined;
  const parent = await mkdtemp(`${tmpdir()}/fy-pair-name-`);
  homes.push(parent);
  const home = `${parent}/home`;
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    implementations: [
      implementDaemon(gate, { build: () => ({ provides: { admission, gate: new FakeGate() } }) }),
      access,
    ],
    adapters: { ...realAdapters(home, () => {}, { binary: 'fy' }), hostname: () => HOSTNAME },
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  running.push(outcome.host);
  return { host: outcome.host, home };
}

const json = (response: { readonly body: string }): Record<string, unknown> =>
  JSON.parse(response.body) as Record<string, unknown>;

function call(method: string, path: string, init: { owner?: boolean; body?: unknown } = {}): ApiRequest {
  const body = init.body === undefined ? '' : JSON.stringify(init.body);
  return {
    method,
    path,
    query: queryFrom([]),
    headers: headersFrom({}),
    arrival: init.owner === true ? testArrival(owner()) : { kind: 'carried', carrier: 'direct' as CarrierKey },
    ...(deviceId === undefined || init.owner === true
      ? {}
      : {
          principal: {
            kind: 'device' as const,
            holder: deviceId as HolderId,
            session: `transcript-${deviceId}` as never,
            appSession: `session-${deviceId}`,
            leaseUntil: '2099-01-01T00:00:00.000Z' as never,
          },
        }),
    text: async () => body,
  };
}

/** Mints a code, pairs a phone called `My phone` (with `machineName` when typed), and asks for its first passkey options. */
async function pairThenOptions(host: RunningHost, machineName: string | undefined) {
  const minted = await host.dispatch(call('POST', '/v1/pair/code', { owner: true, body: {} }));
  expect(minted.status).toBe(201);
  const code = String(json(minted).code);
  // The app's own pairing client (the one the PWA uses), joined straight to the host's session layer: no daemon socket,
  // no kernel test harness, and the typed name travels exactly as the app sends it.
  const link = host.sessionLayer.open('direct' as CarrierKey, { address: '192.0.2.9' });
  const crypto = new WebCryptoRelayCrypto();
  const key = await crypto.generateDeviceKey();
  let live = true;
  let session: RelayClientSession | undefined;
  session = new RelayClientSession({
    crypto,
    daemonId: host.identity.daemonId,
    mode: {
      kind: 'pair',
      code,
      deviceName: 'My phone',
      ...(machineName === undefined ? {} : { machineName }),
      publicKey: Buffer.from(key.publicKeySpki).toString('base64url'),
      key: crypto.deviceKeyHandle(key.privateKey),
    },
    socket: {
      send: bytes => link.inbound(bytes),
      sendText: () => {},
      close: () => {
        live = false;
      },
    },
  });
  // A direct carrier opens with its own `ready`: the session id the handshake is bound to.
  void session.receiveBinary(readyFrame(testSessionId()));
  const pulling = (async () => {
    while (live) {
      for (let next = link.outbound.next(); next !== undefined; next = link.outbound.next()) {
        if (isSessionEnd(next)) live = false;
        else session?.receiveBinary(next.bytes);
      }
      await new Promise(resolve => setTimeout(resolve, 3));
    }
  })();
  const outcome = await session.paired();
  live = false;
  await pulling;
  session.close('the pairing finished');
  const answer = outcome.response as Record<string, unknown>;
  deviceId = String(answer['deviceId']);
  const options = await host.dispatch(call('POST', '/v1/passkeys/options', { body: { origin: HOSTED_APP_ORIGIN } }));
  expect(options.status).toBe(200);
  const user = (json(options).user ?? {}) as { name?: string; displayName?: string };
  return { answer, user };
}

describe('the machine name typed while pairing, through the real Access half', () => {
  test('is in the paired answer and in both first-passkey labels', async () => {
    const { host } = await boot();
    const { answer, user } = await pairThenOptions(host, 'Studio box');
    expect(answer['daemonName']).toBe('Studio box');
    expect(user.name).toBe('My phone → Studio box');
    expect(user.displayName).toBe('Ferretry: My phone → Studio box');
    expect(`${user.name}${user.displayName}`).not.toContain(HOSTNAME);
  });

  test('no name typed: the host name is the fallback, in the answer and in both labels', async () => {
    const { host } = await boot();
    const { answer, user } = await pairThenOptions(host, undefined);
    expect(answer['daemonName']).toBe(HOSTNAME);
    expect(user.name).toBe(`My phone → ${HOSTNAME}`);
    expect(user.displayName).toBe(`Ferretry: My phone → ${HOSTNAME}`);
  });

  test('a name the owner already holds is kept: the answer and both labels carry it, never the typed one', async () => {
    const { host, home } = await boot();
    await Bun.write(`${home}/config/host.yaml`, 'name: "pebox"\n');
    const { answer, user } = await pairThenOptions(host, 'Studio box');
    expect(answer['daemonName']).toBe('pebox');
    expect(user.name).toBe('My phone → pebox');
    expect(user.displayName).toBe('Ferretry: My phone → pebox');
  });
});
