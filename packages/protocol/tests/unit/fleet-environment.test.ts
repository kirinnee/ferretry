import { describe, it } from 'bun:test';
import should from 'should';
import * as environment from '../../src/lib/fleet-environment.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const view = { profiles: { portable: { EDITOR: 'vim', LANG: 'en_US.UTF-8' }, empty: {} } };

describe('fleet environment schemas', () => {
  it('should round-trip every public fleet environment schema', () => {
    // Arrange
    const cases: SchemaCase[] = [
      { name: 'environment view', schema: environment.FleetEnvironmentViewSchema, value: view },
    ];

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(environment, cases);
  });

  it('should refuse a body that is not a profile-to-variable map of strings', () => {
    // Arrange: an empty body, a value that is not text, and a profile that is not a map — each was
    // accepted by the cast this schema replaced and failed later inside a render.
    const cases: SchemaCase[] = [
      { name: 'empty body', schema: environment.FleetEnvironmentViewSchema, value: {} },
      { name: 'numeric value', schema: environment.FleetEnvironmentViewSchema, value: { profiles: { p: { A: 1 } } } },
      { name: 'profile list', schema: environment.FleetEnvironmentViewSchema, value: { profiles: { p: ['A=1'] } } },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should drop a field a newer daemon adds rather than refuse the read', () => {
    // Act
    const parsed = environment.FleetEnvironmentViewSchema.parse({ ...view, generatedAt: 'later' });

    // Assert
    should(parsed).deepEqual(view);
  });
});
