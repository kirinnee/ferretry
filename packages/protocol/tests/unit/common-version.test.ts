import { describe, it } from 'bun:test';
import should from 'should';
import * as common from '../../src/lib/common.ts';
import * as version from '../../src/lib/version-skew.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const commonCases: SchemaCase[] = [
  { name: 'instant', schema: common.InstantSchema, value: '2026-07-30T12:00:00Z' },
  { name: 'nonempty string', schema: common.NonEmptyStringSchema, value: ' value ' },
  { name: 'nonnegative integer', schema: common.NonNegativeIntegerSchema, value: 0 },
  { name: 'positive integer', schema: common.PositiveIntegerSchema, value: 1 },
  { name: 'nonnegative finite', schema: common.NonNegativeFiniteSchema, value: 1.5 },
  { name: 'string map', schema: common.StringMapSchema, value: { key: 1 } },
  {
    name: 'API error',
    schema: common.ApiErrorResponseSchema,
    value: { error: 'bad request', code: 'invalid', method: 'POST', path: '/v1/test', detail: true },
  },
];

const versionCases: SchemaCase[] = [
  { name: 'protocol version', schema: version.ProtocolVersionSchema, value: '1.2.3-alpha.1+build.9' },
  { name: 'skew direction', schema: version.VersionSkewDirectionSchema, value: 'daemon-newer' },
  {
    name: 'version skew',
    schema: version.VersionSkewSchema,
    value: {
      clientVersion: '1.2.3',
      daemonVersion: '1.3.0',
      direction: 'daemon-newer',
      message: 'update fy',
    },
  },
];

describe('common protocol schemas', () => {
  it('should round-trip every public common schema', () => {
    // Arrange
    const cases = commonCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(common, cases);
  });

  it('should reject malformed primitives', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'instant without timezone', schema: common.InstantSchema, value: '2026-07-30T12:00:00' },
      { name: 'blank string', schema: common.NonEmptyStringSchema, value: '   ' },
      { name: 'fractional integer', schema: common.NonNegativeIntegerSchema, value: 1.5 },
      { name: 'zero positive', schema: common.PositiveIntegerSchema, value: 0 },
      { name: 'infinite number', schema: common.NonNegativeFiniteSchema, value: Number.POSITIVE_INFINITY },
      { name: 'missing error', schema: common.ApiErrorResponseSchema, value: { code: 'invalid' } },
    ];

    // Act + Assert
    assertRejects(cases);
  });
});

describe('version skew', () => {
  it('should round-trip every version schema', () => {
    // Arrange
    const cases = versionCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(version, cases);
  });

  it('should compare full SemVer precedence without numeric overflow', () => {
    // Arrange
    const cases = [
      ['1.2.3', '1.2.3', 0],
      ['2.0.0', '1.9.9', 1],
      ['1.2.3', '1.3.0', -1],
      ['999999999999999999999.0.0', '2.0.0', 1],
      ['1.0.0', '1.0.0-rc.1', 1],
      ['1.0.0-alpha', '1.0.0', -1],
      ['1.0.0-alpha.2', '1.0.0-alpha.10', -1],
      ['1.0.0-1', '1.0.0-alpha', -1],
      ['1.0.0-beta', '1.0.0-alpha', 1],
      ['1.0.0-alpha', '1.0.0-beta', -1],
      ['1.0.0-alpha.1', '1.0.0-alpha.1', 0],
      ['1.0.0-alpha', '1.0.0-alpha.1', -1],
      ['1.0.0-alpha.1', '1.0.0-alpha', 1],
      ['1.0.0+left', '1.0.0+right', 0],
    ] as const;

    // Act + Assert
    for (const [left, right, expected] of cases) {
      should(version.compareProtocolVersions(left, right)).equal(expected);
    }
    should(version.compareProtocolVersions('latest', '1.0.0')).be.undefined();
  });

  it('should detect each skew direction and suppress matching or missing versions', () => {
    // Act
    const clientNewer = version.detectVersionSkew('2.0.0', '1.0.0');
    const daemonNewer = version.detectVersionSkew('1.0.0', '2.0.0');
    const different = version.detectVersionSkew('invalid', 'custom');

    // Assert
    should(clientNewer?.direction).equal('client-newer');
    should(daemonNewer?.direction).equal('daemon-newer');
    should(different?.direction).equal('different');
    should(version.detectVersionSkew('1.0.0', '1.0.0')).be.undefined();
    should(version.detectVersionSkew('1.0.0', null)).be.undefined();
    should(version.detectVersionSkew('1.0.0', undefined)).be.undefined();
  });

  it('should format actionable unknown-route errors', () => {
    // Act
    const olderDaemon = version.formatUnknownRouteError('POST /v1/new', '2.0.0', '1.0.0');
    const unknownDaemon = version.formatUnknownRouteError('GET /v1/new', '2.0.0', null);

    // Assert
    should(olderDaemon).containEql('requires a newer fyd');
    should(unknownDaemon).containEql('unknown route');
    should(unknownDaemon).containEql('unknown');
  });

  it('should reject malformed SemVer spellings', () => {
    // Arrange
    const cases = ['', 'v1.2.3', '1.2', '01.2.3', '1.2.3.4', '1.2.3-01', '1.2.3-alpha..1'];

    // Act + Assert
    for (const value of cases) should(version.ProtocolVersionSchema.safeParse(value).success).be.false();
  });
});
