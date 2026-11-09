import { describe, it } from 'bun:test';
import should from 'should';
import { builtInModelCatalogs } from '../../../daemon/lib/catalog/catalog.ts';
import { checkedBuiltInModelCatalogs, checkedBuiltInPresets } from '../../../daemon/lib/built-ins.ts';
import {
  checkedBuiltInModelCatalogs as inlinedModelCatalogs,
  checkedBuiltInPresets as inlinedPresets,
} from '../../../daemon/lib/built-ins.ts' with { type: 'macro' };
import { builtInPresets } from '../../../daemon/lib/presets/catalog.ts';

describe('this build’s catalogs, parsed when it is built', () => {
  it('should inline exactly what parsing the shipped files at run time gives', () => {
    // Act
    const inlined = { models: inlinedModelCatalogs(), presets: inlinedPresets() };

    // Assert — a value the macro cannot carry (a function, a class, a Date) would differ here.
    should(inlined.models).eql(builtInModelCatalogs());
    should(inlined.presets).eql(builtInPresets());
    should(Object.keys(inlined.models).length).be.above(0);
    should(inlined.presets.length).be.above(0);
  });

  it('should answer the same values when called plainly', () => {
    // Act
    const plain = { models: checkedBuiltInModelCatalogs(), presets: checkedBuiltInPresets() };

    // Assert
    should(plain.models).eql(builtInModelCatalogs());
    should(plain.presets).eql(builtInPresets());
  });
});
