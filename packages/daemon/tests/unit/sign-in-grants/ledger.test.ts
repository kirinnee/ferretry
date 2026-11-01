import { describe, it } from 'bun:test';
import type { SignInId } from '@ferretry/protocol';
import should from 'should';
import {
  FILLS_PER_HOUR_PER_SESSION,
  FILLS_PER_HOUR_PER_SIGN_IN,
  type GrantReservation,
  SignInGrantLedger,
} from '../../../src/lib/sign-in-grants/ledger.ts';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const SESSION = 'mvv6b4qw-49d0158d';
const SIGN_IN = 'si_0123456789abcdef01234567' as SignInId;
const grant = (remaining = 1, id = 'plan:aa:0', signIn = SIGN_IN) => ({ id, signIn, remaining });

const reserved = (outcome: GrantReservation | string): GrantReservation => {
  if (typeof outcome === 'string') throw new Error(`expected a reservation, got ${outcome}`);
  return outcome;
};

describe('SignInGrantLedger: uses are spent synchronously', () => {
  it('should let only one of two reservations in one tick take a line’s last use', () => {
    const ledger = new SignInGrantLedger();
    const first = ledger.reserve(grant(1), SESSION, 'password+username', NOW);
    const second = ledger.reserve(grant(1), SESSION, 'password+username', NOW);
    should(typeof first).equal('object');
    should(second).equal('used-up');
  });

  it('should give a released reservation back, and count a spent one', () => {
    const ledger = new SignInGrantLedger();
    ledger.release(reserved(ledger.reserve(grant(1), SESSION, 'password', NOW)));
    const again = reserved(ledger.reserve(grant(1), SESSION, 'password', NOW));
    should(ledger.spent(again, 'id1')).be.true();
    // Spending twice is ignored.
    should(ledger.spent(again, 'id1')).be.false();
  });
});

describe('SignInGrantLedger: one use is one sign-in attempt', () => {
  it('should take username, password and code steps within three minutes as one use', () => {
    const ledger = new SignInGrantLedger();
    const user = reserved(ledger.reserve(grant(1), SESSION, 'username', NOW));
    should(ledger.spent(user, 'a')).be.true();
    // The grant now has no use left, yet the next steps of the same attempt join it.
    const pass = reserved(ledger.reserve(grant(0), SESSION, 'password', NOW + 30_000));
    should(pass.opens).be.false();
    should(ledger.spent(pass, 'b')).be.false();
    const code = reserved(ledger.reserve(grant(0), SESSION, 'totp', NOW + 60_000));
    should(code.opens).be.false();
  });

  it('should open a new attempt for a field set already filled, or after three minutes', () => {
    const ledger = new SignInGrantLedger();
    ledger.spent(reserved(ledger.reserve(grant(2), SESSION, 'password', NOW)), 'a');
    should(reserved(ledger.reserve(grant(1), SESSION, 'password', NOW + 1_000)).opens).be.true();
    const later = new SignInGrantLedger();
    later.spent(reserved(later.reserve(grant(2), SESSION, 'username', NOW)), 'a');
    should(reserved(later.reserve(grant(1), SESSION, 'password', NOW + 181_000)).opens).be.true();
    should(later.reserve(grant(0), SESSION, 'totp', NOW + 181_000)).equal('used-up');
  });

  it('should pin each field set to the identity of its first fill, and forget the pins with the grant', () => {
    const ledger = new SignInGrantLedger();
    ledger.spent(reserved(ledger.reserve(grant(2), SESSION, 'password', NOW)), 'first');
    ledger.spent(reserved(ledger.reserve(grant(1), SESSION, 'password', NOW + 1_000)), 'second');
    should(ledger.pinned('plan:aa:0').get('password')).equal('first');
    ledger.retain(() => false);
    should(ledger.pinned('plan:aa:0').size).equal(0);
  });
});

describe('SignInGrantLedger: the rate limit', () => {
  it(`should refuse the ${String(FILLS_PER_HOUR_PER_SIGN_IN + 1)}th fill of one sign-in within an hour, across grants`, () => {
    const ledger = new SignInGrantLedger();
    for (let index = 0; index < FILLS_PER_HOUR_PER_SIGN_IN; index++) {
      const each = grant(1, `plan:p${String(index)}:0`);
      ledger.spent(reserved(ledger.reserve(each, `s${String(index)}`, 'password', NOW + index)), 'x');
    }
    should(ledger.reserve(grant(1, 'plan:fresh:0'), 'another', 'password', NOW + 100)).equal('rate');
    // An hour later it fills again.
    should(typeof ledger.reserve(grant(1, 'plan:fresh:0'), 'another', 'password', NOW + 3_600_100)).equal('object');
  });

  it(`should refuse a session’s ${String(FILLS_PER_HOUR_PER_SESSION + 1)}th grant fill within an hour`, () => {
    const ledger = new SignInGrantLedger();
    for (let index = 0; index < FILLS_PER_HOUR_PER_SESSION; index++) {
      const each = grant(1, `plan:p${String(index)}:0`, `si_${String(index).padStart(24, '0')}` as SignInId);
      ledger.spent(reserved(ledger.reserve(each, SESSION, 'password', NOW + index)), 'x');
    }
    should(
      ledger.reserve(
        grant(1, 'plan:fresh:0', 'si_ffffffffffffffffffffffff' as SignInId),
        SESSION,
        'password',
        NOW + 100,
      ),
    ).equal('rate');
  });
});
