import { describe, it } from 'bun:test';
import { type AccountModel, parseAccountModel } from '@ferretry/fleet';
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

  it('should refuse a profile with nothing for the login’s harness (P5, E14)', () => {
    // Act + Assert
    should(refusalOf(runtimePut({ profile: 'only-codex' }))).equal(
      'Nothing in profile only-codex applies on Claude Code. Pick a different profile.',
    );
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

  it('should remove a login Ferretry signed in and say it stays until signed out', () => {
    // Act
    const edit = derive({ kind: 'credential.remove', id: 'spare' });

    // Assert
    should(edit.model.credentials.spare).be.undefined();
    should(edit.consequences).deepEqual(['Its saved login stays on this machine until you sign it out.']);
  });

  it('should say nothing about a login kept in the environment', () => {
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
    should(edit.consequences).deepEqual([]);
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

describe('deriveAccountChange: machine.settings', () => {
  it('should apply to new sessions when none is running', () => {
    // Act
    const edit = derive({ kind: 'machine.settings', agentPermissions: 'skip' });

    // Assert
    should(edit.summary).equal('Set agent permissions to Skip all permission checks');
    should(edit.model.machine.agentPermissions).equal('skip');
    should(edit.consequences).deepEqual(['Applies to new sessions.']);
  });

  it('should say one running session keeps the old mode (E32)', () => {
    // Act
    const edit = derive({ kind: 'machine.settings', agentPermissions: 'skip' }, modelOf(), {
      ...FACTS,
      runningSessions: 1,
    });

    // Assert
    should(edit.consequences).deepEqual([
      'Applies to new sessions. 1 running session keeps the old mode (Auto mode) until restarted.',
    ]);
  });

  it('should say several running sessions keep the old mode (E32)', () => {
    // Arrange
    const model = modelOf({ machine: { agentPermissions: 'skip' } });

    // Act
    const edit = derive({ kind: 'machine.settings', agentPermissions: 'auto' }, model, {
      ...FACTS,
      runningSessions: 3,
    });

    // Assert
    should(edit.summary).equal('Set agent permissions to Auto mode');
    should(edit.consequences).deepEqual([
      'Applies to new sessions. 3 running sessions keep the old mode (Skip all permission checks) until restarted.',
    ]);
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
