/**
 * "Which AI do you want to use?": the pick as data. Others -> provider -> harness is read from the CATALOG rows (no provider is
 * named in the code), the pick flattens to the segments the run walks (Claude, then Codex), and the flow hides the pages of every
 * segment left out without recording anything.
 */
import { describe, expect, test } from 'bun:test';
import {
  comingFor,
  defaultPick,
  foundOn,
  type Harness,
  isEmptyPick,
  listedHarnesses,
  memoryOfPick,
  pickFromMemory,
  type Pick,
  PresetCatalogSchema,
  providersOf,
  segmentsOf,
  withHarness,
  withProvider,
  withTicked,
} from '../../../app/features/agents/agents-model.ts';
import { EMPTY_LEDGER, flattenFlow, type PairedDaemon } from '../../../app/lib/index.ts';
import { ProviderPresetCatalogSchema } from '@ferretry/plugin-logins/contract';
import { REAL_PROVIDER_PRESET_CATALOG as realCatalog } from '@ferretry/plugin-logins/contract/testing';
import {
  advance,
  answeredBefore,
  applyPicked,
  clearNotNeeded,
  markNotNeeded,
  pagesOf,
  pickedOf,
  startRun,
} from '../../../app/features/setup-flow/flow-model.ts';

/** The harnesses installed on the machine, as the daemon's registry states them. */
const HARNESSES: readonly Harness[] = [
  { key: 'claude-code', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
];
const DEFAULT_PICK = defaultPick(HARNESSES);

const yes = { available: true } as const;
const no = { available: false, reason: 'not yet' } as const;
const row = (id: string, label: string, halves: readonly (readonly [string, boolean])[], offered = true) => ({
  id,
  label,
  offered: offered ? yes : no,
  halves: halves.map(([harness, on]) => ({ harness, offered: on ? yes : no })),
});

/** A catalog with names the code has never heard of: the list can only come from the data. */
const catalog = PresetCatalogSchema.parse({
  presets: [
    row('alpha-ai', 'Alpha AI', [['claude-code', true]]),
    row('beta-ai', 'Beta AI', [
      ['codex', true],
      ['claude-code', true],
    ]),
    row('gamma-ai', 'Gamma AI', [['codex', false]]),
    row('delta-ai', 'Delta AI', [['gemini', true]]),
    row('eps-ai', 'Eps AI', [['claude-code', true]], false),
    row('alpha-ai', 'Alpha AI again', [['claude-code', true]]),
  ],
});

describe('Others: the provider list and the harness choice come from the catalog', () => {
  const providers = providersOf(catalog, HARNESSES);

  test('lists only offered providers a supported harness can run, once each, in catalog order', () => {
    expect(providers.map(provider => provider.id)).toEqual(['alpha-ai', 'beta-ai']);
  });

  test('"Which harness runs it?" offers only supported harnesses with an offered half, Claude before Codex', () => {
    expect(providers.map(provider => provider.harnesses)).toEqual([['claude-code'], ['claude-code', 'codex']]);
  });

  test('ticking a provider picks its first harness; the choice is limited to the ones it offers', () => {
    const beta = providers[1]!;
    let pick = withProvider(DEFAULT_PICK, beta, true);
    expect(pick.others).toEqual({ 'beta-ai': 'claude-code' });
    pick = withHarness(pick, beta, 'codex');
    expect(pick.others).toEqual({ 'beta-ai': 'codex' });
    expect(withHarness(pick, beta, 'gemini')).toBe(pick);
    expect(withHarness(DEFAULT_PICK, beta, 'codex')).toBe(DEFAULT_PICK);
    expect(withProvider(pick, beta, false).others).toEqual({});
  });
});

describe('the pick flattens to the segments the run walks', () => {
  const providers = providersOf(catalog, HARNESSES);
  const flat = (pick: Pick) => segmentsOf(pick, providers, HARNESSES);
  const none: Pick = { ticked: [], others: {} };

  test('Claude only (the default)', () => {
    expect(flat(DEFAULT_PICK)).toEqual({ on: ['claude-code'], off: ['codex'] });
  });
  test('Codex only', () => {
    expect(flat({ ...none, ticked: ['codex'] })).toEqual({ on: ['codex'], off: ['claude-code'] });
  });
  test('both, always Claude then Codex', () => {
    expect(flat({ ...none, ticked: ['codex', 'claude-code'] })).toEqual({ on: ['claude-code', 'codex'], off: [] });
  });
  test('neither', () => {
    expect(flat(none)).toEqual({ on: [], off: ['claude-code', 'codex'] });
  });
  test('an Others provider run by Codex walks the Codex segment', () => {
    expect(flat({ ...none, others: { 'beta-ai': 'codex' } })).toEqual({ on: ['codex'], off: ['claude-code'] });
  });
  test('Claude plus an Others provider run by Codex walks both', () => {
    expect(flat({ ...DEFAULT_PICK, others: { 'beta-ai': 'codex' } }).on).toEqual(['claude-code', 'codex']);
  });
  test('an Others choice the provider does not offer, or one the catalog dropped, walks nothing', () => {
    expect(flat({ ...none, others: { 'alpha-ai': 'codex', 'gone-ai': 'claude-code' } }).on).toEqual([]);
  });
});

describe('the flow hides the unpicked segments and records nothing', () => {
  const step = (plugin: string, id: string, order: number) => ({
    plugin,
    id,
    title: id,
    order,
    side: 'daemon' as const,
    stepHost: true as const,
    state: 'pending' as const,
    group: plugin,
  });
  const daemon: PairedDaemon = {
    id: 'fy_daemon_a',
    name: 'Studio',
    harnesses: HARNESSES,
    steps: [
      step('onboarding', 'agents', 2),
      step('onboarding', 'name', 5),
      step('claude-code', 'installed', 20),
      step('claude-code', 'sign-in', 21),
      step('codex', 'installed', 40),
      step('codex', 'sign-in', 41),
      step('runtimes', 'start', 10),
    ],
  };
  const pages = pagesOf(
    flattenFlow({ journey: 'first-time', target: daemon.id, daemons: [daemon], ledger: EMPTY_LEDGER }),
  );
  const run = startRun(pages, new Set());
  const walk = (state: ReturnType<typeof startRun>): string[] => {
    const seen: string[] = [state.at];
    let at = state;
    for (let guard = 0; guard < 20 && at.at !== 'end'; guard += 1) {
      at = advance(at, pages, new Set());
      seen.push(at.at);
    }
    return seen;
  };

  test('the picker is the first page of the run', () => {
    expect(run.at).toBe('onboarding.agents');
  });

  test('Claude only: the Codex pages are never landed on', () => {
    const state = applyPicked(run, pages, { on: ['claude-code'], off: ['codex'] });
    expect(walk(state)).toEqual([
      'onboarding.agents',
      'onboarding.name',
      'runtimes.start',
      'claude-code.installed',
      'claude-code.sign-in',
      'end',
    ]);
  });

  test('Codex only: the Claude pages are never landed on', () => {
    const state = applyPicked(run, pages, { on: ['codex'], off: ['claude-code'] });
    expect(walk(state).filter(key => key.startsWith('claude-code'))).toEqual([]);
    expect(walk(state)).toContain('codex.sign-in');
  });

  test('both: every page is asked', () => {
    const state = applyPicked(run, pages, { on: ['claude-code', 'codex'], off: [] });
    expect(walk(state)).toHaveLength(8);
  });

  test('changing the pick brings a segment back, and leaves the machine nothing to record', () => {
    const claudeOnly = applyPicked(run, pages, { on: ['claude-code'], off: ['codex'] });
    expect([...claudeOnly.notNeeded].sort()).toEqual(['codex.installed', 'codex.sign-in']);
    const both = applyPicked(claudeOnly, pages, { on: ['claude-code', 'codex'], off: [] });
    expect(both.notNeeded.size).toBe(0);
    expect(applyPicked(both, pages, { on: ['claude-code', 'codex'], off: [] })).toBe(both);
  });

  test('a later page of the same plugin leaving its own memory does not bring an unpicked page back', () => {
    const claudeOnly = applyPicked(run, pages, { on: ['claude-code'], off: ['codex'] });
    const moved = { ...claudeOnly, at: 'claude-code.installed' };
    expect(clearNotNeeded(moved, pages, 'claude-code').notNeeded.has('codex.sign-in')).toBe(true);
    expect(markNotNeeded(claudeOnly, pages, new Set(), 'codex.sign-in')).toBe(claudeOnly);
  });

  test('the picker memory is read back as the pick, and absent memory picks nothing', () => {
    const memory = memoryOfPick(DEFAULT_PICK, providersOf(catalog, HARNESSES), HARNESSES);
    expect(pickedOf(memory)).toEqual({ on: ['claude-code'], off: ['codex'] });
    const nothing: Pick = { ticked: [], others: {} };
    expect(pickedOf(memoryOfPick(nothing, providersOf(catalog, HARNESSES), HARNESSES))).toEqual({
      on: [],
      off: ['claude-code', 'codex'],
    });
    expect(pickedOf({})).toBeUndefined();
  });

  test('Back to the page shows what was ticked, not the default; a missing or broken memory is the default', () => {
    const providers = providersOf(catalog, HARNESSES);
    const ticked: Pick = { ticked: ['codex'], others: { 'beta-ai': 'codex' } };
    expect(pickFromMemory(memoryOfPick(ticked, providers, HARNESSES), HARNESSES)).toEqual(ticked);
    expect(pickFromMemory({}, HARNESSES)).toEqual(DEFAULT_PICK);
    expect(pickFromMemory({ agentsPick: 'not json' }, HARNESSES)).toEqual(DEFAULT_PICK);
    expect(pickFromMemory({ agentsPick: '{"claude":1}' }, HARNESSES)).toEqual(DEFAULT_PICK);
  });
});

/**
 * The REAL catalog: Logins' `REAL_PROVIDER_PRESET_CATALOG` is `ProviderPresetService.catalog()` over the shipped built-in presets,
 * whole, and Logins' own test (`real-presets.test.ts`) turns red when a shipped preset changes without it. It names a harness the way the wire does
 * (`claude-code`), which a hand-made catalog once got wrong without any test noticing.
 */
describe('the provider list over the real catalog', () => {
  const real = providersOf(PresetCatalogSchema.parse(realCatalog), HARNESSES);

  test('the fixture is the Logins wire shape, whole', () => {
    expect(ProviderPresetCatalogSchema.safeParse(realCatalog).success).toBe(true);
  });
  const harnessesOf = (id: string): readonly string[] | undefined =>
    real.find(provider => provider.id === id)?.harnesses;

  test('GLM (Z.ai) is offered, run by Claude Code', () => {
    expect(harnessesOf('zai-glm')).toEqual(['claude-code']);
  });
  test('Kimi, MiniMax and DeepSeek offer Claude Code AND Codex, Claude Code first', () => {
    for (const id of ['kimi', 'minimax', 'deepseek']) expect(harnessesOf(id)).toEqual(['claude-code', 'codex']);
  });
  test('a Codex-only provider is offered for Codex alone', () => {
    expect(harnessesOf('openai-api-key')).toEqual(['codex']);
  });
  test('every harness any offered half names is one the page can run (none is silently dropped)', () => {
    const named = new Set(realCatalog.presets.flatMap(row => row.halves.map(half => half.harness)));
    expect([...named].sort()).toEqual(['claude-code', 'codex']);
    for (const row of realCatalog.presets) expect(real.some(provider => provider.id === row.id)).toBe(true);
  });
});

describe('an empty pick', () => {
  const providers = providersOf(catalog, HARNESSES);
  test('walks no harness; any ticked AI is not empty', () => {
    expect(isEmptyPick({ ticked: [], others: {} }, providers, HARNESSES)).toBe(true);
    expect(isEmptyPick(DEFAULT_PICK, providers, HARNESSES)).toBe(false);
    expect(isEmptyPick({ ticked: [], others: { 'beta-ai': 'codex' } }, providers, HARNESSES)).toBe(false);
  });
});

describe('answers the picker already sees', () => {
  const step = (plugin: string, id: string, order: number, state: 'pending' | 'done' | 'found') => ({
    plugin,
    id,
    title: id,
    order,
    side: 'daemon' as const,
    stepHost: true as const,
    state,
    group: plugin,
  });
  const make = (
    states: readonly ['pending' | 'done' | 'found', 'pending' | 'done' | 'found', 'pending' | 'done' | 'found'],
  ) => {
    const daemon: PairedDaemon = {
      id: 'fy_daemon_a',
      name: 'Studio',
      steps: [
        step('onboarding', 'agents', 2, states[0]),
        step('claude-code', 'installed', 20, states[1]),
        step('codex', 'installed', 40, states[2]),
      ],
    };
    return pagesOf(flattenFlow({ journey: 'first-time', target: daemon.id, daemons: [daemon], ledger: EMPTY_LEDGER }));
  };

  test('the picker is asked again while a harness page is still unanswered (the pick itself is never stored)', () => {
    expect(answeredBefore(make(['done', 'pending', 'done']), new Set(), HARNESSES).has('onboarding.agents')).toBe(
      false,
    );
  });
  test('and stays answered once every harness page is', () => {
    expect(answeredBefore(make(['done', 'found', 'done']), new Set(), HARNESSES).has('onboarding.agents')).toBe(true);
  });
  test('an answered page of a segment left out is passed over, never marked: no mark means nothing is told to the machine', () => {
    const pages = make(['pending', 'found', 'pending']);
    const answered = answeredBefore(pages, new Set(), HARNESSES);
    const state = applyPicked(startRun(pages, answered), pages, { on: ['codex'], off: ['claude-code'] }, answered);
    expect([...state.notNeeded]).toEqual([]);
    expect([...state.aside]).toEqual(['claude-code.installed']);
    // Picked again, it is no longer set aside.
    expect(applyPicked(state, pages, { on: ['claude-code', 'codex'], off: [] }, answered).aside.size).toBe(0);
  });
  test('without the answered set an unanswered page is marked as before', () => {
    const pages = make(['pending', 'pending', 'pending']);
    const state = applyPicked(startRun(pages, new Set()), pages, { on: ['codex'], off: ['claude-code'] });
    expect([...state.notNeeded]).toEqual(['claude-code.installed']);
  });
});

describe('"found on this computer" comes from the scan, for the harnesses installed here', () => {
  test('a harness not installed, or no scan yet, has no note; an installed one says whether a setup is ready to bring over', () => {
    expect(foundOn(null)).toEqual({});
    expect(
      foundOn({
        'claude-code': { installed: true, empty: false },
        codex: { installed: false, empty: true },
      }),
    ).toEqual({ 'claude-code': { ready: true } });
    expect(foundOn({ codex: { installed: true, empty: true } })).toEqual({ codex: { ready: false } });
  });
});

describe('the harnesses the page lists come from the registry', () => {
  const third: Harness = { key: 'fake-third', label: 'Fake Third' };

  test('Claude Code leads whatever order the registry gave, and the rest keep theirs', () => {
    expect(listedHarnesses([HARNESSES[1]!, third, HARNESSES[0]!]).map(harness => harness.key)).toEqual([
      'claude-code',
      'codex',
      'fake-third',
    ]);
  });

  test('only Claude Code is ticked at first; it is the first harness when Claude Code is not installed', () => {
    expect(defaultPick([HARNESSES[1]!, third, HARNESSES[0]!]).ticked).toEqual(['claude-code']);
    expect(defaultPick([HARNESSES[1]!, third]).ticked).toEqual(['codex']);
    expect(defaultPick([]).ticked).toEqual([]);
  });

  test('a third harness is listed, ticked, walked and left out like the first two, with no edit here', () => {
    const installed = [...HARNESSES, third];
    expect(segmentsOf(defaultPick(installed), [], installed)).toEqual({
      on: ['claude-code'],
      off: ['codex', 'fake-third'],
    });
    expect(segmentsOf(withTicked(defaultPick(installed), 'fake-third', true), [], installed).on).toEqual([
      'claude-code',
      'fake-third',
    ]);
    expect(withTicked(withTicked(DEFAULT_PICK, 'codex', true), 'codex', true).ticked).toEqual(['claude-code', 'codex']);
    expect(withTicked(DEFAULT_PICK, 'claude-code', false).ticked).toEqual([]);
  });

  test('a harness the registry does not list is never walked, however the memory ticked it', () => {
    expect(segmentsOf({ ticked: ['gone', 'codex'], others: {} }, [], HARNESSES)).toEqual({
      on: ['codex'],
      off: ['claude-code'],
    });
  });

  test('Google (Antigravity CLI) is shown as coming until an installed harness covers it', () => {
    expect(comingFor(HARNESSES).map(choice => choice.title)).toEqual(['Google (Antigravity CLI)']);
    expect(comingFor([...HARNESSES, { key: 'antigravity', label: 'Antigravity' }])).toEqual([]);
    expect(comingFor([...HARNESSES, { key: 'gemini', label: 'Gemini' }])).toEqual([]);
  });

  test('the flow reads the harness pages from the registry too: a third harness page keeps the picker asking', () => {
    const daemon: PairedDaemon = {
      id: 'fy_daemon_a',
      name: 'Studio',
      steps: [
        {
          plugin: 'onboarding',
          id: 'agents',
          title: 'agents',
          order: 2,
          side: 'daemon',
          stepHost: true,
          state: 'done',
          group: 'g',
        },
        {
          plugin: 'fake-third',
          id: 'sign-in',
          title: 'sign-in',
          order: 60,
          side: 'daemon',
          stepHost: true,
          state: 'pending',
          group: 'g',
        },
      ],
    };
    const pages = pagesOf(
      flattenFlow({ journey: 'first-time', target: daemon.id, daemons: [daemon], ledger: EMPTY_LEDGER }),
    );
    expect(answeredBefore(pages, new Set(), [third]).has('onboarding.agents')).toBe(false);
    expect(answeredBefore(pages, new Set(), HARNESSES).has('onboarding.agents')).toBe(true);
  });
});

describe("a provider's harness choice follows the listed order, whatever order the registry gave", () => {
  test('Claude Code before Codex even when the registry lists Codex first', () => {
    const reversed: readonly Harness[] = [HARNESSES[1]!, HARNESSES[0]!];
    expect(providersOf(catalog, reversed).map(provider => provider.harnesses)).toEqual([
      ['claude-code'],
      ['claude-code', 'codex'],
    ]);
  });
});
