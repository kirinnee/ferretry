import { describe, it } from 'bun:test';
import {
  RELAY_SESSION_CONCLUDED_CLOSE_CODE,
  RELAY_SESSION_CONCLUDED_CLOSE_REASON,
  relayDataByteBudget,
} from '@ferretry/protocol';
import should from 'should';

/** The relay protocol's record-plaintext ceiling, restated here because this package may not import
 *  `@ferretry/relay` to read it — the test proves the derivation, not the constant. */
const MAX_PLAINTEXT_BYTES = 65_492;

/** The exact record a §14 sender builds around a run of raw bytes. */
const dataRecordLength = (raw: Uint8Array): number =>
  JSON.stringify({ t: 'data', bytes: Buffer.from(raw).toString('base64url') }).length;

describe('relay session vocabulary', () => {
  it('should publish the concluded close inside the range a rendezvous forwards untouched', () => {
    should(RELAY_SESSION_CONCLUDED_CLOSE_CODE).equal(4440);
    should(RELAY_SESSION_CONCLUDED_CLOSE_CODE).be.within(4000, 4999);
  });

  it('should publish one conclusion reason that describes no particular conclusion', () => {
    // THE PROPERTY IS THE ABSENCE OF CONTENT, so it is asserted as an absence rather than as a
    // spelling. A `closed` control frame is unseated by design — the rendezvous reads it to route the
    // session — so whatever rides here is plaintext to the carrier. §14 says every conclusion reads
    // the same from outside the channel, which forbids naming WHICH outcome happened: a pairing that
    // succeeded and one that was refused, a viewer that left and a reader that fell behind.
    should(RELAY_SESSION_CONCLUDED_CLOSE_REASON).equal('the session concluded');
    for (const outcome of [
      'paired',
      'refused',
      'pairing',
      'stream',
      'viewer',
      'terminal',
      'behind',
      'event',
      'client',
      'left',
      'oversize',
    ]) {
      should(RELAY_SESSION_CONCLUDED_CLOSE_REASON).not.match(new RegExp(outcome, 'iu'));
    }
  });

  it('should carry no interpolation point a caller could put a session detail through', () => {
    // A constant that a caller can append to is a convention; one with nowhere to put anything is a
    // rule. This is what stops the previous defect returning as `${REASON}: ${message.reason}`.
    should(RELAY_SESSION_CONCLUDED_CLOSE_REASON).not.match(/[${}]/u);
    // Short enough that no rendezvous truncates it, and non-empty so a reader never sees a bare code.
    should(RELAY_SESSION_CONCLUDED_CLOSE_REASON.length).be.within(1, 123);
  });

  it('should derive the largest byte run whose sealed record actually fits the ceiling', () => {
    // Proved by building the real record, not by asserting a number: the budget-sized payload
    // encodes within the ceiling and one more byte does not.
    const budget = relayDataByteBudget(MAX_PLAINTEXT_BYTES);
    should(budget).be.greaterThan(0);
    should(dataRecordLength(new Uint8Array(budget))).be.belowOrEqual(MAX_PLAINTEXT_BYTES);
    should(dataRecordLength(new Uint8Array(budget + 1))).be.greaterThan(MAX_PLAINTEXT_BYTES);
  });

  it('should keep the fit-exactly property at every ceiling, not just the shipped one', () => {
    // base64url pays four characters per three bytes, so the boundary moves unevenly; sweeping a
    // window of ceilings catches an off-by-one at every remainder the arithmetic can produce.
    for (let ceiling = 24; ceiling < 96; ceiling++) {
      const budget = relayDataByteBudget(ceiling);
      should(dataRecordLength(new Uint8Array(budget))).be.belowOrEqual(ceiling);
      should(dataRecordLength(new Uint8Array(budget + 1))).be.greaterThan(ceiling);
    }
  });

  it('should answer zero, never a negative, for a ceiling nothing fits inside', () => {
    should(relayDataByteBudget(0)).equal(0);
    should(relayDataByteBudget(-1)).equal(0);
    should(relayDataByteBudget(JSON.stringify({ t: 'data', bytes: '' }).length)).equal(0);
    should(relayDataByteBudget(Number.NaN)).equal(0);
    should(relayDataByteBudget(Number.NEGATIVE_INFINITY)).equal(0);
  });

  it('should floor a fractional ceiling rather than inventing capacity', () => {
    should(relayDataByteBudget(MAX_PLAINTEXT_BYTES + 0.9)).equal(relayDataByteBudget(MAX_PLAINTEXT_BYTES));
  });
});
