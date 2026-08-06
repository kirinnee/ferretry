import { describe, it } from 'bun:test';
import { RELAY_SESSION_CONCLUDED_CLOSE_CODE, relayDataByteBudget } from '@ferretry/protocol';
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
