import { describe, it } from 'bun:test';
import should from 'should';
import { type HostDocumentRead, type HostHarnessScan, mergeImport, planImport } from '../../src/lib/account/import.ts';

const digest = (text: string): string => String(Bun.hash(text));

const text = (source: string, body: string): HostDocumentRead => ({
  kind: 'text',
  source,
  text: body,
  bytes: body.length,
});
const absent = (source: string): HostDocumentRead => ({ kind: 'absent', source });

const claude = (patch: Partial<HostHarnessScan> = {}): HostHarnessScan => ({
  harness: 'claude',
  command: '/bin/claude',
  login: { state: 'signed-in', email: 'person@example.test' },
  instructions: absent('/h/.claude/CLAUDE.md'),
  settings: absent('/h/.claude/settings.json'),
  mcp: absent('/h/.claude.json'),
  skills: [],
  missingCommands: [],
  problems: [],
  ...patch,
});

const codex = (patch: Partial<HostHarnessScan> = {}): HostHarnessScan => ({
  harness: 'codex',
  command: '/bin/codex',
  login: { state: 'signed-in' },
  instructions: absent('/h/.codex/AGENTS.md'),
  settings: absent('/h/.codex/config.toml'),
  hooks: absent('/h/.codex/hooks.json'),
  skills: [],
  missingCommands: [],
  problems: [],
  ...patch,
});

const component = (plan: ReturnType<typeof planImport>, kind: string, name: string) =>
  plan.components.find(item => item.kind === kind && item.name === name)?.value;

describe('planImport — an MCP server both harnesses name but configure differently', () => {
  it("should keep each harness its own and explain the second one's new name", () => {
    // Arrange
    const scans = [
      claude({
        mcp: text('/h/.claude.json', JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['a'] } } })),
      }),
      codex({ settings: text('/h/.codex/config.toml', '[mcp_servers.github]\ncommand = "uvx"\nargs = ["b"]\n') }),
    ];

    // Act
    const plan = planImport(scans, { digest });

    // Assert
    should(component(plan, 'mcp', 'github')).deepEqual({ command: 'npx', args: ['a'], harness: 'claude' });
    should(component(plan, 'mcp', 'github-codex')).deepEqual({ command: 'uvx', args: ['b'], harness: 'codex' });
    should(plan.notes.map(note => note.text)).containEql(
      'Your Codex MCP server "github" differs from the Claude Code one, so it was kept separately as "github-codex".',
    );
  });
});

describe('planImport — hooks that are not lists of handlers', () => {
  it('should count a hook event whose handlers are not a list as no hooks', () => {
    // Arrange
    const scan = claude({ settings: text('/h/.claude/settings.json', JSON.stringify({ hooks: { Stop: 'bell' } })) });

    // Act
    const plan = planImport([scan], { digest });

    // Assert
    should(plan.preview.harnesses[0]?.settings).deepEqual({ source: '/h/.claude/settings.json', count: 0, hooks: 0 });
  });
});

describe('planImport — a skills component the person already made', () => {
  it('should take the next free name and leave the copied skill directory where it was planned', () => {
    // Arrange
    const skills = [{ item: 'review', source: '/h/.claude/skills/review', digest: 'one' }];
    const own = mergeImport(undefined, planImport([claude({ skills })], { digest }));

    // Act
    const plan = planImport([claude({ skills })], { digest, existing: own });

    // Assert
    const names = plan.components.filter(item => item.kind === 'skills').map(item => item.name);
    should(names).have.length(1);
    should(names[0]).match(/-2$/);
    should(plan.files.filter(file => file.kind === 'copy-directory').map(file => file.from)).deepEqual([
      '/h/.claude/skills/review',
    ]);
  });
});
