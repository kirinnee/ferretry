import { describe, expect, it } from 'bun:test';
import {
  type ConfiguredServer,
  configuredServersOf,
  identifyKnownProcesses,
  type ProcRow,
  type Provenance,
} from '../../../../../daemon/lib/session/processes/provenance.ts';

const ROOT = 500;
const row = (pid: number, ppid: number, argv: string): ProcRow => ({ pid, ppid, startedSecondsAgo: 10, argv });
const provenance = (configuredServers: readonly ConfiguredServer[] = []): Provenance => ({
  rootPid: ROOT,
  binaryName: 'fy',
  configuredServers,
});
const kindsOf = (rows: readonly ProcRow[], p: Provenance = provenance()) =>
  Object.fromEntries([...identifyKnownProcesses(rows, p)].map(([pid, known]) => [pid, known.kind]));

describe('which processes in a pane are the agent’s own', () => {
  it('knows the harness CLI however its runtime spells it', () => {
    expect(
      kindsOf([
        row(501, ROOT, 'claude --resume'),
        row(502, ROOT, '.codex-wrapped exec'),
        row(503, ROOT, 'node /home/me/.npm/@anthropic-ai/claude-code/cli.js'),
        row(504, ROOT, 'bun /opt/lib/@openai/codex/bin.js'),
        row(505, ROOT, 'node --max-old-space-size=4096 --inspect claude.js'),
        row(506, ROOT, 'node'),
      ]),
    ).toEqual({ 501: 'harness', 502: 'harness', 503: 'harness', 504: 'harness', 505: 'harness' });
  });

  it('knows Ferretry’s tools server and its status line, by binary name wherever the shell put it', () => {
    expect(
      kindsOf([
        row(501, ROOT, 'fy mcp serve'),
        row(502, ROOT, '/nix/store/abc/bin/fy mcp serve'),
        row(503, ROOT, 'bun /src/fy.ts mcp serve'),
        row(504, ROOT, "sh -c 'fy' statusline"),
        row(505, ROOT, 'fy statusline --then x'),
        row(506, ROOT, 'fy mcp'),
        row(507, ROOT, 'a b c d fy mcp serve'),
        row(508, ROOT, 'other mcp serve'),
        row(509, ROOT, 'a b c d fy statusline'),
      ]),
    ).toEqual({
      501: 'ferretry-tools',
      502: 'ferretry-tools',
      503: 'ferretry-tools',
      504: 'status-line',
      505: 'status-line',
    });
  });

  it('knows a language server and says which', () => {
    const known = identifyKnownProcesses(
      [row(501, ROOT, 'node /usr/lib/gopls serve'), row(502, ROOT, 'clangd --x')],
      provenance(),
    );
    expect(known.get(502)).toEqual({ kind: 'language-server', label: 'The clangd language server' });
    expect(known.get(501)?.kind).toBe('language-server');
  });

  it('names a configured tool server by the words it was started with, flags ignored, in order', () => {
    const npx: ConfiguredServer = { name: 'docs', command: 'npx', args: ['-y', 'docs-mcp', '--stdio'] };
    const bare: ConfiguredServer = { name: 'tiny', command: '/usr/bin/tinyd', args: [] };
    const known = identifyKnownProcesses(
      [
        row(501, ROOT, 'npm exec docs-mcp'),
        row(502, ROOT, 'tinyd --port 1'),
        row(503, ROOT, 'npm exec other-mcp'),
        row(504, ROOT, 'docs-mcp'),
      ],
      provenance([npx, bare]),
    );
    expect(known.get(501)).toEqual({
      kind: 'configured-server',
      label: 'The “docs” tool server from the project config',
    });
    expect(known.get(502)?.kind).toBe('configured-server');
    expect(known.has(503)).toBe(false);
    expect(known.get(504)?.kind).toBe('configured-server');
  });

  it('claims nothing the agent’s shell started, and passes a helper’s kind down to its children', () => {
    const rows = [
      row(501, ROOT, 'sh -c bun run dev'),
      row(502, 501, 'fy mcp serve'),
      row(503, ROOT, 'claude'),
      row(504, 503, 'fy mcp serve'),
      row(505, 504, 'node child.js'),
    ];
    expect(kindsOf(rows)).toEqual({ 503: 'harness', 504: 'ferretry-tools', 505: 'ferretry-tools' });
  });
});

describe('the tool servers a project’s .mcp.json declares', () => {
  it('lists the command servers, with their arguments, and skips URL servers and malformed entries', () => {
    const text = JSON.stringify({
      mcpServers: {
        docs: { command: 'npx', args: ['-y', 'docs-mcp', 5] },
        plain: { command: 'tinyd' },
        remote: { url: 'https://example.test/mcp' },
        empty: { command: '' },
        broken: 'nope',
      },
    });
    expect(configuredServersOf(text)).toEqual([
      { name: 'docs', command: 'npx', args: ['-y', 'docs-mcp'] },
      { name: 'plain', command: 'tinyd', args: [] },
    ]);
  });

  it('declares none for a missing, blank, unparseable or wrongly shaped document', () => {
    expect(configuredServersOf(null)).toEqual([]);
    expect(configuredServersOf('  \n')).toEqual([]);
    expect(configuredServersOf('{nope')).toEqual([]);
    expect(configuredServersOf('[1]')).toEqual([]);
    expect(configuredServersOf('null')).toEqual([]);
    expect(configuredServersOf(JSON.stringify({ mcpServers: [] }))).toEqual([]);
    expect(configuredServersOf(JSON.stringify({ other: true }))).toEqual([]);
  });
});
