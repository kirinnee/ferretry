import { describe, it } from 'bun:test';
import { type PackFleetModel, PackInventorySchema, type RoutingPromptView } from '@ferretry/protocol';
import should from 'should';
import { buildInventory, inventoryRuntimes, readyByHeadroom } from '../../../../src/lib/pack/cleanup/inventory.ts';
import { choice, credential, facts, runtime, tool } from '../support.ts';

const NOW = '2026-10-22T12:00:00.000Z';

const model = (overrides: Partial<PackFleetModel> = {}): PackFleetModel => ({
  provider: 'anthropic',
  providerLabel: 'Anthropic',
  harness: 'claude',
  id: 'opus',
  label: 'Opus',
  tier: 'best',
  efforts: ['low', 'high'],
  runtimes: [],
  ...overrides,
});

const ROUTING: RoutingPromptView = { text: 'Opus for planning, haiku for chores.', source: 'file' };

const opusOn = (name: string) => runtime(name, { catalogId: 'anthropic', choices: [choice('opus', 'Opus')] });
const week = (name: string, used: number) =>
  credential(`${name}-login`, { usage: { fiveHour: { usedPercent: 2 }, weekly: { usedPercent: used } } });

describe('buildInventory', () => {
  it('should list every model with the runtimes here that run it and whether each is ready, and carry the prompt in effect', () => {
    // Arrange
    const known = facts({
      runtimes: [
        opusOn('claude-kirin'),
        runtime('claude-off', {
          catalogId: 'anthropic',
          choices: [choice('opus', 'Opus')],
          launch: { available: false, reason: 'its folder is gone' },
        }),
      ],
      credentials: [week('claude-kirin', 20)],
      tools: [tool('claude', true)],
      now: NOW,
    });
    const models = [
      model({ context: 1_000_000, runtimes: ['claude-kirin', 'claude-off', 'claude-gone'] }),
      model({ id: 'haiku', label: 'Haiku', tier: 'fast', efforts: [] }),
      model({ provider: 'openai', providerLabel: 'OpenAI', harness: 'codex', id: 'gpt-6', label: 'GPT-6' }),
    ];

    // Act
    const inventory = buildInventory({ facts: known, models, routing: ROUTING, now: NOW });

    // Assert
    should(inventory.at).equal(NOW);
    should(inventory.routing).deepEqual(ROUTING);
    should(inventory.models.map(row => row.id)).deepEqual(['opus', 'haiku', 'gpt-6']);
    should(inventory.models[0]).deepEqual({
      provider: 'anthropic',
      harness: 'claude',
      id: 'opus',
      label: 'Opus',
      tier: 'best',
      context: 1_000_000,
      efforts: ['low', 'high'],
      runtimes: [
        { name: 'claude-kirin', ready: true },
        { name: 'claude-off', ready: false },
        { name: 'claude-gone', ready: false },
      ],
    });
    should(inventory.models[1]).deepEqual({
      provider: 'anthropic',
      harness: 'claude',
      id: 'haiku',
      label: 'Haiku',
      tier: 'fast',
      efforts: [],
      runtimes: [],
    });
  });

  it('should be valid against the wire schema', () => {
    // Arrange
    const known = facts({
      runtimes: [opusOn('claude-kirin'), runtime('codex-bare', { harness: 'codex' })],
      credentials: [week('claude-kirin', 40)],
      tools: [tool('claude', true), tool('codex', false)],
      now: NOW,
    });

    // Act
    const inventory = buildInventory({
      facts: known,
      models: [model({ runtimes: ['claude-kirin'] })],
      routing: { ...ROUTING, source: 'default' },
      now: NOW,
    });

    // Assert
    should(PackInventorySchema.safeParse(inventory).success).be.true();
  });

  it('should never carry anything but names and states: no credential field reaches it', () => {
    // Arrange
    const known = facts({ runtimes: [opusOn('claude-kirin')], credentials: [week('claude-kirin', 10)], now: NOW });

    // Act
    const text = JSON.stringify(buildInventory({ facts: known, models: [model()], routing: ROUTING, now: NOW }));

    // Assert
    should(text).not.match(/"[a-z]*(token|secret|key|password|email|value)[a-z]*"\s*:/iu);
  });
});

describe('inventoryRuntimes', () => {
  it('should list agent runtimes only, with the provider, login, refusal and models each offers', () => {
    // Arrange
    const known = facts({
      runtimes: [
        opusOn('claude-kirin'),
        runtime('claude-person', { agent: false }),
        runtime('codex-bare', { harness: 'codex' }),
      ],
      credentials: [week('claude-kirin', 30)],
      tools: [tool('claude', true), tool('codex', false)],
      now: NOW,
    });

    // Act
    const runtimes = inventoryRuntimes(known, NOW);

    // Assert
    should(
      runtimes.map(row => [row.name, row.ready, row.provider, row.login, row.refusal?.code, row.models]),
    ).deepEqual([
      ['claude-kirin', true, 'anthropic', 'claude-kirin-login', undefined, ['opus']],
      ['codex-bare', false, undefined, 'codex-bare-login', 'cli_missing', []],
    ]);
    should(runtimes[0]?.quota.state).equal('plenty');
    should(runtimes[0]?.quota.leftPercent).equal(70);
  });

  it('should offer only the available models of a model set when the runtime has no catalog', () => {
    // Arrange
    const withSet = runtime('claude-set', {
      modelSet: {
        source: 'model-set',
        models: [
          { id: 'opus', label: 'Opus', efforts: [], available: true },
          { id: 'haiku', label: 'Haiku', efforts: [], available: false },
        ],
      },
    } as never);
    const known = facts({ runtimes: [withSet], tools: [tool('claude', true)], now: NOW });

    // Act
    const runtimes = inventoryRuntimes(known, NOW);

    // Assert
    should(runtimes[0]?.models).deepEqual(['opus']);
    should(runtimes[0]?.provider).be.undefined();
  });

  it('should say a login nobody measured has unknown quota', () => {
    // Arrange
    const known = facts({ runtimes: [opusOn('claude-new')], tools: [tool('claude', true)], now: NOW });

    // Act
    const runtimes = inventoryRuntimes(known, NOW);

    // Assert
    should(runtimes[0]?.quota.state).equal('unknown');
  });
});

describe('readyByHeadroom', () => {
  it('should drop what is not ready and put the runtime with the most quota left first', () => {
    // Arrange
    const known = facts({
      runtimes: [
        opusOn('claude-kirin'),
        opusOn('claude-atomi'),
        opusOn('claude-mid'),
        runtime('codex-bare', { harness: 'codex' }),
      ],
      credentials: [week('claude-kirin', 91), week('claude-atomi', 30), week('claude-mid', 60)],
      tools: [tool('claude', true), tool('codex', false)],
      now: NOW,
    });
    const runtimes = inventoryRuntimes(known, NOW);

    // Act
    const actual = readyByHeadroom(runtimes).map(row => row.name);

    // Assert
    should(actual).deepEqual(['claude-atomi', 'claude-mid', 'claude-kirin']);
  });

  it('should keep the listed order among equals, and leave an exhausted login out because it cannot start', () => {
    // Arrange
    const known = facts({
      runtimes: [opusOn('claude-a'), opusOn('claude-out'), opusOn('claude-b')],
      credentials: [week('claude-out', 100)],
      tools: [tool('claude', true)],
      now: NOW,
    });
    const runtimes = inventoryRuntimes(known, NOW);

    // Act
    const actual = readyByHeadroom(runtimes).map(row => row.name);

    // Assert
    should(actual).deepEqual(['claude-a', 'claude-b']);
  });

  it('should answer nothing when no runtime can start', () => {
    // Arrange
    const known = facts({ runtimes: [runtime('codex-bare', { harness: 'codex' })], tools: [tool('codex', false)] });

    // Act
    const actual = readyByHeadroom(inventoryRuntimes(known, NOW));

    // Assert
    should(actual).deepEqual([]);
  });
});
