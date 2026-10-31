import { describe, expect, it } from 'bun:test';
import { AUDIT_EVENTS, FULL_DEVICE_GRANTS, type PairedDevice, type PairedDevicesView } from '@ferretry/protocol';
import {
  AUDIT_EVENT_WORDS,
  absoluteWords,
  allSeen,
  auditActorWords,
  auditDetailWords,
  auditOutcomeBadge,
  deviceLabel,
  devicesNotSeen,
  firstLookSeen,
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
  idleExpiresAt: createdAt,
  grants: FULL_DEVICE_GRANTS,
});

describe('security log words', () => {
  it('has a plain sentence for every event the wire can carry', () => {
    expect(Object.keys(AUDIT_EVENT_WORDS).toSorted()).toEqual([...AUDIT_EVENTS].toSorted());
    expect(AUDIT_EVENT_WORDS['device.paired']).toBe('A device was paired');
    expect(AUDIT_EVENT_WORDS['step-up.failed']).toBe('Passkey confirmation failed');
    expect(AUDIT_EVENT_WORDS['step-up.succeeded']).toBe('Passkey confirmation passed');
    expect(AUDIT_EVENT_WORDS['catalog.share.minted']).toBe('A catalog share code was made');
    expect(AUDIT_EVENT_WORDS['catalog.share.ended']).toBe('A catalog share code was ended');
    expect(AUDIT_EVENT_WORDS['catalog.member.revoked']).toBe('A person who reads shared catalogs was removed');
    expect(AUDIT_EVENT_WORDS['catalog.member.key-removed']).toBe(
      'One browser of a person who reads shared catalogs was removed',
    );
    expect(AUDIT_EVENT_WORDS['catalog.member.catalog-removed']).toBe('A shared catalog was taken away from a person');
    expect(AUDIT_EVENT_WORDS['catalog.share.cross-member']).toBe(
      "A share code made for one person was used by another person's browser",
    );
    expect(Object.values(AUDIT_EVENT_WORDS).join(' ')).not.toContain('Password confirmation');
  });

  it('names who did it the way a person would', () => {
    expect(auditActorWords({ kind: 'host' })).toBe('this computer');
    expect(auditActorWords({ kind: 'warden' })).toBe('a supervising agent');
    expect(auditActorWords({ kind: 'anonymous' })).toBe('someone who is not paired');
    const id = 'fy_device_id_abcdef123456';
    expect(auditActorWords({ kind: 'device', deviceId: id, deviceName: 'Pixel 8' })).toBe('device “Pixel 8” (…123456)');
    expect(auditActorWords({ kind: 'device', deviceId: id })).toBe('device …123456');
    expect(auditActorWords({ kind: 'device', deviceName: 'Pixel 8' })).toBe('device “Pixel 8”');
    expect(auditActorWords({ kind: 'device' })).toBe('a paired device');
  });

  it('never lets a chosen name read as this computer', () => {
    const words = auditActorWords({
      kind: 'device',
      deviceId: 'fy_device_id_abcdef123456',
      deviceName: 'this computer',
    });
    expect(words).not.toBe(auditActorWords({ kind: 'host' }));
    expect(words).toBe('device “this computer” (…123456)');
  });

  it('reads a record detail as sorted short facts', () => {
    const base = { at: ago(0), event: 'terminal.input', outcome: 'succeeded', actor: { kind: 'host' } } as const;
    expect(auditDetailWords(base)).toBe('');
    expect(auditDetailWords({ ...base, detail: { count: 3, carrier: 'relay' } })).toBe('carrier: relay · count: 3');
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

describe('devices this browser has not seen', () => {
  const view: PairedDevicesView = {
    devices: [
      device('old', ago(2 * DAY)),
      device('yesterday', ago(DAY)),
      device('me', ago(MINUTE)),
      device('newer', ago(2 * MINUTE)),
      device('newest', ago(MINUTE)),
    ],
    hostLocal: false,
    thisDeviceId: 'me',
    mayWiden: FULL_DEVICE_GRANTS,
  };

  it('lists only unseen devices, newest first, never this one', () => {
    expect(devicesNotSeen(view, new Set(['old'])).map(entry => entry.id)).toEqual(['newest', 'newer', 'yesterday']);
    expect(devicesNotSeen(view, allSeen(view))).toEqual([]);
    expect([...allSeen(null)]).toEqual([]);
  });

  it('on a first look, sees only what was paired over a day before the newest, by the daemon clock', () => {
    expect([...firstLookSeen(view)]).toEqual(['old']);
    // A browser clock a year off changes nothing: only the createdAt values on the list are compared.
    const later: PairedDevicesView = {
      ...view,
      devices: view.devices.map(entry => ({
        ...entry,
        createdAt: new Date(Date.parse(entry.createdAt) + 365 * DAY).toISOString(),
      })),
    };
    expect([...firstLookSeen(later)]).toEqual(['old']);
    expect([...firstLookSeen({ ...view, devices: [device('bad', 'x')] })]).toEqual(['bad']);
  });

  it('says what happened, over what, when, and what removing it did', () => {
    const pixel = { ...device('fy_device_id_abcdef123456', ago(5 * MINUTE), 'Pixel 8'), pairedOver: 'relay' as const };
    expect(deviceLabel(pixel)).toBe('“Pixel 8” (…123456)');
    expect(newDeviceNoticeText(pixel, 'workstation', NOW)).toBe(
      `A device calling itself “Pixel 8” (…123456) was paired with workstation over the relay 5 minutes ago (${absoluteWords(pixel.createdAt)}).`,
    );
    const { pairedOver: _, ...unknown } = pixel;
    expect(newDeviceNoticeText(unknown, 'workstation', NOW)).toBe(
      `A device calling itself “Pixel 8” (…123456) was paired with workstation 5 minutes ago (${absoluteWords(pixel.createdAt)}).`,
    );
    expect(newDeviceNoticeText({ ...pixel, pairedOver: 'direct' }, 'w', NOW)).toContain('on the local network');
    expect(removedDeviceText(pixel, 'workstation')).toBe(
      '“Pixel 8” (…123456) was removed. It can no longer reach workstation.',
    );
  });
});
