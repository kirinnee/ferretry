/**
 * The pure part of handing an import's components to their owners: which components those are, the document each is
 * handed as, the model with them left out, and the guard that keeps a hook out of an import.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  ownerReferences,
  ownerWrites,
  revertComponents,
  withComponentsOf,
  withoutHookChanges,
} from '../../../daemon/lib/account/owner-components.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';

/** A secret reference, built so the lint that guards template strings does not read it as one. */
const SECRET_REF = ['$', '{secret:T}'].join('');

const BEFORE = parseAccountModel({
  version: 1,
  components: { mcp: { old: { command: 'old' } }, hooks: { 'claude-hooks': { harness: 'claude', file: 'h.json' } } },
  profiles: { default: { layers: ['mcp/old', 'hooks/claude-hooks'] } },
});

const NEXT = parseAccountModel({
  version: 1,
  components: {
    mcp: { old: { command: 'old' }, github: { command: 'npx', args: ['-y', 'x'], env: { T: SECRET_REF } } },
    skills: { skills: { items: ['review'] } },
    settings: { 'claude-settings': { harness: 'claude', file: 'components/settings/claude-settings.json' } },
    hooks: {
      'claude-hooks': { harness: 'claude', file: 'h.json' },
      'codex-hooks': { harness: 'codex', file: 'c.json' },
    },
  },
  profiles: {
    default: { layers: ['mcp/old', 'mcp/github', 'skills/skills', 'hooks/claude-hooks', 'hooks/codex-hooks'] },
  },
});

describe('ownerReferences', () => {
  it('should name only the mcp, skills and settings components the change adds or changes', () => {
    // Act
    const references = ownerReferences(BEFORE, NEXT);

    // Assert
    should(references.map(({ kind, name }) => `${kind}/${name}`).toSorted()).eql([
      'mcp/github',
      'settings/claude-settings',
      'skills/skills',
    ]);
  });
});

describe('ownerWrites', () => {
  it("should hand a settings component's file to its owner as the document itself, parsed", () => {
    // Act
    const writes = ownerWrites(BEFORE, NEXT, file =>
      file === 'components/settings/claude-settings.json' ? '{"theme":"dark"}' : undefined,
    );

    // Assert
    const settings = writes.find(write => write.kind === 'settings');
    should(settings?.file).equal('claude-code/settings/claude-settings.yaml');
    should(JSON.parse(settings?.text ?? '{}')).eql({ harness: 'claude', document: { theme: 'dark' } });
    should(writes.find(write => write.kind === 'mcp')?.file).equal('mcp/github.yaml');
    should(writes.find(write => write.kind === 'skills')?.file).equal('skills/skills.yaml');
  });

  it('should say why a settings document could not be made instead of handing over a half one', () => {
    // Act
    const missing = ownerWrites(BEFORE, NEXT, () => undefined).find(write => write.kind === 'settings');
    const broken = ownerWrites(BEFORE, NEXT, () => '{ not json').find(write => write.kind === 'settings');

    // Assert
    should(missing?.text).be.undefined();
    should(missing?.problem).containEql('could not be read');
    should(broken?.text).be.undefined();
    should(broken?.problem).containEql('not valid');
  });
});

describe('withComponentsOf and revertComponents', () => {
  const owned = ownerReferences(BEFORE, NEXT);

  it("should put the owners' components back as they were, so Runtimes' own files carry none of them", () => {
    // Act
    const model = withComponentsOf(NEXT, BEFORE, owned);

    // Assert
    should(Object.keys(model.components.mcp)).eql(['old']);
    should(Object.keys(model.components.skills)).eql([]);
    should(Object.keys(model.components.settings)).eql([]);
    should(Object.keys(model.components.hooks)).eql(Object.keys(NEXT.components.hooks));
  });

  it('should leave a refused component out of the model and out of every profile, and keep the others', () => {
    // Act
    const model = revertComponents(NEXT, BEFORE, [{ kind: 'mcp', name: 'github' }]);

    // Assert
    should(Object.keys(model.components.mcp)).eql(['old']);
    should(model.profiles.default?.layers).not.containEql('mcp/github');
    should(model.profiles.default?.layers).containEql('mcp/old');
    should(model.profiles.default?.layers).containEql('skills/skills');
  });
});

describe('withoutHookChanges', () => {
  it('should keep the hooks the machine had and drop every other, with the layers that name them', () => {
    // Act
    const model = withoutHookChanges(BEFORE, NEXT);

    // Assert
    should(Object.keys(model.components.hooks)).eql(['claude-hooks']);
    should(model.profiles.default?.layers).containEql('hooks/claude-hooks');
    should(model.profiles.default?.layers).not.containEql('hooks/codex-hooks');
  });

  it('should return the very same model when no hook moved', () => {
    // Act / Assert
    should(withoutHookChanges(BEFORE, BEFORE)).equal(BEFORE);
  });
});

describe('a component an owner already holds, and a settings component given as data', () => {
  const CHANGED = parseAccountModel({
    version: 1,
    components: {
      mcp: { old: { command: 'newer' } },
      settings: { given: { harness: 'codex', document: { model: 'x' } } },
    },
    profiles: { default: { layers: ['mcp/old', 'settings/given'] } },
  });

  it('should revert a changed component to what the machine had, and keep its layer', () => {
    // Act
    const model = revertComponents(CHANGED, BEFORE, [{ kind: 'mcp', name: 'old' }]);

    // Assert
    should(model.components.mcp.old).eql({ command: 'old' });
    should(model.profiles.default?.layers).containEql('mcp/old');
  });

  it('should hand settings that are already data over as they are, under the harness directory', () => {
    // Act
    const write = ownerWrites(BEFORE, CHANGED, () => undefined).find(candidate => candidate.kind === 'settings');

    // Assert
    should(write?.file).equal('codex/settings/given.yaml');
    should(JSON.parse(write?.text ?? '{}')).eql({ harness: 'codex', document: { model: 'x' } });
  });
});
