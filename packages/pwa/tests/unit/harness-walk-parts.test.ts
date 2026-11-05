import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWalkParts, partsOwedOver, WALK_PARTS } from '../../harness/walk-parts.ts';

type Leg = {
  readonly scheme: string;
  readonly scope: 'settings' | 'full';
  readonly viewport?: 'mobile' | 'desktop';
  readonly leg: string;
  readonly parts: string;
};

const ciWorkflow = resolve(import.meta.dir, '../../../../.github/workflows/ci.yaml');
const legs = (
  Bun.YAML.parse(readFileSync(ciWorkflow, 'utf8')) as {
    jobs: { 'pwa-screenshot': { strategy: { matrix: { include: Leg[] } } } };
  }
).jobs['pwa-screenshot'].strategy.matrix.include;

describe('the harness walk parts', () => {
  test('should take every part when --parts is absent', () => {
    expect(parseWalkParts(['bun', 'screenshot.ts', '--light'])).toEqual({ parts: undefined });
  });

  test('should take the parts --parts names, once each', () => {
    expect(parseWalkParts(['--parts', 'sessions,safe-area,sessions'])).toEqual({
      parts: new Set(['sessions', 'safe-area']),
    });
  });

  test('should refuse a part it does not know, naming it', () => {
    expect(parseWalkParts(['--parts', 'sessions,sessoins'])).toEqual({
      refusal: `--parts takes a comma-separated list of ${WALK_PARTS.join(', ')}, not sessoins`,
    });
  });

  test('should refuse an empty list rather than walk nothing', () => {
    expect(parseWalkParts(['--parts', ''])).toMatchObject({ refusal: expect.stringContaining('not nothing') });
    expect(parseWalkParts(['--parts'])).toMatchObject({ refusal: expect.stringContaining('not nothing') });
  });

  test('should owe the passes to the viewport that owns them', () => {
    expect([...partsOwedOver('full', ['mobile'])].sort() as string[]).toEqual(
      ['gallery', 'overlays', 'safe-area', 'sessions', 'sessions-page', 'settings'].sort(),
    );
    expect([...partsOwedOver('full', ['desktop'])].sort() as string[]).toEqual(
      ['gallery', 'layout', 'overlays', 'sessions', 'settings'].sort(),
    );
    expect([...partsOwedOver('settings', ['mobile', 'desktop'])].sort() as string[]).toEqual(
      ['layout', 'safe-area', 'sessions-page', 'settings'].sort(),
    );
  });
});

describe('the CI screenshot matrix', () => {
  const runs = [
    ...new Map(legs.map(leg => [`${leg.scheme}/${leg.scope}/${leg.viewport ?? 'both'}`, leg] as const)).values(),
  ];

  test.each(runs)('should walk every part of $scheme $scope $viewport exactly once across its legs', run => {
    const mine = legs.filter(
      leg => leg.scheme === run.scheme && leg.scope === run.scope && leg.viewport === run.viewport,
    );
    const named = mine.flatMap(leg => leg.parts.split(','));
    const owed = partsOwedOver(run.scope, run.viewport === undefined ? ['mobile', 'desktop'] : [run.viewport]);
    expect([...named].sort()).toEqual([...owed].sort());
    expect(mine.map(leg => leg.leg)).toEqual([...new Set(mine.map(leg => leg.leg))]);
  });

  test('should keep a settings and a full run for the colour schemes the gate promises', () => {
    expect(runs.map(run => `${run.scheme}/${run.scope}/${run.viewport ?? 'both'}`).sort()).toEqual([
      'dark/full/desktop',
      'dark/full/mobile',
      'light/settings/both',
    ]);
  });
});
