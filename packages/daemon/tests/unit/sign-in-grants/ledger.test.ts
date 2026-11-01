import { describe, it } from 'bun:test';
import type { LoginFieldRole, SignInId } from '@ferretry/protocol';
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

/** Reserve a fill of `roles` (its field set is the roles, sorted). */
const fill = (
  ledger: SignInGrantLedger,
  roles: readonly LoginFieldRole[],
  remaining: number,
  at: number,
  over: { id?: string; session?: string; signIn?: SignInId } = {},
) =>
  ledger.reserve(
    grant(remaining, over.id, over.signIn),
    over.session ?? SESSION,
    roles,
    [...roles].sort().join('+'),
    at,
  );

describe('SignInGrantLedger: uses are spent synchronously', () => {
  it('should let only one of two reservations in one tick take a line’s last use', () => {
    const ledger = new SignInGrantLedger();
    should(typeof fill(ledger, ['username', 'password'], 1, NOW)).equal('object');
    should(fill(ledger, ['username', 'password'], 1, NOW)).equal('used-up');
  });

  it('should give a released reservation back, and count a spent one once', () => {
    const ledger = new SignInGrantLedger();
    ledger.release(reserved(fill(ledger, ['password'], 1, NOW)));
    const again = reserved(fill(ledger, ['password'], 1, NOW));
    should(ledger.spent(again, 'id1')).be.true();
    should(ledger.spent(again, 'id1')).be.false();
  });
});

describe('SignInGrantLedger: one use is one sign-in attempt, and each role is typed once per use', () => {
  it('should take username, password and code steps within three minutes as one use', () => {
    const ledger = new SignInGrantLedger();
    should(ledger.spent(reserved(fill(ledger, ['username'], 1, NOW)), 'a')).be.true();
    // No use is left, yet the next steps of the same attempt type roles it has not typed, so they join it.
    should(ledger.joinable('plan:aa:0', NOW + 30_000)).be.true();
    const pass = reserved(fill(ledger, ['password'], 0, NOW + 30_000));
    should(pass.opens).be.false();
    should(ledger.spent(pass, 'b')).be.false();
    should(reserved(fill(ledger, ['totp'], 0, NOW + 60_000)).opens).be.false();
  });

  it('should refuse a second password on one use: a confirm-password form is not part of the sign-in', () => {
    const ledger = new SignInGrantLedger();
    ledger.spent(reserved(fill(ledger, ['username', 'password'], 1, NOW)), 'a');
    should(fill(ledger, ['password'], 0, NOW + 1_000)).equal('used-up');
    should(fill(ledger, ['password', 'totp'], 0, NOW + 1_000)).equal('used-up');
  });

  it('should spend a second use for a password typed twice, even inside the window', () => {
    const ledger = new SignInGrantLedger();
    ledger.spent(reserved(fill(ledger, ['password'], 2, NOW)), 'a');
    const second = reserved(fill(ledger, ['password'], 1, NOW + 1_000));
    should(second.opens).be.true();
  });

  it('should count a role still being typed by a fill in flight as typed', () => {
    const ledger = new SignInGrantLedger();
    ledger.spent(reserved(fill(ledger, ['username'], 1, NOW)), 'a');
    reserved(fill(ledger, ['password'], 0, NOW + 1_000));
    should(fill(ledger, ['password'], 0, NOW + 1_000)).equal('used-up');
  });

  it('should keep the attempt window from its first fill: a step that joined does not slide it', () => {
    const ledger = new SignInGrantLedger();
    ledger.spent(reserved(fill(ledger, ['username'], 1, NOW)), 'a');
    ledger.spent(reserved(fill(ledger, ['password'], 0, NOW + 100_000)), 'b');
    // 200 s after the first fill, 100 s after the join: the attempt closed at 180 s, so a code needs a use of its own.
    should(ledger.joinable('plan:aa:0', NOW + 200_000)).be.false();
    should(fill(ledger, ['totp'], 0, NOW + 200_000)).equal('used-up');
  });

  it('should open a new attempt after three minutes', () => {
    const ledger = new SignInGrantLedger();
    ledger.spent(reserved(fill(ledger, ['username'], 2, NOW)), 'a');
    should(ledger.joinable('plan:aa:0', NOW + 181_000)).be.false();
    should(reserved(fill(ledger, ['password'], 1, NOW + 181_000)).opens).be.true();
    should(fill(ledger, ['totp'], 0, NOW + 181_000)).equal('used-up');
  });

  it('should pin each field set to the identity of its first fill, and forget it with the grant', () => {
    const ledger = new SignInGrantLedger();
    ledger.spent(reserved(fill(ledger, ['password'], 2, NOW)), 'first');
    ledger.spent(reserved(fill(ledger, ['password'], 1, NOW + 1_000)), 'second');
    should(ledger.pinned('plan:aa:0').get('password')).equal('first');
    ledger.retain(() => false);
    should(ledger.pinned('plan:aa:0').size).equal(0);
    should(ledger.joinable('plan:aa:0', NOW + 2_000)).be.false();
  });
});

describe('SignInGrantLedger: the rate limit', () => {
  it(`should refuse the ${String(FILLS_PER_HOUR_PER_SIGN_IN + 1)}th fill of one sign-in within an hour, across grants`, () => {
    const ledger = new SignInGrantLedger();
    for (let index = 0; index < FILLS_PER_HOUR_PER_SIGN_IN; index++)
      ledger.spent(
        reserved(
          fill(ledger, ['password'], 1, NOW + index, { id: `plan:p${String(index)}:0`, session: `s${String(index)}` }),
        ),
        'x',
      );
    should(fill(ledger, ['password'], 1, NOW + 100, { id: 'plan:fresh:0', session: 'another' })).equal('rate');
    should(typeof fill(ledger, ['password'], 1, NOW + 3_600_100, { id: 'plan:fresh:0', session: 'another' })).equal(
      'object',
    );
  });

  it(`should refuse a session’s ${String(FILLS_PER_HOUR_PER_SESSION + 1)}th grant fill within an hour`, () => {
    const ledger = new SignInGrantLedger();
    for (let index = 0; index < FILLS_PER_HOUR_PER_SESSION; index++)
      ledger.spent(
        reserved(
          fill(ledger, ['password'], 1, NOW + index, {
            id: `plan:p${String(index)}:0`,
            signIn: `si_${String(index).padStart(24, '0')}` as SignInId,
          }),
        ),
        'x',
      );
    should(
      fill(ledger, ['password'], 1, NOW + 100, {
        id: 'plan:fresh:0',
        signIn: 'si_ffffffffffffffffffffffff' as SignInId,
      }),
    ).equal('rate');
  });
});
