import { describe, expect, it } from 'bun:test';
import { starterModelsOf, type ModelCatalogSources } from '../../../daemon/lib/models/catalog.ts';
import { TEST_MODEL_SOURCES, TEST_STARTERS } from '../../support/starters.ts';

describe('the starter model of each harness', () => {
  it('is the default of the catalog its sign-in reads', () => {
    expect(starterModelsOf(TEST_MODEL_SOURCES as unknown as ModelCatalogSources)).toEqual(TEST_STARTERS);
  });

  it('is the one marked default, not the first listed', () => {
    const sources = {
      catalogs: {
        anthropic: {
          claude: { models: [{ id: 'first' }, { id: 'chosen', default: true }] },
        },
      },
    } as unknown as ModelCatalogSources;
    expect(starterModelsOf(sources)).toEqual({ claude: 'chosen' });
  });

  it('names no harness whose catalog this machine does not hold', () => {
    expect(starterModelsOf({ catalogs: {} })).toEqual({});
  });
});
