/**
 * U4b part 4a (packs): Pack mode reads a harness through Runtimes' table and refuses one it does not know, instead of
 * reading it as Claude. `fake-third` is a harness key no table has a row for.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { renderInventory } from '../../../cli/lib/guide-render.ts';
import { PackInventoryModelSchema, PackInventoryRuntimeSchema } from '../../../contract/cleanup.ts';
import { PackFleetModelSchema } from '../../../contract/wire.ts';
import { halfOf } from '../../../daemon/lib/catalog.ts';
import { fleetModels } from '../../../daemon/lib/routing.ts';
import { INVENTORY } from '../cli/fixtures.ts';
import { catalog, choice, entry, runtime } from './support.ts';

const THIRD = 'fake-third';

describe('a harness key Packs has no row for (U4b part 4a)', () => {
  it('should carry the key on the wire views instead of refusing the whole document', () => {
    // Arrange
    const model = {
      provider: 'p',
      providerLabel: 'P',
      harness: THIRD,
      id: 'm',
      label: 'M',
      tier: 'best',
      efforts: [],
      runtimes: [],
    };

    // Act + Assert
    should(PackFleetModelSchema.safeParse(model).success).equal(true);
    const [inventoryModel] = INVENTORY.models;
    const [inventoryRuntime] = INVENTORY.runtimes;
    if (inventoryModel === undefined || inventoryRuntime === undefined) throw new Error('fixture is empty');
    should(PackInventoryModelSchema.safeParse({ ...inventoryModel, harness: THIRD }).success).equal(true);
    should(PackInventoryRuntimeSchema.safeParse({ ...inventoryRuntime, harness: THIRD }).success).equal(true);
    should(PackFleetModelSchema.safeParse({ ...model, harness: 'Not A Key' }).success).equal(false);
  });

  it('should tag a model by its own key in the inventory, never leave it untagged as if it were Claude', () => {
    // Arrange
    const [first] = INVENTORY.models;
    if (first === undefined) throw new Error('fixture has no model');
    const inventory = {
      ...INVENTORY,
      models: [
        { ...first, id: 'on-claude', harness: 'claude-code' },
        { ...first, id: 'on-codex', harness: 'codex' },
        { ...first, id: 'on-third', harness: THIRD },
      ],
    };

    // Act
    const lines = renderInventory(inventory).split('\n');

    // Assert
    should(lines.find(line => line.includes('/on-claude'))?.includes(' (')).equal(false);
    should(lines.find(line => line.includes('/on-codex'))).match(/\/on-codex \(codex\) — /u);
    should(lines.find(line => line.includes('/on-third'))).match(/\/on-third \(fake-third\) — /u);
  });

  it('should read a catalog half by its word and never fall back to a list of another harness', () => {
    // Arrange
    const anthropic = catalog('anthropic', 'Anthropic', { claude: [entry('opus', 'Opus', 'best')] });

    // Act + Assert
    should(halfOf(anthropic, 'claude')?.map(model => model.id)).deepEqual(['opus']);
    should(halfOf(anthropic, 'codex')).equal(undefined);
    should(halfOf(anthropic, THIRD)).equal(undefined);
    should(halfOf(anthropic, 'id')).equal(undefined);
    should(halfOf(anthropic, '__proto__')).equal(undefined);
  });

  it('should list the models of the harnesses Runtimes has words for, and no runtime on another harness runs one', () => {
    // Arrange
    const both = catalog('mix', 'Mix', {
      claude: [entry('c-model', 'C', 'best')],
      codex: [entry('x-model', 'X', 'best')],
    });
    const onThird = runtime('third-box', {
      harness: THIRD as never,
      catalogId: 'mix',
      choices: [choice('c-model', 'C'), choice('x-model', 'X')],
    });

    // Act
    const models = fleetModels([both], [onThird]);

    // Assert
    should(models.map(model => `${model.harness}:${model.id}`)).deepEqual(['claude-code:c-model', 'codex:x-model']);
    should(models.flatMap(model => model.runtimes)).deepEqual([]);
  });
});
