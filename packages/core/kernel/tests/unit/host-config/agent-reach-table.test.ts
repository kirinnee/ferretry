/**
 * The agent's reach over the REAL declared files (round-2 review N1 and the reach ruling): every file `agent-reach.ts`
 * lets an agent name is one row here, written through the real kernel writer with the plugin's real def, and each row
 * proves that an agent's LOOSENING edit is HELD and not applied, that a raw secret is refused, and that the file is not
 * person-only. Every declared file outside the reach is refused on read, validate and write. A file that becomes
 * reachable without a row here fails the completeness test, so the reach can only widen with its proof.
 *
 * The defs are loaded from every manifest at run time, as Gate's audited-route test does: the kernel imports no plugin.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { AgentConfigCallSchema, type AgentConfigCall } from '../../../contract/agent-config.ts';
import { ApiError } from '../../../contract/http.ts';
import type { ConfigDef } from '../../../contract/index.ts';
import { agentConfig } from '../../../host/config/agent.ts';
import { agentMayName } from '../../../host/config/agent-reach.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { loadManifests, loadWorkspace } from '../../../../../../scripts/gen/lib/workspace.ts';
import { captureLog, HOME, manualClock } from './support.ts';
import TODAY_EXTRACTED from './today-holds.json' with { type: 'json' };

const ROOT = resolve(import.meta.dir, '../../../../../..');

/** Fake only: shaped like a key, never one. */
const FAKE_SECRET =
  'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const SECRET_SENTENCE = 'names the secret OWNER_KEY, which only the owner may add to a configuration';

interface Declared {
  readonly plugin: string;
  readonly def: ConfigDef;
}

const { loaded, failures } = await loadManifests(loadWorkspace(ROOT));
const DECLARED: readonly Declared[] = loaded.flatMap(({ manifest }) =>
  ((manifest as { readonly data?: { readonly config?: readonly ConfigDef[] } }).data?.config ?? []).map(def => ({
    plugin: manifest.id,
    def,
  })),
);

/** Where a def's files live: its file, or its folder. */
const placeOf = (def: ConfigDef): string => (def.shape === 'file' ? def.file : def.collection);
/** A path that names one file of a def. */
const samplePath = (def: ConfigDef): string => (def.shape === 'file' ? def.file : `${def.collection}/sample.yaml`);

interface Row {
  readonly path: string;
  /** A tight version, written first and in effect. */
  readonly base: string;
  /** An edit the file's own rule says loosens, and a part of the sentence it is held with. */
  readonly loosening?: { readonly text: string; readonly sentence: string };
  /** An edit adding `${secret:OWNER_KEY}`: the owner's alone to add, held whatever the file's own rule says. */
  readonly secretAdded?: string;
  /** For a file no edit of which loosens (and none did today): a change that is applied at once, and why. */
  readonly neverLoosens?: { readonly text: string; readonly why: string };
}

/** Today's 14 entries, in 5.0's files (docs/config-files.md, the agent's tools). */
const ROWS: readonly Row[] = [
  {
    path: 'warden.yaml',
    base: 'enabled: false\n',
    loosening: { text: 'enabled: true\n', sentence: 'the warden is switched on' },
  },
  {
    path: 'voice.yaml',
    base: 'defaultEngine: browser\n',
    loosening: {
      text: 'postProcessing:\n  provider: login\n  login: owner-claude\n  style: polish\n  useConversation: true\n',
      sentence:
        'dictated text now goes to the login owner-claude to be cleaned up; recent conversation messages may now go to the cleanup provider to help clean up dictation',
    },
  },
  {
    path: 'limits.yaml',
    base: 'ionice: true\n',
    loosening: {
      text: 'ionice: true\nagentControl:\n  ferretrySettings: true\n',
      sentence: 'agents may now control',
    },
  },
  {
    path: 'lessons.yaml',
    base: 'enabled: false\n',
    loosening: { text: 'enabled: true\n', sentence: 'lesson mining may now spend on ferrets' },
  },
  {
    path: 'packs.yaml',
    base: 'enabled: false\n',
    loosening: { text: 'enabled: true\n', sentence: 'Pack mode is switched on' },
  },
  {
    path: 'accounts.yaml',
    base: 'sites: {}\n',
    loosening: {
      text: 'sites:\n  github.com: HOME\n',
      sentence: 'changes which account a card offers first for github.com',
    },
  },
  {
    path: 'runtimes.yaml',
    base: 'defaultRuntime: first\n',
    neverLoosens: {
      text: 'defaultRuntime: second\n',
      why: 'pointing the default elsewhere changes where an unnamed start spends: not a loosening, nor was it today',
    },
  },
  {
    path: 'agenda.yaml',
    base: 'agendaMode: false\n',
    neverLoosens: { text: 'agendaMode: true\n', why: 'today: "not a loosening"; the file names no secret' },
  },
  {
    // Today's machine.yaml `conversations.listComputer`: no rule of today's judged it, and none of 5.0's does.
    path: 'conversation.yaml',
    base: 'keepInSync: true\n',
    neverLoosens: { text: 'keepInSync: false\n', why: "today's machineLoosening judged no conversations key" },
  },
  {
    path: 'logins/work.yaml',
    base: 'harness: claude-code\nbudget:\n  daily:\n    hard: 5\n',
    loosening: { text: 'harness: claude-code\nbudget:\n  daily:\n    hard: 50\n', sentence: 'daily hard limit' },
    secretAdded: 'harness: claude-code\nbudget:\n  daily:\n    hard: 5\nenv:\n  API_KEY: ${secret:OWNER_KEY}\n',
  },
  {
    path: 'profiles/p.yaml',
    base: 'compactAt: auto\n',
    secretAdded: 'compactAt: auto\nclonedFromKey: ${secret:OWNER_KEY}\n',
  },
  {
    path: 'runtimes/r.yaml',
    base: 'login: first\nprofile: p\n',
    loosening: { text: 'login: second\nprofile: p\n', sentence: 'a runtime moves off login "first" to "second"' },
  },
  {
    path: 'models/m.yaml',
    base: 'label: M\ndocs: https://example.com/models\nverified: "2026-01-01"\n',
    secretAdded:
      'label: M\ndocs: https://example.com/models\nverified: "2026-01-01"\nunverified:\n  - ${secret:OWNER_KEY}\n',
  },
  {
    path: 'mcp/github.yaml',
    base: 'command: gh-mcp\n',
    secretAdded: 'command: gh-mcp\nenv:\n  TOKEN: ${secret:OWNER_KEY}\n',
  },
  {
    path: 'skills/s.yaml',
    base: 'items:\n  - one\n',
    secretAdded: 'items:\n  - one\nclonedFromKey: ${secret:OWNER_KEY}\n',
  },
  {
    path: 'claude-code/settings/a.yaml',
    base: 'settings:\n  theme: dark\n',
    secretAdded: 'settings:\n  theme: dark\n  env:\n    TOKEN: ${secret:OWNER_KEY}\n',
  },
  {
    path: 'codex/settings/a.yaml',
    base: 'settings:\n  model: m\n',
    secretAdded: 'settings:\n  model: m\n  env:\n    TOKEN: ${secret:OWNER_KEY}\n',
  },
  {
    path: 'claude-code/hooks/h.yaml',
    base: 'hooks: {}\n',
    secretAdded: 'hooks:\n  Stop:\n    - command: ${secret:OWNER_KEY}\n',
  },
  {
    path: 'model-sets/fast.yaml',
    base: 'models:\n  - a\ndefault: a\n',
    secretAdded: 'models:\n  - a\ndefault: a\nclonedFromKey: ${secret:OWNER_KEY}\n',
  },
];

const owning = (path: string): Declared => {
  const found = DECLARED.find(({ def }) =>
    def.shape === 'file'
      ? def.file === path
      : path.startsWith(`${def.collection}/`) && !path.slice(def.collection.length + 1).includes('/'),
  );
  if (found === undefined) throw new Error(`no declared def owns ${path}`);
  return found;
};

function world() {
  const fs = createMemoryHostFs();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: DECLARED,
  });
  const agent = agentConfig({
    writer: () => files.writer(),
    control: () => ({ allows: async (_ferret, kind) => kind === 'settings' }),
    status: () => files.status(),
    home: HOME,
    binary: 'fy',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { fs, files, agent };
}

const ferret = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };
const call = (body: Record<string, unknown>): AgentConfigCall => AgentConfigCallSchema.parse(body);

/** What is IN EFFECT for one file, as its own plugin reads it. */
function inEffect(files: ReturnType<typeof world>['files'], path: string): unknown {
  const { plugin, def } = owning(path);
  const port = files.port(plugin);
  if (def.shape === 'file') return port.file(def);
  return port.collection(def).get(path.slice(def.collection.length + 1, -'.yaml'.length));
}

describe('T-0034 R-0073 every file in the agent’s reach is a row, and nothing else is reachable', () => {
  test('R-0073 the manifests load', () => {
    expect(failures).toEqual([]);
    expect(DECLARED.length).toBeGreaterThan(ROWS.length);
  });

  test('R-0073 T-0034 the declared files an agent may name are exactly the rows', () => {
    const reachable = DECLARED.filter(({ def }) => agentMayName(samplePath(def))).map(({ def }) => placeOf(def));
    const rowPlaces = ROWS.map(row => placeOf(owning(row.path).def));
    expect(reachable.toSorted()).toEqual([...new Set(rowPlaces)].toSorted());
    for (const row of ROWS) expect(agentMayName(row.path)).toBe(true);
  });

  test('T-0034 no row is person-only', () => {
    for (const row of ROWS) expect(owning(row.path).def.personOnly).toBeUndefined();
  });

  test('T-0034 every row proves a held loosening, or says why no edit of it loosens', () => {
    for (const row of ROWS)
      expect(row.loosening !== undefined || row.secretAdded !== undefined || row.neverLoosens !== undefined).toBe(true);
  });
});

for (const row of ROWS)
  describe(`T-0034 ${row.path}, written by an agent through the real ${owning(row.path).plugin} def`, () => {
    test(`T-0032 T-0033 T-0034 ${row.path}: read, validate and a tight write are in effect`, async () => {
      const { agent, files } = world();
      await files.reload();
      const starter = await agent.run(call({ tool: 'config.read', path: row.path }), ferret);
      expect(starter.summary).toBe(`${row.path} does not exist yet; this is the starter a new one begins with.`);
      const checked = await agent.run(call({ tool: 'config.validate', path: row.path, text: row.base }), ferret);
      expect(checked).toEqual({ summary: `${row.path} checks.`, issues: [] });
      const written = await agent.run(call({ tool: 'config.write', path: row.path, text: row.base }), ferret);
      expect(written.summary).toBe(`Wrote ${row.path}; it is in effect.`);
      const read = await agent.run(call({ tool: 'config.read', path: row.path }), ferret);
      expect(read).toMatchObject({ summary: `${row.path} (ok).`, text: row.base });
      expect(inEffect(files, row.path)).toBeDefined();
    });

    if (row.loosening !== undefined) {
      const loosening = row.loosening;
      test(`T-0034 ${row.path}: a loosening edit is HELD and NOT applied: the tighter version stays in effect`, async () => {
        const { agent, files } = world();
        await files.reload();
        await agent.run(call({ tool: 'config.write', path: row.path, text: row.base }), ferret);
        const before = inEffect(files, row.path);
        const answer = await agent.run(call({ tool: 'config.write', path: row.path, text: loosening.text }), ferret);
        expect(answer.summary).toStartWith(`Wrote ${row.path}, but it loosens what this machine allows (`);
        expect(answer.summary).toContain(loosening.sentence);
        expect(answer.summary).toContain(`--confirms ${row.path}`);
        expect(inEffect(files, row.path)).toEqual(before);
        expect(files.status().held.map(held => held.path)).toEqual([row.path]);
      });
    }

    if (row.secretAdded !== undefined) {
      const secretAdded = row.secretAdded;
      test(`T-0034 ${row.path}: adding \${secret:OWNER_KEY} is HELD for the owner and NOT applied`, async () => {
        const { agent, files } = world();
        await files.reload();
        await agent.run(call({ tool: 'config.write', path: row.path, text: row.base }), ferret);
        const before = inEffect(files, row.path);
        const answer = await agent.run(call({ tool: 'config.write', path: row.path, text: secretAdded }), ferret);
        expect(answer.summary).toContain(SECRET_SENTENCE);
        expect(inEffect(files, row.path)).toEqual(before);
        expect(files.status().held.map(held => held.path)).toEqual([row.path]);
      });
    }

    if (row.neverLoosens !== undefined) {
      const change = row.neverLoosens;
      test(`T-0034 ${row.path}: no edit loosens (${change.why}), so a change is in effect at once`, async () => {
        const { agent, files } = world();
        await files.reload();
        await agent.run(call({ tool: 'config.write', path: row.path, text: row.base }), ferret);
        const answer = await agent.run(call({ tool: 'config.write', path: row.path, text: change.text }), ferret);
        expect(answer.summary).toBe(`Wrote ${row.path}; it is in effect.`);
        expect(files.status().held).toEqual([]);
      });
    }

    test(`T-0034 ${row.path}: a raw secret is refused, nothing is written, and the value is never repeated`, async () => {
      const { agent, files, fs } = world();
      await files.reload();
      await agent.run(call({ tool: 'config.write', path: row.path, text: row.base }), ferret);
      const answer = await agent.run(
        call({ tool: 'config.write', path: row.path, text: `${row.base}apiToken: ${FAKE_SECRET}\n` }),
        ferret,
      );
      expect(answer.summary).toBe(`Nothing was written: ${row.path} does not check. Fix each issue and try again.`);
      expect(JSON.stringify(answer)).not.toContain(FAKE_SECRET);
      expect(await fs.readText(`${HOME}/config/${row.path}`)).toBe(row.base);
    });
  });

/**
 * EVERY LOOSENING TODAY'S HOLD HELD (round-3 review N3, britnee's binding condition), for every file in the agent's
 * reach. The `words` below are not chosen by hand: they are the extraction, from today's code (rebuild-ref
 * `packages/fleet/src/lib/config-files/kinds.ts` `configLoosening`'s per-kind rules, `loginLoosening`,
 * `runtimeLoosening`, and `packages/protocol/src/lib/limits.ts` `limitsLoosening`), of every sentence the
 * config-write hold could return, each words-map rule expanded per key: `today-holds.json` beside this file, written by
 * the extraction script named in the kac2-fix3 report and never edited by hand. The table must equal it; each entry is
 * then either:
 * - `door`: one or more AGENT writes through the real kernel writer, each over a base the OWNER confirmed, and each
 *   must be HELD with the tighter version still in effect, or
 * - `out`: the 5.0 file that holds it, which the agent may not name at all (its GAP line says why).
 * A 5.0 rule that drops one of today's holds fails its row here.
 */
interface DoorEdit {
  readonly path: string;
  /** Written by the owner (`confirmedLoosening`): in effect. */
  readonly base: string;
  /** The agent's edit: today's hold for these words. */
  readonly text: string;
}
interface TodayHold {
  /** Today's file kind (`configLoosening`'s `kind`, or `login` / `runtime`). */
  readonly today: string;
  /** Today's sentence, as extracted (a `${…}` is today's template slot). */
  readonly words: string;
  readonly door?: readonly DoorEdit[];
  readonly out?: string;
}

const w = (base: string, text: string): DoorEdit => ({ path: 'warden.yaml', base, text });
const moves = (extra: string): string => `autoMove:\n  enabled: true\n${extra}`;
const limits = (base: string, text: string): DoorEdit => ({ path: 'limits.yaml', base, text });
const lessons = (base: string, text: string): DoorEdit => ({ path: 'lessons.yaml', base, text });
const packs = (base: string, text: string): DoorEdit => ({ path: 'packs.yaml', base, text });
const LOGIN = 'harness: claude-code\n';
const login = (base: string, text: string): DoorEdit => ({
  path: 'logins/work.yaml',
  base: LOGIN + base,
  text: LOGIN + text,
});
const VOICE_LOGIN = 'postProcessing:\n  provider: login\n  login: owner-claude\n  style: polish\n';
const AGENT_CONTROL = ['terminals', 'browsers', 'files', 'ferretrySettings', 'pageScripts'] as const;
const agentControlOff = `agentControl:\n${AGENT_CONTROL.map(kind => `  ${kind}: false\n`).join('')}`;
const controlOn = (kind: (typeof AGENT_CONTROL)[number]): DoorEdit =>
  limits(agentControlOff, agentControlOff.replace(`  ${kind}: false`, `  ${kind}: true`));
const ACT_ALONE = ['nudge', 'resume', 'restart', 'failover', 'stop', 'closeLeftovers'] as const;
const actAlone = (act: (typeof ACT_ALONE)[number]): DoorEdit =>
  w(`mayActAlone:\n  ${act}: false\n`, `mayActAlone:\n  ${act}: true\n`);
const jevAct = (act: string): DoorEdit => w(`jevActs:\n  ${act}: 0.9\n`, `jevActs:\n  ${act}: 0.5\n`);
const raise = (group: 'fleet' | 'perFerret', field: string, from: string, to: string): DoorEdit =>
  limits(`${group}:\n  ${field}: ${from}\n`, `${group}:\n  ${field}: ${to}\n`);

const TODAY_HOLDS: readonly TodayHold[] = [
  // machine.yaml → limits.yaml agentControl; the rest → files kept out of the reach.
  { today: 'machine', words: 'agents may now control terminals', door: [controlOn('terminals')] },
  { today: 'machine', words: 'agents may now control browsers', door: [controlOn('browsers')] },
  { today: 'machine', words: 'agents may now control project files', door: [controlOn('files')] },
  { today: 'machine', words: 'agents may now control Ferretry settings', door: [controlOn('ferretrySettings')] },
  { today: 'machine', words: 'agents may now control page scripts', door: [controlOn('pageScripts')] },
  { today: 'machine', words: 'agents now skip every permission prompt', out: 'harness-claude-code.yaml' },
  {
    today: 'machine',
    words:
      'budgets now reset in ${after.machine.timeZone ?? "the host\'s time zone"} instead of ${before.machine.timeZone ?? "the host\'s time zone"}',
    out: 'usage.yaml',
  },
  {
    today: 'machine',
    words: 'any process on this host can now read quota percentages and account labels without a credential',
    out: 'usage.yaml',
  },
  {
    today: 'machine',
    words: 'the agent browser now sends its traffic through the proxy at ${after.url}',
    out: 'browsers.yaml',
  },
  // warden.yaml → warden.yaml
  {
    today: 'warden',
    words: 'the Warden may now spend on Jev decisions',
    door: [w('layers:\n  jev: false\n', 'layers:\n  jev: true\n')],
  },
  {
    today: 'warden',
    words: 'the Warden may now spend on AI investigations',
    door: [w('layers:\n  llm: false\n', 'layers:\n  llm: true\n')],
  },
  { today: 'warden', words: 'the Warden may now nudge a ferret on its own', door: [actAlone('nudge')] },
  { today: 'warden', words: 'the Warden may now resume a ferret on its own', door: [actAlone('resume')] },
  { today: 'warden', words: 'the Warden may now restart a ferret on its own', door: [actAlone('restart')] },
  {
    today: 'warden',
    words: 'the Warden may now move a ferret to another login on its own',
    door: [actAlone('failover')],
  },
  { today: 'warden', words: 'the Warden may now stop a ferret on its own', door: [actAlone('stop')] },
  {
    today: 'warden',
    words: 'the Warden may now close a browser a finished ferret left running on its own',
    door: [actAlone('closeLeftovers')],
  },
  { today: 'warden', words: 'how sure Jev must be to nudge a ferret on its own', door: [jevAct('nudge')] },
  { today: 'warden', words: 'how sure Jev must be to resume a ferret on its own', door: [jevAct('resume')] },
  { today: 'warden', words: 'how sure Jev must be to restart a ferret on its own', door: [jevAct('restart')] },
  { today: 'warden', words: 'how sure Jev must be to stop a ferret on its own', door: [jevAct('stop')] },
  {
    today: 'warden',
    words: 'the daily Jev cap in dollars',
    door: [w('caps:\n  jevUsdPerDay: 0.5\n', 'caps:\n  jevUsdPerDay: 5\n')],
  },
  {
    today: 'warden',
    words: 'the daily investigation cap in dollars',
    door: [w('caps:\n  investigationUsdPerDay: 2\n', 'caps:\n  investigationUsdPerDay: 20\n')],
  },
  {
    today: 'warden',
    words: 'the investigations allowed per hour',
    door: [w('caps:\n  maxInvestigationsPerHour: 6\n', 'caps:\n  maxInvestigationsPerHour: 30\n')],
  },
  {
    today: 'warden',
    words: 'the Jev price the cap counts with',
    door: [w('guard:\n  usdPerMillionInputTokens: 0.042\n', 'guard:\n  usdPerMillionInputTokens: 0.01\n')],
  },
  {
    today: 'warden',
    words: 'the number of wardens that may run at once',
    door: [w('maxAssignedWardens: 1\n', 'maxAssignedWardens: 3\n')],
  },
  {
    today: 'warden',
    words: 'the minutes between Warden sweeps',
    door: [w('intervalMinutes: 2\n', 'intervalMinutes: 1\n')],
  },
  {
    today: 'warden',
    words: 'the minutes between two Warden investigations',
    door: [w('minSpawnGapMinutes: 15\n', 'minSpawnGapMinutes: 0\n')],
  },
  {
    today: 'warden',
    words: 'the Warden now also moves a ferret whose login hit a usage limit',
    door: [w(moves('  when: [budget_exceeded]\n'), moves('  when: [budget_exceeded, rate_limited]\n'))],
  },
  {
    today: 'warden',
    words: 'the Warden now also moves a ferret whose login passed its hard spend budget',
    door: [w(moves('  when: [rate_limited]\n'), moves('  when: [rate_limited, budget_exceeded]\n'))],
  },
  {
    today: 'warden',
    words: 'the Warden may now move a ferret that hit a limit to another login on its own',
    door: [
      w('autoMove:\n  enabled: false\n', 'autoMove:\n  enabled: true\n'),
      w('enabled: false\nautoMove:\n  enabled: true\n', 'enabled: true\nautoMove:\n  enabled: true\n'),
    ],
  },
  {
    today: 'warden',
    words: "the Warden may now stop a ferret's own background jobs to move it",
    door: [w(moves(''), moves('  forceStopBackground: true\n'))],
  },
  {
    today: 'warden',
    words: 'the Warden may now move ferrets onto ${target}',
    door: [
      w(moves('  targets: [claude-b]\n'), moves('  targets: [claude-b, glm-a]\n')),
      w(moves(''), moves('  targets: [glm-a]\n')),
    ],
  },
  {
    today: 'warden',
    words: 'the Warden may now move ferrets onto any ready login of the same harness and provider',
    door: [w(moves('  targets: [claude-b]\n'), moves('  targets: []\n'))],
  },
  {
    today: 'warden',
    words: 'the moves one ferret may get in an hour',
    door: [w(moves('  maxMovesPerHour: 1\n'), moves('  maxMovesPerHour: 3\n'))],
  },
  {
    today: 'warden',
    words: 'the share a login must have left to be moved onto',
    door: [w(moves('  minHeadroomPercent: 20\n'), moves('  minHeadroomPercent: 5\n'))],
  },
  // learning.yaml → lessons.yaml (today's "sessions" are 5.0's "ferrets")
  {
    today: 'learning',
    words: 'lesson mining may now spend on agent sessions',
    door: [lessons('enabled: false\n', 'enabled: true\n')],
  },
  {
    today: 'learning',
    words: 'the lesson miners one run may start',
    door: [lessons('maxMinersPerRun: 1\n', 'maxMinersPerRun: 5\n')],
  },
  {
    today: 'learning',
    words: 'the sessions one lesson run may read',
    door: [lessons('maxFerretsPerRun: 5\n', 'maxFerretsPerRun: 50\n')],
  },
  {
    today: 'learning',
    words: 'the sessions one lesson miner reads',
    door: [lessons('batchSize: 5\n', 'batchSize: 50\n')],
  },
  {
    today: 'learning',
    words: 'the minutes between lesson runs',
    door: [lessons('intervalMinutes: 60\n', 'intervalMinutes: 5\n')],
  },
  {
    today: 'learning',
    words: 'the minutes between two lesson miners',
    door: [lessons('minSpawnGapMinutes: 10\n', 'minSpawnGapMinutes: 0\n')],
  },
  // pack.yaml → packs.yaml
  {
    today: 'pack',
    words: 'ferrets may now start sub-ferrets (Pack mode)',
    door: [packs('enabled: false\n', 'enabled: true\n')],
  },
  {
    today: 'pack',
    words: 'Jev may now spend on choosing sub-ferret models',
    door: [packs('enabled: true\ndecision: agent\n', 'enabled: true\ndecision: jev\n')],
  },
  {
    today: 'pack',
    words: 'the sub-ferrets an interactive ferret may run at once',
    door: [packs('limits:\n  interactiveChildren: 2\n', 'limits:\n  interactiveChildren: 20\n')],
  },
  {
    today: 'pack',
    words: 'the sub-ferrets an unattended ferret may run at once',
    door: [packs('limits:\n  autoChildren: 2\n', 'limits:\n  autoChildren: 20\n')],
  },
  {
    today: 'pack',
    words: 'how deep sub-ferrets may nest',
    door: [packs('limits:\n  maxDepth: 1\n', 'limits:\n  maxDepth: 4\n')],
  },
  {
    today: 'pack',
    words: "Jev's daily cap in dollars for choosing models",
    door: [packs('jev:\n  usdPerDay: 0.5\n', 'jev:\n  usdPerDay: 5\n')],
  },
  // voice.yaml → voice.yaml
  {
    today: 'voice',
    words: "the login ${to.login ?? ''}",
    door: [{ path: 'voice.yaml', base: 'defaultEngine: browser\n', text: VOICE_LOGIN }],
  },
  {
    today: 'voice',
    words: 'dictated text now goes to ${destination} to be cleaned up',
    door: [
      { path: 'voice.yaml', base: 'defaultEngine: browser\n', text: VOICE_LOGIN },
      { path: 'voice.yaml', base: VOICE_LOGIN, text: VOICE_LOGIN.replace('owner-claude', 'other-login') },
    ],
  },
  {
    today: 'voice',
    words: 'recent conversation messages may now go to the cleanup provider to help clean up dictation',
    door: [{ path: 'voice.yaml', base: VOICE_LOGIN, text: `${VOICE_LOGIN}  useConversation: true\n` }],
  },
  // account-defaults.yaml → accounts.yaml: a line added, changed or taken away, by an agent
  {
    today: 'accountDefaults',
    words: 'changes which account a card offers first for ${line.key} in ${accountDefaultScopeWords(line)}',
    door: [
      { path: 'accounts.yaml', base: 'sites: {}\n', text: 'sites:\n  github.com: HOME\n' },
      { path: 'accounts.yaml', base: 'sites:\n  github.com: HOME\n', text: 'sites:\n  github.com: WORK\n' },
      { path: 'accounts.yaml', base: 'sites:\n  github.com: HOME\n', text: 'sites: {}\n' },
    ],
  },
  // logins/<id>.yaml → logins/<id>.yaml
  {
    today: 'login',
    words: "login \"${id}\"'s ${period} ${level === 'hard' ? 'hard limit' : 'trigger'} in dollars",
    door: [
      login('budget:\n  daily:\n    hard: 5\n', 'budget:\n  daily:\n    hard: 50\n'),
      login('budget:\n  weekly:\n    trigger: 5\n', 'budget:\n  weekly:\n    trigger: 50\n'),
    ],
  },
  {
    today: 'login',
    words: '${what} is removed (was ${String(was)})',
    door: [
      login('budget:\n  daily:\n    hard: 5\n', ''),
      login('budget:\n  daily:\n    hard: 5\n    trigger: 4\n', 'budget:\n  daily:\n    hard: 5\n'),
    ],
  },
  // runtimes/<n>.yaml → runtimes/<n>.yaml (5.0's kernel-side rule fails closed on any change of login)
  {
    today: 'runtime',
    words: 'runtime "${name}" is removed from login "${before.credential}", whose budget counts and stops it',
    out: 'removal: an agent has no remove (config_read, config_validate and config_write only)',
  },
  {
    today: 'runtime',
    words:
      'runtime "${name}" moves off login "${before.credential}", whose budget counts and stops it, to "${after.credential}"',
    door: [{ path: 'runtimes/r.yaml', base: 'login: first\nprofile: p\n', text: 'login: second\nprofile: p\n' }],
  },
  // limits.yaml → limits.yaml
  {
    today: 'limits',
    words: 'ferret limits are switched off, so ferrets may take all of the machine',
    door: [limits('enabled: true\n', 'enabled: false\n')],
  },
  {
    today: 'limits',
    words: 'ferrets no longer run at a lower disk priority',
    door: [limits('ionice: true\n', 'ionice: false\n')],
  },
  { today: 'limits', words: '${words} was raised', door: [raise('fleet', 'cpuWeight', '100', '200')] },
  {
    today: 'limits',
    words: 'the CPU weight of all ferrets together was raised',
    door: [raise('fleet', 'cpuWeight', '100', '200')],
  },
  {
    today: 'limits',
    words: 'the soft memory limit for all ferrets together was raised',
    door: [raise('fleet', 'memoryHigh', '10%', '50%')],
  },
  {
    today: 'limits',
    words: 'the hard memory limit for all ferrets together was raised',
    door: [raise('fleet', 'memoryMax', '10%', '50%')],
  },
  {
    today: 'limits',
    words: 'the swap all ferrets together may use was raised',
    door: [raise('fleet', 'swapMax', '10%', '50%')],
  },
  {
    today: 'limits',
    words: 'the processes all ferrets together may run was raised',
    door: [raise('fleet', 'tasksMax', '100', '200')],
  },
  {
    today: 'limits',
    words: 'the CPU share all ferrets together may use was raised',
    door: [raise('fleet', 'cpuPercent', '20', '40')],
  },
  {
    today: 'limits',
    words: 'the CPU weight of each ferret was raised',
    door: [raise('perFerret', 'cpuWeight', '100', '200')],
  },
  {
    today: 'limits',
    words: 'the CPU weight of a ferret you started was raised',
    door: [raise('perFerret', 'interactiveCpuWeight', '100', '200')],
  },
  {
    today: 'limits',
    words: 'the soft memory limit of each ferret was raised',
    door: [raise('perFerret', 'memoryHigh', '10%', '50%')],
  },
  {
    today: 'limits',
    words: 'the hard memory limit of each ferret was raised',
    door: [raise('perFerret', 'memoryMax', '10%', '50%')],
  },
  {
    today: 'limits',
    words: 'the processes each ferret may run was raised',
    door: [raise('perFerret', 'tasksMax', '100', '200')],
  },
  {
    today: 'limits',
    words: 'the CPU share each ferret may use was raised',
    door: [raise('perFerret', 'cpuPercent', '20', '40')],
  },
];

/**
 * Every file in the agent's reach, with the kinds of today's it holds that today's hold judged. A file listed with no
 * kinds held nothing today (today's `configLoosening`: "any other edit to a login, component, profile or runtime
 * changes what an agent RUNS WITH ... not what it may spend or control"; `modelsGuide` returned []); its own row in
 * ROWS proves its `${secret:…}` hold or says why no edit loosens.
 */
const TODAY_KINDS_OF: Readonly<Record<string, readonly string[]>> = {
  'warden.yaml': ['warden'],
  'voice.yaml': ['voice'],
  'limits.yaml': ['limits', 'machine'],
  'lessons.yaml': ['learning'],
  'packs.yaml': ['pack'],
  'accounts.yaml': ['accountDefaults'],
  'runtimes.yaml': [],
  'agenda.yaml': [],
  'conversation.yaml': [],
  logins: ['login'],
  runtimes: ['runtime'],
  profiles: [],
  models: [],
  mcp: [],
  skills: [],
  'claude-code/settings': [],
  'codex/settings': [],
  'claude-code/hooks': [],
  'model-sets': [],
};

describe("T-0034 every loosening today's hold held, for every file in the agent's reach", () => {
  test('T-0034 the table is exactly the extraction from today’s code (today-holds.json), each once, each with a door or an out', () => {
    const key = (hold: { readonly today: string; readonly words: string }): string => `${hold.today}\n${hold.words}`;
    expect(TODAY_HOLDS.map(key).toSorted()).toEqual(TODAY_EXTRACTED.map(key).toSorted());
    expect(new Set(TODAY_HOLDS.map(key)).size).toBe(TODAY_HOLDS.length);
    for (const hold of TODAY_HOLDS) expect((hold.door?.length ?? 0) > 0 || hold.out !== undefined).toBe(true);
  });

  test('T-0034 R-0073 every reachable file is listed, and every door edit names a reachable file of its kinds', () => {
    const reachable = DECLARED.filter(({ def }) => agentMayName(samplePath(def))).map(({ def }) => placeOf(def));
    expect(Object.keys(TODAY_KINDS_OF).toSorted()).toEqual([...new Set(reachable)].toSorted());
    for (const hold of TODAY_HOLDS)
      for (const edit of hold.door ?? []) {
        expect(agentMayName(edit.path)).toBe(true);
        expect(TODAY_KINDS_OF[placeOf(owning(edit.path).def)]).toContain(hold.today);
      }
  });

  test('T-0034 a hold whose 5.0 file is out of the reach: the agent may not name that file', () => {
    for (const hold of TODAY_HOLDS)
      if (hold.out !== undefined && hold.out.endsWith('.yaml')) expect(agentMayName(hold.out)).toBe(false);
  });

  for (const hold of TODAY_HOLDS)
    for (const [index, edit] of (hold.door ?? []).entries())
      test(`T-0034 ${edit.path} (today's ${hold.today}): "${hold.words}" #${String(index + 1)} is HELD and NOT applied`, async () => {
        const { agent, files } = world();
        await files.reload();
        const { plugin, def } = owning(edit.path);
        const name = def.shape === 'file' ? undefined : edit.path.slice(def.collection.length + 1, -'.yaml'.length);
        const owner = await files.write(plugin, def, name, edit.base, { confirmedLoosening: true });
        expect(owner.kind).toBe('applied');
        await files.reload();
        const before = inEffect(files, edit.path);
        const answer = await agent.run(call({ tool: 'config.write', path: edit.path, text: edit.text }), ferret);
        expect(answer.summary).toStartWith(`Wrote ${edit.path}, but it loosens what this machine allows (`);
        expect(inEffect(files, edit.path)).toEqual(before);
        expect(files.status().held.map(held => held.path)).toEqual([edit.path]);
      });
});

describe('T-0034 every declared file outside the reach is refused on read, validate AND write', () => {
  const outside = DECLARED.filter(({ def }) => !agentMayName(samplePath(def)));

  test('R-0073 the files kept out include the person-only ones and the ones whose loosenings are not ported', () => {
    const places = outside.map(({ def }) => placeOf(def));
    for (const place of [
      'gate.yaml',
      'plugins.yaml',
      'catalogs.yaml',
      'browsers.yaml',
      'usage.yaml',
      'harness-claude-code.yaml',
      'harness-codex.yaml',
      'endpoints',
    ])
      expect(places).toContain(place);
  });

  for (const { plugin, def } of outside)
    test(`T-0032 T-0033 T-0034 ${samplePath(def)} (${plugin}) is refused and nothing is written`, async () => {
      const { agent, files, fs } = world();
      await files.reload();
      const path = samplePath(def);
      for (const body of [
        { tool: 'config.read', path },
        { tool: 'config.validate', path, text: 'enabled: true\n' },
        { tool: 'config.write', path, text: 'enabled: true\n' },
      ]) {
        let refused: unknown;
        try {
          await agent.run(call(body), ferret);
        } catch (error) {
          refused = error;
        }
        expect(refused).toBeInstanceOf(ApiError);
        expect((refused as ApiError).status).toBe(400);
        expect((refused as ApiError).code).toBe('invalid_request');
      }
      expect(await fs.readText(`${HOME}/config/${path}`).catch(() => undefined)).toBeUndefined();
    });
});
