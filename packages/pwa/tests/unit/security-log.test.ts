import { describe, expect, it } from 'bun:test';
import { AUDIT_EVENTS, type PairedDevice, type PairedDevicesView } from '@ferretry/protocol';
import {
  AUDIT_EVENT_WORDS,
  absoluteWords,
  auditActorWords,
  auditOutcomeBadge,
  devicesPairedSince,
  lookedInstant,
  newDeviceNoticeText,
  relativeWords,
  removedDeviceText,
  securityLogGapWarning,
} from '../../src/lib/security-log.ts';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const device = (id: string, createdAt: string, name = id): PairedDevice => ({
  id,
  name,
  platform: 'browser',
  createdAt,
  lastSeenAt: createdAt,
});

describe('security log words', () => {
  it('has a plain sentence for every event the wire can carry', () => {
    expect(Object.keys(AUDIT_EVENT_WORDS).toSorted()).toEqual([...AUDIT_EVENTS].toSorted());
    expect(AUDIT_EVENT_WORDS['device.paired']).toBe('A device was paired');
    expect(AUDIT_EVENT_WORDS['step-up.failed']).toBe('Password confirmation failed');
  });

  it('names who did it the way a person would', () => {
    expect(auditActorWords({ kind: 'host' })).toBe('this computer');
    expect(auditActorWords({ kind: 'warden' })).toBe('a supervising agent');
    expect(auditActorWords({ kind: 'anonymous' })).toBe('someone who is not paired');
    expect(auditActorWords({ kind: 'device', deviceId: 'd1', deviceName: 'Pixel 8' })).toBe('Pixel 8');
    expect(auditActorWords({ kind: 'device', deviceId: 'd1' })).toBe('a paired device');
  });

  it('badges only what was refused or failed', () => {
    expect(auditOutcomeBadge('succeeded')).toBeNull();
    expect(auditOutcomeBadge('refused')).toBe('Refused');
    expect(auditOutcomeBadge('failed')).toBe('Failed');
  });

  it('says a damaged log has gaps, in the singular and the plural', () => {
    expect(securityLogGapWarning(1)).toBe('1 entry in this log could not be read. The history has gaps.');
    expect(securityLogGapWarning(3)).toBe('3 entries in this log could not be read. The history has gaps.');
  });

  it('says how long ago in words', () => {
    expect(relativeWords(ago(10_000), NOW)).toBe('just now');
    expect(relativeWords(ago(-30_000), NOW)).toBe('just now');
    expect(relativeWords(ago(MINUTE), NOW)).toBe('1 minute ago');
    expect(relativeWords(ago(5 * MINUTE), NOW)).toBe('5 minutes ago');
    expect(relativeWords(ago(HOUR), NOW)).toBe('1 hour ago');
    expect(relativeWords(ago(3 * HOUR), NOW)).toBe('3 hours ago');
    expect(relativeWords(ago(DAY), NOW)).toBe('yesterday');
    expect(relativeWords(ago(4 * DAY), NOW)).toBe('4 days ago');
    expect(relativeWords('not a time', NOW)).toBe('at an unknown time');
  });

  it('gives the exact instant, or the raw text when it is unreadable', () => {
    expect(absoluteWords(ago(0))).toBe(new Date(NOW).toLocaleString());
    expect(absoluteWords('garbled')).toBe('garbled');
  });
});

describe('devices paired since this browser last looked', () => {
  const view: PairedDevicesView = {
    devices: [
      device('old', ago(DAY)),
      device('me', ago(MINUTE)),
      device('newer', ago(2 * MINUTE)),
      device('newest', ago(MINUTE)),
    ],
    hostLocal: false,
    thisDeviceId: 'me',
  };

  it('lists only later devices, newest first, never this one', () => {
    expect(devicesPairedSince(view, NOW - HOUR).map(entry => entry.id)).toEqual(['newest', 'newer']);
    expect(devicesPairedSince(view, NOW)).toEqual([]);
  });

  it('remembers no earlier than now, and no earlier than the newest device shown', () => {
    expect(lookedInstant(null, NOW)).toBe(NOW);
    expect(lookedInstant(view, NOW)).toBe(NOW);
    const ahead = { ...view, devices: [device('skewed', new Date(NOW + 5_000).toISOString()), device('bad', 'x')] };
    expect(lookedInstant(ahead, NOW)).toBe(NOW + 5_000);
  });

  it('says what happened and what removing it did', () => {
    expect(newDeviceNoticeText(device('p', ago(5 * MINUTE), 'Pixel 8'), 'workstation', NOW)).toBe(
      'A new device, Pixel 8, was paired with workstation 5 minutes ago.',
    );
    expect(removedDeviceText(device('p', ago(0), 'Pixel 8'), 'workstation')).toBe(
      'Pixel 8 was removed. It can no longer reach workstation.',
    );
  });
});
