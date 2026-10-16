import { describe, expect, it } from 'bun:test';
import { RELAY_CLOSE_CODES } from '@ferretry/relay';
import { describePairingUnreachable, PairingUnreachableError } from '../../src/lib/pairing-unreachable.ts';

const RELAY = 'https://relay.example.test';

describe('describePairingUnreachable', () => {
  it('says a loopback address means "this computer itself", in every loopback spelling', () => {
    for (const address of ['http://127.0.0.1:7431', 'http://localhost:7431', 'http://[::1]:7431']) {
      const sentence = describePairingUnreachable([{ kind: 'direct', address, code: 1006 }]);
      expect(sentence).toContain('"this computer itself"');
      expect(sentence).toContain(new URL(address).host);
    }
  });

  it('names a reachable-looking direct address as one this device could not reach', () => {
    const sentence = describePairingUnreachable([{ kind: 'direct', address: 'http://192.168.1.20:7431' }]);
    expect(sentence).toContain('could not reach the machine directly at 192.168.1.20:7431');
    expect(sentence).not.toContain('this computer itself');
  });

  it('gives each relay close its own remedy', () => {
    const relay = (code?: number) =>
      describePairingUnreachable([{ kind: 'relay', address: RELAY, ...(code === undefined ? {} : { code }) }]);
    expect(relay(RELAY_CLOSE_CODES.daemonAbsent)).toContain('the machine is not connected to it right now');
    expect(relay(RELAY_CLOSE_CODES.hostedDisabled)).toContain('is switched off right now');
    for (const busy of [
      RELAY_CLOSE_CODES.rendezvousBusy,
      RELAY_CLOSE_CODES.hostedCapacity,
      RELAY_CLOSE_CODES.hostedBandwidth,
    ]) {
      expect(relay(busy)).toContain('is busy right now');
    }
    expect(relay(RELAY_CLOSE_CODES.heartbeatTimeout)).toContain('did not answer in time');
    expect(relay(1006)).toContain('could not be reached, or it failed on its side');
    expect(relay()).toContain('could not be reached, or it failed on its side');
  });

  it('says so when no relay was tried at all', () => {
    expect(describePairingUnreachable([{ kind: 'direct', address: 'http://127.0.0.1:7431' }])).toContain(
      'There was no relay to fall back to',
    );
    expect(
      describePairingUnreachable([
        { kind: 'direct', address: 'http://127.0.0.1:7431' },
        { kind: 'relay', address: RELAY },
      ]),
    ).not.toContain('There was no relay to fall back to');
  });

  it('names only a host, never a path, and survives an address that is not a URL', () => {
    const sentence = describePairingUnreachable([
      { kind: 'relay', address: `${RELAY}/v1/rendezvous/fy_daemon_secretish/client` },
      { kind: 'direct', address: 'not a url' },
    ]);
    expect(sentence).toContain('relay.example.test');
    expect(sentence).not.toContain('fy_daemon_secretish');
    expect(sentence).toContain('directly at not a url');
  });
});

describe('PairingUnreachableError', () => {
  it('carries the legs and their sentence', () => {
    const legs = [{ kind: 'direct', address: 'http://127.0.0.1:7431', code: 1006 }] as const;
    const error = new PairingUnreachableError(legs);
    expect(error.name).toBe('PairingUnreachableError');
    expect(error.legs).toEqual(legs);
    expect(error.message).toBe(describePairingUnreachable(legs));
  });
});
