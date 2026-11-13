/**
 * The account model's catalogue projections (`daemon/lib/service/catalog.ts`): who uses what, and the four reads
 * (machine, components, profiles, runtimes) plus the draft-profile preview, as pure values. The wire shapes and the
 * sentences a person reads are asserted here; component text redaction has its own file.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { instantFromEpochMs } from '@ferretry/std';
import type { LocalModels } from '@ferretry/plugin-logins/contract';
import {
  type CatalogFacts,
  componentCatalog,
  componentUsage,
  counted,
  editConsequence,
  layersRefusal,
  listed,
  machineView,
  profileCatalog,
  profileDraftView,
  profileUsage,
  runtimeCatalog,
  runtimesUsingCredential,
  runtimesUsingProfile,
} from '../../../daemon/lib/service/catalog.ts';
import { type AccountModel, type AccountModelDocument, parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { MachineAuthority } from '../../../contract/index.ts';
import { shownWords, shownWordsEtag } from '../../../daemon/lib/service/command-line.ts';
import { builtInModelCatalogs, builtInPresets } from '../lib/fixtures/built-ins.ts';

const DIGEST = `sha256:${'0'.repeat(64)}`;
const AUTHORITY: MachineAuthority = { mayApply: true, applyRefusal: 'granted' };
const NOW = 1_794_052_800_000;

const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'studio',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 2,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
};

/** A document with every kind of component, a stack of profiles and runtimes on different logins. */
const documentOf = (patch: Partial<AccountModelDocument> = {}): AccountModelDocument => ({
  version: 1,
  machine: { defaultRuntime: 'claude-default', browserProxy: { url: 'http://proxy.example.invalid:8080' } },
  credentials: {
    'claude-a': { harness: 'claude', store: 'ferretry', label: 'Work' },
    'claude-b': { harness: 'claude', store: 'ferretry' },
    'codex-a': { harness: 'codex', store: 'ferretry' },
  },
  components: {
    instructions: {
      notes: { file: 'components/instructions/notes.md', clonedFrom: 'other-box', clonedFromDaemon: 'daemon-7' },
    },
    mcp: {
      srv: { command: 'srv-bin', args: ['--x'], env: { PLAIN: 'visible', API_TOKEN: 'fake-token-value-0000' } },
      remote: { url: 'https://mcp.example.invalid/sse', auth: 'oauth' },
      plain: { url: 'https://mcp.example.invalid/open' },
      pinned: {
        command: 'pinned-bin',
        installedFrom: {
          publisher: 'pub',
          publisherName: 'Publisher',
          catalogId: 'cat',
          catalogName: 'Catalog',
          itemId: 'item',
          kind: 'mcp',
          name: 'pinned',
          version: 1,
          digest: DIGEST,
        },
      },
    },
    skills: { sk: { items: ['sk-one', 'sk-two'] } },
    settings: {
      'cl-settings': {
        harness: 'claude',
        file: 'components/settings/cl-settings.json',
        flags: ['--verbose'],
        env: { KEPT: 'old', SECRET_TOKEN: 'fake-token-value-0000' },
      },
      'cx-settings': { harness: 'codex', file: 'components/settings/cx-settings.toml' },
    },
    hooks: {
      'cl-hooks': { harness: 'claude', file: 'components/hooks/cl-hooks.json' },
      'dir-hooks': { harness: 'claude', directory: 'components/hooks/dir-hooks' },
    },
    modelSets: {
      'claude-set': { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
      'codex-set': { models: ['gpt-6'], default: 'gpt-6' },
    },
  },
  profiles: {
    plain: { layers: ['instructions/notes'] },
    base: { layers: ['instructions/notes'] },
    derived: { layers: ['profile/base', 'mcp/srv'] },
    empty: { layers: [] },
    'claude-only': { layers: ['settings/cl-settings', 'modelSets/claude-set'] },
    'codex-only': { layers: ['settings/cx-settings', 'modelSets/codex-set'] },
    mixed: { layers: ['settings/cl-settings', 'modelSets/codex-set'] },
  },
  runtimes: {
    'claude-default': { credential: 'claude-a', profile: 'plain', agent: true },
    second: { credential: 'claude-b', profile: 'derived', agent: false },
    'codex-run': { credential: 'codex-a', profile: 'codex-only', agent: true },
  },
  ...patch,
});

const modelOf = (patch: Partial<AccountModelDocument> = {}): AccountModel => parseAccountModel(documentOf(patch));

describe('usage helpers', () => {
  it('should say who uses a component directly, through a base, and by runtime', () => {
    // Act
    const actual = componentUsage(modelOf(), 'instructions/notes');

    // Assert
    should(actual).eql({
      direct: ['base', 'plain'],
      profiles: ['base', 'derived', 'plain'],
      runtimes: ['claude-default', 'second'],
    });
  });

  it('should not count a profile whose stack cannot be read as reaching a component', () => {
    // Arrange — a layer the schema would refuse, for the total-function case
    const model = modelOf();
    const broken = {
      ...model,
      profiles: { ...model.profiles, ghost: { layers: ['profile/missing', 'instructions/notes'] } },
    } as unknown as AccountModel;

    // Act
    const actual = componentUsage(broken, 'instructions/notes');

    // Assert
    should(actual.direct).containEql('ghost');
    should(actual.profiles).not.containEql('ghost');
  });

  it('should say who builds on a profile and which runtimes sit on it or on them', () => {
    // Act
    const actual = profileUsage(modelOf(), 'base');

    // Assert
    should(actual).eql({ direct: ['derived'], profiles: ['derived'], runtimes: ['second'] });
    should(profileUsage(modelOf(), 'plain')).eql({ direct: [], profiles: [], runtimes: ['claude-default'] });
  });

  it('should list the runtimes that name a profile or a credential themselves', () => {
    // Assert
    should(runtimesUsingProfile(modelOf(), 'derived')).eql(['second']);
    should(runtimesUsingProfile(modelOf(), 'base')).eql([]);
    should(runtimesUsingCredential(modelOf(), 'codex-a')).eql(['codex-run']);
    should(runtimesUsingCredential(modelOf(), 'nobody')).eql([]);
  });

  it('should write counts and lists in plain words', () => {
    // Assert
    should(counted(1, 'profile')).equal('1 profile');
    should(counted(3, 'runtime')).equal('3 runtimes');
    should(counted(2, 'child', 'children')).equal('2 children');
    should(listed([])).equal('');
    should(listed(['a'])).equal('a');
    should(listed(['a', 'b', 'c'])).equal('a, b and c');
  });

  it('should say nothing about an edit nobody else uses, and where an edit lands otherwise', () => {
    // Assert
    should(editConsequence({ direct: [], profiles: [], runtimes: [] })).be.undefined();
    should(editConsequence({ direct: ['a'], profiles: ['a'], runtimes: ['r1', 'r2'] })).equal(
      'Used by 1 profile and 2 runtimes. Saving changes it everywhere. Running sessions keep the old version until restarted.',
    );
  });
});

describe('machineView', () => {
  it('should say a machine with runtimes is set up, with the tools it has and the one it lacks', () => {
    // Act
    const actual = machineView(modelOf(), FACTS, AUTHORITY);

    // Assert
    should(actual).match({
      name: 'studio',
      format: 'present',
      setUp: true,
      defaultRuntime: 'claude-default',
      lastAutoResume: null,
      runtimeCount: 3,
      runningSessions: 2,
      authority: AUTHORITY,
    });
    should(actual.browserProxy).match({ url: 'http://proxy.example.invalid:8080' });
    should(actual.tools).eql([
      { harness: 'claude-code', label: 'Claude Code', installed: true, command: '/usr/bin/claude' },
      { harness: 'codex', label: 'Codex', installed: false },
    ]);
  });

  it('should say an empty machine is not set up, with no proxy and the last auto-resume it was given', () => {
    // Arrange
    const empty = modelOf({ machine: {}, credentials: {}, runtimes: {}, profiles: {}, components: {} });
    const lastAutoResume = { at: instantFromEpochMs(NOW), resumed: 1, skipped: 0 } as never;

    // Act
    const actual = machineView(empty, { ...FACTS, lastAutoResume }, AUTHORITY);

    // Assert
    should(actual.setUp).be.false();
    should(actual.defaultRuntime).be.null();
    should(actual.browserProxy).be.null();
    should(actual.runtimeCount).equal(0);
    should(actual.lastAutoResume).equal(lastAutoResume);
  });
});

describe('componentCatalog', () => {
  const catalog = (facts: Partial<CatalogFacts> = {}, model: AccountModel = modelOf()) =>
    componentCatalog(model, { ...FACTS, ...facts });
  const component = (reference: string, facts: Partial<CatalogFacts> = {}, model: AccountModel = modelOf()) => {
    const found = catalog(facts, model)
      .kinds.flatMap(group => group.components)
      .find(entry => entry.reference === reference);
    if (found === undefined) throw new Error(`no component ${reference}`);
    return found;
  };

  it('should list the six kinds in order with their descriptions', () => {
    // Act
    const actual = catalog();

    // Assert
    should(actual.format).equal('present');
    should(actual.kinds.map(group => group.kind)).eql([
      'instructions',
      'mcp',
      'skills',
      'settings',
      'hooks',
      'modelSets',
    ]);
    should(actual.kinds[0]?.label).equal('Instructions');
  });

  it('should show each kind of component in its own detail, hiding secret-looking environment values', () => {
    // Assert
    should(component('instructions/notes').detail).eql({
      kind: 'instructions',
      file: 'components/instructions/notes.md',
    });
    should(component('mcp/srv').detail).eql({
      kind: 'mcp',
      command: 'srv-bin',
      args: ['--x'],
      argsEtag: shownWordsEtag(shownWords(['--x'], 'srv-bin')),
      env: [
        { name: 'API_TOKEN', hidden: true },
        { name: 'PLAIN', value: 'visible' },
      ],
    });
    should(component('mcp/remote').detail).eql({
      kind: 'mcp',
      url: 'https://mcp.example.invalid/sse',
      auth: 'oauth',
      env: [],
    });
    should(component('mcp/plain').detail).eql({ kind: 'mcp', url: 'https://mcp.example.invalid/open', env: [] });
    should(component('skills/sk').detail).eql({ kind: 'skills', items: ['sk-one', 'sk-two'] });
    should(component('settings/cl-settings').detail).eql({
      kind: 'settings',
      file: 'components/settings/cl-settings.json',
      flags: ['--verbose'],
      flagsEtag: shownWordsEtag(shownWords(['--verbose'])),
      env: [
        { name: 'KEPT', value: 'old' },
        { name: 'SECRET_TOKEN', hidden: true },
      ],
    });
    should(component('settings/cx-settings').detail).eql({
      kind: 'settings',
      file: 'components/settings/cx-settings.toml',
      env: [],
    });
    should(component('hooks/cl-hooks').detail).eql({ kind: 'hooks', file: 'components/hooks/cl-hooks.json' });
    should(component('hooks/dir-hooks').detail).eql({ kind: 'hooks', directory: 'components/hooks/dir-hooks' });
    should(component('modelSets/claude-set').detail).eql({
      kind: 'modelSets',
      models: ['claude-opus-5-5'],
      default: 'claude-opus-5-5',
    });
  });

  it('should say who uses a component, what removing it needs, and where its copy came from', () => {
    // Act
    const notes = component('instructions/notes');

    // Assert
    should(notes.usedBy).eql({ profiles: ['base', 'derived', 'plain'], runtimes: ['claude-default', 'second'] });
    should(notes.editNote).match(/^Used by 3 profiles and 2 runtimes\./u);
    should(notes.remove).eql({
      available: false,
      reason: 'It is a layer in base and plain. Remove it from those profiles first.',
    });
    should(notes.clonedFrom).equal('other-box');
    should(notes.clonedFromDaemon).equal('daemon-7');
    should(component('mcp/srv').remove).eql({
      available: false,
      reason: 'It is a layer in derived. Remove it from that profile first.',
    });
    should(component('skills/sk')).match({ editNote: 'Nothing uses it yet.', remove: { available: true } });
    should(component('skills/sk').clonedFrom).be.undefined();
  });

  it('should carry what a catalog install pinned, a harness, and the scope word the wire spells', () => {
    // Assert
    should(component('mcp/pinned').installedFrom).match({ publisher: 'pub', catalogId: 'cat', version: 1 });
    should(component('mcp/srv').installedFrom).be.undefined();
    should(component('settings/cl-settings')).match({ harness: 'claude-code', scope: 'claude-code' });
    should(component('settings/cx-settings')).match({ harness: 'codex', scope: 'codex' });
    should(component('skills/sk').scope).equal('generic');
    should(component('skills/sk').harness).be.undefined();
  });

  it('should warn about a command this machine does not have, and only that', () => {
    // Act
    const facts = { missingCommands: new Set(['srv-bin']) };

    // Assert
    should(component('mcp/srv', facts).warnings).eql(['Command not found: srv-bin']);
    should(component('mcp/pinned', facts).warnings).eql([]);
    should(component('mcp/srv').warnings).eql([]);
  });

  it('should report partial support for a component a harness only half understands', () => {
    // Arrange — a skill whose frontmatter names a field Codex does not read
    const facts: Partial<CatalogFacts> = { skillFrontmatter: { 'sk-one': ['allowed-tools'] } };

    // Act
    const sk = component('skills/sk', facts);

    // Assert
    should(sk.partial.every(entry => typeof entry.reason === 'string' && entry.harness !== undefined)).be.true();
  });

  it('should carry settings as dotted entries and hide the ones that look secret', () => {
    // Arrange
    const facts: Partial<CatalogFacts> = {
      settingsBodies: {
        'cl-settings': {
          permissions: { defaultMode: 'plan', allow: ['Bash(ls)'] },
          model: 'opus',
          apiKey: 'fake-api-key-value-0000',
          empty: {},
          count: 3,
        },
      },
    };

    // Act
    const actual = component('settings/cl-settings', facts).content;

    // Assert
    should(actual).eql({
      form: 'entries',
      entries: [
        { key: 'apiKey', hidden: true },
        { key: 'count', value: '3' },
        { key: 'empty', value: '{}' },
        { key: 'model', value: 'opus' },
        { key: 'permissions.allow', value: '["Bash(ls)"]' },
        { key: 'permissions.defaultMode', value: 'plan' },
      ],
    });
    should(component('settings/cx-settings', facts).content).be.undefined();
  });

  it('should carry instructions and hooks as text and no content for the other kinds', () => {
    // Arrange
    const facts: Partial<CatalogFacts> = {
      instructionBodies: { notes: 'Be kind.' },
      hooksTexts: { 'cl-hooks': '{"hooks":{}}' },
    };

    // Assert
    should(component('instructions/notes', facts).content).eql({ form: 'text', text: 'Be kind.', redacted: false });
    should(component('hooks/cl-hooks', facts).content).eql({ form: 'text', text: '{"hooks":{}}', redacted: false });
    should(component('hooks/dir-hooks', facts).content).be.undefined();
    should(component('mcp/srv', facts).content).be.undefined();
    should(component('instructions/notes').content).be.undefined();
  });

  describe('a path under somebody else’s home (E30)', () => {
    const checkPath = (reference: string, facts: Partial<CatalogFacts>, model: AccountModel = modelOf()) =>
      component(reference, facts, model).checkPath;

    it('should name the first foreign home path in instructions, hooks and settings values', () => {
      // Assert
      should(checkPath('instructions/notes', { instructionBodies: { notes: 'see /Users/someone/notes.md' } })).equal(
        '/Users/someone/notes.md',
      );
      should(checkPath('hooks/cl-hooks', { hooksTexts: { 'cl-hooks': 'run /home/other/bin/hook' } })).equal(
        '/home/other/bin/hook',
      );
      should(
        checkPath('settings/cl-settings', { settingsBodies: { 'cl-settings': { log: '/Users/someone/log' } } }),
      ).equal('/Users/someone/log');
    });

    it('should not name a path under this machine’s own home, or one in a hidden setting', () => {
      // Assert
      should(
        checkPath('instructions/notes', { instructionBodies: { notes: 'at /home/person/a and /home/person' } }),
      ).be.undefined();
      should(
        checkPath('settings/cl-settings', {
          settingsBodies: { 'cl-settings': { apiKey: '/Users/someone/fake-api-key-0000' } },
        }),
      ).be.undefined();
      should(checkPath('hooks/cl-hooks', {})).be.undefined();
      should(checkPath('instructions/notes', {})).be.undefined();
    });

    it('should read an MCP server’s command, url and arguments', () => {
      // Arrange
      const model = modelOf({
        components: {
          ...documentOf().components,
          mcp: {
            srv: { command: '/Users/someone/bin/srv', args: ['--cfg', '/home/other/cfg.json'] },
            args: { command: 'srv', args: ['/home/other/a'] },
            url: { url: 'https://mcp.example.invalid/Users/someone/x' },
          },
        },
      });

      // Assert
      should(checkPath('mcp/srv', {}, model)).equal('/Users/someone/bin/srv');
      should(checkPath('mcp/args', {}, model)).equal('/home/other/a');
      should(checkPath('mcp/url', {}, model)).equal('/Users/someone/x');
    });
  });
});

describe('profileCatalog', () => {
  const profile = (name: string, facts: Partial<CatalogFacts> = {}, model: AccountModel = modelOf()) => {
    const found = profileCatalog(model, { ...FACTS, ...facts }).profiles.find(entry => entry.name === name);
    if (found === undefined) throw new Error(`no profile ${name}`);
    return found;
  };
  const stack = (name: string, harness: 'claude-code' | 'codex', facts: Partial<CatalogFacts> = {}) => {
    const found = profile(name, facts).harnesses.find(entry => entry.harness === harness);
    if (found === undefined) throw new Error(`no stack ${harness}`);
    return found;
  };

  it('should list profiles by name with their layers, users and what stands on them', () => {
    // Act
    const base = profile('base');

    // Assert
    should(profileCatalog(modelOf(), FACTS).profiles.map(entry => entry.name)).eql([
      'base',
      'claude-only',
      'codex-only',
      'derived',
      'empty',
      'mixed',
      'plain',
    ]);
    should(base).match({
      layers: ['instructions/notes'],
      usedBy: [],
      baseFor: ['derived'],
      wouldIncludeItself: ['base', 'derived'],
      scope: { kind: 'scoped', scope: 'generic' },
    });
    should(base.remove).eql({
      available: false,
      reason: 'It is a base for derived. Remove it from that profile first.',
    });
    should(profile('plain').usedBy).eql(['claude-default']);
    should(profile('plain').remove).eql({ available: true });
  });

  it('should say a base shared by several profiles is removed from those profiles', () => {
    // Arrange
    const model = modelOf({
      profiles: { ...documentOf().profiles, other: { layers: ['profile/base'] } },
    });

    // Assert
    should(profile('base', {}, model).remove).eql({
      available: false,
      reason: 'It is a base for derived and other. Remove it from those profiles first.',
    });
  });

  it('should say a mixed profile is mixed, in the sentence that names its layers', () => {
    // Act
    const mixed = profile('mixed');

    // Assert
    should(mixed.scope.kind).equal('mixed');
    should((mixed.scope as { sentence: string }).sentence).be.a.String();
    should(profile('claude-only').scope).eql({ kind: 'scoped', scope: 'claude-code' });
  });

  it('should say why a stack is unavailable: empty, or nothing that applies to the harness', () => {
    // Assert
    should(stack('empty', 'codex').available).eql({ available: false, reason: 'This profile has no layers yet.' });
    should(stack('claude-only', 'codex').available).eql({
      available: false,
      reason: 'Only Claude Code settings. Nothing here applies on Codex.',
    });
    should(stack('plain', 'codex').available).eql({ available: true });
    should(stack('claude-only', 'claude-code').available).eql({ available: true });
  });

  it('should say nothing applies when the skipped layers belong to no single harness', () => {
    // Arrange — a Claude-only and a Codex-only layer: neither applies to a third reading, so ask Codex of both
    const model = modelOf({ profiles: { ...documentOf().profiles, both: { layers: ['settings/cl-settings'] } } });

    // Act
    const actual = profileCatalog(model, FACTS).profiles.find(entry => entry.name === 'both');

    // Assert
    should(actual?.harnesses.find(entry => entry.harness === 'codex')?.available.available).be.false();
  });

  it('should explain each skipped layer in the product’s words', () => {
    // Act
    const codex = stack('mixed', 'codex');
    const claude = stack('mixed', 'claude-code');

    // Assert
    should(codex.skipped).eql([
      {
        reference: 'settings/cl-settings',
        sentence: 'Settings cl-settings is for Claude Code only, so it is skipped on Codex.',
      },
    ]);
    should(claude.skipped).eql([
      {
        reference: 'modelSets/codex-set',
        sentence: 'Model set codex-set has no Claude Code model, so it is skipped on Claude Code.',
      },
    ]);
    should(claude.applied).eql(['settings/cl-settings']);
  });

  it('should report the settings two layers disagree on', () => {
    // Arrange
    const model = modelOf({
      components: {
        ...documentOf().components,
        settings: {
          ...documentOf().components?.settings,
          'cl-two': { harness: 'claude', file: 'components/settings/cl-two.json' },
        },
      },
      profiles: { ...documentOf().profiles, clash: { layers: ['settings/cl-settings', 'settings/cl-two'] } },
    });
    const facts: CatalogFacts = {
      ...FACTS,
      settingsBodies: {
        'cl-settings': { model: 'opus', deep: { a: 1 } },
        'cl-two': { model: 'sonnet', deep: { a: 2 } },
      },
    };

    // Act
    const clash = profileCatalog(model, facts).profiles.find(entry => entry.name === 'clash');
    const conflicts = clash?.harnesses.find(entry => entry.harness === 'claude-code')?.conflicts ?? [];

    // Assert
    should(conflicts.length).be.above(0);
    should(conflicts[0]).match({
      harness: 'claude-code',
      winner: 'cl-two',
      overridden: ['cl-settings'],
    });
    should(conflicts[0]?.sentence).be.a.String();
  });

  it('should say a profile that cannot be read cannot be read, on both harnesses', () => {
    // Arrange — a profile whose base does not exist: the schema would refuse it, the projection stays total
    const model = modelOf();
    const broken = {
      ...model,
      profiles: { ...model.profiles, ghost: { layers: ['profile/missing'] } },
    } as unknown as AccountModel;

    // Act
    const actual = profileCatalog(broken, FACTS).profiles.find(entry => entry.name === 'ghost');

    // Assert
    should(actual?.harnesses).eql(
      ['claude-code', 'codex'].map(harness => ({
        harness,
        available: { available: false, reason: 'This profile cannot be read.' },
        applied: [],
        skipped: [],
        conflicts: [],
        partial: [],
      })),
    );
  });
});

describe('runtimeCatalog', () => {
  const catalog = (facts: Partial<CatalogFacts> = {}, model: AccountModel = modelOf()) =>
    runtimeCatalog(model, { ...FACTS, ...facts });
  const runtime = (name: string, facts: Partial<CatalogFacts> = {}, model: AccountModel = modelOf()) => {
    const found = catalog(facts, model).runtimes.find(entry => entry.name === name);
    if (found === undefined) throw new Error(`no runtime ${name}`);
    return found;
  };

  it('should list runtimes by name with their login, profile and which others are the same', () => {
    // Arrange
    const model = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        twin: { credential: 'claude-a', profile: 'plain', agent: false },
      },
    });

    // Act
    const actual = catalog({}, model);

    // Assert
    should(actual.runtimes.map(entry => entry.name)).eql(['claude-default', 'codex-run', 'second', 'twin']);
    should(runtime('claude-default', {}, model)).match({
      id: 'claude-default',
      name: 'claude-default',
      wrapper: 'claude-default',
      harness: 'claude-code',
      credential: { id: 'claude-a', store: 'ferretry', label: 'Work' },
      profile: 'plain',
      agent: true,
      sameAs: ['twin'],
      modelSet: { source: 'harness-default' },
    });
    should(runtime('second').credential).eql({ id: 'claude-b', store: 'ferretry' });
    should(runtime('second').sameAs).eql([]);
  });

  it('should use the id a publish gave a runtime, and the files the last apply left alone', () => {
    // Act
    const facts: Partial<CatalogFacts> = {
      runtimeIds: { 'claude-default': 'id-1' },
      skipped: { 'id-1': ['settings.json'], second: ['x'] },
    };

    // Assert
    should(runtime('claude-default', facts)).match({ id: 'id-1', skipped: ['settings.json'] });
    should(runtime('second', facts)).match({ id: 'second', skipped: ['x'] });
    should(runtime('codex-run', facts).skipped).be.undefined();
  });

  it('should carry the credential status the credentials surface read', () => {
    // Assert
    should(runtime('claude-default', { credentialStatus: { 'claude-a': 'ready' as never } }).credential.status).equal(
      'ready',
    );
  });

  it('should say why a runtime cannot launch, in the order the reasons rank', () => {
    // Arrange
    const model = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        'claude-empty': { credential: 'claude-b', profile: 'empty', agent: false },
      },
    });

    // Assert
    should(runtime('claude-default').launch).eql({ available: true });
    should(runtime('codex-run').launch).eql({ available: false, reason: 'Install Codex to launch' });
    should(runtime('claude-default', { credentialStatus: { 'claude-a': 'needs_sign_in' } }).launch).eql({
      available: false,
      reason: 'Sign in to launch',
    });
    should(runtime('claude-empty', {}, model).launch).eql({
      available: false,
      reason: 'This profile has no layers yet.',
    });
  });

  it('should refuse an agent runtime when the installed Claude does not accept Auto mode', () => {
    // Arrange
    const model = modelOf({ machine: { agentPermissions: 'auto', defaultRuntime: 'claude-default' } });

    // Act
    const refused = runtime('claude-default', { acceptsAutoPermissionMode: false }, model);

    // Assert
    should(refused.launch.available).be.false();
    should((refused.launch as { reason: string }).reason)
      .be.a.String()
      .and.not.empty();
    should(refused.fixedLayer).be.undefined();
    should(runtime('second', { acceptsAutoPermissionMode: false }, model).launch).eql({ available: true });
  });

  it('should show an agent runtime’s fixed layer by purpose, once per thing switched off', () => {
    // Act
    const skipping = modelOf({ machine: { agentPermissions: 'skip', defaultRuntime: 'claude-default' } });
    const claude = runtime('claude-default', {}, skipping).fixedLayer;
    const codex = runtime('codex-run', { tools: { claude: '/c', codex: '/x' } }, skipping).fixedLayer;

    // Assert
    should(claude?.agentPermissions).equal('skip');
    should(claude?.entries).containDeep([
      { key: 'trust prompt', value: 'off' },
      { key: 'onboarding screens', value: 'off' },
      { key: 'Remote Control at startup', value: 'off' },
      { key: 'one-time prompts (nudges, upsells, notices)', value: 'off' },
      { key: 'Ferretry tools (terminals and browsers)', value: 'on' },
      { key: 'Ferretry tools instruction', value: 'on' },
    ]);
    should(claude?.entries.filter(entry => entry.key === 'one-time prompts (nudges, upsells, notices)')).have.length(1);
    should(claude?.entries.some(entry => entry.key === 'permissions.defaultMode')).be.true();
    should(codex?.entries.some(entry => entry.key === 'approval_policy')).be.true();
    should(runtime('second').fixedLayer).be.undefined();
  });

  it('should report what the profile sets that the fixed layer overrides', () => {
    // Arrange — a settings value and a flag the fixed layer takes over
    const model = modelOf({
      profiles: { ...documentOf().profiles, tuned: { layers: ['settings/cl-settings'] } },
      runtimes: { 'claude-default': { credential: 'claude-a', profile: 'tuned', agent: true } },
      components: {
        ...documentOf().components,
        settings: {
          ...documentOf().components?.settings,
          'cl-settings': {
            harness: 'claude',
            file: 'components/settings/cl-settings.json',
            flags: ['--permission-mode', 'plan'],
          },
        },
      },
    });
    const facts: Partial<CatalogFacts> = {
      settingsBodies: { 'cl-settings': { permissions: { defaultMode: 'plan' }, theme: 'dark' } },
    };

    // Act
    const overridden = runtime('claude-default', facts, model).fixedLayer?.overridden ?? [];

    // Assert
    should(overridden).containDeep([
      {
        key: 'permissions.defaultMode',
        value: 'plan',
        from: 'cl-settings',
        sentence: 'From your cl-settings · Overridden for agents by Ferretry',
      },
    ]);
    should(overridden.some(entry => entry.key === '--permission-mode')).be.true();
    should(overridden.find(entry => entry.key === '--permission-mode')?.value).match(/^--permission-mode/u);
  });

  it('R-0082 should name a dropped flag through the one command-line rule, so its key and value show no credential (review r1 F5)', () => {
    // Arrange — flags the fixed layer supersedes, each carrying an obviously fake credential.
    const secret = 'not-a-real-secret-0000';
    const token = 'sk-not-a-real-key-0000';
    const model = modelOf({
      profiles: {
        ...documentOf().profiles,
        tuned: { layers: ['settings/cl-settings'] },
        cx: { layers: ['settings/cx-settings'] },
      },
      runtimes: {
        'claude-default': { credential: 'claude-a', profile: 'tuned', agent: true },
        'codex-run': { credential: 'codex-a', profile: 'cx', agent: true },
      },
      components: {
        ...documentOf().components,
        settings: {
          'cl-settings': {
            harness: 'claude',
            file: 'components/settings/cl-settings.json',
            flags: ['--permission-mode', token, `--permission-mode=${token}`, '--permission-mode', 'plan'],
          },
          'cx-settings': {
            harness: 'codex',
            file: 'components/settings/cx-settings.toml',
            flags: [
              '-c',
              `mcp_servers.ferretry.env.API_KEY=${secret}`,
              `--config=mcp_servers.ferretry.env.API_KEY=${secret}`,
            ],
          },
        },
      },
    });
    const facts: Partial<CatalogFacts> = { tools: { claude: '/usr/bin/claude', codex: '/usr/bin/codex' } };

    // Act
    const claude = runtime('claude-default', facts, model).fixedLayer?.overridden ?? [];
    const codex = runtime('codex-run', facts, model).fixedLayer?.overridden ?? [];

    // Assert
    const text = JSON.stringify([claude, codex]);
    should(text).not.containEql(secret);
    should(text).not.containEql('not-a-real-key-0000');
    should(claude.map(entry => [entry.key, entry.value])).deepEqual([
      ['--permission-mode', '--permission-mode ‹hidden›'],
      ['--permission-mode=‹hidden›', '--permission-mode=‹hidden›'],
      ['--permission-mode', '--permission-mode plan'],
    ]);
    should(codex.map(entry => [entry.key, entry.value])).deepEqual([
      ['-c', '-c mcp_servers.ferretry.env.API_KEY=‹hidden›'],
      ['--config=mcp_servers.ferretry.env.API_KEY=‹hidden›', '--config=mcp_servers.ferretry.env.API_KEY=‹hidden›'],
    ]);
  });

  it('should say a switched-off runtime is off, by its own switch, its login’s, or a budget', () => {
    // Arrange
    const own = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        'claude-default': { credential: 'claude-a', profile: 'plain', agent: true, disabled: { reason: 'resting' } },
      },
    });
    const login = modelOf({
      credentials: {
        ...documentOf().credentials,
        'claude-a': { harness: 'claude', store: 'ferretry', disabled: { reason: 'billing' } },
      },
    });

    // Assert
    const byOwn = runtime('claude-default', { now: NOW }, own);
    should(byOwn.disabled).match({ reason: 'resting', source: 'runtime' });
    should((byOwn.launch as { reason: string }).reason).match(/resting/u);
    const byLogin = runtime('claude-default', { now: NOW }, login);
    should(byLogin.disabled).match({ reason: 'billing', source: 'login' });
    const byBudget = runtime('claude-default', {
      now: NOW,
      budgetHolds: {
        'claude-a': { period: 'daily', level: 'over_hard', limitUsd: 5, resetsAtMs: NOW + 3_600_000, timeZone: 'UTC' },
      },
    });
    should(byBudget.disabled).be.undefined();
    should(byBudget.launch.available).be.false();
  });

  it('should read the clock from now, and an expired switch is no switch', () => {
    // Arrange
    const model = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        'claude-default': {
          credential: 'claude-a',
          profile: 'plain',
          agent: true,
          disabled: { until: '2026-11-01T00:00:00Z' },
        },
      },
    });

    // Assert
    should(runtime('claude-default', { now: NOW }, model).disabled).be.undefined();
    should(runtime('claude-default', {}, model).disabled).match({
      until: instantFromEpochMs(Date.parse('2026-11-01')),
    });
  });

  it('should skip a runtime whose login does not exist', () => {
    // Arrange — the schema refuses this; the projection stays total
    const model = modelOf();
    const broken = {
      ...model,
      runtimes: { ...model.runtimes, orphan: { credential: 'gone', profile: 'plain', agent: false } },
    } as unknown as AccountModel;

    // Assert
    should(catalog({}, broken).runtimes.map(entry => entry.name)).eql(['claude-default', 'codex-run', 'second']);
  });

  it('should show the profile’s model set, and the catalog’s models when the login reads one', () => {
    // Arrange
    const model = modelOf({
      credentials: {
        ...documentOf().credentials,
        zai: {
          harness: 'claude',
          store: 'environment',
          preset: 'zai-glm',
          env: {
            ANTHROPIC_BASE_URL: 'https://api.example.invalid/anthropic',
            ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_KEY}',
          },
        },
      },
      profiles: { ...documentOf().profiles, sets: { layers: ['modelSets/claude-set'] } },
      runtimes: {
        ...documentOf().runtimes,
        glm: { credential: 'zai', profile: 'sets', agent: false },
        'plain-set': { credential: 'claude-b', profile: 'sets', agent: false },
      },
    });
    const sources = { catalogs: builtInModelCatalogs(), presets: builtInPresets() };

    // Act
    const withSet = runtime('plain-set', {}, model);
    const glm = runtime('glm', { modelCatalogs: sources }, model);
    const anthropic = runtime('plain-set', { modelCatalogs: sources }, model);

    // Assert
    should(withSet.modelSet).match({
      source: 'model-set',
      name: 'claude-set',
      models: [{ id: 'claude-opus-5-5', available: true }],
      declaredDefault: 'claude-opus-5-5',
      default: 'claude-opus-5-5',
    });
    should(withSet.models).be.undefined();
    should(glm.models?.catalog.id).equal('zai');
    should(glm.models?.choices.map(choice => choice.id)).eql(['glm-5.3', 'glm-5.3-flash']);
    should(glm.models?.choices.every(choice => typeof choice.fast === 'boolean')).be.true();
    should(glm.models?.default).equal('glm-5.3');
    should(anthropic.models?.catalog.id).equal('anthropic');
  });

  it('should leave models out for a login whose catalog this machine does not have', () => {
    // Arrange — an environment login made by hand names no catalog
    const model = modelOf({
      credentials: {
        ...documentOf().credentials,
        hand: { harness: 'claude', store: 'environment', env: { ANTHROPIC_BASE_URL: 'https://x.example.invalid' } },
      },
      runtimes: { ...documentOf().runtimes, byhand: { credential: 'hand', profile: 'plain', agent: false } },
    });

    // Assert
    should(
      runtime('byhand', { modelCatalogs: { catalogs: builtInModelCatalogs(), presets: builtInPresets() } }, model)
        .models,
    ).be.undefined();
  });

  it('should carry the models a local server has installed, for Codex', () => {
    // Arrange
    const local: LocalModels = {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      state: 'found',
      models: [{ id: 'gpt-oss:20b', label: 'gpt-oss 20B' }],
      checkedAt: instantFromEpochMs(NOW),
      message: 'Found 1 model.',
      pullCommand: 'ollama pull gpt-oss:20b',
    };
    const model = modelOf({
      credentials: {
        ...documentOf().credentials,
        ollama: {
          harness: 'codex',
          store: 'environment',
          preset: 'ollama-codex',
          codexProvider: { id: 'ollama', model: 'gpt-oss:20b' },
          env: { OLLAMA_HOST: 'http://localhost:11434' },
        },
      },
      runtimes: { ...documentOf().runtimes, local: { credential: 'ollama', profile: 'plain', agent: false } },
    });
    const sources = { catalogs: builtInModelCatalogs(), presets: builtInPresets(), local: { ollama: local } };

    // Act
    const actual = runtime('local', { modelCatalogs: sources, tools: { claude: '/c', codex: '/x' } }, model);

    // Assert
    should(actual.models?.local).equal(local);
    should(actual.models?.choices.map(choice => choice.id)).containEql('gpt-oss:20b');
    should(actual.models?.choices.every(choice => !('fast' in choice))).be.true();
  });
});

describe('layersRefusal', () => {
  const refusal = (layers: readonly string[], name = 'plain', named = true) =>
    layersRefusal(modelOf(), name, layers, named);

  it('should accept layers that exist, are not repeated, and do not mix scopes', () => {
    // Assert
    should(refusal(['instructions/notes', 'profile/base'])).be.undefined();
    should(refusal([])).be.undefined();
  });

  it('should refuse text that is not a layer', () => {
    // Assert
    should(refusal(['nonsense'])).equal('"nonsense" is not a layer — write <kind>/<name> or profile/<name>');
  });

  it('should refuse a layer given twice', () => {
    // Assert
    should(refusal(['instructions/notes', 'instructions/notes'])).match(/is in the layers twice$/u);
  });

  it('should refuse a base that does not exist, or that would include the profile itself', () => {
    // Assert
    should(refusal(['profile/ghost'])).equal('no profile ghost exists on this machine');
    should(refusal(['profile/derived'], 'base')).equal(
      'profile derived would include itself: it is base or is built on it',
    );
    should(refusal(['profile/plain'], 'plain')).match(/would include itself/u);
  });

  it('should refuse a component that does not exist on this machine', () => {
    // Assert
    should(refusal(['mcp/ghost'])).match(/^no .+ ghost exists on this machine$/u);
  });

  it('should refuse a stack that is both Claude only and Codex only, naming the profile only when it has a name', () => {
    // Act
    const named = refusal(['settings/cl-settings', 'modelSets/codex-set'], 'plain', true);
    const draft = refusal(['settings/cl-settings', 'modelSets/codex-set'], 'plain', false);

    // Assert
    should(named).be.a.String();
    should(draft).be.a.String();
    should(draft).not.equal(named);
  });
});

describe('profileDraftView', () => {
  it('should resolve a draft per harness exactly as a saved profile, with no refusal when it is fine', () => {
    // Act
    const actual = profileDraftView(modelOf(), { layers: ['instructions/notes'] }, FACTS);

    // Assert
    should(actual.harnesses.map(entry => entry.harness)).eql(['claude-code', 'codex']);
    should(actual.harnesses.every(entry => entry.available.available)).be.true();
    should(actual.scope).eql({ kind: 'scoped', scope: 'generic' });
    should(actual.refusal).be.undefined();
    should(actual.resolved).be.an.Array();
  });

  it('should stand a new draft under a name no profile has, and say what is wrong with it', () => {
    // Arrange — `draft` is taken, so the draft takes the next free name
    const model = modelOf({ profiles: { ...documentOf().profiles, draft: { layers: ['instructions/notes'] } } });

    // Act
    const actual = profileDraftView(model, { layers: ['profile/ghost'] }, FACTS);

    // Assert
    should(actual.refusal).equal('no profile ghost exists on this machine');
    should(actual.harnesses.every(entry => !entry.available.available)).be.true();
    should(actual.resolved).eql([]);
  });

  it('should preview an edit in place of the profile being edited', () => {
    // Act
    const actual = profileDraftView(modelOf(), { editing: 'derived', layers: ['profile/derived'] }, FACTS);

    // Assert
    should(actual.refusal).match(/would include itself/u);
    should(profileDraftView(modelOf(), { editing: 'plain', layers: ['mcp/srv'] }, FACTS).refusal).be.undefined();
  });

  it('should report a mixed draft’s scope as the sentence naming its layers', () => {
    // Act
    const actual = profileDraftView(modelOf(), { layers: ['settings/cl-settings', 'modelSets/codex-set'] }, FACTS);

    // Assert
    should(actual.scope.kind).equal('mixed');
    should(actual.refusal).be.a.String();
  });
});

describe('stacks nothing applies to', () => {
  it('should say nothing applies when the only skipped layer is a model set with no model for the harness', () => {
    // Arrange
    const model = modelOf({
      profiles: { ...documentOf().profiles, 'models-only': { layers: ['modelSets/codex-set'] } },
    });

    // Act
    const actual = profileCatalog(model, FACTS).profiles.find(entry => entry.name === 'models-only');
    const claude = actual?.harnesses.find(entry => entry.harness === 'claude-code');

    // Assert
    should(claude?.available).eql({ available: false, reason: 'Nothing here applies on Claude Code.' });
  });

  it('should apply a model set of third-party ids on every tool, skipping nothing (#1586)', () => {
    // Arrange — llama-4 is neither tool's own id, so it is served through whichever CLI the login drives
    const base = documentOf();
    const model = modelOf({
      components: {
        ...base.components,
        modelSets: { ...base.components?.modelSets, junk: { models: ['llama-4'], default: 'llama-4' } },
      },
      profiles: { ...base.profiles, junk: { layers: ['modelSets/junk'] } },
    });

    // Act
    const actual = profileCatalog(model, FACTS).profiles.find(entry => entry.name === 'junk');
    const stackOf = (harness: 'claude-code' | 'codex') => actual?.harnesses.find(entry => entry.harness === harness);

    // Assert
    should(stackOf('claude-code')?.available).eql({ available: true });
    should(stackOf('codex')?.available).eql({ available: true });
    should(stackOf('claude-code')?.skipped).eql([]);
    should(stackOf('codex')?.skipped).eql([]);
  });

  it('should show an agent runtime on a profile that cannot be read with no overrides', () => {
    // Arrange — the schema refuses a dangling base; the projection stays total
    const model = modelOf();
    const broken = {
      ...model,
      profiles: { ...model.profiles, ghost: { layers: ['profile/missing'] } },
      runtimes: { ...model.runtimes, haunted: { credential: 'claude-a', profile: 'ghost', agent: true } },
    } as unknown as AccountModel;

    // Act
    const actual = runtimeCatalog(broken, { ...FACTS, now: NOW }).runtimes.find(entry => entry.name === 'haunted');

    // Assert
    should(actual?.fixedLayer?.overridden).eql([]);
    should(actual?.launch).eql({ available: false, reason: 'This profile cannot be read.' });
    should(actual?.modelSet).eql({ source: 'harness-default' });
  });
});
