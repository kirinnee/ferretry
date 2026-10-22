import { describe, it } from 'bun:test';
import should from 'should';
import { buildInventory, inventoryRuntimes, readyByHeadroom } from '../../../../src/lib/pack/builder/inventory.ts';
import { catalog, choice, credential, entry, facts, runtime, tool } from '../support.ts';

const NOW = '2026-10-22T12:00:00.000Z';

const CATALOGS = [
  catalog('anthropic', 'Anthropic', {
    claude: [
      entry('opus', 'Opus', 'best', {
        efforts: ['low', 'high'],
        context: 1_000_000,
        note: 'The strongest planner.',
        price: { input: 5, output: 25 },
        retires: '2027-06-01',
      }),
      entry('haiku', 'Haiku', 'fast'),
    ],
  }),
  catalog('openai', 'OpenAI', { codex: [entry('gpt-6', 'GPT-6', 'best', { efforts: ['medium', 'xhigh'] })] }),
];

const opusOn = (name: string) => runtime(name, { catalogId: 'anthropic', choices: [choice('opus', 'Opus')] });
const week = (name: string, used: number) =>
  credential(`${name}-login`, { usage: { fiveHour: { usedPercent: 2 }, weekly: { usedPercent: used } } });

describe('buildInventory', () => {
  it("should list every catalog model with the owner's words or the catalog's, its price and retirement, runtimes and headroom", () => {
    // Arrange
    const known = facts({
      runtimes: [
        opusOn('claude-kirin'),
        opusOn('claude-atomi'),
        runtime('claude-off', {
          catalogId: 'anthropic',
          choices: [choice('opus', 'Opus')],
          launch: { available: false, reason: 'its folder is gone' },
        }),
      ],
      credentials: [week('claude-kirin', 91), week('claude-atomi', 20)],
      tools: [tool('claude', true)],
      now: NOW,
    });

    // Act
    const inventory = buildInventory({
      catalogs: CATALOGS,
      facts: known,
      guide: { source: 'derived', useCases: [] },
      described: [{ provider: 'anthropic', model: 'haiku', description: 'Cheap; fine for renames.' }],
      preferences: '  Keep Opus for reviews.  ',
      now: NOW,
    });

    // Assert
    const opus = inventory.models.find(model => model.id === 'opus');
    should(opus).deepEqual({
      provider: 'anthropic',
      providerLabel: 'Anthropic',
      harness: 'claude',
      id: 'opus',
      label: 'Opus',
      tier: 'best',
      context: 1_000_000,
      efforts: ['low', 'high'],
      description:
        'Opus: the strongest tier on Anthropic, reads 1000k tokens, efforts low/high. The strongest planner.',
      describedBy: 'catalog',
      retires: '2027-06-01',
      price: { input: 5, output: 25 },
      runtimes: [
        { name: 'claude-kirin', ready: true },
        { name: 'claude-atomi', ready: true },
        { name: 'claude-off', ready: false, reason: 'claude-off cannot launch: its folder is gone' },
      ],
      headroom: {
        runtimes: 3,
        ready: 2,
        best: {
          runtime: 'claude-atomi',
          quota: {
            state: 'plenty',
            leftPercent: 80,
            tightest: 'week',
            windows: [
              { label: '5h', usedPercent: 2, leftPercent: 98 },
              { label: 'week', usedPercent: 20, leftPercent: 80 },
            ],
            summary: '5h 2% · wk 20%',
          },
        },
        summary: '3 runtimes, 2 ready; most headroom on claude-atomi: 5h 2% · wk 20%',
      },
    });
    should(inventory.models.find(model => model.id === 'haiku')).containEql({
      description: 'Cheap; fine for renames.',
      describedBy: 'owner',
      headroom: { runtimes: 0, ready: 0, summary: 'no runtime here runs it' },
    });
    should(inventory.models.map(model => model.id)).deepEqual(['opus', 'haiku', 'gpt-6']);
    should(inventory.preferences).equal('Keep Opus for reviews.');
    should(inventory.at).equal(NOW);
  });

  it('should say a model none of whose runtimes can start is not ready, and leave out empty preferences', () => {
    // Arrange
    const known = facts({
      runtimes: [
        runtime('claude-off', {
          catalogId: 'anthropic',
          choices: [choice('opus', 'Opus')],
          launch: { available: false, reason: 'gone' },
        }),
      ],
      tools: [tool('claude', true)],
    });

    // Act
    const inventory = buildInventory({
      catalogs: CATALOGS,
      facts: known,
      guide: { source: 'derived', useCases: [] },
      described: [],
      preferences: '   ',
      now: NOW,
    });

    // Assert
    should(inventory.models[0]?.headroom.summary).equal('1 runtime, none ready');
    should(inventory).not.have.property('preferences');
  });

  it('should never carry anything but names and states: no credential field reaches it', () => {
    // Arrange
    const known = facts({ runtimes: [opusOn('claude-kirin')], credentials: [week('claude-kirin', 10)], now: NOW });

    // Act
    const text = JSON.stringify(
      buildInventory({
        catalogs: CATALOGS,
        facts: known,
        guide: { source: 'derived', useCases: [] },
        described: [],
        now: NOW,
      }),
    );

    // Assert
    should(text).not.match(/"[a-z]*(token|secret|key|password|email|value|credential)[a-z]*"\s*:/iu);
  });
});

describe('inventoryRuntimes and readyByHeadroom', () => {
  it('should list agent runtimes only, with refusals, and order the ready ones by headroom', () => {
    // Arrange
    const known = facts({
      runtimes: [
        opusOn('claude-kirin'),
        opusOn('claude-atomi'),
        runtime('claude-person', { agent: false }),
        runtime('codex-bare', { harness: 'codex' }),
      ],
      credentials: [week('claude-kirin', 91), week('claude-atomi', 30)],
      tools: [tool('claude', true), tool('codex', false)],
      now: NOW,
    });

    // Act
    const runtimes = inventoryRuntimes(known, NOW);

    // Assert
    should(runtimes.map(row => [row.name, row.ready, row.provider, row.login, row.refusal?.code])).deepEqual([
      ['claude-kirin', true, 'anthropic', 'claude-kirin-login', undefined],
      ['claude-atomi', true, 'anthropic', 'claude-atomi-login', undefined],
      ['codex-bare', false, undefined, 'codex-bare-login', 'cli_missing'],
    ]);
    should(readyByHeadroom(runtimes).map(row => row.name)).deepEqual(['claude-atomi', 'claude-kirin']);
  });
});
