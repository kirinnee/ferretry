import { describe, it } from 'bun:test';
import { type AccountModel, builtInPresets, parseAccountModel } from '@ferretry/fleet';
import should from 'should';
import {
  type AccountChangeFacts,
  type AccountModelEdit,
  type AccountPlanChange,
  deriveAccountChange,
  FleetMutationRefusal,
  isAccountPlanChange,
} from '../../../src/lib/fleet/mutations.ts';

/** A reference to the secret store, spelled `${secret:NAME}`. */
const secretRef = (name: string): string => `\${secret:${name}}`;

const FACTS: AccountChangeFacts = { machineName: 'studio', runningSessions: 0 };

/** A model with a login of each store, components of every kind, layered profiles and two runtimes. */
const modelOf = (overrides: Record<string, unknown> = {}): AccountModel =>
  parseAccountModel({
    version: 2,
    credentials: {
      'my-claude': { harness: 'claude', store: 'host' },
      work: { harness: 'claude', store: 'ferretry', label: 'Work' },
      home: { harness: 'claude', store: 'ferretry', label: 'Home' },
      spare: { harness: 'claude', store: 'ferretry' },
      'my-codex': { harness: 'codex', store: 'host' },
    },
    components: {
      instructions: {
        main: { file: 'components/instructions/main.md' },
        'codex-only': { file: 'components/instructions/codex-only.md', harness: 'codex' },
      },
      mcp: {
        search: { command: 'search-server', args: ['--fast'], env: { REGION: 'eu', API_TOKEN: secretRef('SEARCH') } },
      },
      skills: { review: { items: ['review'] } },
      settings: { tuned: { harness: 'claude', file: 'components/settings/tuned.json', flags: ['--verbose'] } },
      hooks: {
        guard: { harness: 'claude', file: 'components/hooks/guard.json' },
        scripts: { harness: 'claude', directory: 'hooks/scripts' },
      },
      modelSets: { heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
    },
    profiles: {
      base: { layers: ['instructions/main'] },
      team: { layers: ['profile/base', 'settings/tuned'] },
      'only-codex': { layers: ['instructions/codex-only'] },
      other: { layers: ['skills/review'] },
    },
    runtimes: {
      alpha: { credential: 'work', profile: 'team', agent: false },
      beta: { credential: 'home', profile: 'base', agent: true },
    },
    advanced: { commands: [{ wrapper: 'alpha-fast', runtime: 'alpha', flags: ['--fast'] }] },
    ...overrides,
  });

const derive = (change: AccountPlanChange, model: AccountModel = modelOf(), facts = FACTS): AccountModelEdit =>
  deriveAccountChange(model, change, facts);

/** The sentence a derivation refused with. */
const refusalOf = (change: AccountPlanChange, model: AccountModel = modelOf(), facts = FACTS): string => {
  try {
    deriveAccountChange(model, change, facts);
  } catch (error) {
    should(error).be.instanceof(FleetMutationRefusal);
    should((error as Error).name).equal('FleetMutationRefusal');
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

const runtimePut = (overrides: Record<string, unknown> = {}): AccountPlanChange =>
  ({
    kind: 'runtime.put',
    name: 'gamma',
    credential: 'spare',
    profile: 'other',
    agent: false,
    create: true,
    ...overrides,
  }) as AccountPlanChange;

const profilePut = (overrides: Record<string, unknown> = {}): AccountPlanChange =>
  ({
    kind: 'profile.put',
    name: 'fresh',
    layers: ['instructions/main'],
    create: true,
    ...overrides,
  }) as AccountPlanChange;

const componentPut = (component: Record<string, unknown>, overrides: Record<string, unknown> = {}): AccountPlanChange =>
  ({ kind: 'component.put', name: 'fresh', component, create: true, ...overrides }) as AccountPlanChange;

describe('isAccountPlanChange', () => {
  it.each(['credential.signout', 'setup.import', 'clone.import'])('should say %p is run by its own executor', kind => {
    // Act + Assert
    should(isAccountPlanChange({ kind } as never)).be.false();
  });

  it.each([
    { kind: 'runtime.remove', name: 'alpha' },
    { kind: 'machine.settings', agentPermissions: 'skip' },
    { kind: 'credential.remove', id: 'spare' },
  ])('should say $kind derives a configuration', change => {
    // Act + Assert
    should(isAccountPlanChange(change as never)).be.true();
  });
});

describe('deriveAccountChange: runtime.put', () => {
  it('should add a runtime and say nothing else about it', () => {
    // Act
    const edit = derive(runtimePut());

    // Assert
    should(edit.summary).equal('Add runtime gamma');
    should(edit.model.runtimes.gamma).deepEqual({ credential: 'spare', profile: 'other', agent: false });
    should(edit.consequences).deepEqual([]);
    should(edit.files).deepEqual([]);
  });

  it('should make the first agent runtime the machine default and say so', () => {
    // Act
    const edit = derive(runtimePut({ agent: true }));

    // Assert
    should(edit.model.machine.defaultRuntime).equal('gamma');
    should(edit.consequences).deepEqual(["gamma is now this machine's default runtime for new agents."]);
  });

  it('should keep the default the machine already has when another agent runtime is added', () => {
    // Arrange
    const model = modelOf({ machine: { ...modelOf().machine, defaultRuntime: 'beta' } });

    // Act
    const edit = derive(runtimePut({ agent: true }), model);

    // Assert
    should(edit.model.machine.defaultRuntime).equal('beta');
    should(edit.consequences).deepEqual([]);
  });

  it('should leave the default alone when the new runtime does not launch as an agent', () => {
    // Act
    const edit = derive(runtimePut({ agent: false }));

    // Assert
    should(edit.model.machine.defaultRuntime).be.undefined();
  });

  it('should leave the model it was given untouched', () => {
    // Arrange
    const model = modelOf();

    // Act
    derive(runtimePut(), model);

    // Assert
    should(model.runtimes.gamma).be.undefined();
  });

  it('should change an existing runtime and say that running sessions keep the old setup', () => {
    // Act
    const edit = derive(
      runtimePut({ name: 'alpha', credential: 'work', profile: 'other', agent: true, create: false }),
    );

    // Assert
    should(edit.summary).equal('Change runtime alpha');
    should(edit.model.runtimes.alpha).deepEqual({ credential: 'work', profile: 'other', agent: true });
    should(edit.consequences).deepEqual(['Running sessions keep the old setup until restarted.']);
  });

  it('should refuse to change a runtime that does not exist', () => {
    // Act + Assert
    should(refusalOf(runtimePut({ name: 'ghost', create: false }))).equal('no runtime ghost exists on this machine');
  });

  it('should refuse a name outside the grammar and suggest its slug (E16)', () => {
    // Act + Assert
    should(refusalOf(runtimePut({ name: 'My Runtime!' }))).equal(
      'Use only letters, digits and dashes. Use My-Runtime?',
    );
  });

  it('should suggest the runtime fallback when nothing of the name survives', () => {
    // Act + Assert
    should(refusalOf(runtimePut({ name: '!!!' }))).equal('Use only letters, digits and dashes. Use runtime?');
  });

  it('should suggest the next free number when the name is taken by a runtime (E16)', () => {
    // Act + Assert
    should(refusalOf(runtimePut({ name: 'alpha' }))).equal('alpha is already a runtime on studio. Use alpha-2?');
  });

  it('should skip a number that is taken too', () => {
    // Arrange
    const model = modelOf({
      runtimes: {
        alpha: { credential: 'work', profile: 'team' },
        'alpha-2': { credential: 'work', profile: 'team' },
      },
      advanced: {},
    });

    // Act + Assert
    should(refusalOf(runtimePut({ name: 'alpha' }), model)).equal('alpha is already a runtime on studio. Use alpha-3?');
  });

  it('should refuse a name an advanced command wrapper already owns', () => {
    // Act + Assert
    should(refusalOf(runtimePut({ name: 'alpha-fast' }))).equal(
      'alpha-fast is already a runtime on studio. Use alpha-fast-2?',
    );
  });

  it('should refuse an unknown login', () => {
    // Act + Assert
    should(refusalOf(runtimePut({ credential: 'nobody' }))).equal('no login nobody exists on this machine');
  });

  it('should refuse an unknown profile', () => {
    // Act + Assert
    should(refusalOf(runtimePut({ profile: 'nothing' }))).equal('no profile nothing exists on this machine');
  });

  it('should refuse a profile that is only for the other harness (P7)', () => {
    // Act + Assert
    should(refusalOf(runtimePut({ profile: 'only-codex' }))).equal(
      'Profile only-codex is Codex only and spare is a Claude Code login. Pick a Generic or Claude only profile.',
    );
  });

  it('should refuse a generic profile with nothing for the login’s harness (P5, E14)', () => {
    // Arrange — a model set of ids neither harness runs is generic, and applies nowhere.
    const model = modelOf({
      components: {
        ...modelOf().components,
        modelSets: { odd: { models: ['llama-9'], default: 'llama-9' } },
      },
      profiles: { ...modelOf().profiles, odd: { layers: ['modelSets/odd'] } },
    });

    // Act + Assert
    should(refusalOf(runtimePut({ profile: 'odd' }), model)).equal(
      'Nothing in profile odd applies on Claude Code. Pick a different profile.',
    );
  });

  it('should refuse moving a runtime onto a profile mixed before P7, and keep one already on it', () => {
    // Arrange
    const model = modelOf({
      profiles: { ...modelOf().profiles, legacy: { layers: ['settings/tuned', 'instructions/codex-only'] } },
      runtimes: { ...modelOf().runtimes, old: { credential: 'spare', profile: 'legacy', agent: false } },
    });

    // Act + Assert
    should(refusalOf(runtimePut({ profile: 'legacy' }), model)).equal(
      "Profile legacy can't be both Claude only and Codex only: settings tuned is Claude only and instructions codex-only is Codex only.",
    );
    should(
      derive(runtimePut({ name: 'old', profile: 'legacy', agent: true, create: false }), model).model.runtimes.old,
    ).deepEqual({
      credential: 'spare',
      profile: 'legacy',
      agent: true,
    });
  });

  it('should accept a profile whose layers the harness can read', () => {
    // Act
    const edit = derive(runtimePut({ credential: 'my-codex', profile: 'only-codex' }));

    // Assert
    should(edit.model.runtimes.gamma).deepEqual({ credential: 'my-codex', profile: 'only-codex', agent: false });
  });

  it('should ask before duplicating one runtime (E15)', () => {
    // Act + Assert
    should(refusalOf(runtimePut({ credential: 'work', profile: 'team' }))).equal(
      'alpha already uses this login and profile. Add another anyway?',
    );
  });

  it('should ask before duplicating several runtimes, sorted', () => {
    // Arrange
    const model = modelOf({
      runtimes: {
        zed: { credential: 'work', profile: 'team' },
        alpha: { credential: 'work', profile: 'team' },
      },
      advanced: {},
    });

    // Act + Assert
    should(refusalOf(runtimePut({ credential: 'work', profile: 'team' }), model)).equal(
      'alpha and zed already use this login and profile. Add another anyway?',
    );
  });

  it('should add a twin once the person said add another, and say what it duplicates', () => {
    // Act
    const edit = derive(runtimePut({ credential: 'work', profile: 'team', addAnother: true }));

    // Assert
    should(edit.model.runtimes.gamma).deepEqual({ credential: 'work', profile: 'team', agent: false });
    should(edit.consequences).deepEqual(['alpha already uses this login and profile.']);
  });

  it('should say several twins use the pair', () => {
    // Arrange
    const model = modelOf({
      runtimes: {
        zed: { credential: 'work', profile: 'team' },
        alpha: { credential: 'work', profile: 'team' },
      },
      advanced: {},
    });

    // Act
    const edit = derive(runtimePut({ credential: 'work', profile: 'team', addAnother: true }), model);

    // Assert
    should(edit.consequences).deepEqual(['alpha and zed already use this login and profile.']);
  });

  it('should still ask when addAnother is false', () => {
    // Act + Assert
    should(refusalOf(runtimePut({ credential: 'work', profile: 'team', addAnother: false }))).equal(
      'alpha already uses this login and profile. Add another anyway?',
    );
  });

  it('should not count the runtime being edited as its own twin', () => {
    // Act
    const edit = derive(runtimePut({ name: 'alpha', credential: 'work', profile: 'team', create: false }));

    // Assert
    should(edit.summary).equal('Change runtime alpha');
  });
});

describe('deriveAccountChange: runtime.remove', () => {
  it('should remove the runtime and say what happens to its sessions', () => {
    // Act
    const edit = derive({ kind: 'runtime.remove', name: 'beta' });

    // Assert
    should(edit.summary).equal('Remove runtime beta');
    should(edit.model.runtimes.beta).be.undefined();
    should(edit.consequences).deepEqual([
      'Running sessions of it keep going until they end. Its past sessions stay in history.',
    ]);
  });

  it('should refuse a runtime that does not exist', () => {
    // Act + Assert
    should(refusalOf({ kind: 'runtime.remove', name: 'ghost' })).equal('no runtime ghost exists on this machine');
  });

  it('should refuse the final schema check when a command still runs the runtime', () => {
    // Act + Assert
    should(refusalOf({ kind: 'runtime.remove', name: 'alpha' })).equal(
      'this change would leave the setup invalid: command "alpha-fast" runs unknown runtime "alpha"',
    );
  });
});

describe('deriveAccountChange: runtime.remove of the default and of a runtime with ferrets on it', () => {
  it('should refuse the machine default runtime until another default is picked', () => {
    // Arrange
    const model = modelOf({ machine: { defaultRuntime: 'beta' } });

    // Act + Assert
    should(refusalOf({ kind: 'runtime.remove', name: 'beta' }, model)).equal(
      "beta is this machine's default runtime for new agents. Pick another default first.",
    );
  });

  it('should say how many ferrets keep running on it, and that a restart needs another runtime', () => {
    // Act
    const one = derive({ kind: 'runtime.remove', name: 'beta' }, modelOf(), {
      ...FACTS,
      runningOn: [{ id: 's-1', name: 'Fisher', harness: 'claude' }],
    });
    const two = derive({ kind: 'runtime.remove', name: 'beta' }, modelOf(), {
      ...FACTS,
      runningOn: [
        { id: 's-1', name: 'Fisher', harness: 'claude' },
        { id: 's-2', name: 'Otter', harness: 'claude' },
      ],
    });
    const none = derive({ kind: 'runtime.remove', name: 'beta' }, modelOf(), { ...FACTS, runningOn: [] });

    // Assert
    should(one.consequences).deepEqual([
      '1 ferret is running on it. It keeps running, but restarting it later needs another runtime. Its past sessions stay in history.',
    ]);
    should(two.consequences).deepEqual([
      '2 ferrets are running on it. They keep running, but restarting them later needs another runtime. Its past sessions stay in history.',
    ]);
    should(none.consequences).deepEqual(['Nothing is running on it. Its past sessions stay in history.']);
  });
});

describe('deriveAccountChange: runtime.rename', () => {
  it('should move the runtime to its new name, with every command that runs it', () => {
    // Act
    const edit = derive({ kind: 'runtime.rename', name: 'alpha', to: 'alpha-main' });

    // Assert
    should(edit.summary).equal('Rename runtime alpha to alpha-main');
    should(edit.model.runtimes.alpha).be.undefined();
    should(edit.model.runtimes['alpha-main']).deepEqual(modelOf().runtimes.alpha);
    should(edit.model.advanced.commands).deepEqual([
      { wrapper: 'alpha-fast', runtime: 'alpha-main', flags: ['--fast'] },
    ]);
    should(edit.consequences).deepEqual([
      'alpha-fast runs alpha-main from now on.',
      'Running ferrets keep working — nothing restarts.',
      'alpha keeps starting it: `--agent alpha` still works.',
    ]);
  });

  it('should keep a renamed default runtime the default', () => {
    // Arrange
    const model = modelOf({ machine: { defaultRuntime: 'beta' } });

    // Act
    const edit = derive({ kind: 'runtime.rename', name: 'beta', to: 'beta-2' }, model);

    // Assert
    should(edit.model.machine.defaultRuntime).equal('beta-2');
    should(edit.consequences[0]).equal("beta-2 stays this machine's default runtime for new agents.");
  });

  it('should refuse a runtime that does not exist, and a name it already has', () => {
    // Act + Assert
    should(refusalOf({ kind: 'runtime.rename', name: 'ghost', to: 'spirit' })).equal(
      'no runtime ghost exists on this machine',
    );
    should(refusalOf({ kind: 'runtime.rename', name: 'alpha', to: 'alpha' })).equal('alpha is already called alpha.');
  });

  it('should refuse a name that clashes with another runtime or a command, offering a free one', () => {
    // Act + Assert
    should(refusalOf({ kind: 'runtime.rename', name: 'alpha', to: 'beta' })).equal(
      'beta is already a runtime on studio. Use beta-2?',
    );
    should(refusalOf({ kind: 'runtime.rename', name: 'beta', to: 'alpha-fast' })).equal(
      'alpha-fast is already a runtime on studio. Use alpha-fast-2?',
    );
  });

  it('should refuse a name outside the runtime grammar, with the nearest one that fits', () => {
    // Act + Assert
    should(refusalOf({ kind: 'runtime.rename', name: 'alpha', to: 'My Alpha' })).equal(
      'Use only letters, digits and dashes. Use My-Alpha?',
    );
  });

  it('should refuse another runtime’s former name or id, and let a runtime take back its own', () => {
    // Arrange
    const facts: AccountChangeFacts = {
      ...FACTS,
      runtimeReferences: { 'old-beta': 'beta', 'first-alpha': 'alpha', '00000000-0000-4000-8000-00000000000b': 'beta' },
    };

    // Act + Assert
    should(refusalOf({ kind: 'runtime.rename', name: 'alpha', to: 'old-beta' }, modelOf(), facts)).equal(
      'old-beta is already a runtime on studio. Use old-beta-2?',
    );
    should(
      refusalOf(
        { kind: 'runtime.rename', name: 'alpha', to: '00000000-0000-4000-8000-00000000000b' },
        modelOf(),
        facts,
      ),
    ).match(/is already a runtime on studio/);
    should(derive({ kind: 'runtime.rename', name: 'alpha', to: 'first-alpha' }, modelOf(), facts).summary).equal(
      'Rename runtime alpha to first-alpha',
    );
  });
});

describe('deriveAccountChange: profile.put', () => {
  it('should add a profile', () => {
    // Act
    const edit = derive(profilePut({ layers: ['instructions/main', 'profile/base', 'hooks/guard'] }));

    // Assert
    should(edit.summary).equal('Add profile fresh');
    should(edit.model.profiles.fresh).deepEqual({ layers: ['instructions/main', 'profile/base', 'hooks/guard'] });
    should(edit.consequences).deepEqual([]);
  });

  it('should refuse a name that is taken and suggest the next one (E16)', () => {
    // Act + Assert
    should(refusalOf(profilePut({ name: 'base' }))).equal('base is already a profile on studio. Use base-2?');
  });

  it('should refuse to change a profile that does not exist', () => {
    // Act + Assert
    should(refusalOf(profilePut({ name: 'ghost', create: false }))).equal('no profile ghost exists on this machine');
  });

  it('should change the layers of a profile nobody uses without a consequence', () => {
    // Act
    const edit = derive(profilePut({ name: 'only-codex', layers: ['instructions/main'], create: false }));

    // Assert
    should(edit.summary).equal('Change the layers of profile only-codex');
    should(edit.model.profiles['only-codex']).deepEqual({ layers: ['instructions/main'] });
    should(edit.consequences).deepEqual([]);
  });

  it('should refuse a profile that is both Claude only and Codex only, naming both layers (P7)', () => {
    // Act + Assert
    should(refusalOf(profilePut({ layers: ['instructions/main', 'hooks/guard', 'instructions/codex-only'] }))).equal(
      "Profile fresh can't be both Claude only and Codex only: hooks guard is Claude only and instructions codex-only is Codex only.",
    );
    should(refusalOf(profilePut({ layers: ['profile/team', 'profile/only-codex'] }))).equal(
      "Profile fresh can't be both Claude only and Codex only: profile team is Claude only and profile only-codex is Codex only.",
    );
  });

  it('should refuse a base edit that would make a profile built on it mixed (P7)', () => {
    // Act + Assert — team is Claude only through settings tuned; base becoming Codex only mixes it.
    should(refusalOf(profilePut({ name: 'base', layers: ['instructions/codex-only'], create: false }))).equal(
      "Profile team can't be both Claude only and Codex only: settings tuned is Claude only and profile base is Codex only.",
    );
  });

  it('should say where an edit of a used profile lands (E20)', () => {
    // Act
    const edit = derive(profilePut({ name: 'base', layers: ['instructions/main', 'hooks/guard'], create: false }));

    // Assert
    should(edit.consequences).deepEqual([
      'Used by 1 profile and 2 runtimes. Saving changes it everywhere. Running sessions keep the old version until restarted.',
    ]);
  });

  it('should refuse text that is not a layer', () => {
    // Act + Assert
    should(refusalOf(profilePut({ layers: ['nonsense'] }))).equal(
      '"nonsense" is not a layer — write <kind>/<name> or profile/<name>',
    );
  });

  it('should refuse a layer written twice, in the product’s words for a component', () => {
    // Act + Assert
    should(refusalOf(profilePut({ layers: ['instructions/main', 'instructions/main'] }))).equal(
      'instructions main is in the layers twice',
    );
  });

  it('should refuse a profile layer written twice', () => {
    // Act + Assert
    should(refusalOf(profilePut({ layers: ['profile/base', 'profile/base'] }))).equal(
      'profile base is in the layers twice',
    );
  });

  it('should name an MCP server in the layer words', () => {
    // Act + Assert
    should(refusalOf(profilePut({ layers: ['mcp/search', 'mcp/search'] }))).equal(
      'MCP server search is in the layers twice',
    );
  });

  it('should refuse a base profile that does not exist', () => {
    // Act + Assert
    should(refusalOf(profilePut({ layers: ['profile/ghost'] }))).equal('no profile ghost exists on this machine');
  });

  it('should refuse a component that does not exist', () => {
    // Act + Assert
    should(refusalOf(profilePut({ layers: ['modelSets/ghost'] }))).equal('no model set ghost exists on this machine');
  });

  it('should refuse a profile that would include itself (E19)', () => {
    // Act + Assert
    should(refusalOf(profilePut({ name: 'base', layers: ['profile/base'], create: false }))).equal(
      'profile base would include itself: it is base or is built on it',
    );
  });

  it('should refuse a profile built on one that is built on it (E19)', () => {
    // Act + Assert
    should(refusalOf(profilePut({ name: 'base', layers: ['profile/team'], create: false }))).equal(
      'profile team would include itself: it is base or is built on it',
    );
  });
});

describe('deriveAccountChange: profile.remove', () => {
  it('should delete a profile nothing uses and say its components stay', () => {
    // Act
    const edit = derive({ kind: 'profile.remove', name: 'other' });

    // Assert
    should(edit.summary).equal('Delete profile other');
    should(edit.model.profiles.other).be.undefined();
    should(edit.model.components.skills.review).deepEqual({ items: ['review'] });
    should(edit.consequences).deepEqual(['Its components stay saved.']);
  });

  it('should refuse a profile that does not exist', () => {
    // Act + Assert
    should(refusalOf({ kind: 'profile.remove', name: 'ghost' })).equal('no profile ghost exists on this machine');
  });

  it('should refuse a base of one profile (E21)', () => {
    // Act + Assert
    should(refusalOf({ kind: 'profile.remove', name: 'base' })).equal(
      'Profile base is a base for team. Remove it from that profile first.',
    );
  });

  it('should refuse a base of several profiles (E21)', () => {
    // Arrange
    const model = modelOf({
      profiles: {
        base: { layers: ['instructions/main'] },
        team: { layers: ['profile/base'] },
        crew: { layers: ['profile/base'] },
      },
      runtimes: {},
      advanced: {},
    });

    // Act + Assert
    should(refusalOf({ kind: 'profile.remove', name: 'base' }, model)).equal(
      'Profile base is a base for crew and team. Remove it from those profiles first.',
    );
  });

  it('should ask where one runtime goes when it is not said', () => {
    // Act + Assert
    should(refusalOf({ kind: 'profile.remove', name: 'team' })).equal(
      '1 runtime uses profile team (alpha). Pick the profile it switches to.',
    );
  });

  it('should ask where several runtimes go when it is not said', () => {
    // Arrange
    const model = modelOf({
      runtimes: {
        alpha: { credential: 'work', profile: 'other' },
        beta: { credential: 'home', profile: 'other' },
      },
      advanced: {},
    });

    // Act + Assert
    should(refusalOf({ kind: 'profile.remove', name: 'other' }, model)).equal(
      '2 runtimes use profile other (alpha and beta). Pick the profile they switch to.',
    );
  });

  it('should refuse to switch the runtimes to the profile being deleted', () => {
    // Act + Assert
    should(refusalOf({ kind: 'profile.remove', name: 'team', switchRuntimesTo: 'team' })).equal(
      'pick a profile other than team to switch to',
    );
  });

  it('should refuse to switch the runtimes to an unknown profile', () => {
    // Act + Assert
    should(refusalOf({ kind: 'profile.remove', name: 'team', switchRuntimesTo: 'ghost' })).equal(
      'no profile ghost exists on this machine',
    );
  });

  it('should switch a runtime to the named profile and delete', () => {
    // Act
    const edit = derive({ kind: 'profile.remove', name: 'team', switchRuntimesTo: 'other' });

    // Assert
    should(edit.summary).equal('Switch 1 runtime and delete profile team');
    should(edit.model.runtimes.alpha?.profile).equal('other');
    should(edit.model.profiles.team).be.undefined();
    should(edit.consequences).deepEqual(['Switches 1 runtime to other.', 'Its components stay saved.']);
  });

  it('should switch several runtimes', () => {
    // Arrange
    const model = modelOf({
      runtimes: {
        alpha: { credential: 'work', profile: 'other' },
        beta: { credential: 'home', profile: 'other' },
      },
      advanced: {},
    });

    // Act
    const edit = derive({ kind: 'profile.remove', name: 'other', switchRuntimesTo: 'base' }, model);

    // Assert
    should(edit.summary).equal('Switch 2 runtimes and delete profile other');
    should(edit.model.runtimes.alpha?.profile).equal('base');
    should(edit.model.runtimes.beta?.profile).equal('base');
  });
});

describe('deriveAccountChange: component.put', () => {
  it('should refuse narrowing a component when that leaves a runtime on a profile for the other harness (P7)', () => {
    // Arrange — gamma, a Claude login, runs profile other, whose only layer is skills review.
    const model = modelOf({
      runtimes: { ...modelOf().runtimes, gamma: { credential: 'spare', profile: 'other', agent: false } },
    });

    // Act + Assert
    should(
      refusalOf(
        componentPut({ kind: 'skills', items: ['review'], harness: 'codex' }, { name: 'review', create: false }),
        model,
      ),
    ).equal(
      'Runtime gamma uses a Claude Code login, and this change would make its profile other Codex only. Move it to another profile first.',
    );
  });

  it('should refuse narrowing a component when that makes a profile mixed (P7)', () => {
    // Act + Assert — team is Claude only; the instructions in its base becoming Codex only mixes it.
    should(refusalOf(componentPut({ kind: 'instructions', harness: 'codex' }, { name: 'main', create: false }))).equal(
      "Profile team can't be both Claude only and Codex only: settings tuned is Claude only and profile base is Codex only.",
    );
  });

  it('should add instructions and write the markdown file the daemon names', () => {
    // Act
    const edit = derive(componentPut({ kind: 'instructions' }, { content: '# Rules' }));

    // Assert
    should(edit.summary).equal('Add instructions fresh');
    should(edit.model.components.instructions.fresh).deepEqual({ file: 'components/instructions/fresh.md' });
    should(edit.files).deepEqual([{ file: 'components/instructions/fresh.md', content: '# Rules' }]);
  });

  it('should keep a harness an instructions component names', () => {
    // Act
    const edit = derive(componentPut({ kind: 'instructions', harness: 'codex' }, { content: 'x' }));

    // Assert
    should(edit.model.components.instructions.fresh).deepEqual({
      file: 'components/instructions/fresh.md',
      harness: 'codex',
    });
  });

  it('should refuse new instructions with no text', () => {
    // Act + Assert
    should(refusalOf(componentPut({ kind: 'instructions' }))).equal('instructions fresh needs its text');
  });

  it('should keep the file an edit of instructions has when no text is sent', () => {
    // Act
    const edit = derive(componentPut({ kind: 'instructions' }, { name: 'main', create: false }));

    // Assert
    should(edit.summary).equal('Change instructions main');
    should(edit.model.components.instructions.main).deepEqual({ file: 'components/instructions/main.md' });
    should(edit.files).deepEqual([]);
    should(edit.consequences).deepEqual([
      'Used by 2 profiles and 2 runtimes. Saving changes it everywhere. Running sessions keep the old version until restarted.',
    ]);
  });

  it('should rewrite the file of an edit that sends text', () => {
    // Act
    const edit = derive(componentPut({ kind: 'instructions' }, { name: 'main', create: false, content: 'new' }));

    // Assert
    should(edit.files).deepEqual([{ file: 'components/instructions/main.md', content: 'new' }]);
  });

  it('should add an MCP server that starts a command', () => {
    // Act
    const edit = derive(
      componentPut({ kind: 'mcp', command: 'serve', args: ['-v'], env: { REGION: 'eu' }, harness: 'claude' }),
    );

    // Assert
    should(edit.summary).equal('Add MCP server fresh');
    should(edit.model.components.mcp.fresh).deepEqual({
      command: 'serve',
      args: ['-v'],
      env: { REGION: 'eu' },
      harness: 'claude',
    });
    should(edit.files).deepEqual([]);
  });

  it('should add an MCP server reached at a url', () => {
    // Act
    const edit = derive(componentPut({ kind: 'mcp', url: 'https://example.com/mcp' }));

    // Assert
    should(edit.model.components.mcp.fresh).deepEqual({ url: 'https://example.com/mcp' });
  });

  it('should keep a hand-registered OAuth client through an edit that keeps the sign-in, and drop it with the sign-in', () => {
    // Arrange — the form has no field for `oauth`, so an edit never sends it.
    const model = modelOf();
    const oauth = { clientId: 'hand-1', clientSecret: secretRef('PHOEBE_CLIENT'), callbackPort: 8123 };
    const url = 'https://phoebe.example/mcp';
    const withHand = {
      ...model,
      components: { ...model.components, mcp: { ...model.components.mcp, phoebe: { url, auth: 'oauth', oauth } } },
    } as AccountModel;
    const edit = { name: 'phoebe', create: false };

    // Act
    const kept = derive(componentPut({ kind: 'mcp', url, auth: 'oauth' }, edit), withHand);
    const dropped = derive(componentPut({ kind: 'mcp', url }, edit), withHand);

    // Assert
    should(kept.model.components.mcp.phoebe).deepEqual({ url, auth: 'oauth', oauth });
    should(dropped.model.components.mcp.phoebe).deepEqual({ url });
  });

  it('should drop an MCP environment that is empty', () => {
    // Act
    const edit = derive(componentPut({ kind: 'mcp', command: 'serve', env: {} }));

    // Assert
    should(edit.model.components.mcp.fresh).deepEqual({ command: 'serve' });
  });

  it('should refuse a secret-looking environment value (K4)', () => {
    // Act + Assert
    should(refusalOf(componentPut({ kind: 'mcp', command: 'serve', env: { API_TOKEN: 'sk-abcdefghijklmnop' } }))).equal(
      `API_TOKEN looks like a secret, and a secret never sits in a component. Save it in this machine's secret store and write ${secretRef('NAME')} here instead.`,
    );
  });

  it('should accept a reference to the secret store', () => {
    // Act
    const edit = derive(componentPut({ kind: 'mcp', command: 'serve', env: { API_TOKEN: secretRef('SEARCH') } }));

    // Assert
    should(edit.model.components.mcp.fresh).deepEqual({ command: 'serve', env: { API_TOKEN: secretRef('SEARCH') } });
  });

  it('should keep the environment values an edit marks as kept', () => {
    // Act
    const edit = derive(
      componentPut(
        { kind: 'mcp', command: 'search-server', env: { API_TOKEN: { keep: true }, REGION: 'us' } },
        { name: 'search', create: false },
      ),
    );

    // Assert
    should(edit.model.components.mcp.search?.env).deepEqual({ API_TOKEN: secretRef('SEARCH'), REGION: 'us' });
  });

  it('should refuse to keep a value the component does not have', () => {
    // Act + Assert
    should(
      refusalOf(
        componentPut(
          { kind: 'mcp', command: 'search-server', env: { MISSING: { keep: true } } },
          { name: 'search', create: false },
        ),
      ),
    ).equal('MCP server search has no value for MISSING to keep; type one');
  });

  it('should refuse to keep a value on a component that is new', () => {
    // Act + Assert
    should(refusalOf(componentPut({ kind: 'mcp', command: 'serve', env: { REGION: { keep: true } } }))).equal(
      'MCP server fresh has no value for REGION to keep; type one',
    );
  });

  it('should add skills', () => {
    // Act
    const edit = derive(componentPut({ kind: 'skills', items: ['a', 'b'], harness: 'codex' }));

    // Assert
    should(edit.summary).equal('Add skills fresh');
    should(edit.model.components.skills.fresh).deepEqual({ items: ['a', 'b'], harness: 'codex' });
  });

  it('should add a Claude settings component and write JSON', () => {
    // Act
    const edit = derive(
      componentPut(
        { kind: 'settings', harness: 'claude', flags: ['--x'], env: { REGION: 'eu' } },
        { content: '{"a":1}' },
      ),
    );

    // Assert
    should(edit.model.components.settings.fresh).deepEqual({
      harness: 'claude',
      file: 'components/settings/fresh.json',
      flags: ['--x'],
      env: { REGION: 'eu' },
    });
    should(edit.files).deepEqual([{ file: 'components/settings/fresh.json', content: '{"a":1}' }]);
  });

  it('should add a Codex settings component and write TOML', () => {
    // Act
    const edit = derive(componentPut({ kind: 'settings', harness: 'codex' }, { content: 'model = "gpt-6"' }));

    // Assert
    should(edit.model.components.settings.fresh).deepEqual({
      harness: 'codex',
      file: 'components/settings/fresh.toml',
    });
    should(edit.files).deepEqual([{ file: 'components/settings/fresh.toml', content: 'model = "gpt-6"' }]);
  });

  it('should refuse settings text that is not valid JSON', () => {
    // Act
    const message = refusalOf(componentPut({ kind: 'settings', harness: 'claude' }, { content: '{nope' }));

    // Assert
    should(message.startsWith('the settings fresh text is not valid JSON: ')).be.true();
  });

  it('should refuse settings text that is not valid TOML', () => {
    // Act
    const message = refusalOf(componentPut({ kind: 'settings', harness: 'codex' }, { content: 'a = = 1' }));

    // Assert
    should(message.startsWith('the settings fresh text is not valid TOML: ')).be.true();
  });

  it('should refuse settings text whose root is not an object', () => {
    // Act + Assert
    should(refusalOf(componentPut({ kind: 'settings', harness: 'claude' }, { content: '[1]' }))).equal(
      'the settings fresh text is not valid JSON: cannot parse json settings: the document root must be an object',
    );
  });

  it('should keep the settings file and drop an empty flag list when an edit sends no text', () => {
    // Act
    const edit = derive(
      componentPut({ kind: 'settings', harness: 'claude', flags: [] }, { name: 'tuned', create: false }),
    );

    // Assert
    should(edit.model.components.settings.tuned).deepEqual({
      harness: 'claude',
      file: 'components/settings/tuned.json',
    });
    should(edit.files).deepEqual([]);
  });

  it('should refuse settings with nothing in them through the final schema check', () => {
    // Act + Assert
    should(refusalOf(componentPut({ kind: 'settings', harness: 'claude' }))).equal(
      'this change would leave the setup invalid: a settings component needs at least one of "file", "flags" or "env"',
    );
  });

  it('should add hooks and write JSON', () => {
    // Act
    const edit = derive(componentPut({ kind: 'hooks', harness: 'claude' }, { content: '{"hooks":{}}' }));

    // Assert
    should(edit.model.components.hooks.fresh).deepEqual({ harness: 'claude', file: 'components/hooks/fresh.json' });
    should(edit.files).deepEqual([{ file: 'components/hooks/fresh.json', content: '{"hooks":{}}' }]);
  });

  it('should refuse hooks text that is not valid JSON', () => {
    // Act
    const message = refusalOf(componentPut({ kind: 'hooks', harness: 'claude' }, { content: 'nope' }));

    // Assert
    should(message.startsWith('the hooks fresh text is not valid JSON: ')).be.true();
  });

  it('should refuse new hooks with no document', () => {
    // Act + Assert
    should(refusalOf(componentPut({ kind: 'hooks', harness: 'claude' }))).equal('hooks fresh needs its hooks document');
  });

  it('should keep the directory of hooks when an edit sends no text', () => {
    // Act
    const edit = derive(componentPut({ kind: 'hooks', harness: 'claude' }, { name: 'scripts', create: false }));

    // Assert
    should(edit.model.components.hooks.scripts).deepEqual({ harness: 'claude', directory: 'hooks/scripts' });
    should(edit.files).deepEqual([]);
  });

  it('should replace a hooks directory with a document when an edit sends text', () => {
    // Act
    const edit = derive(
      componentPut({ kind: 'hooks', harness: 'claude' }, { name: 'scripts', create: false, content: '{}' }),
    );

    // Assert
    should(edit.model.components.hooks.scripts).deepEqual({ harness: 'claude', file: 'components/hooks/scripts.json' });
    should(edit.files).deepEqual([{ file: 'components/hooks/scripts.json', content: '{}' }]);
  });

  it('should keep the document of hooks when an edit sends no text', () => {
    // Act
    const edit = derive(componentPut({ kind: 'hooks', harness: 'claude' }, { name: 'guard', create: false }));

    // Assert
    should(edit.model.components.hooks.guard).deepEqual({ harness: 'claude', file: 'components/hooks/guard.json' });
    should(edit.files).deepEqual([]);
  });

  it('should add a model set', () => {
    // Act
    const edit = derive(componentPut({ kind: 'modelSets', models: ['claude-opus-5-5', 'gpt-6'], default: 'gpt-6' }));

    // Assert
    should(edit.summary).equal('Add model set fresh');
    should(edit.model.components.modelSets.fresh).deepEqual({ models: ['claude-opus-5-5', 'gpt-6'], default: 'gpt-6' });
  });

  it('should refuse a model set whose default is not one of its models through the final schema check', () => {
    // Act + Assert
    should(refusalOf(componentPut({ kind: 'modelSets', models: ['a'], default: 'b' }))).equal(
      'this change would leave the setup invalid: default "b" is not one of this model set\'s models (a)',
    );
  });

  it('should refuse an MCP server with both a command and a url through the final schema check', () => {
    // Act + Assert
    should(refusalOf(componentPut({ kind: 'mcp', command: 'serve', url: 'https://example.com' }))).equal(
      'this change would leave the setup invalid: an MCP server needs exactly one of "command" (a server to start) or "url" (a server to reach)',
    );
  });

  it('should refuse a name that is taken and suggest the next one (E16)', () => {
    // Act + Assert
    should(refusalOf(componentPut({ kind: 'skills', items: ['a'] }, { name: 'review' }))).equal(
      'review is already a skills on studio. Use review-2?',
    );
  });

  it('should refuse to change a component that does not exist', () => {
    // Act + Assert
    should(refusalOf(componentPut({ kind: 'skills', items: ['a'] }, { name: 'ghost', create: false }))).equal(
      'no skills ghost exists on this machine',
    );
  });

  it.each([
    [{ kind: 'skills', items: ['a'] }, 'a skills has no text to save; send its fields instead'],
    [{ kind: 'mcp', command: 'serve' }, 'a MCP server has no text to save; send its fields instead'],
    [{ kind: 'modelSets', models: ['a'], default: 'a' }, 'a model set has no text to save; send its fields instead'],
  ])('should refuse text for a kind with no file: %j', (component, sentence) => {
    // Act + Assert
    should(refusalOf(componentPut(component, { content: 'text' }))).equal(sentence);
  });
});

describe('deriveAccountChange: component.remove', () => {
  it('should delete a component nothing uses', () => {
    // Act
    const edit = derive({ kind: 'component.remove', componentKind: 'hooks', name: 'scripts' });

    // Assert
    should(edit.summary).equal('Delete hooks scripts');
    should(edit.model.components.hooks.scripts).be.undefined();
    should(edit.consequences).deepEqual([]);
  });

  it('should refuse a component that does not exist', () => {
    // Act + Assert
    should(refusalOf({ kind: 'component.remove', componentKind: 'mcp', name: 'ghost' })).equal(
      'no MCP server ghost exists on this machine',
    );
  });

  it('should block a component that is a layer, naming the runtimes behind it (E21)', () => {
    // Act + Assert
    should(refusalOf({ kind: 'component.remove', componentKind: 'settings', name: 'tuned' })).equal(
      'Settings tuned is a layer in team (used by alpha). Remove it from those first.',
    );
  });

  it('should block a component that is a layer with no runtime behind it', () => {
    // Act + Assert
    should(refusalOf({ kind: 'component.remove', componentKind: 'instructions', name: 'codex-only' })).equal(
      'Instructions codex-only is a layer in only-codex. Remove it from those first.',
    );
  });

  it('should remove a component from its profiles and say what it changes', () => {
    // Arrange
    const model = modelOf({
      profiles: {
        base: { layers: ['instructions/main', 'skills/review'] },
        team: { layers: ['profile/base', 'settings/tuned', 'skills/review'] },
        other: { layers: ['skills/review', 'hooks/guard'] },
      },
    });

    // Act
    const edit = derive(
      { kind: 'component.remove', componentKind: 'skills', name: 'review', removeFromProfiles: true },
      model,
    );

    // Assert
    should(edit.summary).equal('Delete skills review');
    should(edit.model.components.skills.review).be.undefined();
    should(edit.model.profiles.base).deepEqual({ layers: ['instructions/main'] });
    should(edit.model.profiles.team).deepEqual({ layers: ['profile/base', 'settings/tuned'] });
    should(edit.model.profiles.other).deepEqual({ layers: ['hooks/guard'] });
    should(edit.consequences).deepEqual([
      'Removes it from base, other and team, which changes 2 runtimes. Running sessions keep the old version until restarted.',
    ]);
  });

  it('should remove a component from profiles nothing runs', () => {
    // Act
    const edit = derive(
      {
        kind: 'component.remove',
        componentKind: 'instructions',
        name: 'codex-only',
        removeFromProfiles: true,
      },
      modelOf({
        profiles: {
          base: { layers: ['instructions/main'] },
          'only-codex': { layers: ['instructions/codex-only', 'instructions/main'] },
        },
        runtimes: { beta: { credential: 'home', profile: 'base', agent: true } },
        advanced: {},
      }),
    );

    // Assert
    should(edit.consequences).deepEqual([
      'Removes it from only-codex. Running sessions keep the old version until restarted.',
    ]);
  });

  it('should refuse to leave a profile with no layers', () => {
    // Act + Assert
    should(
      refusalOf({
        kind: 'component.remove',
        componentKind: 'instructions',
        name: 'codex-only',
        removeFromProfiles: true,
      }),
    ).equal(
      'removing instructions codex-only would leave profile only-codex with no layers; add another layer to it first',
    );
  });

  it('should still block when removeFromProfiles is false', () => {
    // Act + Assert
    should(
      refusalOf({ kind: 'component.remove', componentKind: 'settings', name: 'tuned', removeFromProfiles: false }),
    ).equal('Settings tuned is a layer in team (used by alpha). Remove it from those first.');
  });
});

describe('deriveAccountChange: credential.add', () => {
  it('should add an empty login that needs sign-in', () => {
    // Act
    const edit = derive({ kind: 'credential.add', id: 'fresh', harness: 'codex' });

    // Assert
    should(edit.summary).equal('Add a Codex login fresh');
    should(edit.model.credentials.fresh).deepEqual({ harness: 'codex', store: 'ferretry' });
    should(edit.consequences).deepEqual(['It starts as an empty login that needs sign-in.']);
  });

  it('should add a labelled login', () => {
    // Act
    const edit = derive({ kind: 'credential.add', id: 'fresh', harness: 'claude', label: 'Side project' });

    // Assert
    should(edit.summary).equal('Add a Claude Code login fresh');
    should(edit.model.credentials.fresh).deepEqual({ harness: 'claude', store: 'ferretry', label: 'Side project' });
  });

  it('should refuse an id outside the grammar and suggest its slug (E16)', () => {
    // Act + Assert
    should(refusalOf({ kind: 'credential.add', id: 'Side Project', harness: 'claude' })).equal(
      'Use only letters, digits and dashes. Use Side-Project?',
    );
  });

  it('should suggest the login fallback when nothing of the id survives', () => {
    // Act + Assert
    should(refusalOf({ kind: 'credential.add', id: '???', harness: 'claude' })).equal(
      'Use only letters, digits and dashes. Use login?',
    );
  });

  it('should refuse an id that is taken and suggest the next one (E16)', () => {
    // Act + Assert
    should(refusalOf({ kind: 'credential.add', id: 'work', harness: 'claude' })).equal(
      'work is already a login on studio. Use work-2?',
    );
  });

  it('should refuse a label another login of the harness has (C9)', () => {
    // Act + Assert
    should(refusalOf({ kind: 'credential.add', id: 'fresh', harness: 'claude', label: 'Work' })).equal(
      'another Claude Code login is already labelled Work; pick a different label',
    );
  });

  it('should allow a label another harness’s login has', () => {
    // Act
    const edit = derive({ kind: 'credential.add', id: 'fresh', harness: 'codex', label: 'Work' });

    // Assert
    should(edit.model.credentials.fresh?.label).equal('Work');
  });

  it('should add the person’s own login, shared in place, for the first run’s Sign in now', () => {
    // Arrange — a machine with no own Claude Code login yet.
    const model = modelOf({
      credentials: { work: { harness: 'claude', store: 'ferretry' }, home: { harness: 'claude', store: 'ferretry' } },
    });

    // Act
    const edit = derive({ kind: 'credential.add', id: 'claude-you', harness: 'claude', store: 'host' }, model);

    // Assert
    should(edit.summary).equal('Add your own Claude Code login as claude-you');
    should(edit.model.credentials['claude-you']).deepEqual({ harness: 'claude', store: 'host' });
    should(edit.consequences).deepEqual([
      'It is your own Claude Code login, shared with claude in your terminal: signing in here signs that in too.',
    ]);
  });

  it('should treat an explicit ferretry store as the default', () => {
    // Act
    const edit = derive({ kind: 'credential.add', id: 'fresh', harness: 'codex', store: 'ferretry' });

    // Assert
    should(edit.model.credentials.fresh).deepEqual({ harness: 'codex', store: 'ferretry' });
  });

  it('should refuse a second pointer at the person’s own login', () => {
    // Act + Assert — the fixture already shares the host's Codex login as my-codex.
    should(refusalOf({ kind: 'credential.add', id: 'codex-you', harness: 'codex', store: 'host' })).equal(
      'my-codex is already your own Codex login on this machine',
    );
  });
});

describe('deriveAccountChange: credential.label', () => {
  it('should label a login', () => {
    // Act
    const edit = derive({ kind: 'credential.label', id: 'spare', label: 'Spare' });

    // Assert
    should(edit.summary).equal('Label login spare Spare');
    should(edit.model.credentials.spare?.label).equal('Spare');
  });

  it('should let a login keep its own label', () => {
    // Act
    const edit = derive({ kind: 'credential.label', id: 'work', label: 'Work' });

    // Assert
    should(edit.model.credentials.work?.label).equal('Work');
  });

  it('should remove a label', () => {
    // Act
    const edit = derive({ kind: 'credential.label', id: 'work', label: null });

    // Assert
    should(edit.summary).equal('Remove the label from login work');
    should(edit.model.credentials.work?.label).be.undefined();
  });

  it('should refuse a login that does not exist', () => {
    // Act + Assert
    should(refusalOf({ kind: 'credential.label', id: 'ghost', label: 'x' })).equal(
      'no login ghost exists on this machine',
    );
  });

  it('should refuse a label another login of the harness has (C9)', () => {
    // Act + Assert
    should(refusalOf({ kind: 'credential.label', id: 'spare', label: 'Home' })).equal(
      'another Claude Code login is already labelled Home; pick a different label',
    );
  });
});

describe('deriveAccountChange: credential.remove', () => {
  it('should remove a login of this machine’s own harness and say it stays signed in', () => {
    // Act
    const edit = derive({ kind: 'credential.remove', id: 'my-codex' });

    // Assert
    should(edit.summary).equal('Remove login my-codex');
    should(edit.model.credentials['my-codex']).be.undefined();
    should(edit.consequences).deepEqual([
      'Your own codex in your terminal keeps its login; Ferretry only stops using it.',
    ]);
  });

  it('should remove a login Ferretry signed in and say its sign-in stays unless signed out first', () => {
    // Act
    const edit = derive({ kind: 'credential.remove', id: 'spare' });

    // Assert
    should(edit.model.credentials.spare).be.undefined();
    should(edit.consequences).deepEqual([
      'Its saved sign-in stays on this machine. To delete it, sign the login out before removing it.',
    ]);
  });

  it('should say only the secrets a login kept in the environment leaves behind', () => {
    // Arrange
    const model = modelOf({
      credentials: {
        work: { harness: 'claude', store: 'ferretry' },
        home: { harness: 'claude', store: 'ferretry' },
        keyed: { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: secretRef('KEY') } },
      },
    });

    // Act
    const edit = derive({ kind: 'credential.remove', id: 'keyed' }, model);

    // Assert
    should(edit.model.credentials.keyed).be.undefined();
    should(edit.orphanedSecrets).deepEqual(['KEY']);
    should(edit.consequences).deepEqual([
      '1 saved secret (KEY) is used by nothing else now, and stays in the secret store until you delete it there.',
    ]);
  });

  it('should refuse a login that does not exist', () => {
    // Act + Assert
    should(refusalOf({ kind: 'credential.remove', id: 'ghost' })).equal('no login ghost exists on this machine');
  });

  it('should refuse a login one runtime uses (C10)', () => {
    // Act + Assert
    should(refusalOf({ kind: 'credential.remove', id: 'work' })).equal(
      '1 runtime still uses this login (alpha). Move it to another login first.',
    );
  });

  it('should refuse a login several runtimes use (C10)', () => {
    // Arrange
    const model = modelOf({
      runtimes: {
        alpha: { credential: 'work', profile: 'team' },
        beta: { credential: 'work', profile: 'base' },
      },
    });

    // Act + Assert
    should(refusalOf({ kind: 'credential.remove', id: 'work' }, model)).equal(
      '2 runtimes still use this login (alpha and beta). Move them to another login first.',
    );
  });
});

describe('deriveAccountChange: credential.remove with runtimes on the login', () => {
  /** Two runtimes on `work`, a spare login of the same CLI, and a Codex login. */
  const crowded = (extra: Record<string, unknown> = {}): AccountModel =>
    modelOf({
      machine: { ...modelOf().machine, defaultRuntime: 'beta' },
      credentials: {
        work: { harness: 'claude', store: 'ferretry', label: 'Work' },
        home: { harness: 'claude', store: 'ferretry', label: 'Home' },
        spare: { harness: 'claude', store: 'ferretry' },
        'my-codex': { harness: 'codex', store: 'host' },
      },
      runtimes: {
        alpha: { credential: 'work', profile: 'team', agent: false },
        beta: { credential: 'work', profile: 'base', agent: true },
        gamma: { credential: 'home', profile: 'base', agent: true },
      },
      advanced: { commands: [] },
      ...extra,
    });

  const remove = (overrides: Record<string, unknown>): AccountPlanChange =>
    ({ kind: 'credential.remove', id: 'work', ...overrides }) as AccountPlanChange;

  it('should switch every runtime to another login of its CLI in the same plan as the removal', () => {
    // Act
    const edit = derive(remove({ switchRuntimes: { alpha: 'spare', beta: 'spare' } }), crowded());

    // Assert
    should(edit.model.credentials.work).be.undefined();
    should(edit.model.runtimes.alpha?.credential).equal('spare');
    should(edit.model.runtimes.beta?.credential).equal('spare');
    should(edit.model.runtimes.gamma?.credential).equal('home');
    should(edit.summary).equal('Remove login work, switching 2 runtimes to spare');
    should(edit.consequences[0]).equal(
      'alpha and beta move to login spare, starting with it the next time they launch.',
    );
  });

  it('should remove a runtime with the login and keep the others', () => {
    // Act
    const edit = derive(
      remove({ switchRuntimes: { alpha: 'spare' }, removeRuntimes: ['beta'], defaultRuntime: 'gamma' }),
      crowded(),
    );

    // Assert
    should(edit.model.runtimes.beta).be.undefined();
    should(edit.model.runtimes.alpha?.credential).equal('spare');
    should(edit.model.machine.defaultRuntime).equal('gamma');
    should(edit.summary).equal('Remove login work, switching 1 runtime to spare and removing 1 runtime');
    should(edit.consequences).containEql('Removes 1 runtime: beta. Their past sessions stay in history.');
    should(edit.consequences).containEql("gamma becomes this machine's default runtime for new agents.");
  });

  it('should refuse to remove the default runtime until another default is named', () => {
    // Act + Assert
    should(refusalOf(remove({ switchRuntimes: { alpha: 'spare' }, removeRuntimes: ['beta'] }), crowded())).equal(
      "beta is this machine's default runtime for new agents. Pick another default first.",
    );
  });

  it('should refuse a new default that is itself being removed', () => {
    // Act + Assert
    should(
      refusalOf(
        remove({ switchRuntimes: { alpha: 'spare' }, removeRuntimes: ['beta'], defaultRuntime: 'beta' }),
        crowded(),
      ),
    ).equal('beta is being removed, so it cannot be the new default');
  });

  it('should refuse a login of the other CLI as a switch target', () => {
    // Act + Assert
    should(refusalOf(remove({ switchRuntimes: { alpha: 'my-codex', beta: 'spare' } }), crowded())).equal(
      'alpha runs Claude Code, and login my-codex does not drive it. Pick a Claude Code login.',
    );
  });

  it.each([
    [{ switchRuntimes: { alpha: 'ghost', beta: 'spare' } }, 'no login ghost exists on this machine'],
    [{ switchRuntimes: { alpha: 'work', beta: 'spare' } }, 'runtime alpha cannot switch to the login being removed'],
    [
      { switchRuntimes: { gamma: 'spare', alpha: 'spare', beta: 'spare' } },
      'runtime gamma does not use login work, so this change cannot move it',
    ],
    [{ removeRuntimes: ['ghost'] }, 'runtime ghost does not use login work, so this change cannot move it'],
    [
      { switchRuntimes: { alpha: 'spare', beta: 'spare' }, removeRuntimes: ['beta'], defaultRuntime: 'gamma' },
      'runtime beta cannot be both switched and removed',
    ],
  ])('should refuse %j', (overrides, sentence) => {
    // Act + Assert
    should(refusalOf(remove(overrides), crowded())).equal(sentence);
  });

  it('should name the runtimes left on the login when the plan leaves one out', () => {
    // Act + Assert
    should(refusalOf(remove({ switchRuntimes: { alpha: 'spare' } }), crowded())).equal(
      '1 runtime still uses this login (beta). Switch it to another login or remove it first.',
    );
  });

  it('should count the ferrets running on the runtimes, whichever way each is moved', () => {
    // Arrange
    const running = [{ id: 's1', name: 'scout', harness: 'claude' as const, runtime: 'alpha' }];

    // Act
    const edit = derive(remove({ switchRuntimes: { alpha: 'spare', beta: 'spare' } }), crowded(), {
      ...FACTS,
      runningByRuntime: { alpha: running, beta: [] },
    });

    // Assert
    should(edit.consequences).containEql('1 ferret is running on those runtimes. It keeps running.');
  });

  it('should say a removed runtime needs another runtime to restart its ferrets', () => {
    // Arrange
    const running = [
      { id: 's1', name: 'scout', harness: 'claude' as const, runtime: 'alpha' },
      { id: 's2', name: 'rook', harness: 'claude' as const, runtime: 'alpha' },
    ];

    // Act
    const edit = derive(remove({ switchRuntimes: { beta: 'spare' }, removeRuntimes: ['alpha'] }), crowded(), {
      ...FACTS,
      runningByRuntime: { alpha: running, beta: [] },
    });

    // Assert
    should(edit.consequences).containEql(
      '2 ferrets are running on those runtimes. They keep running, but restarting one on a removed runtime later needs another runtime.',
    );
  });

  it('should leave in the secret store the names only this login used, and say so', () => {
    // Arrange
    const model = modelOf({
      credentials: {
        keyed: {
          harness: 'claude',
          store: 'environment',
          env: { ANTHROPIC_API_KEY: secretRef('KEY'), OTHER: secretRef('SEARCH') },
        },
      },
      runtimes: {},
      advanced: { commands: [] },
    });

    // Act
    const edit = derive({ kind: 'credential.remove', id: 'keyed' }, model);

    // Assert
    should(edit.orphanedSecrets).deepEqual(['KEY']);
    should(edit.consequences).deepEqual([
      '1 saved secret (KEY) is used by nothing else now, and stays in the secret store until you delete it there.',
    ]);
  });
});

describe('deriveAccountChange: machine.settings', () => {
  it('should apply to new sessions when none is running', () => {
    // Act
    const edit = derive({
      kind: 'machine.settings',
      agentPermissions: 'skip',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true },
    });

    // Assert
    should(edit.summary).equal('Set agent permissions to Skip all permission checks');
    should(edit.model.machine.agentPermissions).equal('skip');
    should(edit.consequences).deepEqual(['Applies to new sessions.']);
  });

  it('should say one running session keeps the old mode (E32)', () => {
    // Act
    const edit = derive(
      {
        kind: 'machine.settings',
        agentPermissions: 'skip',
        defaultRuntime: null,
        agentControl: { terminals: true, browsers: true, files: true },
      },
      modelOf(),
      {
        ...FACTS,
        runningSessions: 1,
      },
    );

    // Assert
    should(edit.consequences).deepEqual([
      'Applies to new sessions. 1 running session keeps the old mode (Auto mode) until restarted.',
    ]);
  });

  it('should say several running sessions keep the old mode (E32)', () => {
    // Arrange
    const model = modelOf({ machine: { agentPermissions: 'skip' } });

    // Act
    const edit = derive(
      {
        kind: 'machine.settings',
        agentPermissions: 'auto',
        defaultRuntime: null,
        agentControl: { terminals: true, browsers: true, files: true },
      },
      model,
      {
        ...FACTS,
        runningSessions: 3,
      },
    );

    // Assert
    should(edit.summary).equal('Set agent permissions to Auto mode');
    should(edit.consequences).deepEqual([
      'Applies to new sessions. 3 running sessions keep the old mode (Skip all permission checks) until restarted.',
    ]);
  });

  it('should switch the browser mode, saying it waits for the next browser start', () => {
    // Act
    const edit = derive({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true },
      browserMode: 'window',
    });

    // Assert
    should(edit.summary).equal('Set the browser mode to Real window');
    should(edit.model.machine.browserMode).equal('window');
    should(edit.consequences).deepEqual([
      'Applies the next time the browser starts; a browser already running keeps its mode until it stops.',
    ]);
  });

  it('should set the browser proxy, saying it waits for the next browser start', () => {
    // Act
    const edit = derive({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true },
      browserProxy: { url: 'socks5://proxy.example:1080', bypass: ['*.internal.example'] },
    });

    // Assert
    should(edit.summary).equal('Set the browser proxy to socks5://proxy.example:1080');
    should(edit.model.machine.browserProxy).eql({ url: 'socks5://proxy.example:1080', bypass: ['*.internal.example'] });
    should(edit.consequences).deepEqual([
      'Applies the next time the browser starts; a browser already running keeps its network route until it stops.',
    ]);
  });

  it('should turn the browser proxy off with null, and keep it when an older client leaves it out', () => {
    // Arrange
    const model = modelOf({ machine: { browserProxy: { url: 'http://proxy.example:8080', bypass: [] } } });
    const settings = {
      kind: 'machine.settings' as const,
      agentPermissions: 'auto' as const,
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true },
    };

    // Act
    const off = derive({ ...settings, browserProxy: null }, model);
    const kept = derive(settings, model);
    const same = derive({ ...settings, browserProxy: { url: 'http://proxy.example:8080', bypass: [] } }, model);

    // Assert
    should(off.summary).equal('Set the browser proxy off');
    should(off.model.machine.browserProxy).be.undefined();
    should(kept.model.machine.browserProxy).eql({ url: 'http://proxy.example:8080', bypass: [] });
    should(same.summary).equal('Keep machine settings the same');
  });

  it('should leave the browser mode as it is when an older client leaves it out', () => {
    // Arrange
    const model = modelOf({ machine: { browserMode: 'window' } });

    // Act
    const edit = derive(
      {
        kind: 'machine.settings',
        agentPermissions: 'auto',
        defaultRuntime: null,
        agentControl: { terminals: true, browsers: true, files: true },
      },
      model,
    );

    // Assert
    should(edit.summary).equal('Keep machine settings the same');
    should(edit.model.machine.browserMode).equal('window');
  });

  it('should switch auto-resume off, saying it waits for the next daemon start', () => {
    // Act
    const edit = derive({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true },
      autoResume: false,
    });

    // Assert
    should(edit.summary).equal('Set auto-resume after restart off');
    should(edit.model.machine.autoResume).equal(false);
    should(edit.consequences).deepEqual(['Applies the next time the daemon starts.']);
  });

  it('should leave auto-resume as it is when an older client leaves it out', () => {
    // Arrange
    const model = modelOf({ machine: { autoResume: false } });

    // Act
    const edit = derive(
      {
        kind: 'machine.settings',
        agentPermissions: 'auto',
        defaultRuntime: null,
        agentControl: { terminals: true, browsers: true, files: true },
      },
      model,
    );

    // Assert
    should(edit.summary).equal('Keep machine settings the same');
    should(edit.model.machine.autoResume).equal(false);
  });

  it('should switch auto-resume back on', () => {
    // Act
    const edit = derive(
      {
        kind: 'machine.settings',
        agentPermissions: 'auto',
        defaultRuntime: null,
        agentControl: { terminals: true, browsers: true, files: true },
        autoResume: true,
      },
      modelOf({ machine: { autoResume: false } }),
    );

    // Assert
    should(edit.summary).equal('Set auto-resume after restart on');
  });

  it('should switch the agenda-mode default off, saying existing ferrets keep their own switch', () => {
    // Act
    const edit = derive({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true },
      agendaMode: false,
    });

    // Assert
    should(edit.summary).equal('Set agenda mode for new ferrets off');
    should(edit.model.machine.agendaMode).equal(false);
    should(edit.consequences).deepEqual([
      'Applies to ferrets started after this; ferrets that already exist keep their own switch.',
    ]);
  });

  it('should switch the agenda-mode default back on, and leave it alone when an older client leaves it out', () => {
    // Arrange
    const model = modelOf({ machine: { agendaMode: false } });
    const base = {
      kind: 'machine.settings' as const,
      agentPermissions: 'auto' as const,
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true },
    };

    // Act
    const on = derive({ ...base, agendaMode: true }, model);
    const untouched = derive(base, model);

    // Assert
    should(on.summary).equal('Set agenda mode for new ferrets on');
    should(untouched.summary).equal('Keep machine settings the same');
    should(untouched.model.machine.agendaMode).equal(false);
  });

  it('should say nothing moved when every field matches the current machine settings', () => {
    // Act
    const edit = derive({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true },
    });

    // Assert
    should(edit.summary).equal('Keep machine settings the same');
    should(edit.consequences).deepEqual([]);
  });

  it('should set the default runtime to an agent runtime on this machine, and refuse one that is not', () => {
    // Act
    const edit = derive({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: 'beta',
      agentControl: { terminals: true, browsers: true, files: true },
    });

    // Assert
    should(edit.summary).equal('Set the default runtime for new agents to beta');
    should(edit.model.machine.defaultRuntime).equal('beta');
    should(edit.consequences).deepEqual([]);

    // Assert — "alpha" exists but is not an agent runtime (R3)
    should(
      refusalOf({
        kind: 'machine.settings',
        agentPermissions: 'auto',
        defaultRuntime: 'alpha',
        agentControl: { terminals: true, browsers: true, files: true },
      }),
    ).match(/this change would leave the setup invalid:.*is not an agent runtime/);
  });

  it('should unset an explicit default runtime back to automatic', () => {
    // Arrange
    const model = modelOf({ machine: { defaultRuntime: 'beta' } });

    // Act
    const edit = derive(
      {
        kind: 'machine.settings',
        agentPermissions: 'auto',
        defaultRuntime: null,
        agentControl: { terminals: true, browsers: true, files: true },
      },
      model,
    );

    // Assert
    should(edit.summary).equal('Set the default runtime for new agents back to automatic');
    should(edit.model.machine.defaultRuntime).be.undefined();
  });

  it('should set what agents may control, naming only the switches that moved', () => {
    // Act
    const edit = derive({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: null,
      agentControl: { terminals: false, browsers: true, files: false },
    });

    // Assert
    should(edit.summary).equal('Set what agents may control (terminals off, files off)');
    should(edit.model.machine.agentControl).deepEqual({
      terminals: false,
      browsers: true,
      files: false,
      ferretrySettings: false,
      pageScripts: false,
    });
    should(edit.consequences).deepEqual(['Applies to an agent’s next action; nothing already running is interrupted.']);
  });

  it('should name every field a change moves, in one summary', () => {
    // Act
    const edit = derive({
      kind: 'machine.settings',
      agentPermissions: 'skip',
      defaultRuntime: 'beta',
      agentControl: { terminals: false, browsers: true, files: true },
    });

    // Assert
    should(edit.summary).equal(
      'Set agent permissions to Skip all permission checks; the default runtime for new agents to beta; what agents may control (terminals off)',
    );
  });

  it('should name Ferretry settings when a change turns the config tools on', () => {
    // Act
    const edit = derive({
      kind: 'machine.settings',
      agentPermissions: 'auto',
      defaultRuntime: null,
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: true, pageScripts: false },
    });

    // Assert
    should(edit.summary).equal('Set what agents may control (ferretrySettings on)');
    should(edit.model.machine.agentControl.ferretrySettings).be.true();
  });

  it('should leave Ferretry settings as it is when a client that predates it leaves it out', () => {
    // Arrange — the owner turned it on; an older client sends only the three it knows.
    const model = modelOf({
      machine: {
        agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: true, pageScripts: false },
      },
    });

    // Act
    const edit = derive(
      {
        kind: 'machine.settings',
        agentPermissions: 'auto',
        defaultRuntime: null,
        agentControl: { terminals: false, browsers: true, files: true },
      },
      model,
    );

    // Assert — only terminals moved, and Ferretry settings is still on.
    should(edit.summary).equal('Set what agents may control (terminals off)');
    should(edit.model.machine.agentControl).deepEqual({
      terminals: false,
      browsers: true,
      files: true,
      ferretrySettings: true,
      pageScripts: false,
    });
  });
});

describe('deriveAccountChange: profile.remove from the profiles built on it (E21)', () => {
  it('should take a base out of every profile that names it, then switch and delete', () => {
    // Act
    const edit = derive({ kind: 'profile.remove', name: 'base', removeFromProfiles: true, switchRuntimesTo: 'other' });

    // Assert
    should(edit.model.profiles.base).be.undefined();
    should(edit.model.profiles.team?.layers).deepEqual(['settings/tuned']);
    should(edit.model.runtimes.beta?.profile).equal('other');
    should(edit.consequences).deepEqual([
      'Removes it from team, which changes 1 runtime. Running sessions keep the old version until restarted.',
      'Switches 1 runtime to other.',
      'Its components stay saved.',
    ]);
  });

  it('should not count a runtime behind it when only runtimes on the base itself use it', () => {
    // Arrange
    const model = modelOf({
      profiles: { base: { layers: ['instructions/main'] }, crew: { layers: ['profile/base', 'skills/review'] } },
      runtimes: {},
      advanced: {},
    });

    // Act
    const edit = derive({ kind: 'profile.remove', name: 'base', removeFromProfiles: true }, model);

    // Assert
    should(edit.consequences[0]).equal('Removes it from crew. Running sessions keep the old version until restarted.');
  });

  it('should refuse when it would leave a profile with no layers', () => {
    // Arrange
    const model = modelOf({
      profiles: { base: { layers: ['instructions/main'] }, crew: { layers: ['profile/base'] } },
      runtimes: {},
      advanced: {},
    });

    // Act + Assert
    should(refusalOf({ kind: 'profile.remove', name: 'base', removeFromProfiles: true }, model)).equal(
      'removing profile base would leave profile crew with no layers; add another layer to it first',
    );
  });
});

describe('deriveAccountChange: settings by entry', () => {
  const tuned: AccountChangeFacts = {
    ...FACTS,
    settingsBodies: { tuned: { theme: 'dark', env: { API_TOKEN: 'sk-abcdefghijklmnop' } } },
  };
  const entries = (value: Record<string, unknown>, harness = 'claude', overrides: Record<string, unknown> = {}) =>
    componentPut({ kind: 'settings', harness, entries: value }, { name: 'tuned', create: false, ...overrides });

  it('should write the entries as nested JSON, keeping a hidden value from the file it has', () => {
    // Act
    const edit = derive(
      entries({
        'permissions.defaultMode': { value: 'plan' },
        'env.API_TOKEN': { keep: true },
        verbose: { value: true },
      }),
      modelOf(),
      tuned,
    );

    // Assert
    should(edit.files).deepEqual([
      {
        file: 'components/settings/tuned.json',
        content: `${JSON.stringify(
          { env: { API_TOKEN: 'sk-abcdefghijklmnop' }, permissions: { defaultMode: 'plan' }, verbose: true },
          null,
          2,
        )}\n`,
      },
    ]);
    should(edit.model.components.settings.tuned?.file).equal('components/settings/tuned.json');
  });

  it('should write a Codex component as TOML', () => {
    // Act
    const edit = derive(
      componentPut({ kind: 'settings', harness: 'codex', entries: { 'tui.theme': { value: 'dark' } } }),
    );

    // Assert
    should(edit.files).deepEqual([{ file: 'components/settings/fresh.toml', content: '[tui]\ntheme = "dark"\n' }]);
  });

  it('should refuse a keep the file has no value for, or that runs through a value', () => {
    // Act + Assert
    should(refusalOf(entries({ 'env.OTHER': { keep: true } }), modelOf(), tuned)).equal(
      'settings tuned has no value for env.OTHER to keep; type one',
    );
    should(refusalOf(entries({ 'theme.mode': { keep: true } }), modelOf(), tuned)).equal(
      'settings tuned has no value for theme.mode to keep; type one',
    );
    should(refusalOf(entries({ theme: { keep: true } }))).equal(
      'settings tuned has no value for theme to keep; type one',
    );
  });

  it('should refuse a new value that looks like a secret, as text or inside JSON (E7)', () => {
    // Act + Assert
    for (const value of ['sk-abcdefghijklmnop', { nested: 'sk-abcdefghijklmnop' }]) {
      should(refusalOf(entries({ 'env.API_TOKEN': { value } }))).equal(
        `env.API_TOKEN looks like a secret, and a secret never sits in a component. Save it in this machine's secret store and write ${secretRef('NAME')} here instead.`,
      );
    }
  });

  it('should refuse an empty key segment, a key and a key inside it, and text alongside entries', () => {
    // Act + Assert
    should(refusalOf(entries({ 'a..b': { value: 1 } }))).equal('settings tuned cannot have a setting named "a..b"');
    should(refusalOf(entries({ a: { value: 1 }, 'a.b.c': { value: 2 } }))).equal(
      'settings tuned sets a and a setting inside it',
    );
    should(refusalOf(entries({ a: { value: 1 } }, 'claude', { content: '{}' }))).equal(
      'send settings tuned as its text or as its entries, not both',
    );
  });
});

describe('deriveAccountChange: environment logins (docs/provider-presets.md)', () => {
  const PRESET_FACTS: AccountChangeFacts = { ...FACTS, presets: builtInPresets() };
  const GLM_ENV = {
    ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: secretRef('ZAI_API_KEY'),
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
    API_TIMEOUT_MS: '',
  };
  const addGlm = (overrides: Record<string, unknown> = {}): AccountPlanChange =>
    ({
      kind: 'credential.add',
      id: 'glm',
      harness: 'claude',
      store: 'environment',
      preset: 'zai-glm',
      env: GLM_ENV,
      ...overrides,
    }) as AccountPlanChange;

  it('should add a login from a preset, leaving an empty optional variable out', () => {
    // Act
    const edit = derive(addGlm({ label: 'GLM' }), modelOf(), PRESET_FACTS);

    // Assert
    should(edit.model.credentials.glm).deepEqual({
      harness: 'claude',
      store: 'environment',
      preset: 'zai-glm',
      label: 'GLM',
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: secretRef('ZAI_API_KEY'),
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
      },
    });
    should(edit.summary).equal('Add a Claude Code login glm from GLM / Z.ai');
    should(edit.consequences).matchAny(/never written anywhere/u);
  });

  it('should make ONE login with both halves from a preset that drives both CLIs, listed first as asked', () => {
    // Act
    const edit = derive(
      {
        kind: 'credential.add',
        id: 'kimi',
        harness: 'codex',
        store: 'environment',
        preset: 'kimi',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
          ANTHROPIC_AUTH_TOKEN: secretRef('MOONSHOT_API_KEY'),
          ANTHROPIC_MODEL: 'kimi-k3[1m]',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3[1m]',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3[1m]',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code',
          CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k3[1m]',
          KIMI_API_KEY: secretRef('MOONSHOT_API_KEY'),
        },
      },
      modelOf(),
      PRESET_FACTS,
    );

    // Assert
    const kimi = edit.model.credentials.kimi;
    should(kimi?.harness).equal('codex');
    should(kimi?.codex?.codexProvider?.id).equal('kimi');
    should(kimi?.codex?.env).deepEqual({ KIMI_API_KEY: secretRef('MOONSHOT_API_KEY') });
    should(kimi?.claude?.env?.ANTHROPIC_AUTH_TOKEN).equal(secretRef('MOONSHOT_API_KEY'));
    should(edit.summary).equal('Add a Claude Code + Codex login kimi from Kimi / Moonshot');
    should(edit.consequences).matchAny(/One login, one secret: runtimes on it can run Claude Code or Codex/u);
  });

  it('should add a login from its variables alone when no preset is named', () => {
    // Act
    const edit = derive(
      {
        kind: 'credential.add',
        id: 'raw',
        harness: 'claude',
        store: 'environment',
        env: { CLAUDE_CODE_USE_FOUNDRY: '1' },
        cloudCredential: 'azure-cli',
      },
      modelOf(),
      PRESET_FACTS,
    );

    // Assert
    should(edit.model.credentials.raw).deepEqual({
      harness: 'claude',
      store: 'environment',
      env: { CLAUDE_CODE_USE_FOUNDRY: '1' },
      cloudCredential: 'azure-cli',
    });
    should(edit.summary).equal('Add a Claude Code login raw from its environment');
  });

  it('should refuse a raw key, an unknown preset, a preset of the other tool, and what the preset needs', () => {
    should(
      refusalOf(
        addGlm({ env: { ...GLM_ENV, ANTHROPIC_AUTH_TOKEN: 'sk-ant-api03-abcdefghijklmnopq' } }),
        modelOf(),
        PRESET_FACTS,
      ),
    ).match(/ANTHROPIC_AUTH_TOKEN in login glm looks like a secret/u);
    should(refusalOf(addGlm({ preset: 'nope' }), modelOf(), PRESET_FACTS)).equal('there is no preset nope on studio');
    should(refusalOf(addGlm({ preset: 'zai-glm' }), modelOf(), FACTS)).equal('there is no preset zai-glm on studio');
    should(refusalOf(addGlm({ harness: 'codex' }), modelOf(), PRESET_FACTS)).match(
      /^GLM \/ Z\.ai does not drive Codex: Z\.ai serves the Responses API/u,
    );
    should(
      refusalOf(addGlm({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }), modelOf(), PRESET_FACTS),
    ).match(/ANTHROPIC_AUTH_TOKEN is needed for GLM \/ Z.ai/u);
  });

  it('should refuse a preset, variables or a reference on a login that signs in', () => {
    should(refusalOf({ kind: 'credential.add', id: 'x', harness: 'claude', preset: 'zai-glm' })).equal(
      'a preset, variables and a cloud credential belong only to an environment login',
    );
  });

  it('should change an environment login’s variables, keep a hidden one, and say who starts with them', () => {
    // Arrange
    const model = modelOf({
      credentials: {
        glm: { harness: 'claude', store: 'environment', preset: 'zai-glm', env: GLM_ENV_STORED },
        work: { harness: 'claude', store: 'ferretry' },
      },
      runtimes: { alpha: { credential: 'glm', profile: 'base', agent: false } },
      advanced: {},
    });

    // Act
    const edit = derive(
      {
        kind: 'credential.env',
        id: 'glm',
        env: { ...GLM_ENV_STORED, ANTHROPIC_AUTH_TOKEN: { keep: true }, API_TIMEOUT_MS: '600000' },
      },
      model,
      PRESET_FACTS,
    );

    // Assert
    should(edit.model.credentials.glm?.env).containDeep({
      ANTHROPIC_AUTH_TOKEN: secretRef('ZAI_API_KEY'),
      API_TIMEOUT_MS: '600000',
    });
    should(edit.summary).equal('Change the variables of login glm');
    should(edit.consequences).deepEqual([
      'alpha starts with the new variables next launch. Running sessions keep the old ones until restarted.',
    ]);
  });

  it('should set and remove a cloud credential reference, and empty a login of its variables', () => {
    // Arrange
    const model = modelOf({
      credentials: {
        foundry: {
          harness: 'claude',
          store: 'environment',
          env: { CLAUDE_CODE_USE_FOUNDRY: '1' },
          cloudCredential: 'azure-cli',
        },
      },
      runtimes: {},
      advanced: {},
    });

    // Act
    const kept = derive(
      { kind: 'credential.env', id: 'foundry', env: { CLAUDE_CODE_USE_FOUNDRY: '1' } },
      model,
      PRESET_FACTS,
    );
    const removed = refusalOf(
      { kind: 'credential.env', id: 'foundry', env: {}, cloudCredential: null },
      model,
      PRESET_FACTS,
    );
    const emptied = derive({ kind: 'credential.env', id: 'foundry', env: {} }, model, PRESET_FACTS);
    const unset = derive(
      { kind: 'credential.env', id: 'foundry', env: { CLAUDE_CODE_USE_FOUNDRY: '1' }, cloudCredential: null },
      model,
      PRESET_FACTS,
    );

    // Assert
    should(kept.model.credentials.foundry?.cloudCredential).equal('azure-cli');
    should(kept.consequences).matchAny(/never written anywhere/u);
    should(removed).match(/must say which variables/u);
    should(emptied.model.credentials.foundry).not.have.property('env');
    should(unset.model.credentials.foundry).not.have.property('cloudCredential');
  });

  it('should refuse to change the variables of a login that signs in, or of no login', () => {
    should(refusalOf({ kind: 'credential.env', id: 'work', env: { A: '1' } })).match(
      /is signed in, not made from environment variables/u,
    );
    should(refusalOf({ kind: 'credential.env', id: 'nobody', env: {} })).equal(
      'no login nobody exists on this machine',
    );
  });

  it('should refuse a change that leaves a preset login without what the preset needs', () => {
    const model = modelOf({
      credentials: { glm: { harness: 'claude', store: 'environment', preset: 'zai-glm', env: GLM_ENV_STORED } },
      runtimes: {},
      advanced: {},
    });
    should(
      refusalOf(
        { kind: 'credential.env', id: 'glm', env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } },
        model,
        PRESET_FACTS,
      ),
    ).match(/ANTHROPIC_AUTH_TOKEN is needed/u);
    should(
      refusalOf(
        { kind: 'credential.env', id: 'glm', env: { ...GLM_ENV_STORED, EXTRA: 'sk-ant-api03-abcdefghijklmnopq' } },
        model,
        PRESET_FACTS,
      ),
    ).match(/looks like a secret/u);
  });
});

const GLM_ENV_STORED = {
  ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
  ANTHROPIC_AUTH_TOKEN: secretRef('ZAI_API_KEY'),
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
};

describe('deriveAccountChange: a login that drives both CLIs (docs/provider-presets.md)', () => {
  const PRESET_FACTS: AccountChangeFacts = { ...FACTS, presets: builtInPresets() };
  const DUAL = {
    harness: 'claude',
    store: 'environment',
    preset: 'deepseek',
    env: { API_TIMEOUT_MS: '600000' },
    claude: {
      env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: secretRef('DEEPSEEK_API_KEY'),
        ANTHROPIC_MODEL: 'deepseek-flash[1m]',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
      },
    },
    codex: {
      env: { DEEPSEEK_API_KEY: secretRef('DEEPSEEK_API_KEY') },
      codexProvider: {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/',
        keyVariable: 'DEEPSEEK_API_KEY',
      },
    },
  };
  const dualModel = (runtimes: Record<string, unknown> = {}): AccountModel =>
    modelOf({
      credentials: { deepseek: DUAL, work: { harness: 'claude', store: 'ferretry' } },
      runtimes,
      advanced: {},
    });

  it('should put each edited variable back where it belongs: shared, its half, or the half the preset names', () => {
    // Act
    const edit = derive(
      {
        kind: 'credential.env',
        id: 'deepseek',
        env: {
          API_TIMEOUT_MS: '900000',
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: { keep: true },
          ANTHROPIC_MODEL: 'deepseek-v4-pro',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
          CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
          DEEPSEEK_API_KEY: { keep: true },
          EXTRA_HEADER: 'x',
        },
      },
      dualModel(),
      PRESET_FACTS,
    );

    // Assert
    const login = edit.model.credentials.deepseek;
    should(login?.env).deepEqual({ API_TIMEOUT_MS: '900000', EXTRA_HEADER: 'x' });
    should(login?.claude?.env).deepEqual({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: secretRef('DEEPSEEK_API_KEY'),
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
    });
    should(login?.codex?.env).deepEqual({ DEEPSEEK_API_KEY: secretRef('DEEPSEEK_API_KEY') });
    should(login?.codex?.codexProvider?.id).equal('deepseek');
  });

  it('should put a new variable the preset declares in its half', () => {
    // Arrange: a login whose Claude half lost a variable by hand, and that shares none
    const model = modelOf({
      credentials: {
        deepseek: {
          harness: DUAL.harness,
          store: DUAL.store,
          preset: DUAL.preset,
          claude: {
            env: Object.fromEntries(Object.entries(DUAL.claude.env).filter(([name]) => name !== 'ANTHROPIC_BASE_URL')),
          },
          codex: { env: { DEEPSEEK_API_KEY: secretRef('DEEPSEEK_API_KEY') } },
        },
      },
      runtimes: {},
      advanced: {},
    });

    // Act
    const edit = derive(
      {
        kind: 'credential.env',
        id: 'deepseek',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: { keep: true },
          ANTHROPIC_MODEL: 'deepseek-flash[1m]',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
          CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
          DEEPSEEK_API_KEY: { keep: true },
        },
      },
      model,
      PRESET_FACTS,
    );

    // Assert
    const login = edit.model.credentials.deepseek;
    should(login?.env).be.undefined();
    should(login?.claude?.env?.ANTHROPIC_BASE_URL).equal('https://api.deepseek.com/anthropic');
    should(login?.codex?.env).deepEqual({ DEEPSEEK_API_KEY: secretRef('DEEPSEEK_API_KEY') });
  });

  it('should share a new variable of a login with no preset, and leave a half with no variables none', () => {
    // Arrange: Claude Code through a gateway, Codex on its own Ollama provider
    const model = modelOf({
      credentials: {
        local: {
          harness: 'claude',
          store: 'environment',
          claude: { env: { ANTHROPIC_BASE_URL: 'http://localhost:4000' } },
          codex: { env: { OLLAMA_HOST: 'localhost' }, codexProvider: { id: 'ollama' } },
        },
      },
      runtimes: {},
      advanced: {},
    });

    // Act
    const edit = derive(
      { kind: 'credential.env', id: 'local', env: { ANTHROPIC_BASE_URL: 'http://localhost:4001', TZ: 'UTC' } },
      model,
      PRESET_FACTS,
    );

    // Assert
    const login = edit.model.credentials.local;
    should(login?.env).deepEqual({ TZ: 'UTC' });
    should(login?.claude?.env).deepEqual({ ANTHROPIC_BASE_URL: 'http://localhost:4001' });
    should(login?.codex).deepEqual({ codexProvider: { id: 'ollama' } });
  });

  it('should refuse an edit that drops what one of its halves needs', () => {
    should(
      refusalOf(
        {
          kind: 'credential.env',
          id: 'deepseek',
          env: { ...DUAL.claude.env, ANTHROPIC_AUTH_TOKEN: { keep: true } },
        },
        dualModel(),
        PRESET_FACTS,
      ),
    ).equal('DEEPSEEK_API_KEY is needed for DeepSeek — fill it in');
  });

  it('should judge a one-CLI login only by the half it has, after its preset grew another', () => {
    // Arrange: a Claude Code login made from deepseek before the preset had a Codex half
    const model = modelOf({
      credentials: { deepseek: { harness: 'claude', store: 'environment', preset: 'deepseek', env: DUAL.claude.env } },
      runtimes: {},
      advanced: {},
    });

    // Act
    const edit = derive(
      { kind: 'credential.env', id: 'deepseek', env: { ...DUAL.claude.env, ANTHROPIC_MODEL: 'deepseek-v4-pro' } },
      model,
      PRESET_FACTS,
    );

    // Assert
    should(edit.model.credentials.deepseek?.env?.ANTHROPIC_MODEL).equal('deepseek-v4-pro');
    should(edit.model.credentials.deepseek?.codex).be.undefined();
  });

  it('should run a runtime on the CLI it asks for, and keep that choice', () => {
    // Act
    const edit = derive(
      {
        kind: 'runtime.put',
        name: 'deep-codex',
        credential: 'deepseek',
        profile: 'base',
        harness: 'codex',
        agent: true,
        create: true,
      },
      dualModel(),
      PRESET_FACTS,
    );

    // Assert
    should(edit.model.runtimes['deep-codex']).deepEqual({
      credential: 'deepseek',
      profile: 'base',
      agent: true,
      harness: 'codex',
    });
  });

  it('should run a Codex-only profile on the Codex half without being asked', () => {
    // Act
    const edit = derive(
      { kind: 'runtime.put', name: 'deep', credential: 'deepseek', profile: 'only-codex', agent: false, create: true },
      dualModel(),
      PRESET_FACTS,
    );

    // Assert
    should(edit.model.runtimes.deep).deepEqual({ credential: 'deepseek', profile: 'only-codex', agent: false });
  });

  it('should refuse a CLI the login does not drive, and a profile of the other CLI when one is pinned', () => {
    should(
      refusalOf(
        {
          kind: 'runtime.put',
          name: 'w',
          credential: 'work',
          profile: 'base',
          harness: 'codex',
          agent: false,
          create: true,
        },
        dualModel(),
        PRESET_FACTS,
      ),
    ).equal('work does not drive Codex: it is a Claude Code login.');
    should(
      refusalOf(
        {
          kind: 'runtime.put',
          name: 'deep',
          credential: 'deepseek',
          profile: 'only-codex',
          harness: 'claude',
          agent: false,
          create: true,
        },
        dualModel(),
        PRESET_FACTS,
      ),
    ).equal(
      'Profile only-codex is Codex only and this runtime runs Claude Code on deepseek. Run it on the other CLI, or pick a Generic or Claude only profile.',
    );
  });
});

describe('deriveAccountChange: a new environment login is never made the default', () => {
  it('should leave the machine default runtime, every runtime and every other login exactly as they were', () => {
    // Arrange
    const model = modelOf({ machine: { defaultRuntime: 'beta' } });

    // Act
    const edit = derive(
      {
        kind: 'credential.add',
        id: 'deepseek',
        harness: 'claude',
        store: 'environment',
        preset: 'deepseek',
        env: {
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: secretRef('DEEPSEEK_API_KEY'),
          ANTHROPIC_MODEL: 'deepseek-flash[1m]',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
          CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
          DEEPSEEK_API_KEY: secretRef('DEEPSEEK_API_KEY'),
        },
      },
      model,
      { ...FACTS, presets: builtInPresets() },
    );

    // Assert
    should(edit.model.machine).deepEqual(model.machine);
    should(edit.model.runtimes).deepEqual(model.runtimes);
    const { deepseek, ...others } = edit.model.credentials;
    should(deepseek).not.be.undefined();
    should(others).deepEqual(model.credentials);
  });
});

describe('deriveAccountChange: disable and enable', () => {
  it('should disable a login with a reason and an until, and say nothing running is stopped', () => {
    // Act
    const edit = derive({
      kind: 'credential.disable',
      id: 'work',
      reason: 'spend limit',
      until: '2026-11-01T00:00:00.000Z',
    });

    // Assert
    should(edit.summary).equal('Disable login work');
    should(edit.model.credentials.work?.disabled).eql({ reason: 'spend limit', until: '2026-11-01T00:00:00.000Z' });
    should(edit.consequences.join(' ')).match(/keep going \(move one with `migrate <id> -a <other runtime>`\)/u);
  });

  it('should disable a login with no reason or until at all', () => {
    should(derive({ kind: 'credential.disable', id: 'work' }).model.credentials.work?.disabled).eql({});
  });

  it('should enable a login by taking the block away', () => {
    // Arrange
    const model = modelOf({
      credentials: {
        'my-claude': { harness: 'claude', store: 'host' },
        work: { harness: 'claude', store: 'ferretry', label: 'Work', disabled: { reason: 'x' } },
        home: { harness: 'claude', store: 'ferretry', label: 'Home' },
      },
    });

    // Act
    const edit = derive({ kind: 'credential.enable', id: 'work' }, model);

    // Assert
    should(edit.summary).equal('Enable login work');
    should(edit.model.credentials.work?.disabled).be.undefined();
  });

  it('should disable and enable a runtime, keeping the switch through a rewrite of it', () => {
    // Act
    const off = derive({ kind: 'runtime.disable', name: 'beta', reason: 'paused' });
    const again = derive(
      runtimePut({ name: 'beta', credential: 'home', profile: 'base', agent: true, create: false }),
      off.model,
    );

    // Assert
    should(off.summary).equal('Disable runtime beta');
    should(off.model.runtimes.beta?.disabled).eql({ reason: 'paused' });
    should(off.consequences.join(' ')).match(/ferrets already on this runtime keep going/u);
    should(again.model.runtimes.beta?.disabled).eql({ reason: 'paused' });
    should(derive({ kind: 'runtime.enable', name: 'beta' }, off.model).model.runtimes.beta?.disabled).be.undefined();
  });

  it('should warn that an enabled runtime stays off while its login is disabled', () => {
    // Arrange
    const model = modelOf({
      credentials: {
        'my-claude': { harness: 'claude', store: 'host' },
        work: { harness: 'claude', store: 'ferretry', label: 'Work', disabled: {} },
        home: { harness: 'claude', store: 'ferretry', label: 'Home' },
      },
    });

    // Act
    const edit = derive({ kind: 'runtime.enable', name: 'alpha' }, model);

    // Assert
    should(edit.consequences).containEql(
      'Its login work is still disabled, so alpha stays off until that is enabled too.',
    );
  });

  it('should refuse a login or runtime that does not exist', () => {
    should(refusalOf({ kind: 'credential.disable', id: 'ghost' })).equal('no login ghost exists on this machine');
    should(refusalOf({ kind: 'credential.enable', id: 'ghost' })).equal('no login ghost exists on this machine');
    should(refusalOf({ kind: 'runtime.disable', name: 'ghost' })).equal('no runtime ghost exists on this machine');
    should(refusalOf({ kind: 'runtime.enable', name: 'ghost' })).equal('no runtime ghost exists on this machine');
  });
});
