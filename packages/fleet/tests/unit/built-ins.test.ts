import { describe, expect, it } from 'bun:test';
import { checkedBuiltInModelCatalogs, checkedBuiltInPresets } from '../../src/lib/built-ins.ts';
import {
  checkedBuiltInModelCatalogs as inlinedModelCatalogs,
  checkedBuiltInPresets as inlinedPresets,
} from '../../src/lib/built-ins.ts' with { type: 'macro' };
import { builtInModelCatalogs } from '../../src/lib/models/catalog.ts';
import { builtInPresets } from '../../src/lib/presets/catalog.ts';

describe('this build’s catalogs, parsed when it is built', () => {
  it('should inline exactly what parsing the shipped files at run time gives', () => {
    // Act
    const inlined = { models: inlinedModelCatalogs(), presets: inlinedPresets() };

    // Assert — a value the macro cannot carry (a function, a class, a Date) would differ here.
    expect(inlined.models).toStrictEqual(builtInModelCatalogs());
    expect(inlined.presets).toStrictEqual(builtInPresets());
    expect(Object.keys(inlined.models).length).toBeGreaterThan(0);
    expect(inlined.presets.length).toBeGreaterThan(0);
  });

  it('should answer the same values when called plainly', () => {
    // Act
    const plain = { models: checkedBuiltInModelCatalogs(), presets: checkedBuiltInPresets() };

    // Assert
    expect(plain.models).toStrictEqual(builtInModelCatalogs());
    expect(plain.presets).toStrictEqual(builtInPresets());
  });
});
