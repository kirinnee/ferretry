import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AuthenticatedCredential,
  SOCKET_TICKET_MAX_OUTSTANDING,
  SOCKET_TICKET_TTL_MS,
  type SocketTicketSecrets,
  SocketTicketRegistry,
} from '../../../src/lib/api/index.ts';

/**
 * The credential a browser CAN present on an upgrade.
 *
 * The refusals are the subject. A ticket lives in a URL, which is copied into every access log on the
 * path, so the whole design rests on it being worthless a moment later: spent on first use, dead in
 * seconds, and carrying no authority its buyer did not already hold. Each of those is a case here.
 */

const ADMIN: AuthenticatedCredential = { kind: 'authenticated', tokenClass: 'admin' };
const DEVICE: AuthenticatedCredential = { kind: 'authenticated', tokenClass: 'device', deviceId: 'device-1' };

class FakeClock {
  nowMs = 1_000;
  now = (): number => this.nowMs;
}

/** Counts up, so a case can name the ticket it expects without reading the registry's state. */
class CountingSecrets implements SocketTicketSecrets {
  issued = 0;

  ticket(): string {
    this.issued += 1;
    return `fy_ticket_${String(this.issued).padStart(43, 'x')}`;
  }
}

function fixture(options: { readonly limit?: number; readonly ttlMs?: number } = {}) {
  const clock = new FakeClock();
  const secrets = new CountingSecrets();
  const registry = new SocketTicketRegistry(clock, secrets, options.ttlMs ?? SOCKET_TICKET_TTL_MS, options.limit);
  return { clock, secrets, registry };
}

describe('SocketTicketRegistry', () => {
  it('should replay exactly the credential that bought the ticket', () => {
    // Arrange
    const { registry } = fixture();

    // Act
    const grant = registry.issue(DEVICE);

    // Assert — a device's ticket is a DEVICE's ticket. A ticket that resolved to admin would let a
    // phone reach the host's own surface by way of a transport workaround.
    should(registry.redeem(grant.ticket)).deepEqual(DEVICE);
  });

  it('should expire the ticket at its stated deadline', () => {
    // Arrange
    const { clock, registry } = fixture();
    const grant = registry.issue(ADMIN);
    should(grant.expiresAtMs).equal(clock.nowMs + SOCKET_TICKET_TTL_MS);

    // Act
    clock.nowMs = grant.expiresAtMs;

    // Assert — the deadline itself is already too late, so a ticket is never valid at the instant it
    // is stated to stop being valid.
    should(registry.redeem(grant.ticket)).be.undefined();
  });

  it('should spend a ticket on its first use', () => {
    // Arrange
    const { registry } = fixture();
    const grant = registry.issue(ADMIN);

    // Act
    const first = registry.redeem(grant.ticket);
    const second = registry.redeem(grant.ticket);

    // Assert — one ticket, one socket. A replayable one would be a bearer token in a URL.
    should(first).deepEqual(ADMIN);
    should(second).be.undefined();
  });

  it('should spend an expired ticket too, so an aging one cannot be probed twice', () => {
    // Arrange
    const { clock, registry } = fixture();
    const grant = registry.issue(ADMIN);
    clock.nowMs = grant.expiresAtMs;

    // Act — refused for being expired, and gone afterwards even so.
    should(registry.redeem(grant.ticket)).be.undefined();
    clock.nowMs = 0;

    // Assert — a clock that went backwards cannot resurrect it.
    should(registry.redeem(grant.ticket)).be.undefined();
  });

  it('should refuse a ticket nobody issued', () => {
    // Arrange
    const { registry } = fixture();
    registry.issue(ADMIN);

    // Act / Assert
    should(registry.redeem(`fy_ticket_${'z'.repeat(43)}`)).be.undefined();
  });

  it('should refuse a blank ticket', () => {
    // Arrange — `?ticket=` arrives as ''. Nothing is not a credential.
    const { registry } = fixture();
    registry.issue(ADMIN);

    // Act / Assert
    should(registry.redeem('')).be.undefined();
    should(registry.redeem('   ')).be.undefined();
  });

  it('should refuse to mint a blank ticket rather than store one anything matches', () => {
    // Arrange — a generator that yields nothing is damaged, not empty.
    const registry = new SocketTicketRegistry({ now: () => 1_000 }, { ticket: () => '' });

    // Act / Assert
    should(() => registry.issue(ADMIN)).throw('the socket ticket generator produced no ticket');
    should(registry.redeem('')).be.undefined();
  });

  it('should compare every outstanding ticket, so neither the match nor its position is observable', () => {
    // Arrange
    const comparisons: string[] = [];
    const secrets = new CountingSecrets();
    const registry = new SocketTicketRegistry({ now: () => 1_000 }, secrets, SOCKET_TICKET_TTL_MS, 8, (left, right) => {
      comparisons.push(right);
      return left === right;
    });
    const first = registry.issue(ADMIN);
    registry.issue(DEVICE);
    const third = registry.issue(ADMIN);

    // Act
    should(registry.redeem(first.ticket)).deepEqual(ADMIN);
    const hitCount = comparisons.length;
    comparisons.length = 0;
    should(registry.redeem(`fy_ticket_${'z'.repeat(43)}`)).be.undefined();

    // Assert — no early exit: an outstanding ticket is compared whether or not an earlier one already
    // matched, so the work done says nothing about which ticket answered.
    should(hitCount).equal(3);
    should(comparisons).have.length(2);
    should(registry.redeem(third.ticket)).deepEqual(ADMIN);
  });

  it('should forget expired tickets rather than hold them for their buyer forever', () => {
    // Arrange
    const { clock, registry } = fixture({ limit: 4 });
    const stale = registry.issue(ADMIN);

    // Act — an issue after the deadline is what sweeps the dead ones.
    clock.nowMs = stale.expiresAtMs + 1;
    const fresh = registry.issue(DEVICE);

    // Assert
    should(registry.redeem(stale.ticket)).be.undefined();
    should(registry.redeem(fresh.ticket)).deepEqual(DEVICE);
  });

  it('should bound what it holds, dropping the oldest unredeemed ticket first', () => {
    // Arrange — every issue is authenticated, so this bounds a client reconnecting in a loop rather
    // than an attack. Unbounded, that same loop is unbounded daemon memory.
    const { registry } = fixture({ limit: 3 });
    const first = registry.issue(ADMIN);
    const second = registry.issue(ADMIN);

    // Act
    const third = registry.issue(ADMIN);
    const fourth = registry.issue(DEVICE);

    // Assert — exactly the oldest went, to make room for the newest. Everything still within the
    // ceiling is untouched: making room must not be a reason to drop a ticket a client is about to
    // spend.
    should(registry.redeem(first.ticket)).be.undefined();
    should(registry.redeem(second.ticket)).deepEqual(ADMIN);
    should(registry.redeem(third.ticket)).deepEqual(ADMIN);
    should(registry.redeem(fourth.ticket)).deepEqual(DEVICE);
  });

  it('should keep a ceiling that a real client cannot trip by reconnecting once', () => {
    // A viewer opens one socket at a time and buys one ticket per attempt, so the bound only has to be
    // far above that. This asserts the shipped number is a bound and not an accident.
    should(SOCKET_TICKET_MAX_OUTSTANDING).be.greaterThan(1);
    should(SOCKET_TICKET_TTL_MS).be.lessThanOrEqual(60_000);
  });
});
