import { describe, it } from 'bun:test';
import type { ModelCatalogsView } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerModelsCommands } from '../../../src/lib/models/commands';
import { ModelsController } from '../../../src/lib/models/controller';
import type { IModelsGateway, IModelsOutput } from '../../../src/lib/models/ports';
import { renderModelCatalogs, renderModelRefresh } from '../../../src/lib/models/render';

const VIEW: ModelCatalogsView = {
  published: { origin: 'https://ferretry.pages.dev', enabled: true, version: 4, checkedAt: '2026-10-19T00:00:00.000Z' },
  catalogs: [
    {
      id: 'zai',
      label: 'GLM / Z.ai',
      origin: 'published',
      verified: '2026-10-18',
      customIds: false,
      claude: [
        { id: 'glm-5.3', label: 'GLM-5.3', tier: 'best', context: 1_000_000, efforts: ['low', 'high'], default: true },
        { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', tier: 'fast', context: 256_000, efforts: [], default: false },
      ],
    },
    {
      id: 'openai',
      label: 'OpenAI',
      origin: 'built-in',
      verified: '2026-10-18',
      customIds: true,
      codex: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'balanced', efforts: [], default: true }],
    },
  ],
};

const RUNTIMES = {
  format: 'version-2',
  runtimes: [{ credential: { id: 'glm' }, models: { catalog: { id: 'zai' } } }, { credential: { id: 'by-hand' } }],
};

function harness(answers: Record<string, unknown> = {}) {
  const asked: { path: string; method: string }[] = [];
  const gateway: IModelsGateway = {
    request: async (path, _schema, init) => {
      asked.push({ path, method: init?.method ?? 'GET' });
      return (answers[path] ?? (path === '/v1/models' ? VIEW : RUNTIMES)) as never;
    },
  };
  const lines: string[] = [];
  const out: IModelsOutput = { success: line => lines.push(line) };
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerModelsCommands(program, new ModelsController(gateway, out));
  const run = (...argv: string[]) => program.parseAsync(['node', 'fy', ...argv]);
  return { asked, lines, run };
}

describe('fy models', () => {
  it('should list every catalog, where it came from, and its models by CLI with the default starred', async () => {
    // Arrange
    const { lines, run } = harness();

    // Act
    await run('models', 'list');

    // Assert
    const text = lines.join('\n');
    should(text).containEql(
      'Published catalog from https://ferretry.pages.dev: version 4, checked 2026-10-19T00:00:00.000Z',
    );
    should(text).containEql('zai — GLM / Z.ai (published, verified 2026-10-18)');
    should(text).containEql('* glm-5.3  GLM-5.3 (most capable · 1M context · effort low/high)');
    should(text).containEql('  glm-5.3-flash  GLM-5.3-Flash (fast · 256K context)');
    should(text).containEql('openai — OpenAI (built-in, verified 2026-10-18, takes any id)');
    should(text).containEql('Codex:');
  });

  it("should narrow to one login's catalog, and say why a login has none", async () => {
    // Arrange
    const { lines, run } = harness();

    // Act
    await run('models', 'list', '--login', 'glm', '--json');

    // Assert
    should(JSON.parse(lines[0] as string).catalogs.map((catalog: { id: string }) => catalog.id)).deepEqual(['zai']);
    await should(harness().run('models', 'list', '--login', 'by-hand')).be.rejectedWith(/reads no model catalog/);
    await should(harness().run('models', 'list', '--login', 'nobody')).be.rejectedWith(
      /no runtime uses a login named nobody/,
    );
  });

  it('should check for a newer published catalog and say what came of it', async () => {
    // Arrange
    const { asked, lines, run } = harness({
      '/v1/models/refresh': { outcome: 'refused', version: 4, reason: 'the signature does not verify' },
    });

    // Act
    await run('models', 'refresh');
    await run('models', 'refresh', '--json');

    // Assert
    should(asked[0]).deepEqual({ path: '/v1/models/refresh', method: 'POST' });
    should(lines[0]).equal(
      'The published model catalog did not check; the one held stays in effect (version 4): the signature does not verify.',
    );
    should(JSON.parse(lines[1] as string)).match({ outcome: 'refused' });
  });

  it('should word every outcome, and a daemon that follows no published catalog', () => {
    should(renderModelRefresh({ outcome: 'updated', version: 5 })).equal(
      'A newer model catalog was published; it is in effect now (version 5).',
    );
    should(renderModelRefresh({ outcome: 'disabled' })).containEql('FY_MODEL_CATALOG=off');
    should(renderModelCatalogs({ published: { origin: 'https://x', enabled: false }, catalogs: [] })).equal(
      'Published catalog: not followed (FY_MODEL_CATALOG=off)',
    );
    should(renderModelCatalogs({ published: { origin: 'https://x', enabled: true }, catalogs: [] })).equal(
      'Published catalog from https://x: none taken yet, never checked',
    );
  });
});
