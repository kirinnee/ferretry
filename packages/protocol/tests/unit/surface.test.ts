import { describe, it } from 'bun:test';
import should from 'should';
import type { SurfaceOpener } from '../../src/lib/index.ts';
import * as surface from '../../src/lib/surface.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const human = { by: 'human', deviceId: 'device-7f3a' } satisfies SurfaceOpener;
const agent = { by: 'agent', sessionId: 'mse7wwti-2a75bd9c' } satisfies SurfaceOpener;
const local = { by: 'local' } satisfies SurfaceOpener;

const surfaceCases: SchemaCase[] = [{ name: 'opener', schema: surface.SurfaceOpenerSchema, value: agent }];

describe('surface opener schema', () => {
  it('should round-trip every public surface schema', () => {
    // Arrange
    const cases = surfaceCases;

    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(surface, cases);
  });

  it('should carry each opener class with only the identity that class can attest', () => {
    // Arrange
    const openers = [human, agent, local];

    // Act + Assert
    for (const opener of openers) should(surface.SurfaceOpenerSchema.parse(opener)).deepEqual(opener);
  });

  it('should refuse an opener that mixes classes or omits the identity behind one', () => {
    // Arrange — a human with an agent's identity, or an agent with none, would
    // make `by` unreadable: the whole point is that the class names the evidence.
    const cases: SchemaCase[] = [
      { name: 'human without a device', schema: surface.SurfaceOpenerSchema, value: { by: 'human' } },
      { name: 'agent without a session', schema: surface.SurfaceOpenerSchema, value: { by: 'agent' } },
      {
        name: 'human carrying an agent session',
        schema: surface.SurfaceOpenerSchema,
        value: { by: 'human', deviceId: 'device-7f3a', sessionId: 'mse7wwti' },
      },
      {
        name: 'local carrying an identity',
        schema: surface.SurfaceOpenerSchema,
        value: { by: 'local', deviceId: 'd' },
      },
      { name: 'an unknown class', schema: surface.SurfaceOpenerSchema, value: { by: 'daemon' } },
      { name: 'no class at all', schema: surface.SurfaceOpenerSchema, value: { deviceId: 'device-7f3a' } },
      { name: 'not an object', schema: surface.SurfaceOpenerSchema, value: 'human' },
    ];

    // Act + Assert
    assertRejects(cases);
  });

  it('should refuse identities that could not be printed or matched as themselves', () => {
    // Arrange — an id lands in a badge, a title attribute and an equality check
    // against this device's own id, so whitespace or control characters in one
    // are a rendering hazard rather than a harmless quirk.
    const cases: SchemaCase[] = [
      { name: 'empty device', schema: surface.SurfaceOpenerSchema, value: { by: 'human', deviceId: '' } },
      { name: 'blank device', schema: surface.SurfaceOpenerSchema, value: { by: 'human', deviceId: '   ' } },
      { name: 'spaced session', schema: surface.SurfaceOpenerSchema, value: { by: 'agent', sessionId: 'a b' } },
      { name: 'newline session', schema: surface.SurfaceOpenerSchema, value: { by: 'agent', sessionId: 'a\nb' } },
      { name: 'tab session', schema: surface.SurfaceOpenerSchema, value: { by: 'agent', sessionId: 'a\tb' } },
      { name: 'null session', schema: surface.SurfaceOpenerSchema, value: { by: 'agent', sessionId: 'a\u0000b' } },
      {
        name: 'left-to-right mark session',
        schema: surface.SurfaceOpenerSchema,
        value: { by: 'agent', sessionId: 'a\u200eb' },
      },
      {
        name: 'device beyond the maximum',
        schema: surface.SurfaceOpenerSchema,
        value: { by: 'human', deviceId: 'd'.repeat(129) },
      },
      { name: 'non-string session', schema: surface.SurfaceOpenerSchema, value: { by: 'agent', sessionId: 7 } },
    ];

    // Act
    const trimmed = surface.SurfaceOpenerSchema.parse({ by: 'human', deviceId: '  device-7f3a  ' });

    // Assert
    should(trimmed).deepEqual(human);
    should(surface.SurfaceOpenerSchema.parse({ by: 'agent', sessionId: 'd'.repeat(128) })).deepEqual({
      by: 'agent',
      sessionId: 'd'.repeat(128),
    });
    assertRejects(cases);
  });
});
