import { describe, it } from 'bun:test';
import should from 'should';
import {
  EMPTY_VOICE_NONCE_LEDGER,
  EMPTY_VOICE_RATE_GUARD,
  mayAutoSend,
  recordNonceEcho,
  recordNonceIssued,
  recordShown,
  recordUplinkUnits,
  type VoiceNonceLedger,
  type VoiceSendQuestion,
  type VoiceShown,
} from '../../src/lib/voice-stream-rules.ts';

const A = 'AAAAAAAAAAAA';
const B = 'BBBBBBBBBBBB';
const C = 'CCCCCCCCCCCC';

/** A ledger in which `nonce` was issued at `issuedAt` and has been echoed. */
const echoed = (nonce: string, issuedAt: number): VoiceNonceLedger =>
  recordNonceEcho(recordNonceIssued(EMPTY_VOICE_NONCE_LEDGER, nonce, issuedAt), nonce);

const shown: VoiceShown = { turnId: 4, revision: 2, receivedAt: 10_000 };
const ask = (patch: Partial<VoiceSendQuestion> = {}): ReturnType<typeof mayAutoSend> =>
  mayAutoSend({ now: 10_500, turnId: 4, revision: 2, shown, ledger: echoed(A, 10_000), cancelled: false, ...patch });

describe('the nonce ledger', () => {
  it('learns an echo only of a nonce it issued', () => {
    const issued = recordNonceIssued(EMPTY_VOICE_NONCE_LEDGER, A, 1000);
    should(recordNonceEcho(issued, A).echoedIssuedAt).equal(1000);
    should(recordNonceEcho(issued, B)).equal(issued);
    should(recordNonceEcho(EMPTY_VOICE_NONCE_LEDGER, A)).equal(EMPTY_VOICE_NONCE_LEDGER);
  });

  it('moves the proof forward, never backward', () => {
    let ledger = recordNonceIssued(recordNonceIssued(EMPTY_VOICE_NONCE_LEDGER, A, 1000), B, 1200);
    ledger = recordNonceEcho(ledger, B);
    should(ledger.echoedIssuedAt).equal(1200);
    should(recordNonceEcho(ledger, A)).equal(ledger);
    should(recordNonceEcho(ledger, B)).equal(ledger);
  });

  it('forgets nonces older than the window when it issues one, and caps its size', () => {
    let ledger = recordNonceIssued(EMPTY_VOICE_NONCE_LEDGER, A, 0);
    ledger = recordNonceIssued(ledger, B, 1000);
    should(ledger.issued.map(entry => entry.nonce)).eql([A, B]);
    ledger = recordNonceIssued(ledger, C, 1001);
    should(ledger.issued.map(entry => entry.nonce)).eql([B, C]);
    let many = EMPTY_VOICE_NONCE_LEDGER;
    for (let i = 0; i < 40; i += 1) many = recordNonceIssued(many, `n${String(i).padStart(11, '0')}`, i);
    should(many.issued.length).equal(16);
    should(many.issued[15]?.issuedAt).equal(39);
  });

  it('is a value: it never mutates what it was given', () => {
    const before = recordNonceIssued(EMPTY_VOICE_NONCE_LEDGER, A, 5);
    recordNonceEcho(before, A);
    recordNonceIssued(before, B, 6);
    should(before.echoedIssuedAt).equal(undefined);
    should(before.issued.length).equal(1);
  });
});

describe('recording what the phone showed', () => {
  it('takes a shown control with the time it arrived, and ignores everything else', () => {
    const first = recordShown(undefined, { kind: 'shown', turnId: 1, revision: 2 }, 50);
    should(first).eql({ turnId: 1, revision: 2, receivedAt: 50 });
    should(recordShown(first, { kind: 'hold', turnId: 1 }, 99)).equal(first);
    should(recordShown(first, { kind: 'muted' }, 99)).equal(first);
    should(recordShown(first, undefined, 99)).equal(first);
    should(recordShown(first, { kind: 'shown', turnId: 1, revision: 3 }, 120)).eql({
      turnId: 1,
      revision: 3,
      receivedAt: 120,
    });
  });
});

describe('may a countdown send', () => {
  it('allows it when shown 500 ms ago and the echoed nonce is fresh', () => {
    should(ask()).eql({ allowed: true });
  });

  it('refuses a cancelled send first, whatever else is true', () => {
    should(ask({ cancelled: true })).eql({ allowed: false, reason: 'cancelled' });
    should(ask({ cancelled: true, shown: undefined })).eql({ allowed: false, reason: 'cancelled' });
  });

  it('needs shown for this exact turn and this exact revision', () => {
    should(ask({ shown: undefined })).eql({ allowed: false, reason: 'not_shown' });
    should(ask({ shown: { ...shown, turnId: 3 } })).eql({ allowed: false, reason: 'not_shown' });
    should(ask({ shown: { ...shown, revision: 1 } })).eql({ allowed: false, reason: 'not_shown' });
    // The words changed: the question is now about revision 3, and the old shown does not count.
    should(ask({ revision: 3 })).eql({ allowed: false, reason: 'not_shown' });
  });

  it('measures the shown age to the millisecond: 499 is too soon, 500 is enough', () => {
    should(ask({ now: 10_499 })).eql({ allowed: false, reason: 'shown_too_recent' });
    should(ask({ now: 10_500 })).eql({ allowed: true });
    should(ask({ now: 10_501 })).eql({ allowed: true });
    should(ask({ now: 10_000 })).eql({ allowed: false, reason: 'shown_too_recent' });
    // A clock that went backwards is never old enough.
    should(ask({ now: 9_000 })).eql({ allowed: false, reason: 'shown_too_recent' });
  });

  it('needs an echo at all', () => {
    should(ask({ ledger: EMPTY_VOICE_NONCE_LEDGER })).eql({ allowed: false, reason: 'no_echo' });
    should(ask({ ledger: recordNonceIssued(EMPTY_VOICE_NONCE_LEDGER, A, 10_000) })).eql({
      allowed: false,
      reason: 'no_echo',
    });
  });

  it("measures the echoed nonce's issue time to the millisecond: 1,000 ms is fine, 1,001 is stale", () => {
    should(ask({ now: 11_000, ledger: echoed(A, 10_000) })).eql({ allowed: true });
    should(ask({ now: 11_001, ledger: echoed(A, 10_000) })).eql({ allowed: false, reason: 'echo_stale' });
    should(ask({ now: 10_500, ledger: echoed(A, 10_500) })).eql({ allowed: true });
  });

  it('fails closed on a nonce issued in the future (a negative age)', () => {
    const future = echoed(A, 2_000);
    should(ask({ now: 1_500, shown: { ...shown, receivedAt: 0 }, ledger: future })).eql({
      allowed: false,
      reason: 'echo_stale',
    });
    should(ask({ now: 10_500, ledger: echoed(A, 10_501) })).eql({ allowed: false, reason: 'echo_stale' });
  });

  it('fails closed on a shown time in the future', () => {
    should(ask({ now: 10_500, shown: { ...shown, receivedAt: 20_000 } })).eql({
      allowed: false,
      reason: 'shown_too_recent',
    });
  });

  it('fails closed on a non-finite time or age', () => {
    should(ask({ now: Number.NaN })).eql({ allowed: false, reason: 'shown_too_recent' });
    should(ask({ now: Number.POSITIVE_INFINITY })).eql({ allowed: false, reason: 'shown_too_recent' });
    should(ask({ shown: { ...shown, receivedAt: Number.NaN } })).eql({ allowed: false, reason: 'shown_too_recent' });
    should(ask({ shown: { ...shown, receivedAt: Number.NEGATIVE_INFINITY } })).eql({
      allowed: false,
      reason: 'shown_too_recent',
    });
    should(ask({ ledger: echoed(A, Number.NaN) })).eql({ allowed: false, reason: 'echo_stale' });
    should(ask({ ledger: echoed(A, Number.POSITIVE_INFINITY) })).eql({ allowed: false, reason: 'echo_stale' });
    should(ask({ ledger: echoed(A, Number.NEGATIVE_INFINITY) })).eql({ allowed: false, reason: 'echo_stale' });
  });

  it('judges the age of the nonce, not of the echo: a silent phone goes stale though it echoed once', () => {
    const ledger = echoed(A, 10_000);
    // The daemon keeps issuing nonces (B at 10_800), but the phone has echoed only A.
    const later = recordNonceIssued(ledger, B, 10_800);
    should(ask({ now: 11_200, ledger: later })).eql({ allowed: false, reason: 'echo_stale' });
    should(ask({ now: 11_200, ledger: recordNonceEcho(later, B) })).eql({ allowed: true });
  });
});

describe('the rate guard', () => {
  const feed = (times: readonly number[], per = 1) => {
    let guard = EMPTY_VOICE_RATE_GUARD;
    let exceeded = false;
    for (const now of times) {
      const step = recordUplinkUnits(guard, now, per);
      guard = step.guard;
      exceeded = step.exceeded;
    }
    return { guard, exceeded };
  };
  const at = (count: number, start = 0, step = 0) => Array.from({ length: count }, (_, i) => start + i * step);

  it('allows the nominal rate indefinitely', () => {
    const times = at(2000, 0, 40);
    let guard = EMPTY_VOICE_RATE_GUARD;
    for (const now of times) {
      const step = recordUplinkUnits(guard, now, 1);
      should(step.exceeded).equal(false);
      guard = step.guard;
    }
    should(guard.arrivals.length).be.belowOrEqual(125);
  });

  it('allows exactly 156 units in a window and refuses the 157th', () => {
    should(feed(at(156, 0, 1)).exceeded).equal(false);
    should(feed(at(157, 0, 1)).exceeded).equal(true);
    should(recordUplinkUnits(EMPTY_VOICE_RATE_GUARD, 0, 156).exceeded).equal(false);
    should(recordUplinkUnits(EMPTY_VOICE_RATE_GUARD, 0, 157).exceeded).equal(true);
  });

  it('counts a burst against units already in the window', () => {
    const base = recordUplinkUnits(EMPTY_VOICE_RATE_GUARD, 1000, 100).guard;
    should(recordUplinkUnits(base, 2000, 56).exceeded).equal(false);
    should(recordUplinkUnits(base, 2000, 57).exceeded).equal(true);
  });

  it('forgets a unit exactly 5,000 ms old and keeps one 4,999 ms old', () => {
    const full = recordUplinkUnits(EMPTY_VOICE_RATE_GUARD, 0, 156).guard;
    should(recordUplinkUnits(full, 4999, 1).exceeded).equal(true);
    should(recordUplinkUnits(full, 5000, 1).exceeded).equal(false);
    should(recordUplinkUnits(full, 5000, 1).guard.arrivals.length).equal(1);
  });

  it('tolerates a stall followed by a burst of the credit window and the nominal rate', () => {
    // 2.5 s of silence, then 62 units at once, then the nominal rate for the rest of the window.
    let step = recordUplinkUnits(EMPTY_VOICE_RATE_GUARD, 2500, 62);
    for (let t = 2540; t <= 5000; t += 40) step = recordUplinkUnits(step.guard, t, 1);
    should(step.exceeded).equal(false);
  });

  it('is total: odd counts are zero or clamped, and the state stays bounded', () => {
    should(recordUplinkUnits(EMPTY_VOICE_RATE_GUARD, 0, Number.NaN).guard.arrivals.length).equal(0);
    should(recordUplinkUnits(EMPTY_VOICE_RATE_GUARD, 0, -5).guard.arrivals.length).equal(0);
    should(recordUplinkUnits(EMPTY_VOICE_RATE_GUARD, 0, Infinity).guard.arrivals.length).equal(0);
    should(recordUplinkUnits(EMPTY_VOICE_RATE_GUARD, 0, 2.9).guard.arrivals.length).equal(2);
    const huge = recordUplinkUnits(EMPTY_VOICE_RATE_GUARD, 0, 1e9);
    should(huge.exceeded).equal(true);
    should(huge.guard.arrivals.length).equal(157);
  });
});
