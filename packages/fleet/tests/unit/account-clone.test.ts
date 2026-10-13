import { describe, it } from 'bun:test';
import { type FleetCloneBundle, FleetCloneBundleSchema, secretReference } from '@ferretry/protocol';
import should from 'should';
import {
  buildCloneBundle,
  type CloneOptions,
  CloneRefusal,
  cloneSources,
  describeClone,
  parseCloneBundle,
  planClone,
} from '../../src/lib/account/clone.ts';
import { type AccountModel, parseAccountModel } from '../../src/lib/account/schema.ts';

const EXPORTED_AT = '2026-10-13T09:00:00Z';

/** A model with a little of everything a clone has to carry, so a test only varies what it is about. */
const sourceModel = (): AccountModel =>
  parseAccountModel({
    version: 2,
    credentials: {
      'claude-you': { harness: 'claude', store: 'host' },
      'codex-work': { harness: 'codex', store: 'ferretry', label: 'work' },
      'claude-spare': { harness: 'claude', store: 'ferretry', label: 'spare' },
    },
    components: {
      instructions: {
        main: { file: 'components/instructions/main.md' },
        outside: { file: '/etc/ferretry/rules.md' },
      },
      settings: {
        claude: { harness: 'claude', file: 'components/settings/claude.json' },
        flags: { harness: 'claude', flags: ['--verbose'] },
      },
      hooks: {
        guard: { harness: 'claude', file: 'components/hooks/guard.json' },
        scripts: { harness: 'claude', directory: 'components/hooks/scripts' },
        away: { harness: 'codex', directory: '~/hooks' },
      },
      skills: { mine: { items: ['review', 'notes'] } },
      modelSets: { heavy: { models: ['claude-opus-5-5', 'claude-sonnet-5'], default: 'claude-opus-5-5' } },
    },
    profiles: {
      default: { layers: ['instructions/main', 'modelSets/heavy'] },
      agent: { layers: ['profile/default', 'skills/mine'] },
    },
    runtimes: {
      'claude-default': { credential: 'claude-you', profile: 'default' },
      'codex-agent': { credential: 'codex-work', profile: 'agent', agent: true },
      'codex-extra': { credential: 'codex-work', profile: 'default' },
    },
  });

const emptyTarget = (patch: Record<string, unknown> = {}): AccountModel => parseAccountModel({ version: 2, ...patch });

const options = (patch: Partial<CloneOptions> = {}): CloneOptions => ({
  mode: 'alongside',
  machine: 'work-linux',
  installed: ['claude', 'codex'],
  existingSkillItems: [],
  existingSecrets: [],
  ...patch,
});

/** A hand-written bundle, so a test can damage exactly one field. */
const bundleWith = (patch: Record<string, unknown> = {}): FleetCloneBundle =>
  FleetCloneBundleSchema.parse({
    format: 'ferretry-clone',
    version: 1,
    machine: 'studio-mac',
    exportedAt: EXPORTED_AT,
    credentials: [{ id: 'claude-you', harness: 'claude', label: 'you', email: 'person@example.test' }],
    components: { instructions: { main: { file: 'components/instructions/main.md' } } },
    profiles: { default: { layers: ['instructions/main'] } },
    runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: false } },
    files: [{ path: 'components/instructions/main.md', content: '# Main' }],
    notCopied: [],
    ...patch,
  });

const refusalOf = (action: () => unknown): CloneRefusal => {
  try {
    action();
  } catch (error) {
    should(error).be.instanceOf(CloneRefusal);
    return error as CloneRefusal;
  }
  throw new Error('expected a CloneRefusal');
};

describe('cloneSources', () => {
  it('should split asset-relative documents from folders and from paths outside the asset tree', () => {
    // Act
    const actual = cloneSources(sourceModel());

    // Assert
    should(actual.documents).deepEqual([
      'components/hooks/guard.json',
      'components/instructions/main.md',
      'components/settings/claude.json',
    ]);
    should(actual.directories).deepEqual(['components/hooks/scripts', 'skills/notes', 'skills/review']);
    should(actual.outside).deepEqual(['/etc/ferretry/rules.md', '~/hooks']);
  });

  it('should treat a home, a variable and a climbing path as outside the asset tree', () => {
    // Arrange
    const model = parseAccountModel({
      version: 2,
      components: {
        instructions: {
          a: { file: '~/a.md' },
          b: { file: '$HOME/b.md' },
          c: { file: 'components/../../c.md' },
        },
      },
    });

    // Act
    const actual = cloneSources(model);

    // Assert
    should(actual.documents).deepEqual([]);
    should(actual.outside).deepEqual(['$HOME/b.md', 'components/../../c.md', '~/a.md']);
  });

  it('should list nothing for a model with no components', () => {
    // Act
    const actual = cloneSources(emptyTarget());

    // Assert
    should(actual).deepEqual({ documents: [], directories: [], outside: [] });
  });
});

describe('buildCloneBundle', () => {
  it('should carry only the logins a runtime uses, as descriptors with the email and label that are known', () => {
    // Act
    const bundle = buildCloneBundle({
      model: sourceModel(),
      machine: 'studio-mac',
      exportedAt: EXPORTED_AT,
      emails: { 'claude-you': 'person@example.test', 'claude-spare': 'spare@example.test' },
      files: [{ path: 'components/instructions/main.md', content: '# Main' }],
      notCopied: [{ path: '/etc/ferretry/rules.md', reason: 'outside the asset tree' }],
    });

    // Assert
    should(bundle.credentials).deepEqual([
      { id: 'claude-you', harness: 'claude', email: 'person@example.test' },
      { id: 'codex-work', harness: 'codex', label: 'work' },
    ]);
    should(bundle.format).equal('ferretry-clone');
    should(bundle.machine).equal('studio-mac');
    should(Object.keys(bundle.runtimes)).deepEqual(['claude-default', 'codex-agent', 'codex-extra']);
    should(Object.keys(bundle.profiles)).deepEqual(['default', 'agent']);
    should(bundle.files).deepEqual([{ path: 'components/instructions/main.md', content: '# Main' }]);
    should(bundle.notCopied).deepEqual([{ path: '/etc/ferretry/rules.md', reason: 'outside the asset tree' }]);
  });

  it('should carry no credential value, no store and no history anywhere in the bundle', () => {
    // Arrange
    const model = parseAccountModel({
      version: 2,
      credentials: {
        keyed: {
          harness: 'claude',
          store: 'environment',
          env: { ANTHROPIC_API_KEY: secretReference('ANTHROPIC_API_KEY') },
        },
      },
      profiles: { default: { layers: [] } },
      runtimes: { keyed: { credential: 'keyed', profile: 'default' } },
    });

    // Act
    const text = JSON.stringify(
      buildCloneBundle({ model, machine: 'studio-mac', exportedAt: EXPORTED_AT, emails: {}, files: [], notCopied: [] }),
    );

    // Assert
    should(text).not.containEql('ANTHROPIC_API_KEY');
    should(text).not.containEql('environment');
    should(text).not.containEql('"store"');
  });

  it('should round-trip through parseCloneBundle', () => {
    // Arrange
    const bundle = buildCloneBundle({
      model: sourceModel(),
      machine: 'studio-mac',
      exportedAt: EXPORTED_AT,
      emails: {},
      files: [],
      notCopied: [],
    });

    // Act
    const actual = parseCloneBundle(JSON.parse(JSON.stringify(bundle)));

    // Assert
    should(actual).deepEqual(bundle);
  });
});

describe('parseCloneBundle', () => {
  it('should refuse input that is not a setup Ferretry exported, in a sentence', () => {
    // Act
    const refusal = refusalOf(() => parseCloneBundle({ format: 'something-else' }));

    // Assert
    should(refusal.name).equal('CloneRefusal');
    should(refusal.message).containEql('not a setup exported by Ferretry');
  });

  it('should refuse a bundle of a version this machine cannot read', () => {
    // Act
    const refusal = refusalOf(() => parseCloneBundle({ ...bundleWith(), version: 2 }));

    // Assert
    should(refusal.message).containEql('version this machine cannot read');
  });
});

describe('planClone alongside', () => {
  it('should copy onto an empty machine under the same names, each login an empty slot that keeps its label', () => {
    // Arrange
    const bundle = buildCloneBundle({
      model: sourceModel(),
      machine: 'studio-mac',
      exportedAt: EXPORTED_AT,
      emails: { 'claude-you': 'person@example.test' },
      files: [{ path: 'components/instructions/main.md', content: '# Main' }],
      notCopied: [{ path: '/etc/ferretry/rules.md', reason: 'outside the asset tree' }],
    });

    // Act
    const plan = planClone(emptyTarget(), parseCloneBundle(bundle), options());

    // Assert
    should(plan.renamed).deepEqual([]);
    should(Object.keys(plan.model.runtimes)).deepEqual(['claude-default', 'codex-agent', 'codex-extra']);
    should(plan.model.runtimes['codex-agent']).deepEqual({ credential: 'codex-work', profile: 'agent', agent: true });
    should(plan.model.credentials['claude-you']).deepEqual({
      harness: 'claude',
      store: 'ferretry',
      label: 'person@example.test',
      clonedFrom: 'studio-mac',
    });
    should(plan.model.credentials['codex-work']).deepEqual({
      harness: 'codex',
      store: 'ferretry',
      label: 'work',
      clonedFrom: 'studio-mac',
    });
    should(plan.slots).deepEqual([
      { id: 'claude-you', harness: 'claude', email: 'person@example.test', runtimes: ['claude-default'] },
      { id: 'codex-work', harness: 'codex', label: 'work', runtimes: ['codex-agent', 'codex-extra'] },
    ]);
    should(plan.files).deepEqual([{ path: 'components/instructions/main.md', content: '# Main' }]);
    should(plan.copied).deepEqual({ components: 8, modelSets: 1, profiles: 2, runtimes: 3 });
    should(plan.removed).deepEqual({ components: 0, profiles: 0, runtimes: 0 });
    should(plan.notCopied).deepEqual([{ path: '/etc/ferretry/rules.md', reason: 'outside the asset tree' }]);
    should(plan.missingHarnesses).deepEqual([]);
    should(plan.missingSecrets).deepEqual([]);
    should(plan.keptSkillItems).deepEqual([]);
    should(plan.checkPaths).deepEqual([]);
  });

  it('should give a clashing component, profile, runtime and login the next free name and follow it everywhere', () => {
    // Arrange
    const target = emptyTarget({
      credentials: { 'claude-you': { harness: 'claude', store: 'host' } },
      components: { instructions: { main: { file: 'components/instructions/main.md' } } },
      profiles: { default: { layers: ['instructions/main'] } },
      runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default' } },
    });
    const bundle = bundleWith({
      components: {
        instructions: { main: { file: 'components/instructions/main.md' } },
        settings: { tune: { harness: 'claude', flags: ['--verbose'] } },
      },
      profiles: {
        default: { layers: ['instructions/main'] },
        agent: { layers: ['profile/default', 'settings/tune'] },
      },
      runtimes: {
        'claude-default': { credential: 'claude-you', profile: 'default', agent: false },
        'claude-agent': { credential: 'claude-you', profile: 'agent', agent: true },
      },
    });

    // Act
    const plan = planClone(target, bundle, options());

    // Assert
    should(plan.renamed).deepEqual([
      { what: 'login', from: 'claude-you', to: 'claude-you-2' },
      { what: 'component', from: 'instructions/main', to: 'instructions/main-2' },
      { what: 'profile', from: 'default', to: 'default-2' },
      { what: 'runtime', from: 'claude-default', to: 'claude-default-2' },
    ]);
    should(plan.model.components.instructions['main-2']).deepEqual({ file: 'components/instructions/main-2.md' });
    should(plan.model.components.instructions.main).deepEqual({ file: 'components/instructions/main.md' });
    should(plan.model.profiles['default-2']).deepEqual({ layers: ['instructions/main-2'] });
    should(plan.model.profiles.agent).deepEqual({ layers: ['profile/default-2', 'settings/tune'] });
    should(plan.model.runtimes['claude-default-2']).deepEqual({
      credential: 'claude-you-2',
      profile: 'default-2',
      agent: false,
    });
    should(plan.model.runtimes['claude-agent']).deepEqual({
      credential: 'claude-you-2',
      profile: 'agent',
      agent: true,
    });
    should(plan.model.runtimes['claude-default']).deepEqual({
      credential: 'claude-you',
      profile: 'default',
      agent: false,
    });
    should(plan.model.credentials['claude-you']).deepEqual({ harness: 'claude', store: 'host' });
    should(plan.slots.map(slot => [slot.id, slot.runtimes])).deepEqual([
      ['claude-you-2', ['claude-default-2', 'claude-agent']],
    ]);
  });

  it('should never give two copied profiles the same free name', () => {
    // Arrange: the target has "a"; the bundle carries "a" and "a-2".
    const target = emptyTarget({
      components: { instructions: { t: { file: 'components/instructions/t.md' } } },
      profiles: { a: { layers: ['instructions/t'] } },
    });
    const bundle = bundleWith({
      profiles: { a: { layers: ['instructions/main'] }, 'a-2': { layers: ['instructions/main'] } },
      runtimes: { 'claude-default': { credential: 'claude-you', profile: 'a-2', agent: false } },
    });

    // Act
    const plan = planClone(target, bundle, options());

    // Assert: three profiles, none overwritten, and the runtime follows its own profile.
    should(Object.keys(plan.model.profiles).toSorted()).deepEqual(['a', 'a-2', 'a-2-2']);
    should(plan.model.profiles.a?.layers).deepEqual(['instructions/t']);
    should(plan.model.runtimes['claude-default']?.profile).equal('a-2-2');
  });

  it('should move a renamed component document to a free path and never overwrite the target one', () => {
    // Arrange
    const target = emptyTarget({
      components: { instructions: { main: { file: 'components/instructions/main.md' } } },
    });
    const bundle = bundleWith({
      profiles: {},
      runtimes: {},
      credentials: [],
      files: [
        { path: 'components/instructions/main.md', content: 'from the source' },
        { path: 'components/other.md', content: 'untouched' },
      ],
    });

    // Act
    const plan = planClone(target, bundle, options());

    // Assert
    should(plan.model.components.instructions['main-2']?.file).equal('components/instructions/main-2.md');
    should(plan.files).deepEqual([
      { path: 'components/instructions/main-2.md', content: 'from the source' },
      { path: 'components/other.md', content: 'untouched' },
    ]);
  });

  it('should find a free stem when the renamed document name is taken too or does not follow the component name', () => {
    // Arrange
    const target = emptyTarget({
      components: {
        instructions: {
          main: { file: 'components/instructions/main.md' },
          'main-2': { file: 'components/instructions/main-2.md' },
          notes: { file: 'shared/notes.md' },
          plain: { file: 'shared/plain' },
        },
      },
    });
    const bundle = bundleWith({
      components: {
        instructions: {
          main: { file: 'components/instructions/main.md' },
          notes: { file: 'shared/rules.md' },
          plain: { file: 'shared/plain' },
          dotted: { file: 'v1.0/dotted' },
        },
      },
      profiles: {},
      runtimes: {},
      credentials: [],
      files: [],
    });

    // Act
    const plan = planClone(target, bundle, options());

    // Assert
    should(plan.model.components.instructions['main-3']?.file).equal('components/instructions/main-3.md');
    should(plan.model.components.instructions['notes-2']?.file).equal('shared/rules.md');
    should(plan.model.components.instructions['plain-2']?.file).equal('shared/plain-2');
    should(plan.model.components.instructions.dotted?.file).equal('v1.0/dotted');
  });

  it('should send two components that share one document to one moved copy', () => {
    // Arrange
    const target = emptyTarget({ components: { instructions: { main: { file: 'components/shared.md' } } } });
    const bundle = bundleWith({
      components: {
        instructions: { first: { file: 'components/shared.md' }, second: { file: 'components/shared.md' } },
      },
      profiles: {},
      runtimes: {},
      credentials: [],
      files: [{ path: 'components/shared.md', content: 'shared' }],
    });

    // Act
    const plan = planClone(target, bundle, options());

    // Assert
    should(plan.model.components.instructions.first?.file).equal('components/shared-2.md');
    should(plan.model.components.instructions.second?.file).equal('components/shared-2.md');
    should(plan.files).deepEqual([{ path: 'components/shared-2.md', content: 'shared' }]);
  });

  it('should leave a path outside the asset tree and a hooks folder exactly as they were', () => {
    // Arrange
    const bundle = bundleWith({
      components: {
        instructions: { rules: { file: '/etc/ferretry/rules.md' } },
        hooks: { scripts: { harness: 'claude', directory: 'components/hooks/scripts' } },
      },
      profiles: {},
      runtimes: {},
      credentials: [],
      files: [{ path: 'components/hooks/scripts/guard.sh', content: '#!/bin/sh' }],
    });

    // Act
    const plan = planClone(emptyTarget(), bundle, options());

    // Assert
    should(plan.model.components.instructions.rules?.file).equal('/etc/ferretry/rules.md');
    should(plan.model.components.hooks.scripts?.directory).equal('components/hooks/scripts');
    should(plan.files).deepEqual([{ path: 'components/hooks/scripts/guard.sh', content: '#!/bin/sh' }]);
  });

  it('should keep a skill the target already holds, drop its files and say so', () => {
    // Arrange
    const bundle = bundleWith({
      components: { skills: { mine: { items: ['review', 'notes'] } } },
      profiles: {},
      runtimes: {},
      credentials: [],
      files: [
        { path: 'skills/review/SKILL.md', content: 'their review' },
        { path: 'skills/notes/SKILL.md', content: 'new notes' },
      ],
    });

    // Act
    const plan = planClone(emptyTarget(), bundle, options({ existingSkillItems: ['review'] }));

    // Assert
    should(plan.keptSkillItems).deepEqual(['review']);
    should(plan.files).deepEqual([{ path: 'skills/notes/SKILL.md', content: 'new notes' }]);
    should(plan.model.components.skills.mine).deepEqual({ items: ['review', 'notes'] });
  });

  it('should flag a path under /Users or /home in a component or in its document, once per component', () => {
    // Arrange
    const bundle = bundleWith({
      components: {
        instructions: { rules: { file: 'components/instructions/rules.md' } },
        mcp: { notes: { command: 'node', args: ['/Users/person/notes/server.js', '/home/person/other'] } },
        settings: { calm: { harness: 'claude', flags: ['--verbose'] } },
      },
      profiles: {},
      runtimes: {},
      credentials: [],
      files: [{ path: 'components/instructions/rules.md', content: 'Read "/home/person/docs/style.md" first.' }],
    });

    // Act
    const plan = planClone(emptyTarget(), bundle, options());

    // Assert
    should(plan.checkPaths).deepEqual([
      { reference: 'instructions/rules', path: '/home/person/docs/style.md' },
      { reference: 'mcp/notes', path: '/Users/person/notes/server.js' },
    ]);
  });

  it('should name a harness the target lacks and still copy its runtimes', () => {
    // Arrange
    const bundle = buildCloneBundle({
      model: sourceModel(),
      machine: 'studio-mac',
      exportedAt: EXPORTED_AT,
      emails: {},
      files: [],
      notCopied: [],
    });

    // Act
    const none = planClone(emptyTarget(), bundle, options({ installed: [] }));
    const claudeOnly = planClone(emptyTarget(), bundle, options({ installed: ['claude'] }));

    // Assert
    should(none.missingHarnesses).deepEqual(['claude', 'codex']);
    should(claudeOnly.missingHarnesses).deepEqual(['codex']);
    should(Object.keys(claudeOnly.model.runtimes)).deepEqual(['claude-default', 'codex-agent', 'codex-extra']);
  });

  it('should keep a secret reference as a reference and name the ones the target store lacks', () => {
    // Arrange
    const bundle = bundleWith({
      components: {
        settings: {
          keyed: {
            harness: 'claude',
            env: { ANTHROPIC_API_KEY: secretReference('ANTHROPIC_API_KEY'), TOKEN: secretReference('OTHER_TOKEN') },
          },
        },
        mcp: { notes: { command: 'node', env: { AGAIN: secretReference('ANTHROPIC_API_KEY') } } },
      },
      profiles: {},
      runtimes: {},
      credentials: [],
      files: [],
    });

    // Act
    const plan = planClone(emptyTarget(), bundle, options({ existingSecrets: ['OTHER_TOKEN'] }));

    // Assert
    should(plan.missingSecrets).deepEqual(['ANTHROPIC_API_KEY']);
    should(plan.model.components.settings.keyed?.env?.ANTHROPIC_API_KEY).equal(secretReference('ANTHROPIC_API_KEY'));
  });

  it('should give a runtime a free name when a command wrapper already holds its name', () => {
    // Arrange
    const target = emptyTarget({
      credentials: { you: { harness: 'claude', store: 'host' } },
      profiles: { base: { layers: [] } },
      runtimes: { main: { credential: 'you', profile: 'base' } },
      advanced: { commands: [{ wrapper: 'claude-default', runtime: 'main', flags: ['--fast'] }] },
    });

    // Act
    const plan = planClone(target, bundleWith(), options());

    // Assert
    should(Object.keys(plan.model.runtimes).toSorted()).deepEqual(['claude-default-2', 'main']);
    should(plan.renamed).deepEqual([{ what: 'runtime', from: 'claude-default', to: 'claude-default-2' }]);
    should(plan.model.advanced.commands).deepEqual([{ wrapper: 'claude-default', runtime: 'main', flags: ['--fast'] }]);
  });

  it('should keep a login no runtime uses as a slot with no runtimes', () => {
    // Arrange
    const bundle = bundleWith({
      credentials: [
        { id: 'claude-you', harness: 'claude' },
        { id: 'codex-idle', harness: 'codex' },
      ],
    });

    // Act
    const plan = planClone(emptyTarget(), bundle, options());

    // Assert
    should(plan.slots).deepEqual([
      { id: 'claude-you', harness: 'claude', runtimes: ['claude-default'] },
      { id: 'codex-idle', harness: 'codex', runtimes: [] },
    ]);
    should(plan.model.credentials['codex-idle']).deepEqual({
      harness: 'codex',
      store: 'ferretry',
      clonedFrom: 'studio-mac',
    });
  });

  it('should refuse a damaged bundle whose runtime names a profile it does not carry', () => {
    // Arrange
    const bundle = bundleWith({
      runtimes: { 'claude-default': { credential: 'claude-you', profile: 'ghost', agent: false } },
    });

    // Act
    const refusal = refusalOf(() => planClone(emptyTarget(), bundle, options()));

    // Assert
    should(refusal.message).startWith('The setup from studio-mac cannot be copied: ');
    should(refusal.message).containEql('ghost');
  });

  it('should refuse a damaged bundle whose runtime names a login it does not carry', () => {
    // Arrange
    const bundle = bundleWith({ credentials: [] });

    // Act
    const refusal = refusalOf(() => planClone(emptyTarget(), bundle, options()));

    // Assert
    should(refusal.message).containEql('cannot be copied');
    should(refusal.message).containEql('claude-you');
  });

  it('should refuse a bundle whose components are not a configuration', () => {
    // Arrange
    const bundle = bundleWith({ components: { gadgets: { a: {} } } });

    // Act
    const refusal = refusalOf(() => planClone(emptyTarget(), bundle, options()));

    // Assert
    should(refusal.message).startWith('The setup from studio-mac cannot be copied');
  });

  it('should refuse a merge that would leave the target with a setup it cannot read', () => {
    // Arrange
    const longName = 'r'.repeat(64);
    const target = emptyTarget({
      credentials: { you: { harness: 'claude', store: 'host' } },
      profiles: { base: { layers: [] } },
      runtimes: { [longName]: { credential: 'you', profile: 'base' } },
    });
    const bundle = bundleWith({
      runtimes: { [longName]: { credential: 'claude-you', profile: 'default', agent: false } },
    });

    // Act
    const refusal = refusalOf(() => planClone(target, bundle, options()));

    // Assert
    should(refusal.message).startWith(
      'Copying the setup from studio-mac would leave work-linux with a setup it cannot read',
    );
  });
});

describe('planClone replace', () => {
  const populatedTarget = (): AccountModel =>
    parseAccountModel({
      version: 2,
      credentials: {
        'claude-you': { harness: 'claude', store: 'host', label: 'own' },
        'codex-mine': { harness: 'codex', store: 'ferretry', label: 'mine' },
      },
      components: {
        instructions: {
          main: { file: 'components/instructions/main.md' },
          extra: { file: 'components/instructions/extra.md' },
        },
        modelSets: { local: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
      },
      profiles: { default: { layers: ['instructions/main'] } },
      runtimes: {
        'claude-default': { credential: 'claude-you', profile: 'default' },
        'codex-mine': { credential: 'codex-mine', profile: 'default' },
      },
      advanced: { commands: [{ wrapper: 'fast', runtime: 'claude-default', flags: ['--fast'] }] },
    });

  it('should remove the target components, profiles and runtimes, keep its logins and count what went', () => {
    // Act
    const plan = planClone(populatedTarget(), bundleWith(), options({ mode: 'replace' }));

    // Assert
    should(plan.removed).deepEqual({ components: 3, profiles: 1, runtimes: 2 });
    should(Object.keys(plan.model.components.instructions)).deepEqual(['main']);
    should(plan.model.components.instructions.main).deepEqual({ file: 'components/instructions/main.md' });
    should(plan.model.components.modelSets).deepEqual({});
    should(Object.keys(plan.model.profiles)).deepEqual(['default']);
    should(Object.keys(plan.model.runtimes)).deepEqual(['claude-default']);
    should(plan.model.advanced.commands).deepEqual([]);
    should(plan.model.credentials['codex-mine']).deepEqual({ harness: 'codex', store: 'ferretry', label: 'mine' });
    should(plan.model.credentials['claude-you']).deepEqual({ harness: 'claude', store: 'host', label: 'own' });
    should(plan.renamed).deepEqual([{ what: 'login', from: 'claude-you', to: 'claude-you-2' }]);
    should(plan.model.runtimes['claude-default']).deepEqual({
      credential: 'claude-you-2',
      profile: 'default',
      agent: false,
    });
    should(plan.files).deepEqual([{ path: 'components/instructions/main.md', content: '# Main' }]);
  });

  it('should remove nothing from a target that had nothing', () => {
    // Act
    const plan = planClone(emptyTarget(), bundleWith(), options({ mode: 'replace' }));

    // Assert
    should(plan.removed).deepEqual({ components: 0, profiles: 0, runtimes: 0 });
    should(plan.renamed).deepEqual([]);
  });
});

describe('describeClone', () => {
  const fullBundle = (): FleetCloneBundle =>
    buildCloneBundle({
      model: sourceModel(),
      machine: 'studio-mac',
      exportedAt: EXPORTED_AT,
      emails: { 'claude-you': 'person@example.test' },
      files: [],
      notCopied: [],
    });

  it('should say what is copied, what is not and what to do about each login on a plain copy', () => {
    // Arrange
    const bundle = fullBundle();
    const plan = planClone(emptyTarget(), bundle, options());

    // Act
    const actual = describeClone(plan, bundle, 'work-linux');

    // Assert
    should(actual).deepEqual([
      'Copies 8 components, 1 model set, 2 profiles and 3 runtimes from studio-mac.',
      "Doesn't copy 2 logins: each becomes an empty slot on work-linux that needs sign-in, and its runtimes keep pointing at it — person@example.test (used by 1 runtime), work (used by 2 runtimes).",
      "Doesn't copy history: past sessions stay on studio-mac.",
    ]);
  });

  it('should say a replace removes the target setup first and keeps its logins', () => {
    // Arrange
    const target = parseAccountModel({
      version: 2,
      credentials: { you: { harness: 'claude', store: 'host' } },
      components: { instructions: { main: { file: 'm.md' } } },
      profiles: { base: { layers: ['instructions/main'] } },
      runtimes: { main: { credential: 'you', profile: 'base' } },
    });
    const bundle = bundleWith();
    const plan = planClone(target, bundle, options({ mode: 'replace' }));

    // Act
    const actual = describeClone(plan, bundle, 'work-linux');

    // Assert
    should(actual[0]).equal(
      'Replaces what work-linux has: 1 component, 1 profile and 1 runtime go first. Its logins stay.',
    );
    should(actual[1]).equal('Copies 1 component, 0 model sets, 1 profile and 1 runtime from studio-mac.');
  });

  it('should name a login by its email, then its label, then its id', () => {
    // Arrange
    const bundle = bundleWith({
      credentials: [
        { id: 'claude-you', harness: 'claude', email: 'person@example.test' },
        { id: 'codex-a', harness: 'codex', label: 'work' },
        { id: 'codex-b', harness: 'codex' },
      ],
    });
    const plan = planClone(emptyTarget(), bundle, options());

    // Act
    const actual = describeClone(plan, bundle, 'work-linux');

    // Assert
    should(actual[1]).containEql(
      'person@example.test (used by 1 runtime), work (used by 0 runtimes), codex-b (used by 0 runtimes).',
    );
  });

  it('should skip the login sentence when no login travels', () => {
    // Arrange
    const bundle = bundleWith({ credentials: [], profiles: {}, runtimes: {}, components: {}, files: [] });
    const plan = planClone(emptyTarget(), bundle, options());

    // Act
    const actual = describeClone(plan, bundle, 'work-linux');

    // Assert
    should(actual).deepEqual([
      'Copies 0 components, 0 model sets, 0 profiles and 0 runtimes from studio-mac.',
      "Doesn't copy history: past sessions stay on studio-mac.",
    ]);
  });

  it('should list renames other than logins, paths to check, missing harnesses, secrets, kept skills and documents left behind', () => {
    // Arrange
    const target = emptyTarget({
      credentials: { 'claude-you': { harness: 'claude', store: 'host' } },
      components: { instructions: { main: { file: 'components/instructions/main.md' } } },
    });
    const bundle = bundleWith({
      credentials: [
        { id: 'claude-you', harness: 'claude' },
        { id: 'codex-work', harness: 'codex' },
      ],
      components: {
        instructions: { main: { file: 'components/instructions/main.md' } },
        mcp: {
          notes: {
            command: 'node',
            args: ['/Users/person/server.js'],
            env: { A: secretReference('KEY_ONE'), B: secretReference('KEY_TWO') },
          },
        },
        skills: { mine: { items: ['review'] } },
      },
      profiles: { default: { layers: ['instructions/main', 'mcp/notes', 'skills/mine'] } },
      runtimes: {
        'claude-default': { credential: 'claude-you', profile: 'default', agent: false },
        'codex-default': { credential: 'codex-work', profile: 'default', agent: false },
      },
      files: [{ path: 'skills/review/SKILL.md', content: 'x' }],
      notCopied: [{ path: 'big.bin', reason: 'too large' }],
    });
    const plan = planClone(target, bundle, options({ installed: [], existingSkillItems: ['review'] }));

    // Act
    const actual = describeClone(plan, bundle, 'work-linux');

    // Assert
    should(actual).containEql('1 name already used here got a new one: instructions/main → instructions/main-2.');
    should(actual).containEql('Check after copying: mcp/notes names /Users/person/server.js.');
    should(actual).containEql("Claude Code isn't installed on work-linux: its runtimes are copied and wait for it.");
    should(actual).containEql("Codex isn't installed on work-linux: its runtimes are copied and wait for it.");
    should(actual).containEql(
      "work-linux's secret store has no KEY_ONE, KEY_TWO: add them before those runtimes launch.",
    );
    should(actual).containEql('Skill review is already on work-linux, so its copy there was kept.');
    should(actual).containEql('Not copied: big.bin (too large).');
  });

  it('should say "it" for a single missing secret and count several renames', () => {
    // Arrange
    const target = emptyTarget({
      credentials: { other: { harness: 'claude', store: 'host' } },
      components: { instructions: { main: { file: 'm.md' } } },
      profiles: { default: { layers: [] } },
    });
    const bundle = bundleWith({
      components: {
        instructions: { main: { file: 'components/instructions/main.md' } },
        mcp: { notes: { command: 'node', env: { A: secretReference('KEY_ONE') } } },
      },
      profiles: { default: { layers: ['instructions/main'] } },
    });
    const plan = planClone(target, bundle, options());

    // Act
    const actual = describeClone(plan, bundle, 'work-linux');

    // Assert
    should(actual).containEql("work-linux's secret store has no KEY_ONE: add it before those runtimes launch.");
    should(actual).containEql(
      '2 names already used here got a new one: instructions/main → instructions/main-2, default → default-2.',
    );
  });
});
