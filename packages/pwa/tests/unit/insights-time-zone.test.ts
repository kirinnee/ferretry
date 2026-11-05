import { afterEach, describe, expect, it } from 'bun:test';

import '../support/dom.ts';
import {
  DEVICE_TIME_ZONE,
  INSIGHTS_TIME_ZONE_KEY,
  insightsTimeZonePreference,
  knownTimeZones,
  resolveInsightsTimeZone,
} from '../../src/lib/insights-time-zone.ts';

afterEach(() => {
  // `write` also pins the value for this page, so putting the default back goes through it too.
  insightsTimeZonePreference.write(DEVICE_TIME_ZONE);
  globalThis.localStorage.removeItem(INSIGHTS_TIME_ZONE_KEY);
});

describe('the Insights time zone preference', () => {
  it('defaults to following the device, and a device choice resolves to the device clock', () => {
    expect(insightsTimeZonePreference.read()).toBe(DEVICE_TIME_ZONE);
    expect(resolveInsightsTimeZone(DEVICE_TIME_ZONE, 'Asia/Singapore')).toBe('Asia/Singapore');
    expect(resolveInsightsTimeZone('Europe/London', 'Asia/Singapore')).toBe('Europe/London');
  });

  it('keeps a chosen IANA zone on this device', () => {
    insightsTimeZonePreference.write('America/Los_Angeles');
    expect(globalThis.localStorage.getItem(INSIGHTS_TIME_ZONE_KEY)).toBe('America/Los_Angeles');
    expect(insightsTimeZonePreference.parse('America/Los_Angeles')).toBe('America/Los_Angeles');
  });

  it('treats an abbreviation, an offset or junk in storage as the default', () => {
    for (const stored of ['SGT', '+08:00', 'Mars/Olympus_Mons', '', null])
      expect(insightsTimeZonePreference.parse(stored)).toBe(DEVICE_TIME_ZONE);
  });

  it('lists UTC first and the device zone among them', () => {
    const zones = knownTimeZones();
    expect(zones[0]).toBe('UTC');
    expect(zones).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
