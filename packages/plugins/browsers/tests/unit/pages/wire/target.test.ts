import { describe, it } from 'bun:test';
import should from 'should';
import * as target from '../../src/lib/browser-target.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const cases: SchemaCase[] = [
  { name: 'ref', schema: target.BrowserRefSchema, value: 'e12' },
  { name: 'coordinate', schema: target.BrowserCoordinateSchema, value: 120.5 },
  { name: 'button', schema: target.BrowserMouseButtonSchema, value: 'middle' },
  { name: 'modifier', schema: target.BrowserModifierSchema, value: 'ControlOrMeta' },
  { name: 'read mode', schema: target.BrowserReadModeSchema, value: 'snapshot' },
  { name: 'screenshot format', schema: target.BrowserScreenshotFormatSchema, value: 'jpeg' },
  { name: 'challenge provider', schema: target.BrowserChallengeProviderSchema, value: 'cloudflare' },
];

describe('browser targets', () => {
  it('should round-trip every public browser-target schema', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(target, cases);
  });

  it('should take a ref in either of the shapes a snapshot writes, and nothing else', () => {
    // Arrange
    const good = ['e1', 'e1234567', 'f1e3', ' e12 '];
    const bad = ['', 'e', 'E12', 'ref=e12', 'f1', 'fe3', 'e12345678', 'button', 'e1; drop'];

    // Act
    const accepted = good.map(value => target.BrowserRefSchema.safeParse(value).success);

    // Assert
    should(accepted.every(Boolean)).be.true();
    assertRejects(bad.map(value => ({ name: value, schema: target.BrowserRefSchema, value })));
    should(target.BrowserRefSchema.parse(' e12 ')).equal('e12');
  });

  it('should name exactly one target, and say which rule a call broke', () => {
    // Arrange
    const point = { point: true, required: true } as const;
    const element = { point: false, required: true } as const;
    const optional = { point: false, required: false } as const;

    // Act + Assert
    should(target.browserTargetProblem({ ref: 'e1' }, point)).be.undefined();
    should(target.browserTargetProblem({ x: 0, y: 0 }, point)).be.undefined();
    should(target.browserTargetProblem({}, optional)).be.undefined();
    should(target.browserTargetProblem({}, point)).equal('name a target: a ref, a selector, or x and y');
    should(target.browserTargetProblem({}, element)).equal('name a target: a ref or a selector');
    should(target.browserTargetProblem({ x: 1, y: 2 }, element)).equal(
      'this act takes a ref or a selector, not a point',
    );
    should(target.browserTargetProblem({ y: 2 }, point)).equal('a point needs both x and y');
    should(target.browserTargetProblem({ ref: 'e1', selector: 'a' }, optional)).equal(
      'name one target: a ref, a selector or a point, not several',
    );
  });

  it('should resolve the fields a call named into one target', () => {
    should(target.browserTargetOf({ ref: 'e1' })).deepEqual({ kind: 'ref', ref: 'e1' });
    should(target.browserTargetOf({ selector: '#a' })).deepEqual({ kind: 'selector', selector: '#a' });
    should(target.browserTargetOf({ x: 0, y: 4 })).deepEqual({ kind: 'point', x: 0, y: 4 });
    should(target.browserTargetOf({ x: 3 })).be.undefined();
    should(target.browserTargetOf({})).be.undefined();
  });

  it('should read as a snapshot whenever a call asked for something only a snapshot has', () => {
    should(target.browserReadModeOf({})).equal('text');
    should(target.browserReadModeOf({ mode: 'a11y' })).equal('a11y');
    should(target.browserReadModeOf({ find: 'Sign in' })).equal('snapshot');
    should(target.browserReadModeOf({ depth: 2 })).equal('snapshot');
    should(target.browserReadModeOf({ boxes: true })).equal('snapshot');
  });
});
