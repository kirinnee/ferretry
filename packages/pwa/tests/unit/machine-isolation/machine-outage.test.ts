/**
 * One machine's outage, said about that machine in words a person reads. The transport's sentence is
 * kept, but only as a Details line.
 */
import { describe, expect, it } from 'bun:test';
import type { ConnectionHealthState } from '../../../src/lib/connection-health.ts';
import {
  machineOutage,
  NOT_ANSWERING_MARK,
  readOnlyReason,
  unreachableOutage,
} from '../../../src/lib/machine-outage.ts';

const RAW =
  'could not reach fyd at http://127.0.0.1:7431 (this machine is reconnecting, so nothing was dialled for this request; the connection retries on its own schedule)';

const reconnecting = (cause: Extract<ConnectionHealthState, { kind: 'reconnecting' }>['cause']) =>
  ({
    kind: 'reconnecting',
    since: 1_000,
    attempt: 4,
    nextAttemptAt: null,
    failures: [{ label: 'Hosted relay', detail: 'no daemon holds this rendezvous (4404)' }],
    cause,
    stalled: true,
  }) as const;

describe('machineOutage', () => {
  it('is nothing while the machine answers', () => {
    expect(machineOutage('Liftoff EC2', { kind: 'connected' }, { status: 'ready', error: null })).toBeNull();
    expect(machineOutage('Liftoff EC2', { kind: 'unknown' }, { status: 'loading', error: null })).toBeNull();
  });

  it('says an asleep machine for people, and keeps the raw text for Details only', () => {
    const outage = machineOutage('Liftoff MBP', reconnecting('daemon-unreachable'), {
      status: 'error',
      error: RAW,
      readAt: 42,
    });
    expect(outage).toMatchObject({
      reason: 'daemon-unreachable',
      chip: 'Asleep · retrying',
      headline: 'Liftoff MBP isn’t reachable right now',
      retrying: true,
      since: 1_000,
      attempt: 4,
      readAt: 42,
    });
    // Nothing a person reads names an address.
    expect(`${outage?.chip} ${outage?.headline} ${outage?.advice}`).not.toContain('127.0.0.1');
    expect(outage?.technical.map(line => line.label)).toEqual(['Hosted relay', 'Last request']);
    expect(outage?.technical[1]?.detail).toBe(RAW);
  });

  it('words every cause', () => {
    const chips = (['device-offline', 'relay-unreachable', 'unknown'] as const).map(
      cause => machineOutage('M', reconnecting(cause), { status: 'ready', error: null })?.chip,
    );
    expect(chips).toEqual(['No network · retrying', 'Relay down · retrying', 'Unreachable · retrying']);
    expect(machineOutage('M', reconnecting('device-offline'), { status: 'ready', error: null })?.headline).toBe(
      'This device is offline',
    );
  });

  it('tells a read that timed out from one that failed, on a carrier that is fine', () => {
    const silent = machineOutage(
      'Studio',
      { kind: 'connected' },
      { status: 'error', error: `the machine ${NOT_ANSWERING_MARK} 15s` },
    );
    expect(silent).toMatchObject({ reason: 'not-answering', chip: 'Not answering', retrying: false });
    expect(silent?.headline).toBe('Studio isn’t answering right now');
    const failed = machineOutage('Studio', { kind: 'connected' }, { status: 'error', error: 'HTTP 500' });
    expect(failed).toMatchObject({ reason: 'refresh-failed', headline: 'Studio couldn’t refresh its sessions' });
  });

  it('keeps a failure through the retry that follows it', () => {
    expect(machineOutage('Studio', { kind: 'unknown' }, { status: 'loading', error: 'HTTP 500' })).not.toBeNull();
  });

  it('gives an offline machine with no recorded failure a reason anyway, and a read-only sentence', () => {
    const outage = unreachableOutage('Laptop', { error: null });
    expect(outage).toMatchObject({ chip: 'Unreachable', headline: 'Laptop isn’t reachable right now', readAt: null });
    expect(outage.technical).toEqual([]);
    expect(readOnlyReason(outage)).toBe(
      'Laptop isn’t reachable right now. These sessions are its last known state and are read-only until it answers.',
    );
  });
});

describe('machineOutage and a blip', () => {
  it('says nothing about a reconnect that has not stalled, unless asked to say it at once', () => {
    const blip = { ...reconnecting('relay-unreachable'), stalled: false };
    expect(machineOutage('M', blip, { status: 'loading', error: null })).toBeNull();
    expect(machineOutage('M', blip, { status: 'loading', error: null }, { immediate: true })?.chip).toBe(
      'Relay down · retrying',
    );
    // A failed read is news whatever the carrier is doing.
    expect(machineOutage('M', blip, { status: 'error', error: 'HTTP 500' })?.chip).toBe('Relay down · retrying');
  });
});
