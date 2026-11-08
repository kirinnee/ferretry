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
      'conversation.yaml',
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
