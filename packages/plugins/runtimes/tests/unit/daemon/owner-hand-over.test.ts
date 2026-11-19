/**
 * The hand-over's own answers: a component whose document could not be made is refused without asking its owner, and an
 * owner's sentence is masked and bounded.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { ComponentWriter } from '../../../daemon/lib/account/owner-components.ts';
import { FleetCatalogRefusal } from '../../../daemon/lib/service/catalog-service.ts';
import { handOver, type OwnedComponents, withoutHandedBodies } from '../../../daemon/lib/service/owner-hand-over.ts';

const MODEL = parseAccountModel({ version: 1 });
const applied = { model: MODEL, documents: [] };

describe('handOver', () => {
  it('should refuse a component with no document without asking its owner, and say why', async () => {
    // Arrange
    let asked = 0;
    const writer: ComponentWriter = {
      put: async () => {
        asked += 1;
        return { outcome: 'written' };
      },
    };
    const owners: OwnedComponents = {
      writes: [
        {
          kind: 'settings',
          name: 'a',
          reference: 'settings/a',
          harness: 'claude',
          file: 'claude-code/settings/a.yaml',
          problem: 'the settings this was made from could not be read',
        },
      ],
      rebuild: async () => applied,
    };

    // Act
    const answer = await handOver({ writer, owners, applied, secretValues: [], inEffect: async () => MODEL });

    // Assert
    should(asked).equal(0);
    should(answer.sentences).eql([
      'Not written: claude-code/settings/a.yaml (the settings this was made from could not be read).',
    ]);
  });

  it('should mask a secret value in the owner sentence and bound its length', async () => {
    // Arrange
    const writer: ComponentWriter = {
      put: async () => ({ outcome: 'refused', reason: `${'x'.repeat(300)} s3cr3t-value` }),
    };
    const owners: OwnedComponents = {
      writes: [{ kind: 'mcp', name: 'a', reference: 'mcp/a', file: 'mcp/a.yaml', text: '{}' }],
      rebuild: async () => applied,
    };

    // Act
    const [sentence] = (
      await handOver({ writer, owners, applied, secretValues: ['s3cr3t-value', ''], inEffect: async () => MODEL })
    ).sentences;

    // Assert
    should(sentence).not.containEql('s3cr3t-value');
    should(sentence?.length).be.below(300);
    should(sentence).containEql('…');
  });
});

describe('handOver warnings', () => {
  it('should say a file was written with a warning, masking any secret in it', async () => {
    // Arrange
    const writer: ComponentWriter = {
      put: async write => ({
        outcome: write.kind === 'mcp' ? 'written' : 'held',
        warnings: ['command "x" is not on this machine'],
      }),
    };
    const owners: OwnedComponents = {
      writes: [
        { kind: 'mcp', name: 'a', reference: 'mcp/a', file: 'mcp/a.yaml', text: '{}' },
        { kind: 'skills', name: 'b', reference: 'skills/b', file: 'skills/b.yaml', text: '{}' },
      ],
      rebuild: async () => applied,
    };

    // Act
    const { sentences } = await handOver({ writer, owners, applied, secretValues: [], inEffect: async () => MODEL });

    // Assert
    should(sentences).containEql(
      'Written with a warning: mcp/a.yaml (command "x" is not on this machine); skills/b.yaml (command "x" is not on this machine).',
    );
  });
});

describe('handOver, what is in effect', () => {
  const owners = (rebuilt: { held?: string[]; refused?: string[] }[]): OwnedComponents => ({
    writes: [
      { kind: 'mcp', name: 'a', reference: 'mcp/a', file: 'mcp/a.yaml', text: '{}' },
      { kind: 'skills', name: 'b', reference: 'skills/b', file: 'skills/b.yaml', text: '{}' },
    ],
    rebuild: async outcome => {
      rebuilt.push({ held: [...outcome.held], refused: [...outcome.refused] });
      return applied;
    },
  });
  const inEffectModel = parseAccountModel({ version: 1, components: { mcp: { a: { command: 'owner-version' } } } });

  it('should apply the model the owners report, not the one the import asked for', async () => {
    // Arrange
    const writer: ComponentWriter = { put: async () => ({ outcome: 'written' }) };
    const asked = parseAccountModel({
      version: 1,
      components: { mcp: { a: { command: 'asked' } }, skills: { b: { items: ['x'] } } },
      profiles: { p: { layers: ['mcp/a', 'skills/b'] } },
    });

    // Act
    const answer = await handOver({
      writer,
      owners: owners([]),
      applied: { model: asked, documents: [] },
      secretValues: [],
      inEffect: async () => inEffectModel,
    });

    // Assert
    should(answer.applied.model.components.mcp.a).eql({ command: 'owner-version' });
    should(answer.applied.model.components.skills).eql({});
    should(answer.applied.model.profiles.p?.layers).eql(['mcp/a']);
  });

  it('should rebuild with the held and the refused named, and not read the owners when none took a component', async () => {
    // Arrange
    const rebuilt: { held?: string[]; refused?: string[] }[] = [];
    let reads = 0;
    const writer: ComponentWriter = {
      put: async write => (write.kind === 'mcp' ? { outcome: 'held' } : { outcome: 'refused', reason: 'no' }),
    };

    // Act
    const answer = await handOver({
      writer,
      owners: owners(rebuilt),
      applied,
      secretValues: [],
      inEffect: async () => {
        reads += 1;
        return inEffectModel;
      },
    });

    // Assert
    should(rebuilt).eql([{ held: ['mcp/a'], refused: ['skills/b'] }]);
    should(reads).equal(1);
    should(answer.sentences).containEql('Held until you confirm: mcp/a.yaml.');
  });

  it('should not read what is in effect when every owner refuses', async () => {
    // Arrange
    const writer: ComponentWriter = { put: async () => ({ outcome: 'refused', reason: 'no' }) };
    let reads = 0;

    // Act
    await handOver({
      writer,
      owners: owners([]),
      applied,
      secretValues: [],
      inEffect: async () => {
        reads += 1;
        return inEffectModel;
      },
    });

    // Assert
    should(reads).equal(0);
  });

  it('should name the files that landed when what is in effect cannot be read afterwards', async () => {
    // Arrange
    const writer: ComponentWriter = { put: async () => ({ outcome: 'written' }) };

    // Act
    const failure = await handOver({
      writer,
      owners: owners([]),
      applied,
      secretValues: [],
      inEffect: async () => {
        throw new Error('files unreadable');
      },
    }).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(FleetCatalogRefusal);
    should((failure as FleetCatalogRefusal).code).equal('fleet_change_failed');
    should((failure as FleetCatalogRefusal).message).containEql('files unreadable');
    should((failure as FleetCatalogRefusal).message).containEql('mcp/a.yaml, skills/b.yaml');
  });

  it('should not read what is in effect when an import hands nothing over', async () => {
    // Act
    const answer = await handOver({
      writer: undefined,
      owners: undefined,
      applied,
      secretValues: [],
      inEffect: async () => {
        throw new Error('never asked');
      },
    });

    // Assert
    should(answer.applied).equal(applied);
  });
});

describe('handOver, a written component the owner keeps out of effect', () => {
  // A profile-only Codex import: the owner takes the profile items and writes no main settings item, yet answers "written".
  const asked = parseAccountModel({
    version: 1,
    components: { settings: { 'codex-settings': { harness: 'codex', file: 'settings/codex-settings.toml' } } },
    profiles: { default: { layers: ['settings/codex-settings'] } },
  });
  const owners = (rebuilds: string[][]): OwnedComponents => ({
    writes: [
      {
        kind: 'settings',
        name: 'codex-settings',
        reference: 'settings/codex-settings',
        harness: 'codex',
        file: 'codex/settings/codex-settings.yaml',
        text: '{}',
      },
    ],
    rebuild: async outcome => {
      rebuilds.push([...outcome.refused]);
      return {
        model: parseAccountModel({ version: 1, profiles: { default: { layers: [] } } }),
        documents: [{ path: 'profiles/default.yaml', content: '{"contents":[]}', mode: 0o600, expect: 'absent' }],
      };
    },
  });

  it('should compose the saved profile files without the layer that names it', async () => {
    // Arrange
    const rebuilds: string[][] = [];
    const writer: ComponentWriter = { put: async () => ({ outcome: 'written' }) };
    const documents = [
      {
        path: 'profiles/default.yaml',
        content: '{"contents":["settings/codex-settings"]}',
        mode: 0o600,
        expect: 'absent',
      },
    ];

    // Act
    const answer = await handOver({
      writer,
      owners: owners(rebuilds),
      applied: { model: asked, documents },
      secretValues: [],
      inEffect: async () => MODEL,
    });

    // Assert
    should(rebuilds).eql([['settings/codex-settings']]);
    should(answer.applied.documents.map(document => document.content)).eql(['{"contents":[]}']);
    should(answer.applied.model.profiles.default?.layers).eql([]);
  });

  it('should keep a held component in the saved profile files', async () => {
    // Arrange
    const rebuilds: string[][] = [];
    const writer: ComponentWriter = { put: async () => ({ outcome: 'held' }) };
    const documents = [
      {
        path: 'profiles/default.yaml',
        content: '{"contents":["settings/codex-settings"]}',
        mode: 0o600,
        expect: 'absent',
      },
    ];

    // Act
    const answer = await handOver({
      writer,
      owners: owners(rebuilds),
      applied: { model: asked, documents },
      secretValues: [],
      inEffect: async () => MODEL,
    });

    // Assert
    should(rebuilds).eql([[]]);
    should(answer.sentences).containEql('Held until you confirm: codex/settings/codex-settings.yaml.');
  });
});

describe('handOver, hidden files', () => {
  it('should say the hidden files that were not handed over, once the owner took the component', async () => {
    // Arrange
    const writer: ComponentWriter = { put: async () => ({ outcome: 'written' }) };
    const owners: OwnedComponents = {
      writes: [
        {
          kind: 'skills',
          name: 'b',
          reference: 'skills/b',
          file: 'skills/b.yaml',
          text: '{}',
          skipped: ['review/.git/config'],
        },
      ],
      rebuild: async () => applied,
    };

    // Act
    const { sentences } = await handOver({ writer, owners, applied, secretValues: [], inEffect: async () => MODEL });

    // Assert
    should(sentences).containEql(
      'Written with a warning: skills/b.yaml (hidden files not handed over: review/.git/config).',
    );
  });
});

describe('withoutHandedBodies', () => {
  const before = parseAccountModel({ version: 1 });
  const model = parseAccountModel({
    version: 1,
    components: {
      skills: { mine: { items: ['review'] } },
      settings: { s: { harness: 'claude', file: 'components/settings/s.json' } },
    },
  });
  const assets = [
    { path: 'skills/review/SKILL.md' },
    { path: 'skills/review/lib/a.sh' },
    { path: 'skills/reviewer/SKILL.md' },
    { path: 'components/settings/s.json' },
    { path: 'components/instructions/main.md' },
  ];

  it("should drop an owner's settings body and the files of each skill item, and keep every other asset", () => {
    // Act
    const kept = withoutHandedBodies(assets, before, model);

    // Assert
    should(kept.map(asset => asset.path)).eql(['skills/reviewer/SKILL.md', 'components/instructions/main.md']);
  });
});
