import { describe, it } from 'bun:test';
import should from 'should';
import {
  AGENT_INSTRUCTION,
  AGENT_TOOLS_INSTRUCTION,
  ALWAYS_ON_SECTIONS,
  ATTENTION_INSTRUCTION,
  applyFixedLayer,
  CLAUDE_NO_QUESTIONS_FLAG,
  CLAUDE_PROMPTS_SEEN,
  CODEX_HIDDEN_NOTICES,
  CODEX_NO_ALT_SCREEN_FLAG,
  claudeToolsConfig,
  codexNoticeOverride,
  codexToolsServer,
  codexTrustOverride,
  FERRET_SECTIONS,
  FERRETRY_MCP_ENV_VARS,
  type FixedLayer,
  type FixedLayerInput,
  fixedLayerFor,
  HYPERMEDIA_ENV,
  HYPERMEDIA_INSTRUCTION,
  LESSONS_INSTRUCTION,
  instructionDigest,
  launchInstructions,
  PACK_ENV,
  PACK_INSTRUCTION,
  PACK_ROUTING_ENV,
  PASSIVE_LEARNING_ENV,
  SESSION_MODE_ENV,
  SET_UP_FERRETRY_INSTRUCTION,
  tomlString,
} from '../../src/lib/account/fixed-layer.ts';
import { type ResolvedProfile, resolveProfile } from '../../src/lib/account/layering.ts';
import { parseAccountModel } from '../../src/lib/account/schema.ts';
import type { HarnessKind } from '../../src/lib/manifest.ts';

const CWD = '/home/me/work.repo';
const FY = '/opt/fy/bin/fy';
/** What every agent runtime is told, for the binary {@link FY} names. */
const INSTRUCTION = AGENT_INSTRUCTION('fy');
/** What every Claude agent launch ends with: the tools server, and the instruction that names it. */
const CLAUDE_TOOL_ARGS = [
  `--mcp-config={"mcpServers":{"ferretry":{"type":"stdio","command":"${FY}","args":["mcp","serve"],"env":{"FY_TOKEN":""}}}}`,
  `--append-system-prompt=${INSTRUCTION}`,
];
/** Every one-shot dialog a Claude agent's `.claude.json` records as seen, as locked entries. */
const CLAUDE_SEEN_ENTRIES = Object.entries(CLAUDE_PROMPTS_SEEN).map(([key, value]) => ({
  purpose: 'one-time-prompts',
  target: 'claude-json',
  path: [key],
  key,
  value,
}));
/** The measured `-c notice={…}` table hiding Codex's one-shot notices. */
const CODEX_NOTICE_ARGS = [
  '-c',
  'notice={hide_full_access_warning=true,hide_world_writable_warning=true,hide_rate_limit_model_nudge=true,hide_gpt5_1_migration_prompt=true,"hide_gpt-5.1-codex-max_migration_prompt"=true}',
];
/** And every Codex agent launch. */
const CODEX_TOOL_ARGS = [
  '-c',
  `mcp_servers.ferretry.command="${FY}"`,
  '-c',
  'mcp_servers.ferretry.args=["mcp","serve"]',
  '-c',
  'mcp_servers.ferretry.env_vars=["FY_HOME","FY_URL","FY_SESSION_ID","FY_SESSION_BOARD_CAPABILITY"]',
  '-c',
  `developer_instructions=${tomlString(INSTRUCTION)}`,
];

const layerOf = (input: FixedLayerInput): FixedLayer => {
  const result = fixedLayerFor(input);
  if (!result.ok) throw new Error(result.refusal.message);
  return result.layer;
};

/** A profile of one settings component, resolved for `harness`. */
const profileWith = (
  harness: HarnessKind,
  settings: { flags?: string[]; body?: Record<string, unknown> },
): ResolvedProfile => {
  const model = parseAccountModel({
    version: 2,
    components: {
      settings: {
        mine: {
          harness,
          ...(settings.flags === undefined ? {} : { flags: settings.flags }),
          ...(settings.body === undefined ? { env: { A: 'b' } } : { file: 'mine' }),
        },
      },
    },
    profiles: { agent: { layers: ['settings/mine'] } },
  });
  const result = resolveProfile({
    model,
    profile: 'agent',
    harness,
    ...(settings.body === undefined ? {} : { settingsBodies: { mine: settings.body } }),
  });
  if (!result.ok) throw new Error('unexpected');
  return result.resolved;
};

describe('fixedLayerFor — Claude', () => {
  it('should launch Auto mode explicitly, with no questions and the trust and onboarding keys', () => {
    // Act
    const actual = fixedLayerFor({
      harness: 'claude',
      agentPermissions: 'auto',
      cwd: CWD,
      fyCommand: FY,
      acceptsAutoPermissionMode: true,
    });

    // Assert
    should(actual).deepEqual({
      ok: true,
      layer: {
        harness: 'claude',
        agentPermissions: 'auto',
        entries: [
          {
            purpose: 'permission-mode',
            target: 'settings',
            path: ['permissions', 'defaultMode'],
            key: 'permissions.defaultMode',
            value: 'auto',
          },
          {
            purpose: 'trust',
            target: 'claude-json',
            path: ['projects', CWD, 'hasTrustDialogAccepted'],
            key: `projects."${CWD}".hasTrustDialogAccepted`,
            value: true,
          },
          {
            purpose: 'onboarding',
            target: 'claude-json',
            path: ['hasCompletedOnboarding'],
            key: 'hasCompletedOnboarding',
            value: true,
          },
          {
            purpose: 'remote-control',
            target: 'settings',
            path: ['remoteControlAtStartup'],
            key: 'remoteControlAtStartup',
            value: false,
          },
          ...CLAUDE_SEEN_ENTRIES,
          {
            purpose: 'skip-prompt',
            target: 'settings',
            path: ['skipAutoPermissionPrompt'],
            key: 'skipAutoPermissionPrompt',
            value: true,
          },
          {
            purpose: 'no-questions',
            target: 'launch',
            path: [CLAUDE_NO_QUESTIONS_FLAG],
            key: CLAUDE_NO_QUESTIONS_FLAG,
            value: true,
          },
          {
            purpose: 'tools',
            target: 'launch',
            path: ['--mcp-config'],
            key: '--mcp-config',
            value: {
              mcpServers: { ferretry: { type: 'stdio', command: FY, args: ['mcp', 'serve'], env: { FY_TOKEN: '' } } },
            },
          },
          {
            purpose: 'instructions',
            target: 'launch',
            path: ['--append-system-prompt'],
            key: '--append-system-prompt',
            value: INSTRUCTION,
          },
        ],
        args: ['--permission-mode', 'auto', '--disallowed-tools=AskUserQuestion', ...CLAUDE_TOOL_ARGS],
        claudeSettingsOverlay: {
          permissions: { defaultMode: 'auto' },
          remoteControlAtStartup: false,
          skipAutoPermissionPrompt: true,
        },
        claudeJson: {
          hasCompletedOnboarding: true,
          ...CLAUDE_PROMPTS_SEEN,
          projects: { [CWD]: { hasTrustDialogAccepted: true } },
        },
      },
    });
  });

  it('should launch Skip as bypassPermissions with the warning suppressed by an overlay', () => {
    // Act
    const actual = layerOf({
      harness: 'claude',
      agentPermissions: 'skip',
      cwd: CWD,
      fyCommand: FY,
      acceptsAutoPermissionMode: false,
    });

    // Assert — Skip needs no Auto support
    should(actual.args).deepEqual([
      '--permission-mode',
      'bypassPermissions',
      '--disallowed-tools=AskUserQuestion',
      ...CLAUDE_TOOL_ARGS,
    ]);
    // The overlay names the mode too: a flag-settings mode is what keeps the auto-default dialog away.
    should(actual.claudeSettingsOverlay).deepEqual({
      permissions: { defaultMode: 'bypassPermissions' },
      remoteControlAtStartup: false,
      skipDangerousModePermissionPrompt: true,
    });
    should(actual.entries.some(entry => entry.key === 'skipAutoPermissionPrompt')).be.false();
    should(actual.entries.map(entry => [entry.purpose, entry.key, entry.value])).containDeep([
      ['permission-mode', 'permissions.defaultMode', 'bypassPermissions'],
      ['skip-prompt', 'skipDangerousModePermissionPrompt', true],
    ]);
  });

  it('should refuse Auto mode on a Claude that does not accept it, naming the fix (O4)', () => {
    // Act
    const actual = fixedLayerFor({
      harness: 'claude',
      agentPermissions: 'auto',
      cwd: CWD,
      fyCommand: FY,
      acceptsAutoPermissionMode: false,
    });

    // Assert
    should(actual.ok).be.false();
    should(!actual.ok && actual.refusal.kind).equal('claude-auto-mode-unsupported');
    should(!actual.ok && actual.refusal.message).match(
      /Update Claude Code, or switch this machine's Agent permissions to Skip/,
    );
  });
});

describe('fixedLayerFor — Codex', () => {
  it('should map Auto mode to on-request in the workspace, with the measured trust table', () => {
    // Act
    const actual = layerOf({ harness: 'codex', agentPermissions: 'auto', cwd: CWD, fyCommand: FY });

    // Assert
    should(actual.args).deepEqual([
      '-c',
      'approval_policy="on-request"',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      `projects={"${CWD}"={trust_level="trusted"}}`,
      '--no-alt-screen',
      ...CODEX_NOTICE_ARGS,
      ...CODEX_TOOL_ARGS,
    ]);
    // One inline table, quoting the one key that is not a bare TOML key: measured to load in codex-cli 0.156.1.
    should(codexNoticeOverride()).equal(CODEX_NOTICE_ARGS[1]);
    should(actual.claudeJson).be.undefined();
    should(actual.claudeSettingsOverlay).be.undefined();
    should(actual.entries.map(entry => [entry.target, entry.key, entry.value])).deepEqual([
      ['settings', 'approval_policy', 'on-request'],
      ['settings', 'sandbox_mode', 'workspace-write'],
      ['settings', `projects."${CWD}".trust_level`, 'trusted'],
      ['launch', CODEX_NO_ALT_SCREEN_FLAG, true],
      ...CODEX_HIDDEN_NOTICES.map(key => [
        'settings',
        `notice.${/^[A-Za-z0-9_-]+$/.test(key) ? key : `"${key}"`}`,
        true,
      ]),
      ['settings', 'mcp_servers.ferretry', codexToolsServer(FY)],
      ['settings', 'developer_instructions', INSTRUCTION],
    ]);
  });

  it('should map Skip to never with full access', () => {
    // Act
    const actual = layerOf({ harness: 'codex', agentPermissions: 'skip', cwd: CWD, fyCommand: FY });

    // Assert
    should(actual.args.slice(0, 4)).deepEqual([
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="danger-full-access"',
    ]);
  });
});

describe('tomlString and codexTrustOverride', () => {
  it('should escape quotes, backslashes and control characters', () => {
    // Assert
    should(tomlString('a"b\\c\nd\u007f')).equal('"a\\"b\\\\c\\u000ad\\u007f"');
    should(tomlString('/plain/ü')).equal('"/plain/ü"');
  });

  it('should write the trust override as an inline table, whatever the folder holds', () => {
    // Assert
    should(codexTrustOverride('/a "b"')).equal('projects={"/a \\"b\\""={trust_level="trusted"}}');
  });
});

describe('applyFixedLayer', () => {
  const claudeAuto = layerOf({
    harness: 'claude',
    agentPermissions: 'auto',
    cwd: CWD,
    fyCommand: FY,
    acceptsAutoPermissionMode: true,
  });
  const codexSkip = layerOf({ harness: 'codex', agentPermissions: 'skip', cwd: CWD, fyCommand: FY });

  it('should append the fixed arguments last and write its settings over the profile', () => {
    // Arrange
    const profile = profileWith('claude', {
      flags: ['--verbose'],
      body: { permissions: { defaultMode: 'plan', allow: ['Bash(ls)'] }, theme: 'dark' },
    });

    // Act
    const actual = applyFixedLayer(profile, claudeAuto);

    // Assert
    should(actual.args).deepEqual([
      '--verbose',
      '--permission-mode',
      'auto',
      '--disallowed-tools=AskUserQuestion',
      ...CLAUDE_TOOL_ARGS,
    ]);
    should(actual.settings).deepEqual({
      permissions: { defaultMode: 'auto', allow: ['Bash(ls)'] },
      theme: 'dark',
      remoteControlAtStartup: false,
      skipAutoPermissionPrompt: true,
    });
    should(actual.fixed).equal(claudeAuto);
    should(actual.overridden).have.length(1);
    should(actual.overridden[0]).containDeep({
      kind: 'setting',
      key: 'permissions.defaultMode',
      path: ['permissions', 'defaultMode'],
      value: 'plan',
      layer: { name: 'mine' },
      fixed: { purpose: 'permission-mode', value: 'auto' },
    });
  });

  it('should override an imported Remote Control at startup preference and strike it through', () => {
    // Arrange — the owner's own Claude settings, copied into a profile, start every session with it on
    const profile = profileWith('claude', { body: { remoteControlAtStartup: true } });

    // Act
    const actual = applyFixedLayer(profile, claudeAuto);

    // Assert
    should(actual.settings).containDeep({ remoteControlAtStartup: false });
    should(actual.overridden.map(entry => entry.kind === 'setting' && [entry.key, entry.value])).deepEqual([
      ['remoteControlAtStartup', true],
    ]);
    should(actual.overridden[0]).containDeep({ fixed: { purpose: 'remote-control', value: false } });
  });

  it('should not report a user value equal to the fixed one', () => {
    // Act
    const actual = applyFixedLayer(
      profileWith('claude', { body: { permissions: { defaultMode: 'auto' } } }),
      claudeAuto,
    );

    // Assert
    should(actual.overridden).deepEqual([]);
  });

  it('should report a user table the fixed key replaces from above', () => {
    // Arrange — a whole `permissions` scalar, or a deeper key under a fixed scalar
    const profile = profileWith('codex', { body: { approval_policy: { nested: 1 }, sandbox_mode: 'read-only' } });

    // Act
    const actual = applyFixedLayer(profile, codexSkip);

    // Assert
    should(actual.overridden.map(entry => entry.kind === 'setting' && [entry.key, entry.value])).deepEqual([
      ['approval_policy.nested', 1],
      ['sandbox_mode', 'read-only'],
    ]);
    should(actual.settings).containDeep({
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access',
      projects: { [CWD]: { trust_level: 'trusted' } },
    });
  });

  it('should drop the Claude permission flags it replaces, in both spellings, and keep the rest', () => {
    // Arrange
    const profile = profileWith('claude', {
      flags: [
        '--permission-mode',
        'plan',
        '--verbose',
        '--permission-mode=acceptEdits',
        '--dangerously-skip-permissions',
        '--allow-dangerously-skip-permissions',
        '--disallowed-tools=AskUserQuestion',
        '--disallowed-tools=WebFetch',
        'auto',
        '--permission-mode',
      ],
    });

    // Act
    const actual = applyFixedLayer(profile, claudeAuto);

    // Assert
    should(actual.args).deepEqual([
      '--verbose',
      '--disallowed-tools=WebFetch',
      'auto',
      '--permission-mode',
      'auto',
      '--disallowed-tools=AskUserQuestion',
      ...CLAUDE_TOOL_ARGS,
    ]);
    should(actual.overridden.map(entry => entry.kind === 'flag' && entry.tokens)).deepEqual([
      ['--permission-mode', 'plan'],
      ['--permission-mode=acceptEdits'],
      ['--dangerously-skip-permissions'],
      ['--allow-dangerously-skip-permissions'],
      ['--permission-mode'],
    ]);
  });

  it('should drop the Codex permission flags and the config keys it sets, keeping other config', () => {
    // Arrange
    const profile = profileWith('codex', {
      flags: [
        '--full-auto',
        '-a',
        'untrusted',
        '--ask-for-approval=on-failure',
        '-s',
        'read-only',
        '--sandbox',
        'workspace-write',
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'approval_policy="untrusted"',
        '--config=sandbox_mode=read-only',
        '-c',
        'model_reasoning_effort="high"',
        '--config=tools.web_search=true',
        '--no-alt-screen',
        '--search',
        '-c',
      ],
    });

    // Act
    const actual = applyFixedLayer(profile, codexSkip);

    // Assert
    should(actual.args).deepEqual([
      '-c',
      'model_reasoning_effort="high"',
      '--config=tools.web_search=true',
      '--search',
      '-c',
      ...codexSkip.args,
    ]);
    should(actual.overridden.map(entry => entry.kind === 'flag' && entry.tokens)).deepEqual([
      ['--full-auto'],
      ['-a', 'untrusted'],
      ['--ask-for-approval=on-failure'],
      ['-s', 'read-only'],
      ['--sandbox', 'workspace-write'],
      ['--dangerously-bypass-approvals-and-sandbox'],
      ['-c', 'approval_policy="untrusted"'],
      ['--config=sandbox_mode=read-only'],
    ]);
  });
});

describe('the Ferretry tools in the fixed layer', () => {
  it('should hand Claude the tools server as a JSON string, so no file has to exist', () => {
    should(JSON.parse(CLAUDE_TOOL_ARGS[0]?.slice('--mcp-config='.length) ?? '')).deepEqual(claudeToolsConfig(FY));
  });

  it('should never hand the tools server the host admin token', () => {
    // Claude passes a stdio server the whole environment, so its entry blanks the token; Codex passes
    // only what is named, and the token is not named.
    should(claudeToolsConfig(FY)).match({ mcpServers: { ferretry: { env: { FY_TOKEN: '' } } } });
    should(FERRETRY_MCP_ENV_VARS).not.containEql('FY_TOKEN');
    should(codexToolsServer(FY).env_vars).not.containEql('FY_TOKEN');
  });

  it('should APPEND to a profile’s own Claude instruction, in either spelling, and report nothing overridden', () => {
    // Arrange
    const claude = layerOf({
      harness: 'claude',
      agentPermissions: 'auto',
      cwd: CWD,
      fyCommand: FY,
      acceptsAutoPermissionMode: true,
    });
    const spaced = profileWith('claude', { flags: ['--append-system-prompt', 'be terse', '--mcp-config=extra.json'] });
    const joined = profileWith('claude', { flags: ['--append-system-prompt=always test'] });

    // Act
    const one = applyFixedLayer(spaced, claude);
    const two = applyFixedLayer(joined, claude);

    // Assert — the person's own MCP servers and instruction both stay; theirs first, then Ferretry's.
    should(one.args).containEql('--mcp-config=extra.json');
    should(one.args.filter(arg => arg.startsWith('--append-system-prompt'))).deepEqual([
      `--append-system-prompt=be terse\n\n${INSTRUCTION}`,
    ]);
    should(one.args).not.containEql('be terse');
    should(one.overridden).deepEqual([]);
    should(two.args).containEql(`--append-system-prompt=always test\n\n${INSTRUCTION}`);
    should(one.fixed.entries.find(entry => entry.purpose === 'instructions')?.value).equal(
      `be terse\n\n${INSTRUCTION}`,
    );
  });

  it('should APPEND to a profile’s Codex instructions from settings or a -c flag, and still own the tools server', () => {
    // Arrange
    const codex = layerOf({ harness: 'codex', agentPermissions: 'auto', cwd: CWD, fyCommand: FY });
    const fromSettings = profileWith('codex', {
      body: {
        developer_instructions: 'prefer bun',
        mcp_servers: { ferretry: { command: '/evil' }, github: { command: 'gh' } },
      },
    });
    const fromFlags = profileWith('codex', {
      flags: [
        '-c',
        'developer_instructions="be terse"',
        '--config=developer_instructions=plain',
        '--config=developer_instructions="tab\\q"',
        '-c',
        'mcp_servers.ferretry.command="/evil"',
        '--config=mcp_servers.ferretry={command="/evil"}',
        '-c',
        'mcp_servers.github.command="gh"',
        '-c',
        'developer_instructions="broken',
      ],
    });

    // Act
    const settings = applyFixedLayer(fromSettings, codex);
    const flags = applyFixedLayer(fromFlags, codex);

    // Assert
    should(settings.settings).containDeep({
      developer_instructions: `prefer bun\n\n${INSTRUCTION}`,
      mcp_servers: { ferretry: codexToolsServer(FY), github: { command: 'gh' } },
    });
    should(settings.overridden.map(entry => (entry.kind === 'setting' ? entry.key : ''))).deepEqual([
      'mcp_servers.ferretry.command',
    ]);
    should(flags.args).containEql('mcp_servers.github.command="gh"');
    should(flags.args).containEql(
      `developer_instructions=${tomlString(`be terse\n\nplain\n\ntab\\q\n\n"broken\n\n${INSTRUCTION}`)}`,
    );
    should(flags.overridden.map(entry => entry.kind === 'flag' && entry.tokens)).deepEqual([
      ['-c', 'mcp_servers.ferretry.command="/evil"'],
      ['--config=mcp_servers.ferretry={command="/evil"}'],
    ]);
  });

  it('should leave the layer untouched when the person has no instruction of their own', () => {
    const codex = layerOf({ harness: 'codex', agentPermissions: 'auto', cwd: CWD, fyCommand: FY });
    const plain = applyFixedLayer(profileWith('codex', { body: { model: 'x' } }), codex);
    should(plain.fixed).equal(codex);
  });
});

describe('passive learning teaching', () => {
  it('should be a per-ferret system prompt section, not a tools-server variable, and teach the suggest command by name', () => {
    // Arrange
    const binary = 'fy';

    // Act
    const teaching = LESSONS_INSTRUCTION(binary);

    // Assert
    should(FERRETRY_MCP_ENV_VARS).not.containEql(PASSIVE_LEARNING_ENV);
    should(FERRET_SECTIONS(binary).find(section => section.env === PASSIVE_LEARNING_ENV)?.text).equal(teaching);
    should(PASSIVE_LEARNING_ENV).equal('FY_LEARNING_PASSIVE');
    should(teaching).containEql('`fy lesson suggest "<rule>" --scope global|repo`');
    should(teaching).containEql('lessons_suggest');
  });
});

describe('hypermedia teaching', () => {
  it('should be a per-ferret system prompt section and teach every form with one fenced example', () => {
    // Arrange
    const forms = ['mermaid', 'svg', 'html', 'map', 'chart', 'image, video, audio, pdf'];

    // Act
    const lines = HYPERMEDIA_INSTRUCTION.split('\n');

    // Assert
    should(FERRETRY_MCP_ENV_VARS).not.containEql(HYPERMEDIA_ENV);
    should(FERRET_SECTIONS('fy')[0]).deepEqual({ id: 'hypermedia', env: HYPERMEDIA_ENV, text: HYPERMEDIA_INSTRUCTION });
    should(HYPERMEDIA_ENV).equal('FY_HYPERMEDIA');
    for (const form of forms) should(lines.some(line => line.startsWith(`- ${form}:`))).be.true();
    should(lines).containDeepOrdered(['```fy-render', 'type: mermaid', '---', '```']);
    should(HYPERMEDIA_INSTRUCTION).containEql('Do not overdo it');
    // The owner's three asks: reach for it when teaching, keep it inline, and tell it interactively.
    should(HYPERMEDIA_INSTRUCTION).startWith('Hypermedia: when you teach, explain, compare or walk through');
    should(HYPERMEDIA_INSTRUCTION).containEql(
      'never publish an artifact, page, gist or link to explain something unless the owner asks',
    );
    should(HYPERMEDIA_INSTRUCTION).containEql('step-through Next buttons');
    should(HYPERMEDIA_INSTRUCTION).containEql('prefers-reduced-motion');
    // The theme is the reader's: a ferret never paints a chart or a diagram.
    should(HYPERMEDIA_INSTRUCTION).containEql('No colours: tone');
    should(HYPERMEDIA_INSTRUCTION).containEql('auto-themed, so no %%{init}%% or colours');
    // A phone column is narrow: a ferret is taught to draw top-down with short labels.
    should(HYPERMEDIA_INSTRUCTION).containEql('flowchart TB');
    should(HYPERMEDIA_INSTRUCTION).containEql('top-down, short labels');
    should(HYPERMEDIA_INSTRUCTION).not.containEql('flowchart LR');
    // In every prompt, so it is capped; raised from 1,200 for the three asks above, then from 1,600 for `chart`; 1,970 with the top-down hint.
    should(HYPERMEDIA_INSTRUCTION.length).be.below(2000);
  });
});

describe('Pack mode teaching', () => {
  it('should be the per-ferret section between hypermedia and lessons, naming every step by the binary it is given', () => {
    // Arrange
    const binary = 'zz';

    // Act
    const sections = FERRET_SECTIONS(binary);
    const teaching = PACK_INSTRUCTION(binary);

    // Assert
    should(sections.map(section => section.env)).deepEqual([HYPERMEDIA_ENV, PACK_ENV, PASSIVE_LEARNING_ENV]);
    should(sections[1]?.text).equal(teaching);
    should(PACK_ENV).equal('FY_PACK');
    for (const step of [
      '`zz recommend`',
      '`zz new --runtime',
      '`zz new --auto',
      '--name "<short task title>"',
      '`zz wait <id>`',
      '`zz stop children',
    ])
      should(teaching).containEql(step);
    for (const code of [
      'out_of_quota',
      'not_logged_in',
      'cli_missing',
      'probe_failed',
      'limit_reached',
      'depth_exceeded',
    ])
      should(teaching).containEql(code);
    should(teaching).not.containEql('fy ');
    should(teaching.length).be.below(1200);
  });
});

describe('ATTENTION_INSTRUCTION', () => {
  it('should teach raising a structured item, never for progress, the answer message, and resolving, with the binary name given', () => {
    // Act
    const text = ATTENTION_INSTRUCTION('zz');

    // Assert
    // Why first: the owner reads the board, so an ask left in a reply reaches nobody.
    should(text).startWith('Attention: the owner reads the board, not your replies');
    // Every notification is an item, and progress is never one.
    should(text).containEql('every notification is an Attention item (never progress)');
    // Every human action is its own item, raised before the reply ends — never prose alone.
    should(text).containEql(
      'Before ending a reply that asks them to decide or DO anything, raise each ask as its OWN item',
    );
    // An ask starts in discussion in the chat, one per thing; a card is a short title and a one-line ask.
    should(text).containEql('one per thing, starting in chat discussion:');
    should(text).containEql('`zz attention add --title "<what it is about>" "<the ask>"`');
    should(text).containEql('Title ≤40 chars; ask ≤120.');
    // Isolated: the reader has not followed the conversation, so they must be able to answer cold.
    should(text).containEql('Owner answers cold: no "as above"');
    should(text).containEql('ticket/PR numbers');
    // Point form: the situation, why now and earlier answers are separate flags; a SMALL diagram or mock-up
    // rides in the body when it shows the point faster than words.
    should(text).containEql('`--premise` = situation, `--context` = why now, `--decided` = earlier answers');
    should(text).containEql('a SMALL diagram/mock-up (fy-render svg|html|mermaid)');
    should(text).containEql('ticket/PR numbers, paths or unexplained acronyms');
    should(text).containEql('`--term "X=meaning"`');
    // Kinds, at most three directional answers, the recommendation on the right.
    should(text).containEql('`--kind task|yesno|permission|choice|review|info`');
    should(text).containEql('Choice: 2–3 `--option`s;');
    should(text).containEql('`--recommend <pick> --recommend-why <line>`');
    should(text).containEql('To-do: `--step "<md>"`');
    // An answer is read apart: an option with its note, or the owner's own words instead of the options.
    should(text).containEql('"[answer to !A3 …] <option> · note: …"');
    should(text).containEql('"Other answer (none of the options): …"');
    // The need-more-info loop: expand the same item.
    should(text).containEql('"[needs more info !A3 …]" → `zz attention edit <id>`');
    // The discussion loop: a reply about an ask closes nothing; close what it answered, surface the rest.
    should(text).containEql('"[reply about !A3 …]" is chat; nothing closes:');
    should(text).containEql('`zz attention done <id>` what it answered');
    should(text).containEql('`zz attention surface <id>` the rest');
    // Open items are read on demand.
    should(text).containEql('Open: `zz attention ls`');
    should(text).not.containEql('notify');
    should(text).not.containEql('fy ');
  });

  it('should stay short: it is in every prompt', () => {
    // Assert
    should(ATTENTION_INSTRUCTION('fy').length).be.below(1_050);
  });

  it('should ride in the always-on instruction after the settings rules, not behind a switch', () => {
    // Assert
    should(AGENT_INSTRUCTION('fy')).endWith(`\n\n${ATTENTION_INSTRUCTION('fy')}`);
    should(AGENT_INSTRUCTION('fy').indexOf(SET_UP_FERRETRY_INSTRUCTION('fy'))).be.below(
      AGENT_INSTRUCTION('fy').indexOf(ATTENTION_INSTRUCTION('fy')),
    );
    should(FERRET_SECTIONS('fy').map(section => section.id)).not.containEql('attention');
  });
});

describe('ALWAYS_ON_SECTIONS', () => {
  it('should be exactly the always-on instruction, section by section, in order', () => {
    // Act
    const sections = ALWAYS_ON_SECTIONS('zz');

    // Assert
    should(sections.map(section => section.id)).deepEqual(['tools', 'settings', 'attention']);
    should(sections.map(section => section.text).join('\n\n')).equal(AGENT_INSTRUCTION('zz'));
  });
});

describe('instructionDigest', () => {
  it('should be a short, stable fingerprint that changes with the words', () => {
    // Act
    const once = instructionDigest(ATTENTION_INSTRUCTION('fy'));
    const again = instructionDigest(ATTENTION_INSTRUCTION('fy'));
    const other = instructionDigest(ATTENTION_INSTRUCTION('zz'));

    // Assert
    should(once).match(/^[0-9a-f]{14}$/u);
    should(once).equal(again);
    should(once).not.equal(other);
    should(instructionDigest('')).match(/^[0-9a-f]{14}$/u);
  });
});

describe('launchInstructions', () => {
  it('should name every section the wrapper would compose for an interactive ferret, with each size, and leave its question tool in', () => {
    // Arrange
    const binary = 'zz';
    const env = {
      [SESSION_MODE_ENV]: 'interactive',
      [HYPERMEDIA_ENV]: '1',
      [PACK_ENV]: '1',
      [PASSIVE_LEARNING_ENV]: '1',
    };

    // Act
    const launched = launchInstructions(binary, env);

    // Assert
    should(launched).deepEqual({
      sections: [
        {
          id: 'tools',
          chars: AGENT_TOOLS_INSTRUCTION.length,
          digest: instructionDigest(AGENT_TOOLS_INSTRUCTION),
        },
        {
          id: 'settings',
          chars: SET_UP_FERRETRY_INSTRUCTION(binary).length,
          digest: instructionDigest(SET_UP_FERRETRY_INSTRUCTION(binary)),
        },
        {
          id: 'attention',
          chars: ATTENTION_INSTRUCTION(binary).length,
          digest: instructionDigest(ATTENTION_INSTRUCTION(binary)),
        },
        { id: 'hypermedia', chars: HYPERMEDIA_INSTRUCTION.length },
        { id: 'pack', chars: PACK_INSTRUCTION(binary).length },
        { id: 'learning', chars: LESSONS_INSTRUCTION(binary).length },
      ],
      mode: 'interactive',
      questions: true,
    });
  });

  it("should count the routing prompt's line in the Pack section, and only while Pack mode is on", () => {
    // Arrange
    const line = 'Routing: Everyday coding: claude-sonnet-5-5.';

    // Act
    const on = launchInstructions('fy', { [PACK_ENV]: '1', [PACK_ROUTING_ENV]: line });
    const off = launchInstructions('fy', { [PACK_ENV]: '0', [PACK_ROUTING_ENV]: line });

    // Assert
    should(on.sections.find(section => section.id === 'pack')?.chars).equal(
      PACK_INSTRUCTION('fy').length + 1 + line.length,
    );
    should(off.sections.map(section => section.id)).deepEqual(['tools', 'settings', 'attention']);
  });

  it.each([
    ['interactive', { [SESSION_MODE_ENV]: 'interactive' }],
    ['auto', { [SESSION_MODE_ENV]: 'auto' }],
    ['unset', {}],
    ['every switch on', { [HYPERMEDIA_ENV]: '1', [PACK_ENV]: '1', [PASSIVE_LEARNING_ENV]: '1' }],
    ['every switch off', { [HYPERMEDIA_ENV]: '0', [PACK_ENV]: '0', [PASSIVE_LEARNING_ENV]: '0' }],
  ])(
    'should report the attention section, between settings and the per-ferret sections, for a %s launch',
    (_name, env) => {
      // Act
      const ids = launchInstructions('fy', env).sections.map(section => section.id);

      // Assert
      should(ids.slice(0, 3)).deepEqual(['tools', 'settings', 'attention']);
      should(launchInstructions('fy', env).sections[2]?.chars).equal(ATTENTION_INSTRUCTION('fy').length);
    },
  );

  it('should carry only the always-on sections, and withhold questions, for a launch with no mode and no switch exactly 1', () => {
    // Arrange
    const env = { [HYPERMEDIA_ENV]: '0', [PACK_ENV]: 'yes', [PASSIVE_LEARNING_ENV]: '' };

    // Act
    const launched = launchInstructions('fy', env);

    // Assert
    should(launched.sections.map(section => section.id)).deepEqual(['tools', 'settings', 'attention']);
    should(launched.mode).equal('auto');
    should(launched.questions).be.false();
  });
});
