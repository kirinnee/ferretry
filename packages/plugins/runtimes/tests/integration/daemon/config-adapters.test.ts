/**
 * The adapters that read and write Runtimes' own configuration files, over the kernel's REAL configuration service on a
 * real disk (a temp directory standing in for `$FY_HOME/config`): the all-or-none writer, the model in effect, the
 * components other plugins provide and Runtimes' own `instructions`. Nothing here reads a real home.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Log, ProvideHook } from '@ferretry/kernel/contract';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { createConfigFiles } from '../../../../../core/kernel/host/config/service.ts';
import { createNodeHostFs } from '../../../../../core/kernel/host/state/host-fs.ts';
import {
  INSTRUCTION_ITEMS,
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  ProfileClaudeSettingsSource,
  ProfileCodexSettingsSource,
  ProfileMcpSource,
  ProfileSkillsSource,
  type ProfileComponentSource,
  RUNTIME_ITEMS,
  RUNTIMES_CONFIG,
} from '../../../contract/index.ts';
import { writeAllConfigWriter } from '../../../daemon/adapters/config-write-all.ts';
import { ownInstructionsSource } from '../../../daemon/adapters/own-instructions-source.ts';
import {
  type ComponentSourceLookup,
  readProfileComponents,
  withinMs,
} from '../../../daemon/adapters/profile-components.ts';
import { refuseBeforeWriting, runtimesConfigFiles } from '../../../daemon/adapters/runtimes-config-files.ts';
import type { AccountModel } from '../../../daemon/lib/account/schema.ts';
import { ConfigWriteConflict, ConfigWriteInvalid } from '../../../daemon/lib/service/ports.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const silentLog: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

const DEFS = [RUNTIMES_CONFIG, RUNTIME_ITEMS, PROFILE_ITEMS, MODEL_SET_ITEMS, INSTRUCTION_ITEMS];

const BASE: Readonly<Record<string, string>> = {
  'runtimes/claude-default.yaml': 'login: claude-you\nprofile: default\nagent: true\n',
  'profiles/default.yaml': 'contents:\n  - modelSets/heavy\n',
  'model-sets/heavy.yaml': 'models:\n  - claude-opus-5-5\ndefault: claude-opus-5-5\n',
};

/** The kernel's configuration service over a fresh temp home, holding `seed` (relative path → text), loaded once. */
async function world(seed: Readonly<Record<string, string>> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fy-config-adapters-'));
  homes.push(home);
  for (const [relative, text] of Object.entries(seed)) {
    await mkdir(dirname(join(home, 'config', relative)), { recursive: true });
    await writeFile(join(home, 'config', relative), text);
  }
  const files = createConfigFiles({
    home,
    fs: createNodeHostFs(),
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined } as never,
    log: silentLog,
    binary: 'fy',
    defs: DEFS.map(def => ({ plugin: 'runtimes', def: def as never })),
  });
  await files.reload();
  const port = files.port('runtimes');
  return { home, configDirectory: join(home, 'config'), files, port };
}

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const keysOf = (port: { collection: (def: never) => ReadonlyMap<string, unknown> }, def: unknown) => [
  ...port.collection(def as never).keys(),
];

describe('the config writer over the kernel’s all-or-none write', () => {
  const RUNTIME = 'login: claude-you\nprofile: p\n';
  const PROFILE = 'contents: []\n';
  const doc = (configDirectory: string, relative: string, content: string, expect?: string) => ({
    path: join(configDirectory, relative),
    content,
    mode: 0o600,
    ...(expect === undefined ? {} : { expect }),
  });

  it('writes a runtime and its profile together, as files', async () => {
    const { port, configDirectory } = await world();
    const writer = writeAllConfigWriter(port, configDirectory);

    await writer.write([
      doc(configDirectory, 'profiles/p.yaml', PROFILE),
      doc(configDirectory, 'runtimes/r.yaml', RUNTIME),
    ]);

    expect(await readFile(join(configDirectory, 'runtimes', 'r.yaml'), 'utf8')).toBe(RUNTIME);
    expect(keysOf(port, PROFILE_ITEMS)).toEqual(['p']);
    expect(keysOf(port, RUNTIME_ITEMS)).toEqual(['r']);
  });

  it('patches the keys that moved, and removes a file the change drops', async () => {
    const { port, configDirectory } = await world({
      ...BASE,
      'runtimes/gone.yaml': 'login: claude-you\nprofile: default\n',
    });
    const writer = writeAllConfigWriter(port, configDirectory);

    await writer.write([
      { path: join(configDirectory, 'runtimes.yaml'), content: '', mode: 0o600, patch: { autoResume: false } },
      { path: join(configDirectory, 'runtimes', 'gone.yaml'), content: '', mode: 0o600, remove: true },
    ]);

    expect(await readFile(join(configDirectory, 'runtimes.yaml'), 'utf8')).toContain('autoResume: false');
    expect(await readdir(join(configDirectory, 'runtimes'))).toEqual(['claude-default.yaml']);
  });

  it('writes none of the set when one document moved since it was read', async () => {
    const { port, configDirectory } = await world({ 'runtimes/r.yaml': RUNTIME });
    const writer = writeAllConfigWriter(port, configDirectory);

    const act = writer.write([
      doc(configDirectory, 'profiles/p.yaml', PROFILE),
      doc(configDirectory, 'runtimes/r.yaml', RUNTIME, digest('stale')),
    ]);

    await expect(act).rejects.toBeInstanceOf(ConfigWriteConflict);
    expect(keysOf(port, PROFILE_ITEMS)).toEqual([]);
  });

  it('refuses a document another part of Ferretry owns, and a path outside the folder, writing nothing', async () => {
    const { port, configDirectory } = await world();
    const writer = writeAllConfigWriter(port, configDirectory);

    const foreign = await writer
      .write([
        doc(configDirectory, 'profiles/p.yaml', PROFILE),
        doc(configDirectory, 'logins/claude-you.yaml', 'store: host\n'),
        { path: '/etc/runtimes/r.yaml', content: RUNTIME, mode: 0o600 },
      ])
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );

    expect(foreign).toBeInstanceOf(ConfigWriteInvalid);
    expect(foreign?.message).toContain('logins/claude-you.yaml');
    expect(foreign?.message).toContain('/etc/runtimes/r.yaml');
    expect(keysOf(port, PROFILE_ITEMS)).toEqual([]);
  });

  it('refuses a document that does not check against its schema, naming it, writing nothing', async () => {
    const { port, configDirectory } = await world();
    const writer = writeAllConfigWriter(port, configDirectory);

    const refusal = await writer
      .write([
        doc(configDirectory, 'profiles/p.yaml', PROFILE),
        doc(configDirectory, 'runtimes/r.yaml', 'login: [not, a, login]\n'),
      ])
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );

    expect(refusal).toBeInstanceOf(ConfigWriteInvalid);
    expect(refusal?.message).toContain('runtimes');
    expect(keysOf(port, PROFILE_ITEMS)).toEqual([]);
  });

  it('holds the WHOLE set, writing nothing, when one document is a loosening the judge would hold', async () => {
    const { port, configDirectory } = await world({ 'runtimes/r.yaml': RUNTIME });
    const writer = writeAllConfigWriter(port, configDirectory);

    const refusal = await writer
      .write([
        doc(configDirectory, 'profiles/p.yaml', PROFILE),
        doc(configDirectory, 'runtimes/r.yaml', 'login: claude-other\nprofile: p\n'),
      ])
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );

    expect(refusal).toBeInstanceOf(ConfigWriteInvalid);
    expect(refusal?.message).toContain('the whole set is held');
    expect(keysOf(port, PROFILE_ITEMS)).toEqual([]);
    expect(await readFile(join(configDirectory, 'runtimes', 'r.yaml'), 'utf8')).toBe(RUNTIME);
  });

  it('does nothing for an empty change', async () => {
    const { port, configDirectory } = await world();

    await writeAllConfigWriter(port, configDirectory).write([]);

    expect(await readdir(configDirectory).catch(() => [])).toEqual([]);
  });
});

describe('Runtimes’ own instructions as a component source', () => {
  it('lists the files by name and reads each without its description', async () => {
    const { port } = await world({
      'instructions/rules.yaml': 'text: be kind\ndescription: house rules\n',
      'instructions/alpha.yaml': 'text: be brief\n',
    });
    const source = ownInstructionsSource(port);

    expect(await source.list()).toEqual(['alpha', 'rules']);
    expect(await source.read('rules')).toEqual({ text: 'be kind' });
    expect(await source.read('missing')).toBeUndefined();
  });
});

describe('the components other plugins provide', () => {
  const lookupOf =
    (
      providers: ReadonlyMap<ProvideHook<string, 'components', ProfileComponentSource>, ProfileComponentSource>,
    ): ComponentSourceLookup =>
    hook =>
      providers.get(hook) ?? 'unavailable';
  const provider = (documents: Record<string, unknown>): ProfileComponentSource => ({
    list: async () => Object.keys(documents),
    read: async name => documents[name] as never,
  });
  const within = withinMs((ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  }, 30);
  const own = provider({});

  it('reads what every owner gave, skips one removed between listing and reading, and says which kind stands partly', async () => {
    const { port } = await world();
    const lookup = lookupOf(
      new Map<ProvideHook<string, 'components', ProfileComponentSource>, ProfileComponentSource>([
        [
          ProfileMcpSource,
          {
            list: async () => ['github', 'gone'],
            read: async name => (name === 'github' ? ({ command: 'github-mcp' } as never) : undefined),
          },
        ],
        // The owner of Claude's settings decides the harness of what it gives; Codex's owner is not running.
        [ProfileClaudeSettingsSource, provider({ base: { document: { effort: 'high' } } })],
      ]),
    );

    const reading = await readProfileComponents(lookup, ownInstructionsSource(port), within);

    expect(reading.mcp).toMatchObject({ state: 'read' });
    expect([...(reading.mcp as { components: Map<string, unknown> }).components.keys()]).toEqual(['github']);
    expect(reading.settings).toMatchObject({
      state: 'read',
      partial: 'the part of Ferretry that owns them is not running',
    });
    expect((reading.settings as { components: Map<string, unknown> }).components.get('base')).toMatchObject({
      harness: 'claude',
    });
    expect(reading.skills).toEqual({ state: 'unread', reason: 'the part of Ferretry that owns them is not running' });
  });

  it('does not read a kind that holds an invalid component, or two components of one name', async () => {
    const lookup = lookupOf(
      new Map<ProvideHook<string, 'components', ProfileComponentSource>, ProfileComponentSource>([
        [ProfileMcpSource, provider({ bad: { command: '' } })],
        [ProfileClaudeSettingsSource, provider({ dup: { document: { a: 1 } } })],
        [ProfileCodexSettingsSource, provider({ dup: { document: { b: 2 } } })],
      ]),
    );

    const reading = await readProfileComponents(lookup, own, within);

    expect(reading.mcp).toMatchObject({ state: 'unread' });
    expect((reading.mcp as { reason: string }).reason).toMatch(/^"bad" is not a valid mcp component \(/u);
    expect(reading.settings).toEqual({
      state: 'unread',
      reason: 'two parts of Ferretry give a settings component named "dup"',
    });
  });

  it('does not read a kind whose owner never answers, or answers with a failure, and says nothing of its own words', async () => {
    const lookup = lookupOf(
      new Map<ProvideHook<string, 'components', ProfileComponentSource>, ProfileComponentSource>([
        [
          ProfileMcpSource,
          { list: async () => await new Promise<never>(() => undefined), read: async () => undefined },
        ],
        [
          ProfileSkillsSource,
          {
            list: async () => await Promise.reject('a plain string, not an error'),
            read: async () => undefined,
          },
        ],
      ]),
    );

    const reading = await readProfileComponents(lookup, own, within);

    expect(reading.mcp).toEqual({
      state: 'unread',
      reason: 'the part of Ferretry that owns them did not answer in time',
    });
    expect(reading.skills).toEqual({ state: 'unread', reason: 'the part of Ferretry that owns them did not answer' });
  });
});

describe('the model in effect over Runtimes’ files', () => {
  const EMPTY_OWNERS: ComponentSourceLookup = () => ({ list: async () => [], read: async () => undefined });
  const NO_MOVES = new Map<string, string>();
  const modelOf = (loaded: { evaluation: { effective: { model: AccountModel } } }) => loaded.evaluation.effective.model;
  const adapter = (
    port: Parameters<typeof runtimesConfigFiles>[0]['config'],
    patch: Partial<Parameters<typeof runtimesConfigFiles>[0]> = {},
  ) =>
    runtimesConfigFiles({
      config: port,
      logins: fakeLogins([sampleLogin('claude-you', { store: 'ferretry' })]),
      components: () => 'unavailable',
      within: work => work,
      ...patch,
    });

  it('reads the files into one model, with nothing standing in, and primes the commands it will be asked about', async () => {
    const { port } = await world(BASE);
    const primed: (AccountModel | undefined)[] = [];
    const files = adapter(port, {
      prime: async model => {
        primed.push(model);
      },
    });

    const loaded = await files.load();

    expect(loaded.unreadable).toEqual([]);
    expect(loaded.evaluation.fleetFiles).toBeGreaterThan(0);
    expect(Object.keys(modelOf(loaded).runtimes)).toEqual(['claude-default']);
    expect(primed).toHaveLength(1);
    // The last load answers without asking the logins again.
    expect((await files.inEffect()).evaluation.fleetRevision).toBe(loaded.evaluation.fleetRevision);
  });

  it('refuses files that do not fit together, naming the rule and never a value', async () => {
    const { port } = await world({ 'runtimes/r.yaml': 'login: claude-you\nprofile: nope\n' });

    const act = adapter(port).load();

    await expect(act).rejects.toThrow(/the runtimes, profiles and model sets on this machine do not fit together: /u);
  });

  it('words a failure that is not a broken rule in the same sentence, with its own message', async () => {
    const { port } = await world(BASE);
    const failing = {
      ...port,
      file: port.file.bind(port),
      collection: () => {
        throw new Error('the configuration is being reloaded');
      },
    };

    const act = adapter(failing).load();

    await expect(act).rejects.toThrow(
      'the runtimes, profiles and model sets on this machine do not fit together: the configuration is being reloaded',
    );
  });

  it('turns edits into patches of the keys that moved, and a dropped runtime into a removed file', async () => {
    const { port } = await world(BASE);
    const files = adapter(port, { components: EMPTY_OWNERS });
    const loaded = await files.load();
    const before = modelOf(loaded);
    const { 'claude-default': _dropped, ...kept } = before.runtimes;

    const patched = files.editsFor(
      loaded,
      { ...before, machine: { ...before.machine, autoResume: false } } as AccountModel,
      NO_MOVES,
    );
    const removed = files.editsFor(loaded, { ...before, runtimes: kept } as AccountModel, NO_MOVES);

    expect(patched).toEqual([{ path: 'runtimes.yaml', patch: { autoResume: false } }]);
    expect(removed).toEqual([{ path: 'runtimes/claude-default.yaml', content: undefined }]);
    expect(files.mentionsRenamed(loaded, { from: 'a', to: 'b' } as never)).toEqual([]);
  });

  it('refuses a change proposed while a part stands in, a setting no file holds and a component another plugin owns', async () => {
    const standing = await world({
      ...BASE,
      'profiles/default.yaml': 'contents:\n  - modelSets/heavy\n  - mcp/github\n',
    });
    const loadedStanding = await adapter(standing.port).load();
    const files = adapter((await world(BASE)).port, { components: EMPTY_OWNERS });
    const loaded = await files.load();
    const before = modelOf(loaded);

    expect(() => adapter(standing.port).editsFor(loadedStanding, modelOf(loadedStanding), NO_MOVES)).toThrow(
      /nothing was changed.*github/su,
    );
    expect(() =>
      files.editsFor(
        loaded,
        { ...before, machine: { ...before.machine, agentPermissions: 'skip' } } as AccountModel,
        NO_MOVES,
      ),
    ).toThrow(/agentPermissions.*no file of Runtimes holds/su);
    expect(() =>
      files.editsFor(
        loaded,
        { ...before, components: { ...before.components, mcp: { github: { command: 'github-mcp' } } } } as AccountModel,
        NO_MOVES,
      ),
    ).toThrow(/mcp "github".*another part of Ferretry owns/su);
  });

  it('refuses a change that would carry a login whose environment it could not read', async () => {
    const glm = sampleLogin('glm', {
      store: 'environment',
      environment: {
        variables: [],
        quotaSource: 'none',
        missingSecrets: [],
        test: { available: false, reason: 'x' },
      } as never,
    });
    const { port } = await world({ ...BASE, 'runtimes/claude-default.yaml': 'login: glm\nprofile: default\n' });
    const files = adapter(port, {
      logins: {
        list: async () => ({ format: 1 as const, machine: 'm', logins: [glm] }),
        // Logins could not give the templates: the login stands in rather than being read as empty.
        environmentTemplates: async () => await Promise.reject(new Error('locked')),
      },
    });
    const loaded = await files.load();

    expect(loaded.stoodInLogins).toHaveLength(1);
    expect(() => files.editsFor(loaded, modelOf(loaded), NO_MOVES)).toThrow(/glm/u);
  });

  it('refuses before writing anything while a part stands in, and passes once none does', async () => {
    const standing = await world({
      ...BASE,
      'profiles/default.yaml': 'contents:\n  - modelSets/heavy\n  - skills/tidy\n',
    });
    const clean = await world(BASE);

    await expect(refuseBeforeWriting(adapter(standing.port))()).rejects.toThrow(/nothing was changed.*tidy/su);
    await expect(refuseBeforeWriting(adapter(clean.port))()).resolves.toBeUndefined();
  });
});
