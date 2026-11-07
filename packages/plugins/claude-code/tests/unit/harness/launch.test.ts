import { describe, it } from 'bun:test';
import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import should from 'should';
import { homeText, launchCommand, settingsDocument } from '../../../daemon/lib/harness/launch.ts';
import { parseEntries, parseEntry, parseUsage } from '../../../daemon/lib/harness/transcript.ts';

const settings = new Map([
  ['b-theme', { settings: { theme: 'dark', model: 'one' } }],
  ['a-base', { settings: { model: 'zero', hooks: { Stop: [{ id: 1 }] } } }],
]);
const hooks = new Map([['audit', { hooks: { Stop: [{ id: 2 }], PreToolUse: [{ id: 3 }] } }]]);

describe('settingsDocument', () => {
  it('applies settings items in name order, so a later name wins a key', () => {
    should(settingsDocument({ settings, hooks: new Map(), effort: undefined })).containEql({
      theme: 'dark',
      model: 'one',
    });
  });

  it('appends each hooks item to the events the settings already carry', () => {
    const document = settingsDocument({ settings, hooks, effort: undefined });
    should(document.hooks).eql({ Stop: [{ id: 1 }, { id: 2 }], PreToolUse: [{ id: 3 }] });
  });

  it('persists the start request’s effort where /effort would write it', () => {
    should(settingsDocument({ settings: new Map(), hooks: new Map(), effort: 'high' })).eql({ effortLevel: 'high' });
  });

  it('is an empty document when nothing is declared', () => {
    should(settingsDocument({ settings: new Map(), hooks: new Map(), effort: undefined })).eql({});
  });
});

describe('homeText', () => {
  const parts: LaunchPart[] = [
    { kind: 'mcp', name: 'docs', config: { command: 'docs-mcp' } },
    { kind: 'instruction', id: 'x', text: 'From a plugin.' },
    { kind: 'env', env: { A: '${secret:A}' } },
  ];

  it('writes instructions then instruction parts into the memory file', () => {
    const text = homeText({
      instructions: [{ id: 'i', text: 'Be brief.\n' }],
      parts,
      settings: new Map(),
      hooks: new Map(),
    });
    should(text.memory).equal('Be brief.\n\nFrom a plugin.\n');
  });

  it('writes the MCP servers it was given, and no MCP file when it was given none', () => {
    const withMcp = homeText({ instructions: [], parts, settings: new Map(), hooks: new Map() });
    should(JSON.parse(withMcp.mcp as string)).eql({ mcpServers: { docs: { command: 'docs-mcp' } } });
    const without = homeText({ instructions: [], parts: [], settings: new Map(), hooks: new Map() });
    should(without.mcp).be.undefined();
    should(without.memory).equal('');
  });

  it('never writes an env part: the environment is the Vault’s, not a file’s', () => {
    const text = homeText({ instructions: [], parts, settings: new Map(), hooks: new Map() });
    should(JSON.stringify(text)).not.containEql('secret:');
  });
});

describe('launchCommand', () => {
  const base = {
    binary: '/opt/bin/claude',
    home: '/state/claude-code/agent-homes/f1',
    permissionMode: 'auto' as const,
    hasMcp: false,
    conversation: { kind: 'new' as const, id: 'c-1' },
  };

  it('starts claude in the home with a session id and the auto permission mode', () => {
    should(launchCommand(base)).eql([
      'env',
      'CLAUDE_CONFIG_DIR=/state/claude-code/agent-homes/f1',
      '/opt/bin/claude',
      '--settings',
      '/state/claude-code/agent-homes/f1/settings.json',
      '--permission-mode',
      'auto',
      '--session-id',
      'c-1',
    ]);
  });

  it('resumes by the harness conversation id, with the model last and the MCP file named', () => {
    const argv = launchCommand({
      ...base,
      permissionMode: 'skip',
      hasMcp: true,
      model: 'claude-opus-5-5',
      conversation: { kind: 'resume', id: 'c-9' },
    });
    should(argv.slice(5)).eql([
      '--permission-mode',
      'bypassPermissions',
      '--mcp-config',
      '/state/claude-code/agent-homes/f1/mcp.json',
      '--resume',
      'c-9',
      '--model',
      'claude-opus-5-5',
    ]);
  });
});

describe('transcript', () => {
  const user = JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-11-01T10:00:00.000Z',
    message: { role: 'user', content: 'hello' },
  });
  const assistant = JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-11-01T10:00:05.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'hi there' }],
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100 },
    },
  });
  const tool = JSON.stringify({
    type: 'assistant',
    uuid: 'a2',
    timestamp: '2026-11-01T10:00:06.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] },
  });

  it('reads conversation records and skips every other kind of line', () => {
    const entries = parseEntries([user, '{"type":"summary"}', 'not json', assistant, '', tool].join('\n'));
    should(entries.map(entry => [entry.id, entry.role, entry.text])).eql([
      ['u1', 'user', 'hello'],
      ['a1', 'assistant', 'hi there'],
      ['a2', 'tool', undefined],
    ]);
  });

  it('refuses a record with no id or a bad time', () => {
    should(parseEntry('{"type":"user","message":{"content":"x"}}')).be.undefined();
    should(parseEntry('{"type":"user","uuid":"u","timestamp":"soon"}')).be.undefined();
  });

  it('reads what each assistant turn spent', () => {
    should(parseUsage([user, assistant].join('\n'))).eql([
      {
        turn: 1,
        at: '2026-11-01T10:00:05.000Z',
        model: 'claude-opus-5-5',
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 100,
      },
    ]);
  });
});
