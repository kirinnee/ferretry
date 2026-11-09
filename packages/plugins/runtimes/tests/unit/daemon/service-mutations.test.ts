/**
 * `deriveAccountChange`: the one function that turns a named intent into the next account model, the files it writes
 * and the sentences the person approving it reads. Every refusal is a sentence that names what to do instead.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AccountChangeFacts,
  deriveAccountChange,
  FleetMutationRefusal,
  isAccountPlanChange,
  isLoginAccountChange,
} from '../../../daemon/lib/service/mutations.ts';
import { type AccountModel, type AccountModelDocument, parseAccountModel } from '../../../daemon/lib/account/schema.ts';

const FACTS: AccountChangeFacts = { machineName: 'box', runningSessions: 0 };

/** A base document; `patch` overrides whole top-level keys. */
const documentOf = (patch: Partial<AccountModelDocument> = {}): AccountModelDocument => ({
  version: 1,
  credentials: {
    'claude-a': { harness: 'claude', store: 'ferretry' },
    'claude-b': { harness: 'claude', store: 'ferretry' },
    'codex-a': { harness: 'codex', store: 'ferretry' },
    both: {
      harness: 'claude',
      store: 'environment',
      claude: { env: { ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic' } },
      codex: { env: { OPENAI_BASE_URL: 'https://example.invalid/openai' } },
    },
  },
  components: {
    instructions: { notes: { file: 'components/instructions/notes.md' } },
    mcp: { srv: { command: 'srv-bin', args: ['--x'] } },
    skills: { sk: { items: ['sk'] } },
    settings: {
      'cl-settings': { harness: 'claude', file: 'components/settings/cl-settings.json', env: { KEPT: 'old' } },
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
    'claude-only': { layers: ['settings/cl-settings'] },
    'codex-only': { layers: ['modelSets/codex-set'] },
    mixed: { layers: ['settings/cl-settings', 'modelSets/codex-set'] },
    'cx-twice': { layers: ['settings/cx-settings'] },
  },
  runtimes: {
    'claude-default': { credential: 'claude-a', profile: 'plain', agent: true, clonedFromKey: 'k1' },
    second: { credential: 'claude-b', profile: 'derived', agent: true },
    'codex-run': { credential: 'codex-a', profile: 'codex-only', agent: true },
    'dual-run': { credential: 'both', profile: 'claude-only', agent: true },
  },
  ...patch,
  machine: {
    ...(patch.runtimes === undefined || 'claude-default' in patch.runtimes ? { defaultRuntime: 'claude-default' } : {}),
    ...patch.machine,
  },
});

const modelOf = (patch: Partial<AccountModelDocument> = {}): AccountModel => parseAccountModel(documentOf(patch));

type Change = Parameters<typeof deriveAccountChange>[1];

const derive = (change: object, facts: Partial<AccountChangeFacts> = {}, model: AccountModel = modelOf()) =>
  deriveAccountChange(model, change as Change, { ...FACTS, ...facts });

/** The sentence a change is refused with. */
const refusalOf = (
  change: object,
  facts: Partial<AccountChangeFacts> = {},
  model: AccountModel = modelOf(),
): string => {
  try {
    derive(change, facts, model);
  } catch (error) {
    should(error).be.instanceOf(FleetMutationRefusal);
    should((error as Error).name).equal('FleetMutationRefusal');
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('change classification', () => {
  it('should hand every credential change to Logins and keep setup and clone out of the plan', () => {
    should(isLoginAccountChange({ kind: 'credential.remove' } as never)).be.true();
    should(isLoginAccountChange({ kind: 'runtime.put' } as never)).be.false();
    should(isAccountPlanChange({ kind: 'runtime.put' } as never)).be.true();
    should(isAccountPlanChange({ kind: 'setup.import' } as never)).be.false();
    should(isAccountPlanChange({ kind: 'clone.import' } as never)).be.false();
    should(isAccountPlanChange({ kind: 'credential.label' } as never)).be.false();
  });
});

describe('runtime.put', () => {
  const put = (over: object = {}) => ({
    kind: 'runtime.put',
    name: 'fresh',
    create: true,
    credential: 'claude-b',
    profile: 'plain',
    agent: true,
    ...over,
  });

  it('should add a runtime and say it was added', () => {
    const edit = derive(put());
    should(edit.summary).equal('Add runtime fresh');
    should(edit.model.runtimes.fresh).containEql({ credential: 'claude-b', profile: 'plain', agent: true });
    should(edit.consequences).eql([]);
    should(edit.files).eql([]);
  });

  it('should suggest the nearest slug for a name outside the grammar', () => {
    should(refusalOf(put({ name: 'Bad Name!' }))).match(/^Use only letters, digits and dashes\. Use .+\?$/u);
  });

  it('should suggest the next free name for one that is taken, by a runtime or by a command', () => {
    should(refusalOf(put({ name: 'second' }))).equal('second is already a runtime on box. Use second-2?');
    const commands = {
      advanced: { commands: [{ wrapper: 'wrapped', runtime: 'second', flags: [] }] },
    } as Partial<AccountModelDocument>;
    should(refusalOf(put({ name: 'wrapped' }), {}, modelOf(commands))).equal(
      'wrapped is already a runtime on box. Use wrapped-2?',
    );
  });

  it('should refuse changing a runtime that does not exist', () => {
    should(refusalOf(put({ name: 'ghost', create: false }))).equal('no runtime ghost exists on this machine');
  });

  it('should refuse a login or a profile that does not exist', () => {
    should(refusalOf(put({ credential: 'nope' }))).equal('no login nope exists on this machine');
    should(refusalOf(put({ profile: 'nope' }))).equal('no profile nope exists on this machine');
  });

  it('should refuse a CLI the login does not drive', () => {
    should(refusalOf(put({ harness: 'codex' }))).equal('claude-b does not drive Codex: it is a Claude Code login.');
  });

  it('should refuse a profile scoped to the other CLI, saying how for a single-CLI login and a dual one', () => {
    should(refusalOf(put({ profile: 'codex-only' }))).match(
      /^Profile codex-only is Codex only and claude-b is a Claude Code login\. Pick a Generic or Claude only profile\.$/u,
    );
    should(refusalOf(put({ credential: 'both', harness: 'claude-code', profile: 'codex-only' }))).match(
      /^Profile codex-only is Codex only and this runtime runs Claude Code on both\. Run it on the other CLI, or pick a Generic or Claude only profile\.$/u,
    );
  });

  it('should refuse moving a runtime onto a profile that is already mixed, and allow one already on it', () => {
    should(refusalOf(put({ profile: 'mixed' }))).match(/can't be both Claude only and Codex only/u);
  });

  it('should refuse a profile with nothing for the login to run', () => {
    const model = modelOf({
      profiles: { ...documentOf().profiles, empty: { layers: [] } },
    });
    should(refusalOf(put({ profile: 'empty' }), {}, model)).equal(
      'Nothing in profile empty applies on Claude Code. Pick a different profile.',
    );
  });

  it('should ask before adding a twin of a runtime, and say so once it is allowed', () => {
    should(refusalOf(put({ credential: 'claude-a', profile: 'plain' }))).equal(
      'claude-default already uses this login and profile. Add another anyway?',
    );
    const model = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        'claude-twin': { credential: 'claude-a', profile: 'plain', agent: true },
      },
    });
    should(refusalOf(put({ credential: 'claude-a', profile: 'plain' }), {}, model)).equal(
      'claude-default and claude-twin already use this login and profile. Add another anyway?',
    );
    const allowed = derive(put({ credential: 'claude-a', profile: 'plain', addAnother: true }), {}, model);
    should(allowed.consequences).eql(['claude-default and claude-twin already use this login and profile.']);
    const single = derive(put({ credential: 'claude-a', profile: 'plain', addAnother: true }));
    should(single.consequences).eql(['claude-default already uses this login and profile.']);
  });

  it('should keep what an edit does not own: disabled, compactAt, clone provenance and the CLI pin', () => {
    const model = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        'claude-default': {
          credential: 'claude-a',
          profile: 'plain',
          agent: true,
          disabled: { reason: 'budget' },
          compactAt: 200000,
          clonedFromKey: 'origin-1',
        },
      },
    });
    const edit = derive(
      {
        kind: 'runtime.put',
        name: 'claude-default',
        create: false,
        credential: 'claude-b',
        profile: 'base',
        agent: true,
        harness: 'claude-code',
      },
      {},
      model,
    );
    should(edit.summary).equal('Change runtime claude-default');
    should(edit.model.runtimes['claude-default']).containEql({
      credential: 'claude-b',
      profile: 'base',
      harness: 'claude',
      disabled: { reason: 'budget' },
      compactAt: 200000,
      clonedFromKey: 'origin-1',
    });
    should(edit.consequences).eql(['Running sessions keep the old setup until restarted.']);
  });

  it('should make the first agent runtime the default for new agents', () => {
    const model = modelOf({ runtimes: {} });
    const edit = derive(put({ name: 'first' }), {}, model);
    should(edit.model.machine.defaultRuntime).equal('first');
    should(edit.consequences).eql(["first is now this machine's default runtime for new agents."]);
    const notAgent = derive(put({ name: 'plainer', agent: false }), {}, model);
    should(notAgent.model.machine.defaultRuntime).be.undefined();
  });
});

describe('runtime.remove', () => {
  it('should remove a runtime and say what happens to sessions on it, as exactly as it knows', () => {
    const unknown = derive({ kind: 'runtime.remove', name: 'second' });
    should(unknown.summary).equal('Remove runtime second');
    should(unknown.model.runtimes.second).be.undefined();
    should(unknown.consequences).eql([
      'Running sessions of it keep going until they end. Its past sessions stay in history.',
    ]);
    should(derive({ kind: 'runtime.remove', name: 'second' }, { runningOn: [] }).consequences).eql([
      'Nothing is running on it. Its past sessions stay in history.',
    ]);
    const one = { id: 's1' } as never;
    should(derive({ kind: 'runtime.remove', name: 'second' }, { runningOn: [one] }).consequences).eql([
      '1 ferret is running on it. It keeps running, but restarting it later needs another runtime. Its past sessions stay in history.',
    ]);
    should(derive({ kind: 'runtime.remove', name: 'second' }, { runningOn: [one, one] }).consequences).eql([
      '2 ferrets are running on it. They keep running, but restarting them later needs another runtime. Its past sessions stay in history.',
    ]);
  });

  it('should refuse a runtime that is not there and the machine default', () => {
    should(refusalOf({ kind: 'runtime.remove', name: 'ghost' })).equal('no runtime ghost exists on this machine');
    should(refusalOf({ kind: 'runtime.remove', name: 'claude-default' })).equal(
      "claude-default is this machine's default runtime for new agents. Pick another default first.",
    );
  });
});

describe('runtime.rename', () => {
  const rename = (over: object = {}) => ({ kind: 'runtime.rename', name: 'second', to: 'third', ...over });

  it('should rename a runtime and say nothing restarts', () => {
    const edit = derive(rename());
    should(edit.summary).equal('Rename runtime second to third');
    should(edit.model.runtimes.third).not.be.undefined();
    should(edit.model.runtimes.second).be.undefined();
    should(edit.consequences).eql(
      [
        'Running ferrets keep working — nothing restarts.',
        '`second keeps starting it: `--agent second` still works.',
      ].map(line => line.replace('`second keeps', 'second keeps')),
    );
  });

  it('should carry the default runtime and each command that runs it to the new name', () => {
    const model = modelOf({
      advanced: {
        commands: [
          { wrapper: 'w1', runtime: 'claude-default', flags: [] },
          { wrapper: 'w2', runtime: 'second', flags: [] },
        ],
      },
    });
    const edit = derive(rename({ name: 'claude-default', to: 'main' }), {}, model);
    should(edit.model.machine.defaultRuntime).equal('main');
    should(edit.consequences[0]).equal("main stays this machine's default runtime for new agents.");
    should(edit.consequences[1]).equal('w1 runs main from now on.');
    const both = modelOf({
      advanced: {
        commands: [
          { wrapper: 'w1', runtime: 'second', flags: [] },
          { wrapper: 'w2', runtime: 'second', flags: [] },
          { wrapper: 'w3', runtime: 'claude-default', flags: [] },
        ],
      },
    });
    const many = derive(rename(), {}, both);
    should(many.consequences[0]).equal('w1 and w2 run third from now on.');
    should(many.model.advanced.commands.map(command => command.runtime)).eql(['third', 'third', 'claude-default']);
  });

  it('should refuse an unknown runtime, a no-op, a taken name and a name another runtime once had', () => {
    should(refusalOf(rename({ name: 'ghost' }))).equal('no runtime ghost exists on this machine');
    should(refusalOf(rename({ to: 'second' }))).equal('second is already called second.');
    should(refusalOf(rename({ to: 'claude-default' }))).equal(
      'claude-default is already a runtime on box. Use claude-default-2?',
    );
    should(refusalOf(rename({ to: 'old-name' }), { runtimeReferences: { 'old-name': 'codex-run' } })).equal(
      'old-name is already a runtime on box. Use old-name-2?',
    );
  });

  it('should let a runtime take back a name it had before', () => {
    const edit = derive(rename({ to: 'old-name' }), { runtimeReferences: { 'old-name': 'second' } });
    should(edit.model.runtimes['old-name']).not.be.undefined();
  });
});

describe('runtime.disable and runtime.enable', () => {
  it('should disable a runtime with only what the caller said', () => {
    const both = derive({ kind: 'runtime.disable', name: 'second', reason: 'spend', until: '2026-12-01' });
    should(both.model.runtimes.second?.disabled).eql({ reason: 'spend', until: '2026-12-01' });
    should(both.summary).equal('Disable runtime second');
    should(both.consequences).eql([
      'Nothing running is stopped: ferrets already on this runtime keep going. New starts on it are refused.',
    ]);
    should(derive({ kind: 'runtime.disable', name: 'second' }).model.runtimes.second?.disabled).eql({});
    should(refusalOf({ kind: 'runtime.disable', name: 'ghost' })).equal('no runtime ghost exists on this machine');
  });

  it('should enable a runtime, and warn when its login is still off', () => {
    const model = modelOf({
      credentials: { ...documentOf().credentials, 'claude-b': { harness: 'claude', store: 'ferretry', disabled: {} } },
      runtimes: {
        ...documentOf().runtimes,
        second: { credential: 'claude-b', profile: 'derived', agent: true, disabled: { reason: 'x' } },
      },
    });
    const edit = derive({ kind: 'runtime.enable', name: 'second' }, {}, model);
    should(edit.summary).equal('Enable runtime second');
    should(edit.model.runtimes.second?.disabled).be.undefined();
    should(edit.consequences).eql([
      'Its login claude-b is still disabled, so second stays off until that is enabled too.',
    ]);
    should(derive({ kind: 'runtime.enable', name: 'second' }).consequences).eql([]);
    should(refusalOf({ kind: 'runtime.enable', name: 'ghost' })).equal('no runtime ghost exists on this machine');
  });
});

describe('profile.put', () => {
  const put = (over: object = {}) => ({
    kind: 'profile.put',
    name: 'fresh',
    create: true,
    layers: ['mcp/srv'],
    ...over,
  });

  it('should add a profile', () => {
    const edit = derive(put());
    should(edit.summary).equal('Add profile fresh');
    should(edit.model.profiles.fresh?.layers).eql(['mcp/srv']);
    should(edit.consequences).eql([]);
  });

  it('should refuse a taken name, a missing profile and bad layers', () => {
    should(refusalOf(put({ name: 'plain' }))).equal('plain is already a profile on box. Use plain-2?');
    should(refusalOf(put({ name: 'ghost', create: false }))).equal('no profile ghost exists on this machine');
    should(refusalOf(put({ layers: ['mcp/ghost'] })))
      .be.a.String()
      .and.not.empty();
  });

  it('should keep compactAt and provenance of a profile it changes, and say who is affected', () => {
    const model = modelOf({
      profiles: {
        ...documentOf().profiles,
        plain: { layers: ['instructions/notes'], compactAt: 'auto', clonedFromKey: 'p1' },
      },
    });
    const edit = derive(put({ name: 'plain', create: false, layers: ['mcp/srv'] }), {}, model);
    should(edit.summary).equal('Change the layers of profile plain');
    should(edit.model.profiles.plain).containEql({ layers: ['mcp/srv'], compactAt: 'auto', clonedFromKey: 'p1' });
    should(edit.consequences.length).equal(1);
    should(edit.consequences[0]).match(/^Used by /u);
  });

  it('should say nothing about use when nothing uses the profile', () => {
    const edit = derive(put({ name: 'mixed', create: false, layers: ['mcp/srv'] }));
    should(edit.consequences).eql([]);
  });
});

describe('profile.remove', () => {
  const remove = (over: object = {}) => ({ kind: 'profile.remove', name: 'mixed', ...over });

  it('should delete a profile nothing uses', () => {
    const edit = derive(remove());
    should(edit.summary).equal('Delete profile mixed');
    should(edit.model.profiles.mixed).be.undefined();
    should(edit.consequences).eql(['Its components stay saved.']);
  });

  it('should refuse a profile that is not there', () => {
    should(refusalOf(remove({ name: 'ghost' }))).equal('no profile ghost exists on this machine');
  });

  it('should refuse a profile that is a base, until it is removed from the profiles built on it', () => {
    should(refusalOf(remove({ name: 'base' }))).equal(
      'Profile base is a base for derived. Remove it from that profile first.',
    );
    const twoBases = modelOf({
      profiles: { ...documentOf().profiles, another: { layers: ['profile/base', 'mcp/srv'] } },
    });
    should(refusalOf(remove({ name: 'base' }), {}, twoBases)).equal(
      'Profile base is a base for another and derived. Remove it from those profiles first.',
    );
  });

  it('should remove a base from its profiles and say which runtimes that changes', () => {
    const edit = derive(remove({ name: 'base', removeFromProfiles: true, switchRuntimesTo: 'plain' }));
    should(edit.model.profiles.derived?.layers).eql(['mcp/srv']);
    should(edit.model.runtimes.second?.profile).equal('derived');
    should(edit.consequences[0]).equal(
      'Removes it from derived, which changes 1 runtime. Running sessions keep the old version until restarted.',
    );
    const idle = derive(
      remove({ name: 'base', removeFromProfiles: true }),
      {},
      modelOf({
        runtimes: { ...documentOf().runtimes, second: { credential: 'claude-b', profile: 'plain', agent: true } },
      }),
    );
    should(idle.consequences[0]).equal(
      'Removes it from derived. Running sessions keep the old version until restarted.',
    );
  });

  it('should refuse removing a base that is the only layer of a profile built on it', () => {
    const model = modelOf({ profiles: { ...documentOf().profiles, solo: { layers: ['profile/base'] } } });
    should(refusalOf(remove({ name: 'base', removeFromProfiles: true }), {}, model)).equal(
      'removing profile base would leave profile solo with no layers; add another layer to it first',
    );
  });

  it('should move the runtimes on a profile to another one, and refuse every way that cannot work', () => {
    const used = remove({ name: 'plain' });
    should(refusalOf(used)).equal('1 runtime uses profile plain (claude-default). Pick the profile it switches to.');
    const model = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        'claude-twin': { credential: 'claude-b', profile: 'plain', agent: true },
      },
    });
    should(refusalOf(used, {}, model)).equal(
      '2 runtimes use profile plain (claude-default and claude-twin). Pick the profile they switch to.',
    );
    should(refusalOf({ ...used, switchRuntimesTo: 'plain' })).equal('pick a profile other than plain to switch to');
    should(refusalOf({ ...used, switchRuntimesTo: 'ghost' })).equal('no profile ghost exists on this machine');
    const edit = derive({ ...used, switchRuntimesTo: 'claude-only' });
    should(edit.summary).equal('Switch 1 runtime and delete profile plain');
    should(edit.model.runtimes['claude-default']?.profile).equal('claude-only');
    should(edit.consequences).eql(['Switches 1 runtime to claude-only.', 'Its components stay saved.']);
  });
});

describe('component.remove', () => {
  const remove = (over: object = {}) => ({
    kind: 'component.remove',
    componentKind: 'skills',
    name: 'sk',
    ...over,
  });

  it('should delete a component nothing uses', () => {
    const edit = derive(remove());
    should(edit.summary).equal('Delete skills sk');
    should(edit.model.components.skills.sk).be.undefined();
    should(edit.consequences).eql([]);
  });

  it('should refuse a component that is not there', () => {
    should(refusalOf(remove({ name: 'ghost' }))).equal('no skills ghost exists on this machine');
  });

  it('should refuse a component a profile layers, naming the profiles and the runtimes behind them', () => {
    should(refusalOf(remove({ componentKind: 'mcp', name: 'srv' }))).equal(
      'MCP server srv is a layer in derived (used by second). Remove it from those first.',
    );
    const unused = modelOf({
      profiles: { ...documentOf().profiles, loose: { layers: ['skills/sk', 'mcp/srv'] } },
    });
    should(refusalOf(remove(), {}, unused)).equal('Skills sk is a layer in loose. Remove it from those first.');
  });

  it('should take a component out of its profiles when asked, and say what changes', () => {
    const edit = derive(remove({ componentKind: 'mcp', name: 'srv', removeFromProfiles: true }));
    should(edit.model.profiles.derived?.layers).eql(['profile/base']);
    should(edit.consequences).eql([
      'Removes it from derived, which changes 1 runtime. Running sessions keep the old version until restarted.',
    ]);
    const unused = modelOf({
      profiles: { ...documentOf().profiles, loose: { layers: ['skills/sk', 'mcp/srv'] } },
    });
    const quiet = derive(remove({ removeFromProfiles: true }), {}, unused);
    should(quiet.consequences).eql(['Removes it from loose. Running sessions keep the old version until restarted.']);
  });

  it('should refuse leaving a profile with no layers', () => {
    const model = modelOf({ profiles: { ...documentOf().profiles, solo: { layers: ['skills/sk'] } } });
    should(refusalOf(remove({ removeFromProfiles: true }), {}, model)).equal(
      'removing skills sk would leave profile solo with no layers; add another layer to it first',
    );
  });
});

describe('component.put', () => {
  const put = (component: object, over: object = {}) => ({
    kind: 'component.put',
    name: 'fresh',
    create: true,
    component,
    ...over,
  });

  it('should add an instructions component that keeps its text in its own item', () => {
    const edit = derive(put({ kind: 'instructions' }, { content: '# hi' }));
    should(edit.summary).equal('Add instructions fresh');
    should(edit.files).eql([]);
    should(edit.model.components.instructions.fresh).containEql({ text: '# hi' });
  });

  it('should refuse instructions with no text, and keep the file an existing one has when only fields change', () => {
    should(refusalOf(put({ kind: 'instructions' }))).equal('instructions fresh needs its text');
    const edit = derive(put({ kind: 'instructions', harness: 'claude-code' }, { name: 'notes', create: false }));
    should(edit.summary).equal('Change instructions notes');
    should(edit.files).eql([]);
    should(edit.model.components.instructions.notes).containEql({
      file: 'components/instructions/notes.md',
      harness: 'claude',
    });
  });

  it('should refuse a taken name and a missing component', () => {
    should(refusalOf(put({ kind: 'instructions' }, { name: 'notes', content: 'x' }))).equal(
      'notes is already a instructions on box. Use notes-2?',
    );
    should(refusalOf(put({ kind: 'instructions' }, { name: 'ghost', create: false, content: 'x' }))).equal(
      'no instructions ghost exists on this machine',
    );
  });

  it('should refuse text for a kind that has none', () => {
    should(refusalOf(put({ kind: 'skills', items: ['sk'] }, { content: 'text' }))).equal(
      'a skills has no text to save; send its fields instead',
    );
  });

  it('should add an MCP server, keeping the sign-in a hand-registered client has', () => {
    const edit = derive(
      put({ kind: 'mcp', command: 'run', args: ['a'], env: { MODE: 'fast' }, harness: 'claude-code' }),
    );
    should(edit.model.components.mcp.fresh).containEql({
      command: 'run',
      args: ['a'],
      env: { MODE: 'fast' },
      harness: 'claude',
    });
    const model = modelOf({
      components: {
        ...documentOf().components,
        mcp: {
          srv: { command: 'srv-bin' },
          remote: {
            url: 'https://example.invalid/mcp',
            auth: 'oauth',
            oauth: { clientId: 'client-1' },
          },
        },
      },
      profiles: { only: { layers: ['instructions/notes'] } },
      runtimes: {},
    });
    const kept = derive(
      put({ kind: 'mcp', url: 'https://example.invalid/mcp2', auth: 'oauth' }, { name: 'remote', create: false }),
      {},
      model,
    );
    should(kept.model.components.mcp.remote).containEql({
      url: 'https://example.invalid/mcp2',
      auth: 'oauth',
      oauth: { clientId: 'client-1' },
    });
    should(kept.consequences).eql([]);
    const added = derive(put({ kind: 'mcp', url: 'https://example.invalid/mcp3', auth: 'oauth' }));
    should(added.model.components.mcp.fresh).not.have.property('oauth');
  });

  it('should keep an env value the caller says to keep, and refuse a missing or secret-looking one', () => {
    const model = modelOf({
      components: {
        ...documentOf().components,
        mcp: { srv: { command: 'srv-bin', env: { MODE: 'old' } } },
      },
      profiles: { only: { layers: ['instructions/notes'] } },
      runtimes: {},
    });
    const kept = derive(
      put({ kind: 'mcp', command: 'srv-bin', env: { MODE: { keep: true } } }, { name: 'srv', create: false }),
      {},
      model,
    );
    should(kept.model.components.mcp.srv?.env).eql({ MODE: 'old' });
    should(
      refusalOf(
        put({ kind: 'mcp', command: 'x', env: { OTHER: { keep: true } } }, { name: 'srv', create: false }),
        {},
        model,
      ),
    ).equal('MCP server srv has no value for OTHER to keep; type one');
    should(
      refusalOf(put({ kind: 'mcp', command: 'x', env: { API_TOKEN: 'abcdefghijklmnopqrstuvwxyz0123456789' } })),
    ).match(/^API_TOKEN looks like a secret, and a secret never sits in a component\./u);
    const noEnv = derive(put({ kind: 'mcp', command: 'x', env: {} }));
    should(noEnv.model.components.mcp.fresh).not.have.property('env');
  });

  it('should add skills and model sets', () => {
    should(derive(put({ kind: 'skills', items: ['one', 'two'] })).model.components.skills.fresh?.items).eql([
      'one',
      'two',
    ]);
    const set = derive(put({ kind: 'modelSets', models: ['m1', 'm2'], default: 'm2' }));
    should(set.model.components.modelSets.fresh).containEql({ models: ['m1', 'm2'], default: 'm2' });
  });

  it('should add settings from text, flags and env', () => {
    const edit = derive(
      put({ kind: 'settings', harness: 'claude-code', flags: ['--fast'], env: { MODE: 'x' } }, { content: '{"a":1}' }),
    );
    should(edit.files).eql([{ file: 'components/settings/fresh.json', content: '{"a":1}' }]);
    should(edit.model.components.settings.fresh).containEql({
      harness: 'claude',
      file: 'components/settings/fresh.json',
      flags: ['--fast'],
      env: { MODE: 'x' },
    });
    const toml = derive(put({ kind: 'settings', harness: 'codex' }, { content: 'a = 1' }));
    should(toml.files[0]?.file).equal('components/settings/fresh.toml');
    const empty = derive(put({ kind: 'settings', harness: 'codex', flags: [], env: { A: 'b' } }));
    should(empty.model.components.settings.fresh).not.have.property('flags');
  });

  it('should refuse settings text that is not a valid document', () => {
    should(refusalOf(put({ kind: 'settings', harness: 'claude-code' }, { content: '{nope' }))).match(
      /^the settings fresh text is not valid JSON: /u,
    );
    should(refusalOf(put({ kind: 'settings', harness: 'codex' }, { content: 'a = = 1' }))).match(
      /^the settings fresh text is not valid TOML: /u,
    );
  });

  it('should build settings from entries, nesting dotted keys and keeping a value the file has', () => {
    const edit = derive(
      put(
        {
          kind: 'settings',
          harness: 'claude-code',
          entries: {
            'permissions.defaultMode': { value: 'plan' },
            model: { value: 'opus' },
            count: { value: 3 },
            'permissions.keepMe': { keep: true },
          },
        },
        { name: 'cl-settings', create: false },
      ),
      { settingsBodies: { 'cl-settings': { permissions: { keepMe: 'yes' } } } },
    );
    should(JSON.parse(edit.files[0]?.content ?? '')).eql({
      count: 3,
      model: 'opus',
      permissions: { defaultMode: 'plan', keepMe: 'yes' },
    });
    should(edit.consequences.length).equal(1);
  });

  it('should refuse settings entries that cannot be built', () => {
    const entries = (value: object) =>
      put({ kind: 'settings', harness: 'claude-code', entries: value }, { name: 'cl-settings', create: false });
    should(refusalOf(entries({ 'a..b': { value: 1 } }))).equal(
      'settings cl-settings cannot have a setting named "a..b"',
    );
    should(refusalOf(entries({ gone: { keep: true } }))).equal(
      'settings cl-settings has no value for gone to keep; type one',
    );
    should(
      refusalOf(entries({ gone: { keep: true } }), { settingsBodies: { 'cl-settings': { gone: undefined } } }),
    ).match(/has no value for gone to keep/u);
    should(refusalOf(entries({ 'a.b': { keep: true } }), { settingsBodies: { 'cl-settings': { a: [1] } } })).match(
      /has no value for a\.b to keep/u,
    );
    should(refusalOf(entries({ 'a.b': { keep: true } }), { settingsBodies: { 'cl-settings': { a: null } } })).match(
      /has no value for a\.b to keep/u,
    );
    should(refusalOf(entries({ API_TOKEN: { value: 'abcdefghijklmnopqrstuvwxyz0123456789' } }))).match(
      /^API_TOKEN looks like a secret/u,
    );
    should(refusalOf(entries({ API_TOKEN: { value: { nested: 'abcdefghijklmnopqrstuvwxyz0123456789' } } }))).match(
      /^API_TOKEN looks like a secret/u,
    );
    should(refusalOf(entries({ a: { value: 1 }, 'a.b': { value: 2 } }))).equal(
      'settings cl-settings sets a and a setting inside it',
    );
  });

  it('should refuse sending settings as text and as entries together', () => {
    should(
      refusalOf(put({ kind: 'settings', harness: 'claude-code', entries: { a: { value: 1 } } }, { content: '{}' })),
    ).equal('send settings fresh as its text or as its entries, not both');
  });

  it('should add hooks from a document, keep a scripts directory, and refuse hooks with nothing', () => {
    const edit = derive(put({ kind: 'hooks', harness: 'claude-code' }, { content: '{"hooks":{}}' }));
    should(edit.files).eql([{ file: 'components/hooks/fresh.json', content: '{"hooks":{}}' }]);
    should(edit.model.components.hooks.fresh).containEql({ harness: 'claude', file: 'components/hooks/fresh.json' });
    const directory = derive(put({ kind: 'hooks', harness: 'claude-code' }, { name: 'dir-hooks', create: false }));
    should(directory.model.components.hooks['dir-hooks']).eql({
      harness: 'claude',
      directory: 'components/hooks/dir-hooks',
    });
    const keptFile = derive(put({ kind: 'hooks', harness: 'claude-code' }, { name: 'cl-hooks', create: false }));
    should(keptFile.files).eql([]);
    should(keptFile.model.components.hooks['cl-hooks']).containEql({ file: 'components/hooks/cl-hooks.json' });
    should(refusalOf(put({ kind: 'hooks', harness: 'claude-code' }))).equal('hooks fresh needs its hooks document');
    should(refusalOf(put({ kind: 'hooks', harness: 'claude-code' }, { content: '{bad' }))).match(
      /^the hooks fresh text is not valid JSON: /u,
    );
    const replaced = derive(
      put({ kind: 'hooks', harness: 'claude-code' }, { name: 'dir-hooks', create: false, content: '{}' }),
    );
    should(replaced.model.components.hooks['dir-hooks']).containEql({ file: 'components/hooks/dir-hooks.json' });
  });

  it('should carry the provenance of a component it rebuilds, and say who it touches', () => {
    const model = modelOf({
      components: {
        ...documentOf().components,
        mcp: { srv: { command: 'srv-bin', clonedFrom: 'src', clonedFromDaemon: 'd1', clonedFromKey: 'k' } },
      },
    });
    const edit = derive(put({ kind: 'mcp', command: 'srv-bin2' }, { name: 'srv', create: false }), {}, model);
    should(edit.model.components.mcp.srv).containEql({ clonedFrom: 'src', clonedFromDaemon: 'd1', clonedFromKey: 'k' });
    should(edit.consequences.length).equal(1);
  });
});

describe('catalog.install', () => {
  const origin = {
    publisher: 'pub-1',
    publisherName: 'Acme',
    catalogId: 'cat-1',
    catalogName: 'Acme catalog',
    itemId: 'item-1',
    kind: 'mcp' as const,
    name: 'tool',
    version: 1,
    digest: `sha256:${'0'.repeat(64)}`,
  };
  const install = (over: object = {}) => ({
    kind: 'catalog.install',
    name: 'tool',
    profile: 'plain',
    replace: false,
    installedFrom: origin,
    component: { kind: 'mcp', command: 'tool-bin' },
    files: [],
    ...over,
  });
  const skill = (over: object = {}) =>
    install({
      name: 'sk2',
      component: { kind: 'skills', items: ['sk2'] },
      files: [{ path: 'SKILL.md', content: '# skill' }],
      ...over,
    });

  it('should install an MCP server into a profile and say it becomes a layer', () => {
    const edit = derive(install());
    should(edit.summary).equal('Install MCP server tool from Acme');
    should(edit.model.components.mcp.tool).containEql({ command: 'tool-bin' });
    should(edit.model.components.mcp.tool?.installedFrom).containEql({
      publisher: 'pub-1',
      catalogId: 'cat-1',
      itemId: 'item-1',
    });
    should(edit.model.profiles.plain?.layers).eql(['instructions/notes', 'mcp/tool']);
    should(edit.consequences).eql([
      'It becomes a layer of profile plain, so every runtime on that profile gets it the next time it starts.',
    ]);
  });

  it('should install a skill with its files under the skills store', () => {
    const edit = derive(skill());
    should(edit.summary).equal('Install skills sk2 from Acme');
    should(edit.files.length).equal(1);
    should(edit.files[0]?.content).equal('# skill');
    should(edit.files[0]?.file.endsWith('/SKILL.md')).be.true();
  });

  it('should refuse a skill file that lands outside its folder', () => {
    for (const path of ['', '../escape.md', 'a/../../x', '.']) {
      should(refusalOf(skill({ files: [{ path, content: 'x' }] }))).match(
        /is not a file inside the skill's own folder$/u,
      );
    }
  });

  it('should refuse a skill that is not the one folder carrying its name', () => {
    should(refusalOf(skill({ component: { kind: 'skills', items: ['other'] } }))).equal(
      'a skill installed from a catalog is the one folder that carries its name',
    );
  });

  it('should refuse a profile that is not there', () => {
    should(refusalOf(install({ profile: 'ghost' }))).equal('no profile ghost exists on this machine');
  });

  it('should refuse a name that is taken, replacing something nothing installed, and replacing nothing', () => {
    should(refusalOf(install({ name: 'srv' }))).equal(
      'srv is already a MCP server on box, and no install of this item put it there',
    );
    should(refusalOf(install({ name: 'srv', replace: true }))).equal(
      'srv is a MCP server on box that this item did not install',
    );
    should(refusalOf(install({ replace: true }))).equal('no MCP server tool exists to replace');
  });

  it('should replace the very item an earlier install put there, and keep it as a layer once', () => {
    const model = modelOf({
      components: {
        ...documentOf().components,
        mcp: { srv: { command: 'srv-bin' }, tool: { command: 'old', installedFrom: origin } },
      },
      profiles: { ...documentOf().profiles, plain: { layers: ['instructions/notes', 'mcp/tool'] } },
    });
    const edit = derive(install({ replace: true }), {}, model);
    should(edit.summary).equal('Replace MCP server tool from Acme');
    should(edit.model.profiles.plain?.layers).eql(['instructions/notes', 'mcp/tool']);
    should(edit.consequences.length).equal(2);
    should(edit.consequences[0]).match(/^Used by /u);
    for (const other of [{ itemId: 'other' }, { publisher: 'pub-2' }, { catalogId: 'cat-2' }]) {
      should(refusalOf(install({ replace: true, installedFrom: { ...origin, ...other } }), {}, model)).equal(
        'tool is a MCP server on box that this item did not install',
      );
    }
  });
});

describe('credential.remove (the Runtimes half)', () => {
  const remove = (over: object = {}) => ({ kind: 'credential.remove', id: 'claude-b', ...over });

  it('should refuse a login that is not there', () => {
    should(refusalOf(remove({ id: 'ghost' }))).equal('no login ghost exists on this machine');
  });

  it('should leave a login nothing uses as it is', () => {
    const edit = derive(remove({ id: 'codex-a', removeRuntimes: ['codex-run'] }));
    should(edit.summary).equal('Remove login codex-a, removing 1 runtime');
  });

  it('should say a login nothing runs on is removed plainly', () => {
    const model = modelOf({
      credentials: { ...documentOf().credentials, idle: { harness: 'claude', store: 'ferretry' } },
    });
    const edit = derive(remove({ id: 'idle' }), {}, model);
    should(edit.summary).equal('Remove login idle');
    should(edit.consequences).eql([]);
  });

  it('should refuse naming a runtime that does not use the login, or both switching and removing one', () => {
    should(refusalOf(remove({ removeRuntimes: ['claude-default'] }))).equal(
      'runtime claude-default does not use login claude-b, so this change cannot move it',
    );
    should(refusalOf(remove({ switchRuntimes: { 'claude-default': 'claude-a' } }))).equal(
      'runtime claude-default does not use login claude-b, so this change cannot move it',
    );
    should(refusalOf(remove({ removeRuntimes: ['second'], switchRuntimes: { second: 'claude-a' } }))).equal(
      'runtime second cannot be both switched and removed',
    );
  });

  it('should refuse switching to the login being removed, to a login that is not there, or to a CLI that cannot drive it', () => {
    should(refusalOf(remove({ switchRuntimes: { second: 'claude-b' } }))).equal(
      'runtime second cannot switch to the login being removed',
    );
    should(refusalOf(remove({ switchRuntimes: { second: 'ghost' } }))).equal('no login ghost exists on this machine');
    should(refusalOf(remove({ switchRuntimes: { second: 'codex-a' } }))).equal(
      'second runs Claude Code, and login codex-a does not drive it. Pick a Claude Code login.',
    );
  });

  it('should switch a runtime to another login and say when it starts with it', () => {
    const edit = derive(remove({ switchRuntimes: { second: 'claude-a' } }));
    should(edit.model.runtimes.second?.credential).equal('claude-a');
    should(edit.summary).equal('Remove login claude-b, switching 1 runtime to claude-a');
    should(edit.consequences).eql(['second moves to login claude-a, starting with it the next time it launches.']);
  });

  it('should say several runtimes move together', () => {
    const model = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        third: { credential: 'claude-b', profile: 'plain', agent: true },
      },
    });
    const edit = derive(remove({ switchRuntimes: { second: 'claude-a', third: 'claude-a' } }), {}, model);
    should(edit.consequences).eql([
      'second and third move to login claude-a, starting with it the next time they launch.',
    ]);
    should(edit.summary).equal('Remove login claude-b, switching 2 runtimes to claude-a');
  });

  it('should remove the runtimes it is told to, and say what happens to their sessions', () => {
    const edit = derive(remove({ removeRuntimes: ['second', 'second'] }), {
      runningByRuntime: { second: [{ id: 's1' } as never] },
    });
    should(edit.model.runtimes.second).be.undefined();
    should(edit.summary).equal('Remove login claude-b, removing 1 runtime');
    should(edit.consequences).eql([
      'Removes 1 runtime: second. Their past sessions stay in history.',
      '1 ferret is running on that runtime. It keeps running, but restarting one on a removed runtime later needs another runtime.',
    ]);
  });

  it('should count ferrets across several runtimes', () => {
    const model = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        third: { credential: 'claude-b', profile: 'plain', agent: true },
      },
    });
    const edit = derive(
      remove({ switchRuntimes: { second: 'claude-a' }, removeRuntimes: ['third'] }),
      { runningByRuntime: { second: [{ id: 's1' } as never], third: [{ id: 's2' } as never] } },
      model,
    );
    should(edit.summary).equal('Remove login claude-b, switching 1 runtime to claude-a and removing 1 runtime');
    should(edit.consequences[edit.consequences.length - 1]).equal(
      '2 ferrets are running on those runtimes. They keep running, but restarting one on a removed runtime later needs another runtime.',
    );
    const switchedOnly = derive(remove({ switchRuntimes: { second: 'claude-a' } }), {
      runningByRuntime: { second: [{ id: 's1' } as never] },
    });
    should(switchedOnly.consequences[1]).equal('1 ferret is running on that runtime. It keeps running.');
  });

  it('should refuse a login a runtime still uses, saying what to do', () => {
    should(refusalOf(remove())).equal('1 runtime still uses this login (second). Move it to another login first.');
    const model = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        third: { credential: 'claude-b', profile: 'plain', agent: true },
        fourth: { credential: 'claude-b', profile: 'plain', agent: true },
      },
    });
    should(refusalOf(remove(), {}, model)).equal(
      '3 runtimes still use this login (fourth, second and third). Move them to another login first.',
    );
    should(refusalOf(remove({ switchRuntimes: { second: 'claude-a' } }), {}, model)).equal(
      '2 runtimes still use this login (fourth and third). Switch them to another login or remove them first.',
    );
    const one = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        third: { credential: 'claude-b', profile: 'plain', agent: true },
      },
    });
    should(refusalOf(remove({ switchRuntimes: { second: 'claude-a' } }), {}, one)).equal(
      '1 runtime still uses this login (third). Switch it to another login or remove it first.',
    );
  });

  it('should need another default before removing the default runtime, and move it when told to', () => {
    const model = modelOf({
      runtimes: {
        ...documentOf().runtimes,
        'claude-default': { credential: 'claude-b', profile: 'plain', agent: true },
        second: { credential: 'claude-a', profile: 'derived', agent: true },
      },
    });
    should(refusalOf(remove({ removeRuntimes: ['claude-default'] }), {}, model)).equal(
      "claude-default is this machine's default runtime for new agents. Pick another default first.",
    );
    should(
      refusalOf(remove({ removeRuntimes: ['claude-default'], defaultRuntime: 'claude-default' }), {}, model),
    ).equal('claude-default is being removed, so it cannot be the new default');
    const edit = derive(remove({ removeRuntimes: ['claude-default'], defaultRuntime: 'second' }), {}, model);
    should(edit.model.machine.defaultRuntime).equal('second');
    should(edit.consequences).containEql("second becomes this machine's default runtime for new agents.");
  });
});

describe('machine.settings', () => {
  const settings = (over: object = {}) => ({
    kind: 'machine.settings',
    agentPermissions: 'auto',
    defaultRuntime: 'claude-default',
    agentControl: { terminals: true, browsers: true, files: true },
    ...over,
  });

  it('should say nothing moved when nothing did', () => {
    const edit = derive(
      settings({
        agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
      }),
    );
    should(edit.summary).equal('Keep machine settings the same');
    should(edit.consequences).eql([]);
  });

  it('should change agent permissions and say how it reaches running sessions', () => {
    const none = derive(settings({ agentPermissions: 'skip' }));
    should(none.summary).equal('Set agent permissions to Skip all permission checks');
    should(none.consequences).eql(['Applies to new sessions.']);
    should(derive(settings({ agentPermissions: 'skip' }), { runningSessions: 1 }).consequences).eql([
      'Applies to new sessions. 1 running session keeps the old mode (Auto mode) until restarted.',
    ]);
    should(derive(settings({ agentPermissions: 'skip' }), { runningSessions: 3 }).consequences).eql([
      'Applies to new sessions. 3 running sessions keep the old mode (Auto mode) until restarted.',
    ]);
  });

  it('should change the default runtime, or put it back to automatic', () => {
    const named = derive(settings({ defaultRuntime: 'second' }));
    should(named.model.machine.defaultRuntime).equal('second');
    should(named.summary).equal('Set the default runtime for new agents to second');
    const automatic = derive(settings({ defaultRuntime: null }));
    should(automatic.model.machine.defaultRuntime).be.undefined();
    should(automatic.summary).equal('Set the default runtime for new agents back to automatic');
  });

  it('should change what agents may control and say which', () => {
    const edit = derive(
      settings({ agentControl: { terminals: false, browsers: true, files: true, ferretrySettings: true } }),
    );
    should(edit.summary).equal('Set what agents may control (terminals off, ferretrySettings on)');
    should(edit.consequences).eql(['Applies to an agent’s next action; nothing already running is interrupted.']);
    should(edit.model.machine.agentControl).containEql({ terminals: false, ferretrySettings: true });
  });

  it('should change the browser mode', () => {
    const edit = derive(settings({ browserMode: 'window' }));
    should(edit.summary).equal('Set the browser mode to Real window');
    should(edit.consequences).eql([
      'Applies the next time the browser starts; a browser already running keeps its mode until it stops.',
    ]);
  });

  it('should set, change and clear the browser proxy', () => {
    const proxy = { url: 'http://proxy.invalid:3128' };
    const set = derive(settings({ browserProxy: proxy }));
    should(set.summary).equal('Set the browser proxy to http://proxy.invalid:3128');
    should(set.model.machine.browserProxy).containEql(proxy);
    should(set.consequences).eql([
      'Applies the next time the browser starts; a browser already running keeps its network route until it stops.',
    ]);
    const withProxy = modelOf({ machine: { browserProxy: proxy } });
    should(derive(settings({ browserProxy: withProxy.machine.browserProxy }), {}, withProxy).summary).equal(
      'Keep machine settings the same',
    );
    const cleared = derive(settings({ browserProxy: null }), {}, withProxy);
    should(cleared.summary).equal('Set the browser proxy off');
    should(cleared.model.machine.browserProxy).be.undefined();
    should(derive(settings({ browserProxy: null })).summary).equal('Keep machine settings the same');
  });

  it('should set browser ports in every spelling', () => {
    should(derive(settings({ browserPorts: 'per-user' })).summary).equal(
      'Set the browser ports to per-user (derived from the user id)',
    );
    const explicit = derive(settings({ browserPorts: { cdp: 9300, relay: 9301, vnc: 5901 } }));
    should(explicit.summary).equal('Set the browser ports to cdp 9300, relay 9301, vnc 5901');
    should(explicit.consequences).eql([
      'Applies the next time the browser or the login window starts; a browser already running keeps its ports until it stops.',
    ]);
    const fixed = modelOf({ machine: { browserPorts: 'per-user' } });
    should(derive(settings({ browserPorts: 'random' }), {}, fixed).summary).equal('Set the browser ports to random');
    should(derive(settings({ browserPorts: 'per-user' }), {}, fixed).summary).equal('Keep machine settings the same');
  });

  it('should set the loopback firewall failure policy', () => {
    const edit = derive(settings({ browserFirewallFailure: 'refuse' }));
    should(edit.summary).equal('Set the loopback firewall failure policy to refuse');
    should(edit.consequences).eql([
      'Applies the next time the browser starts; a browser already running is not stopped.',
    ]);
    should(derive(settings({ browserFirewallFailure: 'warn' })).summary).equal('Keep machine settings the same');
  });

  it('should set auto-resume, agenda mode and the public usage feed', () => {
    const resume = derive(settings({ autoResume: false }));
    should(resume.summary).equal('Set auto-resume after restart off');
    should(resume.consequences).eql(['Applies the next time the daemon starts.']);
    const agenda = derive(settings({ agendaMode: false }));
    should(agenda.summary).equal('Set agenda mode for new ferrets off');
    should(agenda.consequences).eql([
      'Applies to ferrets started after this; ferrets that already exist keep their own switch.',
    ]);
    const on = derive(settings({ publicUsageFeed: true }));
    should(on.summary).equal('Set the public usage feed on');
    should(on.consequences[0]).match(/^Applies at once: any process on this host/u);
    const off = derive(settings({ publicUsageFeed: false }), {}, modelOf({ machine: { publicUsageFeed: true } }));
    should(off.summary).equal('Set the public usage feed off');
    should(off.consequences).eql(['Applies at once: /usage and /metrics answer as paths the daemon does not have.']);
    should(derive(settings({ autoResume: true, agendaMode: true })).summary).equal('Keep machine settings the same');
  });

  it('should join several moves into one summary', () => {
    const edit = derive(settings({ agentPermissions: 'skip', browserMode: 'window', autoResume: false }));
    should(edit.summary).equal(
      'Set agent permissions to Skip all permission checks; the browser mode to Real window; auto-resume after restart off',
    );
  });
});

describe('the schema and scope checks after a change', () => {
  it('should refuse a default runtime the machine does not have, in the schema’s words', () => {
    should(
      refusalOf({
        kind: 'machine.settings',
        agentPermissions: 'auto',
        defaultRuntime: 'ghost',
        agentControl: { terminals: true, browsers: true, files: true },
      }),
    ).match(/^this change would leave the setup invalid: .*ghost/u);
  });

  it('should refuse a component change that makes a profile both Claude only and Codex only', () => {
    const model = modelOf({
      components: {
        ...documentOf().components,
        instructions: { notes: { file: 'components/instructions/notes.md' } },
      },
      profiles: { ...documentOf().profiles, split: { layers: ['instructions/notes', 'modelSets/codex-set'] } },
      runtimes: {},
    });
    should(
      refusalOf(
        {
          kind: 'component.put',
          name: 'notes',
          create: false,
          component: { kind: 'instructions', harness: 'claude-code' },
        },
        {},
        model,
      ),
    ).match(/can't be both Claude only and Codex only/u);
  });

  it('should refuse a change that leaves a runtime on a profile its login cannot run', () => {
    const model = modelOf({
      components: {
        ...documentOf().components,
        instructions: { notes: { file: 'components/instructions/notes.md' } },
      },
      profiles: { plain: { layers: ['instructions/notes'] } },
      runtimes: { only: { credential: 'codex-a', profile: 'plain', agent: true } },
    });
    should(
      refusalOf(
        {
          kind: 'component.put',
          name: 'notes',
          create: false,
          component: { kind: 'instructions', harness: 'claude-code' },
        },
        {},
        model,
      ),
    ).equal(
      'Runtime only uses a Codex login, and this change would make its profile plain Claude only. Move it to another profile first.',
    );
  });
});
