import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { describe, expect, test } from 'bun:test';
import type { FencedPath, FerretId } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import type { FerretRecord, Harness, HarnessKey, LaunchSpec, RunSpec } from '../../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../../daemon/lib/tokens/tokens.ts';

/**
 * Each harness names its own per-ferret home (`Harness.homeFor`), and Ferrets launches with exactly that answer after
 * the harness has prepared it. Fixture paths only: nothing here touches a real home or launches anything real.
 */

const CLAUDE_HOMES = '/fixture-fy/state/claude-code/agent-homes';
const CODEX_HOMES = '/fixture-fy/state/codex/agent-homes';

/** A runner that writes every start and resume into one shared log, so order against `prepareHome` is visible. */
class LoggingRunner extends FakeRunner {
  constructor(private readonly log: string[]) {
    super();
  }
  override async start(spec: RunSpec) {
    this.log.push(`runner.start ${spec.ferret}`);
    return await super.start(spec);
  }
}

/** A fake harness whose `prepareHome` writes into the same log. */
class LoggingHarness extends FakeHarness {
  constructor(
    key: HarnessKey,
    homes: string,
    private readonly log: string[],
  ) {
    super(key, homes);
  }
  override async prepareHome(spec: LaunchSpec) {
    this.log.push(`prepareHome ${spec.ferret} ${spec.home}`);
    return await super.prepareHome(spec);
  }
}

function fixture(harnesses: readonly Harness[], records: readonly FerretRecord[] = [], log: string[] = []) {
  const registry = new FerretRegistry(records);
  const tokens = new FerretTokenDirectory();
  const runner = new LoggingRunner(log);
  let next = 0;
  const byKey = new Map(harnesses.map(harness => [harness.key, harness]));
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => {
      next += 1;
      return ferretId(`f${next}`);
    },
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {},
    harness: key => byKey.get(key),
    harnessKeys: () => [...byKey.keys()],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => [],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: {
      childEnvironment: async ferret => {
        log.push(`vault.childEnvironment ${ferret}`);
        return ok(emptyChildEnvironment());
      },
    },
    asks: { open: async () => [] },
  };
  return { log, registry, tokens, runner, ports, service: new FerretsService(registry, tokens, ports) };
}

const stopped = (id: string, harness: HarnessKey, harnessConversation?: string): FerretRecord => ({
  format: 1,
  id: ferretId(id),
  name: id,
  role: 'lead',
  harness,
  runner: 'tmux',
  folder: '/work',
  state: 'stopped',
  ...(harnessConversation === undefined ? {} : { harnessConversation }),
  createdAt: T0,
  stateAt: T0,
});

describe('S42 each harness supplies its own per-ferret home', () => {
  test('S42 two harnesses and two ferrets get four distinct homes, each under its own harness’s agent-homes', async () => {
    const claude = new FakeHarness('claude-code', CLAUDE_HOMES);
    const codex = new FakeHarness('codex', CODEX_HOMES);
    const f = fixture([claude, codex]);
    for (const harness of ['claude-code', 'codex', 'claude-code', 'codex'] as const) {
      const started = await f.service.start({ folder: '/work', harness, by: 'owner' }, PERSON_ORIGIN);
      expect(started.ok).toBe(true);
    }
    const homes = [...claude.launched, ...codex.launched].map(spec => spec.home);
    expect(new Set(homes).size).toBe(4);
    for (const spec of claude.launched) expect(spec.home).toBe(fenced(`${CLAUDE_HOMES}/${spec.ferret}`));
    for (const spec of codex.launched) expect(spec.home).toBe(fenced(`${CODEX_HOMES}/${spec.ferret}`));
    expect(claude.launched).toHaveLength(2);
    expect(codex.launched).toHaveLength(2);
  });

  test('S42 Ferrets never builds a home: the launch carries the harness’s answer exactly as given', async () => {
    const odd = new (class extends FakeHarness {
      override async homeFor(ferret: FerretId): Promise<FencedPath> {
        return fenced(`/somewhere/only-the-harness-knows/${ferret}.home`);
      }
    })('claude-code');
    const asked: FerretId[] = [];
    const original = odd.homeFor.bind(odd);
    odd.homeFor = async ferret => {
      asked.push(ferret);
      return await original(ferret);
    };
    odd.prepareHome = async spec => ({ files: [fenced(`${spec.home}/x`)], args: [] });
    const f = fixture([odd]);
    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
    if (!started.ok) throw new Error(started.error.reason);
    expect(asked).toContain(started.value);
    expect(odd.launched[0]?.home).toBe(fenced(`/somewhere/only-the-harness-knows/${started.value}.home`));
  });

  test('S42 a harness answering another harness’s home for the same ferret is refused before launch', async () => {
    const claude = new FakeHarness('claude-code', CLAUDE_HOMES);
    const impostor = new FakeHarness('codex', CLAUDE_HOMES);
    const f = fixture([claude, impostor]);
    const started = await f.service.start({ folder: '/work', harness: 'codex', by: 'owner' }, PERSON_ORIGIN);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('refused');
    expect(started.error.reason).toContain('claude-code harness also names');
    expect(f.runner.starts).toBe(0);
    expect(claude.prepared).toHaveLength(0);
    expect(impostor.prepared).toHaveLength(0);
    expect(f.tokens.holds(ferretId('f1'))).toBe(false);
    expect(f.registry.get(ferretId('f1'))?.state).toBe('stopped');
  });

  test('S42 two ferrets on one home are refused before launch, whether equal or one inside the other', async () => {
    for (const answer of [
      (ferret: FerretId) => (ferret === 'home-probe' ? `${CLAUDE_HOMES}/home-probe` : `${CLAUDE_HOMES}/shared`),
      (ferret: FerretId) => (ferret === 'f2' ? CLAUDE_HOMES : `${CLAUDE_HOMES}/${ferret}`),
    ]) {
      const shared = new FakeHarness('claude-code', CLAUDE_HOMES);
      shared.homeFor = async ferret => fenced(answer(ferret));
      shared.prepareHome = async () => ({ files: [], args: [] });
      const f = fixture([shared]);
      const first = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
      expect(first.ok).toBe(true);
      const second = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
      expect(second.ok).toBe(false);
      if (second.ok) continue;
      expect(second.error.code).toBe('refused');
      expect(second.error.reason).toContain('ferret f1 also has');
      expect(f.runner.starts).toBe(1);
    }
  });

  test('S42 a harness that throws or answers a relative path is not started (fail closed)', async () => {
    const variants: ((harness: FakeHarness) => void)[] = [
      harness => {
        harness.homeFor = async () => {
          throw new Error('/secret/path should never reach a caller');
        };
      },
      harness => {
        harness.homeFor = async () => fenced('relative/home');
      },
    ];
    for (const breakIt of variants) {
      const harness = new FakeHarness('claude-code', CLAUDE_HOMES);
      breakIt(harness);
      const f = fixture([harness]);
      const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
      expect(started.ok).toBe(false);
      if (started.ok) continue;
      expect(started.error.code).toBe('harness_unavailable');
      expect(started.error.reason).toBe(
        'the claude-code harness did not name a home of its own for this ferret, so it was not started',
      );
      expect(f.runner.starts).toBe(0);
      expect(harness.prepared).toHaveLength(0);
      expect(f.tokens.holds(ferretId('f1'))).toBe(false);
    }
  });

  // The overlap test compares spellings, so a non-canonical answer could name f1's home (or its parent) without being
  // seen to: each is refused as "no home of its own" before the token, prepareHome, the environment or the runner.
  for (const [label, second] of [
    ['a trailing slash on the agent-homes parent (contains f1)', `${CLAUDE_HOMES}/`],
    ['a doubled slash (names f1)', `${CLAUDE_HOMES}//f1`],
    ['a dot segment (names f1)', `${CLAUDE_HOMES}/./f1`],
    ['a dot-dot segment (names f1)', `${CLAUDE_HOMES}/f2/../f1`],
    ['the filesystem root itself (contains every home)', '/'],
    ['a non-ASCII name, NFC (café can be spelled two ways)', `${CLAUDE_HOMES}/caf\u00e9`],
    ['a non-ASCII name, NFD (café can be spelled two ways)', `${CLAUDE_HOMES}/cafe\u0301`],
  ] as const) {
    test(`S42 a non-canonical home is refused before token, prepare or runner: ${label}`, async () => {
      const log: string[] = [];
      const harness = new LoggingHarness('claude-code', CLAUDE_HOMES, log);
      harness.homeFor = async ferret => fenced(ferret === 'f2' ? second : `${CLAUDE_HOMES}/${ferret}`);
      const f = fixture([harness], [], log);
      expect((await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN)).ok).toBe(true);
      const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error).toEqual({
        code: 'harness_unavailable',
        reason: 'the claude-code harness did not name a home of its own for this ferret, so it was not started',
      });
      expect(log).toEqual([`prepareHome f1 ${CLAUDE_HOMES}/f1`, 'vault.childEnvironment f1', 'runner.start f1']);
      expect(f.runner.starts).toBe(1);
      expect(f.tokens.holds(ferretId('f2'))).toBe(false);
      expect(f.registry.get(ferretId('f2'))?.state).toBe('stopped');
    });
  }

  test('S42 two homes that differ only by case are one home on a case-insensitive filesystem: refused', async () => {
    const log: string[] = [];
    const harness = new LoggingHarness('claude-code', CLAUDE_HOMES, log);
    harness.homeFor = async ferret => fenced(`${CLAUDE_HOMES}/${ferret === 'f2' ? 'F1' : ferret}`);
    const f = fixture([harness], [], log);
    expect((await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN)).ok).toBe(true);
    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('refused');
    expect(started.error.reason).toContain('ferret f1 also has');
    expect(log).toEqual([`prepareHome f1 ${CLAUDE_HOMES}/f1`, 'vault.childEnvironment f1', 'runner.start f1']);
    expect(f.tokens.holds(ferretId('f2'))).toBe(false);
  });

  test('S42 a non-ASCII home for the first ferret is refused before token, prepare or runner', async () => {
    for (const name of ['caf\u00e9', 'cafe\u0301']) {
      const log: string[] = [];
      const harness = new LoggingHarness('claude-code', CLAUDE_HOMES, log);
      harness.homeFor = async () => fenced(`${CLAUDE_HOMES}/${name}`);
      const f = fixture([harness], [], log);
      const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error.code).toBe('harness_unavailable');
      expect(log).toEqual([]);
      expect(f.tokens.holds(ferretId('f1'))).toBe(false);
    }
  });

  // The first ferret on a harness has nobody to be compared with, so the harness is also asked for one fixed id that
  // is never minted: a home that equals, holds or sits inside that answer is not a per-ferret home.
  for (const [label, answer] of [
    ['the agent-homes base itself', (_ferret: FerretId) => CLAUDE_HOMES],
    ['the same home for every id', (_ferret: FerretId) => `${CLAUDE_HOMES}/everyone`],
    [
      'the base in another case',
      (ferret: FerretId) => (ferret === 'f1' ? CLAUDE_HOMES.toUpperCase() : `${CLAUDE_HOMES}/${ferret}`),
    ],
  ] as const) {
    test(`S42 the first ferret answered a home that is not its own is refused: ${label}`, async () => {
      const log: string[] = [];
      const harness = new LoggingHarness('claude-code', CLAUDE_HOMES, log);
      const asked: string[] = [];
      harness.homeFor = async ferret => {
        asked.push(ferret);
        return fenced(answer(ferret));
      };
      const f = fixture([harness], [], log);
      const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error.code).toBe('refused');
      expect(started.error.reason).toContain('holds the homes of other ferrets');
      expect(asked).toEqual(['f1', 'home-probe']);
      expect(log).toEqual([]);
      expect(f.tokens.holds(ferretId('f1'))).toBe(false);
      expect(f.registry.get(ferretId('f1'))?.state).toBe('stopped');
    });
  }

  test('S42 the probe id is asked only for the first ferret on a harness, and a throwing probe is refused', async () => {
    const harness = new FakeHarness('claude-code', CLAUDE_HOMES);
    const asked: string[] = [];
    const original = harness.homeFor.bind(harness);
    harness.homeFor = async ferret => {
      asked.push(ferret);
      return await original(ferret);
    };
    const f = fixture([harness]);
    expect((await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN)).ok).toBe(true);
    expect((await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN)).ok).toBe(true);
    expect(asked.filter(ferret => ferret === 'home-probe')).toHaveLength(1);

    const broken = new FakeHarness('claude-code', CLAUDE_HOMES);
    const real = broken.homeFor.bind(broken);
    broken.homeFor = async ferret => {
      if (ferret === 'home-probe') throw new Error('/secret/path should never reach a caller');
      return await real(ferret);
    };
    const g = fixture([broken]);
    const started = await g.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('refused');
    expect(started.error.reason).not.toContain('/secret');
    expect(g.runner.starts).toBe(0);
    expect(broken.prepared).toHaveLength(0);
  });

  // An answer Ferrets cannot judge (it threw, or is not canonical) is not "no overlap": the start is refused.
  for (const [label, bad] of [
    ['throws', 'throw'],
    ['is not canonical', `${CLAUDE_HOMES}//old1`],
    ['is relative', 'old1'],
  ] as const) {
    test(`S42 another ferret’s harness whose answer ${label} refuses the start (fail closed)`, async () => {
      const log: string[] = [];
      const claude = new LoggingHarness('claude-code', CLAUDE_HOMES, log);
      const codex = new FakeHarness('codex', CODEX_HOMES);
      codex.homeFor = async ferret => {
        if (bad === 'throw' && ferret === 'old1') throw new Error('/secret/path should never reach a caller');
        if (ferret === 'old1') return fenced(bad);
        return fenced(`${CODEX_HOMES}/${ferret}`);
      };
      const f = fixture([claude, codex], [stopped('old1', 'codex')], log);
      const started = await f.service.start({ folder: '/work', harness: 'claude-code', by: 'owner' }, PERSON_ORIGIN);
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error.code).toBe('refused');
      expect(started.error.reason).toContain('ferret old1');
      expect(started.error.reason).not.toContain('/secret');
      expect(log).toEqual([]);
      expect(f.tokens.holds(ferretId('f1'))).toBe(false);
    });
  }

  test('S42 the other harness’s answer for THIS ferret that throws or is not canonical refuses the start', async () => {
    for (const answer of ['throw', `${CODEX_HOMES}//f1`] as const) {
      const log: string[] = [];
      const claude = new LoggingHarness('claude-code', CLAUDE_HOMES, log);
      const codex = new FakeHarness('codex', CODEX_HOMES);
      codex.homeFor = async () => {
        if (answer === 'throw') throw new Error('/secret/path should never reach a caller');
        return fenced(answer);
      };
      const f = fixture([claude, codex], [], log);
      const started = await f.service.start({ folder: '/work', harness: 'claude-code', by: 'owner' }, PERSON_ORIGIN);
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error.code).toBe('refused');
      expect(started.error.reason).toContain('codex harness');
      expect(started.error.reason).not.toContain('/secret');
      expect(log).toEqual([]);
    }
  });

  test('S42 a prepareHome that throws stops the start before the runner is asked, and revokes the token', async () => {
    const harness = new FakeHarness('claude-code', CLAUDE_HOMES);
    harness.prepareHome = async () => {
      throw new Error('a link is at the home’s name');
    };
    const f = fixture([harness]);
    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error).toEqual({
      code: 'failed',
      reason: "the claude-code harness could not prepare this ferret's home, so it was not started",
    });
    expect(f.runner.starts).toBe(0);
    expect(f.tokens.holds(ferretId('f1'))).toBe(false);
    expect(f.registry.get(ferretId('f1'))?.state).toBe('stopped');
  });
});

describe('S42 prepareHome runs before the environment is resolved and runner.start, on every start path', () => {
  test('S42 a new start: prepareHome with the harness’s home, then the environment, then the runner (one log)', async () => {
    const log: string[] = [];
    const f = fixture([new LoggingHarness('claude-code', CLAUDE_HOMES, log)], [], log);
    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
    expect(started.ok).toBe(true);
    expect(log).toEqual([`prepareHome f1 ${CLAUDE_HOMES}/f1`, 'vault.childEnvironment f1', 'runner.start f1']);
  });

  test('S42 a start bound to a conversation, a revive, and a revive with a conversation all prepare before the environment', async () => {
    const cases = [
      {
        records: [] as FerretRecord[],
        go: (service: FerretsService) =>
          service.start({ folder: '/work', harnessConversation: 'c1', by: 'owner' }, PERSON_ORIGIN),
        id: 'f1',
      },
      {
        records: [stopped('rev', 'codex')],
        go: (service: FerretsService) => service.resume(ferretId('rev'), undefined, { origin: PERSON_ORIGIN }),
        id: 'rev',
      },
      {
        records: [stopped('rec', 'codex', 'c2')],
        go: (service: FerretsService) => service.resume(ferretId('rec'), undefined, { origin: PERSON_ORIGIN }),
        id: 'rec',
      },
    ];
    for (const { records, go, id } of cases) {
      const log: string[] = [];
      const harness = new LoggingHarness('codex', CODEX_HOMES, log);
      const f = fixture([harness], records, log);
      const result = await go(f.service);
      if (!result.ok) throw new Error(result.error.reason);
      expect(log).toEqual([
        `prepareHome ${id} ${CODEX_HOMES}/${id}`,
        `vault.childEnvironment ${id}`,
        `runner.start ${id}`,
      ]);
      expect(harness.launched[0]?.home).toBe(fenced(`${CODEX_HOMES}/${id}`));
    }
  });

  test('S42 a fresh ferret starts beside ferrets that already have homes under the same agent-homes', async () => {
    const harness = new FakeHarness('claude-code', CLAUDE_HOMES);
    const f = fixture([harness], [stopped('old1', 'claude-code'), stopped('old2', 'claude-code')]);
    const started = await f.service.start({ folder: '/work', by: 'owner' }, PERSON_ORIGIN);
    if (!started.ok) throw new Error(started.error.reason);
    expect(harness.prepared.map(spec => spec.home)).toEqual([fenced(`${CLAUDE_HOMES}/${started.value}`)]);
  });
});
