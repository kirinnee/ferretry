/**
 * E-276 0a: MCP rendering and the partial-support notes — `renderMcpComponents` for each harness × server kind (a started command
 * with literal and forwarded variables, a streamable-HTTP URL, an SSE URL, a server signed in to from Ferretry), the Codex
 * model catalog file, and `componentPartialSupport` (the notes a Codex runtime shows for what it only half reads).
 */
import { describe, it } from 'bun:test';
import {
  componentPartialSupport,
  describePartialSupport,
  isSseUrl,
  renderMcpComponents,
  skillFrontmatterKeys,
} from '../../../daemon/lib/account/adapt.ts';
import type { McpComponent } from '../../../daemon/lib/account/schema.ts';
import {
  codexCatalogArguments,
  renderCodexModelCatalog,
} from '../../../../codex/daemon/lib/runtimes-kit/model-catalog.ts';
import { REAL_KITS } from '../../support/real-kits.ts';
import { expectGolden } from './support/golden.ts';
import { outcome, THIRD_KEY } from './support/thrown.ts';

const SERVERS: Readonly<Record<string, McpComponent>> = {
  stdio: {
    command: 'npx',
    args: ['server-files', '--root', '/srv/files'],
    env: { FILES_TOKEN: '${secret:GOLDEN_FILES}', FILES_MODE: 'read' },
  },
  'stdio-bare': { command: 'golden-server' },
  http: { url: 'https://docs.example.test/mcp' },
  sse: { url: 'https://feed.example.test/sse' },
  oauth: { url: 'https://notes.example.test/mcp', auth: 'oauth' },
  'oauth-sse': { url: 'https://feed.example.test/sse', auth: 'oauth' },
};

describe('mcp goldens', () => {
  for (const harness of ['claude', 'codex'] as const) {
    for (const [kind, server] of Object.entries(SERVERS)) {
      it(`should render a ${kind} server for ${harness} exactly as the base does`, () => {
        expectGolden(
          `mcp/${harness}-${kind}`,
          renderMcpComponents(harness, { golden: server }, REAL_KITS.get(harness)),
        );
      });
    }
    it(`should render every server kind at once for ${harness} exactly as the base does`, () => {
      expectGolden(`mcp/${harness}-all`, renderMcpComponents(harness, SERVERS, REAL_KITS.get(harness)));
    });
  }

  it('should read SSE urls and refuse a third harness exactly as the base does', () => {
    expectGolden('mcp/words', {
      sse: Object.fromEntries(
        [
          'https://a.example.test/sse',
          'https://a.example.test/SSE/',
          'https://a.example.test/mcp',
          'https://a.example.test/sse/x',
        ].map(url => [url, isSseUrl(url)]),
      ),
      thirdKey: outcome(() =>
        renderMcpComponents(THIRD_KEY as never, { golden: SERVERS.stdio as McpComponent }, REAL_KITS.get('claude')),
      ),
      frontmatter: skillFrontmatterKeys('---\nname: golden\nallowed-tools: Bash\nmodel: x\n---\nbody\n'),
    });
  });

  it('should write the Codex model catalog exactly as the base does', () => {
    const entry = (id: string, available: boolean) => ({
      id,
      label: id.toUpperCase(),
      available,
      tier: 'standard',
      context: 200_000,
      reasoning: true,
      efforts: ['low', 'high'],
      defaultEffort: 'low',
    });
    expectGolden('mcp/codex-model-catalog', {
      ordered: renderCodexModelCatalog([entry('golden-a', true), entry('golden-b', true)] as never, 'golden-b'),
      unlaunched: renderCodexModelCatalog([entry('golden-a', true)] as never),
      arguments: codexCatalogArguments('/fy/fleet/homes/golden/.fy/codex-model-catalog.json'),
    });
  });

  it('should list the partial-support notes exactly as the base does', () => {
    const notes = componentPartialSupport({
      components: {
        instructions: {
          imports: { file: 'a.md' },
          plain: { file: 'b.md' },
          claudeOnly: { file: 'c.md', harness: 'claude' },
        },
        mcp: { sse: { url: 'https://feed.example.test/sse' }, http: { url: 'https://docs.example.test/mcp' } },
        skills: { mine: { items: ['review', 'deploy'] } },
      } as never,
      skillFrontmatter: { review: ['name', 'allowed-tools', 'model', 'context'], deploy: ['name', 'description'] },
      instructionBodies: { imports: 'See\n@docs/guide.md\n', plain: 'Be kind.\n', claudeOnly: '@x.md\n' },
      kits: REAL_KITS,
    });
    expectGolden('mcp/partial-support', { notes, described: notes.map(describePartialSupport) });
  });
});
