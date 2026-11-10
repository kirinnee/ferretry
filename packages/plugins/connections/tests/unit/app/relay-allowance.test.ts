/**
 * R159 — a browser shows an exhausted hosted-relay allowance, its reset in the person's LOCAL time, and that direct still
 * works; the byte-ceiling refusals are labelled "Hosted relay". The sentence is ported from v4's
 * `packages/pwa/tests/unit/relay-allowance.test.ts`; the router half from `relay-carrier-reconnect.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { type PairedDaemon, RELAY_CLOSE_CODES } from '@ferretry/app';
import { connector, fakeDeviceClaims, WebCryptoRelayCrypto } from '@ferretry/app/testing';
import { CarrierRouter } from '../../../app/carriers/router.ts';
import type { CarrierOutage } from '../../../app/lib/connection-health.ts';
import { hostedAllowanceSentence } from '../../../app/lib/relay-allowance.ts';
import { HOSTED_RELAY_BANDWIDTH_REASONS, hostedBandwidthReason } from '../../../worker/src/lib/index.ts';
import { BrowserNetwork, HandTimers } from '../../support/browser-network.ts';
import { kernelFixture } from '../../support/kernel-session.ts';

const RESET = Date.UTC(2026, 9, 22);
const clock = (epochMilliseconds: number) => (epochMilliseconds === RESET ? '8:00 AM' : 'another time');
const COMES_BACK = 'Direct connections still work.';

describe('R159 the hosted relay data allowance sentence', () => {
  const sentence = (scope: 'daemon' | 'global', window: 'minute' | 'day') =>
    hostedAllowanceSentence(hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS[scope][window], RESET), clock);

  test('R159 says what ran out, when it resets in local time, and that direct still works', () => {
    expect(sentence('daemon', 'day')).toBe(
      `Today's relay data allowance for this machine is used up (resets at 8:00 AM). ${COMES_BACK}`,
    );
    expect(sentence('daemon', 'minute')).toBe(
      `This machine has used its relay data allowance for this minute (resets at 8:00 AM). ${COMES_BACK}`,
    );
    expect(sentence('global', 'day')).toBe(
      `Ferretry's relay has used today's data allowance for every machine (resets at 8:00 AM). ${COMES_BACK}`,
    );
    expect(sentence('global', 'minute')).toBe(
      `Ferretry's relay is at its data limit for this minute (resets at 8:00 AM). ${COMES_BACK}`,
    );
  });

  test('R159 states the reset rule for a relay too old to carry the instant', () => {
    expect(hostedAllowanceSentence(HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day, clock)).toContain(
      '(resets at midnight UTC)',
    );
    expect(hostedAllowanceSentence(HOSTED_RELAY_BANDWIDTH_REASONS.global.minute, clock)).toContain(
      '(resets within a minute)',
    );
  });

  test('R159 formats in this device’s locale by default and leaves any other refusal alone', () => {
    const local = hostedAllowanceSentence(hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day, RESET));
    expect(local).toContain(new Date(RESET).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    expect(hostedAllowanceSentence('hosted relay is disabled')).toBeUndefined();
    // The browser reads the Worker's own grammar: a reason it wrote is a reason the browser recognises.
    for (const scope of ['daemon', 'global'] as const) {
      for (const window of ['minute', 'day'] as const) {
        expect(sentence(scope, window)).toBeDefined();
        expect(hostedAllowanceSentence(HOSTED_RELAY_BANDWIDTH_REASONS[scope][window])).toBeDefined();
      }
    }
  });
});

const shellCrypto = new WebCryptoRelayCrypto();
const DIRECT = 'https://laptop.example.test';
const RELAY = 'wss://relay.example';

async function failedWalk(reason: string) {
  const fx = await kernelFixture();
  const device = await fx.paired();
  const network = new BrowserNetwork(fx, {
    [new URL(DIRECT).host]: { kind: 'dead' },
    [new URL(RELAY).host]: { kind: 'absent', code: RELAY_CLOSE_CODES.hostedBandwidth, reason },
  });
  const outages: CarrierOutage[] = [];
  const router = new CarrierRouter({
    openSocket: network.openSocket,
    after: new HandTimers().after,
    now: () => 0,
    preference: () => 'auto',
    hostedRelay: async () => undefined,
    health: {
      answered: () => undefined,
      outage: (_daemonId: string, outage: CarrierOutage) => {
        outages.push(outage);
      },
    } as never,
  });
  const daemon: PairedDaemon = {
    daemon: fx.daemonId,
    machine: 'laptop',
    deviceId: device.deviceId,
    address: DIRECT,
    carriers: [
      { kind: 'direct', url: DIRECT },
      { kind: 'relay', url: RELAY },
    ],
    pairedAt: 1,
    lastSelectedAt: 1,
  };
  const claims = fakeDeviceClaims({
    claims: {
      [fx.daemonId]: {
        deviceId: device.deviceId,
        key: shellCrypto.deviceKeyHandle(device.privateKey),
        appSession: device.appSession,
      },
    },
  });
  const transport = await connector({
    crypto: shellCrypto,
    claims,
    carriers: [router.dialer()],
    direct: () => {
      throw new Error('the shell’s own direct dial is not used once Connections registered a carrier');
    },
  })(daemon);
  if (transport === undefined) throw new Error('no transport');
  const failure = await transport.request({ method: 'GET', path: '/v1/projects' }).catch((error: unknown) => error);
  fx.layer.close();
  return { outages, failure, router, daemonId: fx.daemonId };
}

describe('R159 a spent hosted relay allowance on the walk', () => {
  test('R159 names the relay "Hosted relay" and reports the allowance in plain words with the local reset', async () => {
    const { outages, failure } = await failedWalk(
      hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day, RESET),
    );
    expect(failure).toBeInstanceOf(Error);
    const outage = outages.at(-1);
    if (outage === undefined) throw new Error('the walk reported no outage');
    const [direct, relayed] = outage.failures;
    expect(direct?.label).toBe('Direct');
    expect(relayed?.label).toBe('Hosted relay');
    expect(relayed?.detail).toStartWith("Today's relay data allowance for this machine is used up (resets at ");
    expect(relayed?.detail).toContain(
      new Date(RESET).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    );
    expect(relayed?.detail).toContain(COMES_BACK);
    // The operator's words and the numeric code stay out of the person's sentence.
    expect(relayed?.detail).not.toContain('bandwidth ceiling');
  });

  test('R159 any other refusal keeps the relay’s own words and its close code', async () => {
    const { outages } = await failedWalk('hosted relay is disabled');
    const relayed = outages.at(-1)?.failures[1];
    expect(relayed?.label).toBe('Hosted relay');
    expect(relayed?.detail).toBe(`hosted relay is disabled (${String(RELAY_CLOSE_CODES.hostedBandwidth)})`);
  });
});
