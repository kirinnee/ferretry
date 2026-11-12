import { describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchPart } from '@ferretry/core-ferrets/contract';
import should from 'should';
import { homeText, launchCommand, settingsDocument } from '../../../daemon/lib/harness/launch.ts';
import {
  API_KEY_SEED_NAME,
  API_KEY_SEED_SCRIPT,
  API_KEY_SEED_SHELL,
} from '../../../daemon/lib/harness/api-key-seed.ts';
import { parseEntries, parseEntry, parseUsage } from '../../../daemon/lib/harness/transcript.ts';
import {
  CLAUDE_QUESTION_HOOK_COMMAND,
  CLAUDE_QUESTION_HOOKS,
  CLAUDE_PROMPTS_SEEN,
} from '../../../daemon/lib/harness/fixed-layer.ts';
import pending from '../../../../../../ports-pending.json';

const settings = new Map([
  ['b-theme', { settings: { theme: 'dark', model: 'one' } }],
  ['a-base', { settings: { model: 'zero', hooks: { Stop: [{ id: 1 }] } } }],
]);
const hooks = new Map([['audit', { hooks: { Stop: [{ id: 2 }], PreToolUse: [{ id: 3 }] } }]]);

describe('settingsDocument', () => {
  it('deep-merges disjoint nested permission settings without losing deny rules', () => {
    const settings = new Map([
      ['a-deny', { settings: { permissions: { deny: ['Bash(rm *)'], allow: ['Old'] } } }],
      ['b-allow', { settings: { permissions: { allow: ['Read'] } } }],
    ]);
    should(settingsDocument({ settings, hooks: new Map() })).eql({
      permissions: { deny: ['Bash(rm *)'], allow: ['Read'] },
    });
    should(settings.get('a-deny')?.settings.permissions.allow).eql(['Old']);
  });

  it('replaces scalars, null and arrays while empty object overlays preserve nested settings', () => {
    const settings = new Map([
      ['a', { settings: { a: { nested: true }, b: [1], c: { nested: true }, d: null } }],
      ['b', { settings: { a: {}, b: [2], c: null, d: { nested: true } } }],
    ]);
    should(settingsDocument({ settings, hooks: new Map() })).eql({
      a: { nested: true },
      b: [2],
      c: null,
      d: { nested: true },
    });
  });

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
  it('question hook writes the complete tool input quietly and drains input when unset or unwritable', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'claude-question-hook-'));
    const body = JSON.stringify({ tool_use_id: 'question-1', tool_input: { questions: [{ question: 'Which?' }] } });
    const file = join(folder, 'question.json');
    try {
      for (const target of [file, undefined, join(folder, 'missing/question.json')]) {
        const child = Bun.spawn(['sh', '-c', CLAUDE_QUESTION_HOOK_COMMAND], {
          env: { PATH: '/usr/bin:/bin', ...(target === undefined ? {} : { FY_QUESTION_FILE: target }) },
          // A `Buffer`, not a `Blob`: once a DOM suite has registered happy-dom in this process (the unit tier runs every
          // package in one), the global `Blob` is happy-dom's and `Bun.spawn` refuses it as stdio.
          stdin: Buffer.from(body),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        should(await child.exited).equal(0);
        should(await new Response(child.stdout).text()).equal('');
        should(await new Response(child.stderr).text()).equal('');
      }
      should(await readFile(file, 'utf8')).equal(body);
      should(await Bun.file(`${file}.tmp`).exists()).equal(false);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('applies fixed launch precedence, onboarding and trust, and keeps the question hook in its own overlay', () => {
    for (const permissionMode of ['auto', 'skip'] as const) {
      const userHook = { matcher: 'Read', hooks: [{ type: 'command', command: 'true' }] };
      const text = homeText({
        folder: '/work/repo',
        permissionMode,
        instructions: [],
        parts: [],
        effort: 'high',
        settings: new Map([
          [
            'user',
            {
              settings: {
                remoteControlAtStartup: true,
                permissions: { defaultMode: 'plan', deny: ['Bash(rm *)'] },
                skipAutoPermissionPrompt: false,
                skipDangerousModePermissionPrompt: false,
                hooks: { PreToolUse: [userHook] },
              },
            },
          ],
        ]),
        hooks: new Map(),
      });
      const mode = permissionMode === 'skip' ? 'bypassPermissions' : 'auto';
      const settings = JSON.parse(text.settings);
      should(settings.permissions).eql({ defaultMode: mode, deny: ['Bash(rm *)'] });
      should(settings.remoteControlAtStartup).equal(false);
      should(settings.effortLevel).equal('high');
      should(settings.hooks.PreToolUse).eql([userHook]);
      const overlay = JSON.parse(text.overlay);
      should(overlay).eql({
        permissions: { defaultMode: mode },
        remoteControlAtStartup: false,
        ...(permissionMode === 'skip'
          ? { skipDangerousModePermissionPrompt: true }
          : { skipAutoPermissionPrompt: true }),
        hooks: CLAUDE_QUESTION_HOOKS,
      });
      should(JSON.parse(text.claudeJson)).eql({
        hasCompletedOnboarding: true,
        hasCompletedClaudeInChromeOnboarding: true,
        ...CLAUDE_PROMPTS_SEEN,
        projects: { '/work/repo': { hasTrustDialogAccepted: true } },
      });
    }
  });

  it('keeps claude-code pending while item verbs and answer panels are stubs', () => {
    should(pending.pending).containEql('claude-code');
  });

  const parts: LaunchPart[] = [
    { kind: 'mcp', name: 'docs', config: { command: 'docs-mcp' } },
    { kind: 'instruction', id: 'x', text: 'From a plugin.' },
    { kind: 'env', env: { A: '${secret:A}' } },
  ];

  it('writes instructions then instruction parts into the memory file', () => {
    const text = homeText({
      folder: '/work',
      permissionMode: 'auto',
      instructions: [{ id: 'i', text: 'Be brief.\n' }],
      parts,
      settings: new Map(),
      hooks: new Map(),
    });
    should(text.memory).equal('Be brief.\n\nFrom a plugin.\n');
  });

  it('writes the MCP servers it was given, and no MCP file when it was given none', () => {
    const withMcp = homeText({
      folder: '/work',
      permissionMode: 'auto',
      instructions: [],
      parts,
      settings: new Map(),
      hooks: new Map(),
    });
    should(JSON.parse(withMcp.mcp as string)).eql({ mcpServers: { docs: { command: 'docs-mcp' } } });
    const without = homeText({
      folder: '/work',
      permissionMode: 'auto',
      instructions: [],
      parts: [],
      settings: new Map(),
      hooks: new Map(),
    });
    should(without.mcp).be.undefined();
    should(without.memory).equal('');
  });

  it('never writes an env part: the environment is the Vault’s, not a file’s', () => {
    const text = homeText({
      folder: '/work',
      permissionMode: 'auto',
      instructions: [],
      parts,
      settings: new Map(),
      hooks: new Map(),
    });
    should(JSON.stringify(text)).not.containEql('secret:');
  });

  describe('the settings overlay a launch decides (v4 parity)', () => {
    const base = {
      folder: '/work',
      permissionMode: 'auto',
      instructions: [],
      settings: new Map(),
      hooks: new Map(),
    } as const;
    const overlayOf = (inputs: Partial<Parameters<typeof homeText>[0]>) =>
      JSON.parse(homeText({ ...base, parts: [], ...inputs }).overlay) as Record<string, unknown>;

    it('writes fastMode for a start that asked for it, and false for one that asked against it', () => {
      should(overlayOf({ fast: true }).fastMode).equal(true);
      should(overlayOf({ fast: false }).fastMode).equal(false);
    });

    it('leaves fastMode out when the start did not name it', () => {
      should('fastMode' in overlayOf({})).be.false();
    });

    it('writes a compact part as autoCompactWindow, the last one winning', () => {
      should(overlayOf({ parts: [{ kind: 'compact', at: 200_000 }] }).autoCompactWindow).equal(200_000);
      should(
        overlayOf({
          parts: [
            { kind: 'compact', at: 200_000 },
            { kind: 'compact', at: 250_000 },
          ],
        }).autoCompactWindow,
      ).equal(250_000);
      should('autoCompactWindow' in overlayOf({})).be.false();
    });

    it('carries the pins, fast mode and the compaction trigger together in the one overlay, and into no other file', () => {
      const text = homeText({
        ...base,
        parts: [
          { kind: 'pin', env: { ANTHROPIC_BASE_URL: 'https://gateway.invalid' } },
          { kind: 'compact', at: 200_000 },
        ],
        fast: true,
      });
      const overlay = JSON.parse(text.overlay);
      should(overlay.env).eql({ ANTHROPIC_BASE_URL: 'https://gateway.invalid' });
      should(overlay.fastMode).equal(true);
      should(overlay.autoCompactWindow).equal(200_000);
      should(text.settings).not.containEql('fastMode');
      should(text.settings).not.containEql('autoCompactWindow');
      should(text.settings).not.containEql('gateway.invalid');
    });
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
      API_KEY_SEED_SHELL,
      '-c',
      API_KEY_SEED_SCRIPT,
      API_KEY_SEED_NAME,
      '/opt/bin/claude',
      '--settings',
      '/state/claude-code/agent-homes/f1/launch-settings.json',
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
    should(argv.slice(9)).eql([
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
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
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
    const entries = parseEntries(bytes([user, '{"type":"summary"}', 'not json', assistant, '', tool].join('\n')));
    should(entries.map(entry => [entry.id, entry.role, entry.text])).eql([
      ['u1', 'user', 'hello'],
      ['a1', 'assistant', 'hi there'],
      ['a2', 'tool', undefined],
    ]);
  });

  describe('#45 the harness’s own input-queue records travel as input-proof entries', () => {
    const queueOp = (operation: string, content: unknown, timestamp: unknown = '2026-11-01T10:00:02.000Z') =>
      JSON.stringify({ type: 'queue-operation', operation, timestamp, content });
    const drained = (extra: Record<string, unknown> = {}, attachment: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: 'attachment',
        uuid: 'att-1',
        timestamp: '2026-11-01T10:00:09.000Z',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          prompt: 'FIXTURE typed mid-turn',
          origin: { kind: 'human' },
          timestamp: '2026-11-01T10:00:03.000Z',
          ...attachment,
        },
        ...extra,
      });

    it('should read a held and a released prompt as system entries named by their byte offset, never as a message', () => {
      const held = queueOp('enqueue', 'FIXTURE held');
      const entries = parseEntries(bytes([user, held, queueOp('remove', 'FIXTURE held')].join('\n')));
      const second = user.length + 1;
      const third = second + held.length + 1;
      should(entries.map(entry => [entry.id, entry.role, entry.text, entry.data])).eql([
        ['u1', 'user', 'hello', undefined],
        [`queue-operation:${second}`, 'system', 'FIXTURE held', { proof: 'queue-operation', operation: 'enqueue' }],
        [`queue-operation:${third}`, 'system', 'FIXTURE held', { proof: 'queue-operation', operation: 'remove' }],
      ]);
    });

    it('should name a record without an id the same way whichever window reads it, whatever bytes precede the window', () => {
      const drain = drained({ uuid: undefined });
      // An invalid byte decodes to a 3-byte character: a count over decoded text would drift with where the window starts.
      const file = Buffer.concat([
        Buffer.from(`${user}\n`),
        Buffer.from([0xff, 0xfe, 0xff, 0x0a]),
        Buffer.from(`${queueOp('enqueue', 'FIXTURE held')}\n${drain}\n`),
      ]);
      const whole = parseEntries(file);
      const from = user.length + 1 + 4;
      const cut = parseEntries(file.subarray(from), from);
      should(whole.slice(1).map(entry => entry.id)).eql(cut.map(entry => entry.id));
      should(new Set(whole.map(entry => entry.id)).size).equal(3);
    });

    it('should skip a queue record it cannot use: another operation, no text, or no time', () => {
      should(parseEntry(queueOp('popAll', 'x'))).be.undefined();
      should(parseEntry(queueOp('enqueue', 7))).be.undefined();
      should(parseEntry(queueOp('enqueue', 'x', 'soon'))).be.undefined();
    });

    it('should read a drained human prompt as a system entry carrying when the person typed it', () => {
      should(parseEntry(drained())).eql({
        id: 'att-1',
        at: '2026-11-01T10:00:09.000Z',
        role: 'system',
        text: 'FIXTURE typed mid-turn',
        data: { proof: 'queued-prompt', originatedAt: '2026-11-01T10:00:03.000Z' },
      });
    });

    it('should read a drain whose prompt is content blocks, and fall back to the record’s own time and an ordinal id', () => {
      const entry = parseEntry(
        JSON.stringify({
          type: 'attachment',
          timestamp: '2026-11-01T10:00:09.000Z',
          attachment: {
            type: 'queued_command',
            commandMode: 'prompt',
            origin: { kind: 'human' },
            prompt: [{ type: 'text', text: 'FIXTURE one' }, { type: 'image' }, { type: 'text', text: 'FIXTURE two' }],
          },
        }),
        4,
      );
      should(entry).eql({
        id: 'queued-prompt:4',
        at: '2026-11-01T10:00:09.000Z',
        role: 'system',
        text: 'FIXTURE one\nFIXTURE two',
        data: { proof: 'queued-prompt', originatedAt: '2026-11-01T10:00:09.000Z' },
      });
    });

    it('should skip a drain that is not a human prompt: another kind, mode or origin, or no text', () => {
      should(parseEntry(drained({}, { type: 'other' }))).be.undefined();
      should(parseEntry(drained({}, { commandMode: 'bash' }))).be.undefined();
      should(parseEntry(drained({}, { origin: { kind: 'task-notification' } }))).be.undefined();
      should(parseEntry(drained({}, { prompt: '   ' }))).be.undefined();
      should(parseEntry(drained({}, { prompt: [{ type: 'image' }] }))).be.undefined();
      should(parseEntry(JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command' } }))).be.undefined();
    });

    it('should use the drain’s own time when the record carries none, and none when neither does', () => {
      const lone = JSON.parse(drained()) as Record<string, unknown>;
      delete lone.timestamp;
      should(parseEntry(JSON.stringify(lone))?.at).equal('2026-11-01T10:00:03.000Z');
      const attachment = lone.attachment as Record<string, unknown>;
      delete attachment.timestamp;
      should(parseEntry(JSON.stringify(lone))).be.undefined();
    });
  });

  it('refuses a record with no id or a bad time', () => {
    should(parseEntry('{"type":"user","message":{"content":"x"}}')).be.undefined();
    should(parseEntry('{"type":"user","uuid":"u","timestamp":"soon"}')).be.undefined();
  });

  it('skips a line that is not JSON when it reads what the turns spent, and keeps the turns on either side', () => {
    const lines = [user, 'not json {', '', assistant].join('\n');
    should(parseUsage(lines).map(turn => [turn.turn, turn.model])).eql([[1, 'claude-opus-5-5']]);
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
