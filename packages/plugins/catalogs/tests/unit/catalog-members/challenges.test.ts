import { describe, expect, it } from 'bun:test';
import { PASSKEY_CHALLENGE_TTL_SECONDS } from '../../../daemon/lib/boundary.ts';
import { ChallengeLedger, type StepUpSubject } from '../../../daemon/lib/member-passkeys/challenges.ts';

const NOW = 1_000_000;
const TTL_MS = PASSKEY_CHALLENGE_TTL_SECONDS * 1_000;
const phone: StepUpSubject = { deviceId: 'mk_phone', appSession: 'tab-1' };
const otherTab: StepUpSubject = { deviceId: 'mk_phone', appSession: 'tab-2' };
const laptop: StepUpSubject = { deviceId: 'mk_laptop', appSession: 'tab-1' };
const bytes = (fill: number) => Uint8Array.from({ length: 8 }, () => fill);

describe('member passkey ChallengeLedger', () => {
  it('hands a challenge back exactly once', () => {
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'unlock', bytes(1), NOW);
    expect(ledger.take(phone, 'unlock', NOW)).toEqual(bytes(1));
    expect(ledger.take(phone, 'unlock', NOW)).toBeUndefined();
  });

  it('keeps a challenge for its own tab and purpose only', () => {
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'unlock', bytes(1), NOW);
    expect(ledger.take(otherTab, 'unlock', NOW)).toBeUndefined();
    expect(ledger.take(phone, 'register', NOW)).toBeUndefined();
  });

  it('refuses a lapsed challenge, and spends it', () => {
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'unlock', bytes(1), NOW);
    expect(ledger.take(phone, 'unlock', NOW + TTL_MS)).toBeUndefined();
    expect(ledger.size).toBe(0);
  });

  it('sweeps lapsed challenges when the next one is issued, and counts what is outstanding', () => {
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'unlock', bytes(1), NOW);
    ledger.issue(laptop, 'unlock', bytes(2), NOW);
    expect(ledger.size).toBe(2);
    ledger.issue(phone, 'register', bytes(3), NOW + TTL_MS);
    expect(ledger.size).toBe(1);
  });

  it('returns what a step-up challenge was asked for, and nothing extra when none was', () => {
    const ledger = new ChallengeLedger();
    const stamp = { kind: 'act', act: 'pairing-mint' } as never;
    ledger.issue(phone, 'step-up', bytes(1), NOW, undefined, stamp);
    ledger.issue(laptop, 'step-up', bytes(2), NOW);
    const asked = ledger.takeWithAct(phone, 'step-up', NOW);
    expect(asked?.bytes).toEqual(bytes(1));
    expect(asked?.stamp).toEqual(stamp);
    expect(ledger.takeWithAct(phone, 'step-up', NOW)).toBeUndefined();
    const plain = ledger.takeWithAct(laptop, 'step-up', NOW);
    expect(plain?.bytes).toEqual(bytes(2));
    expect(plain?.stamp).toBeUndefined();
  });

  it('pairs a confirmation only with the registration challenge it was issued with', () => {
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'register-confirm', bytes(9), NOW, bytes(1));
    expect(ledger.takeConfirmation(phone, bytes(2), NOW)).toBeUndefined();
    // The mismatch spent it: the right registration cannot take it afterwards.
    expect(ledger.takeConfirmation(phone, bytes(1), NOW)).toBeUndefined();
    ledger.issue(phone, 'register-confirm', bytes(9), NOW, bytes(1));
    expect(ledger.takeConfirmation(phone, bytes(1), NOW)).toEqual(bytes(9));
  });

  it('refuses a confirmation that was issued without a registration to bind to', () => {
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'register-confirm', bytes(9), NOW);
    expect(ledger.takeConfirmation(phone, bytes(1), NOW)).toBeUndefined();
  });

  it('forgets every challenge of one device across its tabs and purposes', () => {
    const ledger = new ChallengeLedger();
    ledger.issue(phone, 'unlock', bytes(1), NOW);
    ledger.issue(otherTab, 'register', bytes(2), NOW);
    ledger.issue(laptop, 'unlock', bytes(3), NOW);
    ledger.forgetDevice('mk_phone');
    expect(ledger.size).toBe(1);
    expect(ledger.take(laptop, 'unlock', NOW)).toEqual(bytes(3));
  });
});
