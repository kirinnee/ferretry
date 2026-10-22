import { describe, it } from 'bun:test';
import { InstantSchema } from '@ferretry/protocol';
import should from 'should';
import { isIsoInstant } from '../../src/lib/iso-instant.ts';

/**
 * The zod-free instant check must accept exactly what the protocol's `InstantSchema` accepts: the
 * observed-runtime projection writes what it accepts into a field the session document parses with
 * the schema, so a string one accepts and the other refuses would either drop real evidence or make
 * the whole document unreadable.
 */
const CORPUS: readonly string[] = [
  '2026-10-22T08:00:00.000Z',
  '2026-10-22T08:00:00Z',
  '2026-10-22T08:00Z',
  '2026-10-22T08:00:00.123456789Z',
  '2026-10-22T08:00:00+02:00',
  '2026-10-22T08:00:00-11:30',
  '2026-10-22T23:59:59.9+23:59',
  '2024-02-29T00:00:00Z',
  '2000-02-29T00:00:00Z',
  '1900-02-29T00:00:00Z',
  '2023-02-29T00:00:00Z',
  '2026-04-31T00:00:00Z',
  '2026-13-01T00:00:00Z',
  '2026-10-22T24:00:00Z',
  '2026-10-22T08:60:00Z',
  '2026-10-22T08:00:60Z',
  '2026-10-22T08:00:00',
  '2026-10-22T08:00:00+0200',
  '2026-10-22T08:00:00+24:00',
  '2026-10-22 08:00:00Z',
  '2026-10-22T08:00:00.Z',
  '2026-10-22',
  'T08:00:00Z',
  'yesterday',
  '',
  ' 2026-10-22T08:00:00Z',
  '2026-10-22T08:00:00Z ',
  '2026-10-22T08:00:00z',
];

describe('isIsoInstant', () => {
  it.each(CORPUS.map(value => [value]))('should agree with InstantSchema about %p', value => {
    // Arrange
    const expected = InstantSchema.safeParse(value).success;

    // Act
    const actual = isIsoInstant(value);

    // Assert
    should(actual).equal(expected);
  });

  it('should accept an offset instant and refuse one without a zone', () => {
    // Act + Assert
    should(isIsoInstant('2026-10-22T08:00:00+02:00')).be.true();
    should(isIsoInstant('2026-10-22T08:00:00')).be.false();
  });
});
