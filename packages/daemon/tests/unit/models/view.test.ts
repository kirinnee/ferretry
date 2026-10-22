import { describe, it } from 'bun:test';
import { builtInModelCatalogs } from '@ferretry/fleet';
import { ModelCatalogsViewSchema } from '@ferretry/protocol';
import should from 'should';
import { modelCatalogsView } from '../../../src/lib/models/view.ts';

describe('modelCatalogsView', () => {
  it('should list every catalog with its models as the CLI is handed them, and the published state', () => {
    // Act
    const view = ModelCatalogsViewSchema.parse(
      modelCatalogsView(builtInModelCatalogs(), { origin: 'https://ferretry.pages.dev', enabled: true, version: 4 }),
    );

    // Assert
    const deepseek = view.catalogs.find(catalog => catalog.id === 'deepseek');
    should(deepseek?.claude?.find(model => model.default)).match({
      id: 'deepseek-flash[1m]',
      tier: 'fast',
      context: 1_000_000,
    });
    should(deepseek?.codex?.find(model => model.default)?.id).equal('deepseek-flash');
    should(view.catalogs.find(catalog => catalog.id === 'openai')?.claude).be.undefined();
    should(view.catalogs.find(catalog => catalog.id === 'anthropic')?.codex).be.undefined();
    should(
      view.catalogs.find(catalog => catalog.id === 'minimax')?.claude?.find(model => model.id === 'MiniMax-M2.7'),
    ).have.property('context');
    should(view.published).deepEqual({ origin: 'https://ferretry.pages.dev', enabled: true, version: 4 });
  });
});

describe('modelCatalogsView facts for the guide builder', () => {
  it("should carry a model's note, list price and retirement day when its catalog states them, and nothing when not", () => {
    // Arrange
    const catalogs = builtInModelCatalogs();
    const [id, catalog] = Object.entries(catalogs)[0] as [string, (typeof catalogs)[string]];
    const half = (catalog.claude ?? catalog.codex) as NonNullable<typeof catalog.claude>;
    const [first, ...rest] = half.models;
    const stated = {
      ...first,
      note: 'A sentence.',
      price: {
        ...(first?.price ?? {}),
        provider: 'openai',
        input: 1,
        output: 4,
        cacheRead: 0.1,
        source: 'https://example.com/pricing',
        verified: '2026-10-01',
      },
      retires: '2027-01-31',
    };
    const bare = { ...first, note: undefined, price: undefined, retires: undefined };
    const make = (model: unknown) =>
      modelCatalogsView(
        {
          [id]: {
            ...catalog,
            ...(catalog.claude
              ? { claude: { ...half, models: [model, ...rest] } }
              : { codex: { ...half, models: [model, ...rest] } }),
          },
        } as never,
        {
          origin: 'https://ferretry.pages.dev',
          enabled: false,
        },
      );

    // Act
    const withFacts = make(stated).catalogs[0];
    const without = make(bare).catalogs[0];

    // Assert
    const entry = (withFacts?.claude ?? withFacts?.codex)?.[0];
    should(entry).containEql({ note: 'A sentence.', price: { input: 1, output: 4 }, retires: '2027-01-31' });
    const plain = (without?.claude ?? without?.codex)?.[0];
    should(plain).not.have.properties(['note', 'price', 'retires']);
  });
});
