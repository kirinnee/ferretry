import { describe, expect, it } from 'bun:test';
import { HOSTED_RELAY_BANDWIDTH_REASONS, hostedBandwidthReason } from '@ferretry/relay';
import { hostedAllowanceSentence } from '../../src/lib/relay-allowance.ts';

const RESET = Date.UTC(2026, 9, 22);
const clock = (epochMilliseconds: number) => (epochMilliseconds === RESET ? '8:00 AM' : 'another time');

describe('the hosted relay data allowance sentence', () => {
  it('says what ran out, when it resets in local time, and that direct still works', () => {
    const sentence = (scope: 'daemon' | 'global', window: 'minute' | 'day') =>
      hostedAllowanceSentence(hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS[scope][window], RESET), clock);
    expect(sentence('daemon', 'day')).toBe(
      "Today's relay data allowance for this machine is used up (resets at 8:00 AM). Direct connections still work.",
    );
    expect(sentence('daemon', 'minute')).toBe(
      'This machine has used its relay data allowance for this minute (resets at 8:00 AM). Direct connections still work.',
    );
    expect(sentence('global', 'day')).toBe(
      "Ferretry's relay has used today's data allowance for every machine (resets at 8:00 AM). Direct connections still work.",
    );
    expect(sentence('global', 'minute')).toBe(
      "Ferretry's relay is at its data limit for this minute (resets at 8:00 AM). Direct connections still work.",
    );
  });

  it('states the reset rule for a relay too old to carry the instant', () => {
    expect(hostedAllowanceSentence(HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day, clock)).toContain(
      '(resets at midnight UTC)',
    );
    expect(hostedAllowanceSentence(HOSTED_RELAY_BANDWIDTH_REASONS.global.minute, clock)).toContain(
      '(resets within a minute)',
    );
  });

  it('formats in this device’s locale by default and leaves any other refusal alone', () => {
    const sentence = hostedAllowanceSentence(hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day, RESET));
    expect(sentence).toContain(new Date(RESET).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    expect(hostedAllowanceSentence('hosted relay is disabled')).toBeUndefined();
  });
});
