import { describe, it } from 'bun:test';
import should from 'should';
import { FY_VERSION_HEADER, SessionViewSchema } from '../../src/lib/index.ts';

describe('protocol package entry', () => {
  it('should expose the deliberate schema and client-port surface', () => {
    // Act
    const actual = { header: FY_VERSION_HEADER, schema: SessionViewSchema };

    // Assert
    should(actual.header).equal('x-fy-version');
    should(actual.schema.safeParse).be.a.Function();
  });
});
