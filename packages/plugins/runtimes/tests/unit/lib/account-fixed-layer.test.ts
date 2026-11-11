import { describe, it } from 'bun:test';
import { AGENDA_SHAPE_LINE } from '../../../daemon/lib/foreign.ts';
import should from 'should';
import {
  AGENDA_ENV,
  AGENDA_INSTRUCTION,
  AGENT_BASE_INSTRUCTION,
  AGENT_TOOLS_INSTRUCTION,
  ALWAYS_ON_SECTIONS,
  applyFixedLayer,
  BOARD_INSTRUCTION,
  CLAUDE_NO_QUESTIONS_FLAG,
  CLAUDE_PROMPTS_SEEN,
  CLAUDE_QUESTION_HOOK_COMMAND,
  CLAUDE_QUESTION_HOOKS,
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
  instructionDigest,
  LEAD_RULES_INSTRUCTION,
  LESSONS_INSTRUCTION,
  launchInstructions,
  NOTIFY_INSTRUCTION,
  PACK_ENV,
  PACK_INSTRUCTION,
  PACK_ROUTING_ENV,
  PASSIVE_LEARNING_ENV,
  SESSION_MODE_ENV,
  SET_UP_FERRETRY_INSTRUCTION,
  SUB_FERRET_ENV,
  SUB_FERRET_INSTRUCTION,
  tomlString,
} from '../../../daemon/lib/account/fixed-layer.ts';
import { type ResolvedProfile, resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { HarnessKind } from '../../../daemon/lib/manifest.ts';

/** What every lead agent is told: the always-on sections, in order, joined as the wrapper joins them. */
const leadInstruction = (fy: string): string =>
  ALWAYS_ON_SECTIONS(fy)
    .map(section => section.text)
    .join('\n\n');

const CWD = '/home/me/work.repo';
const FY = '/opt/fy/bin/fy';
/** What every agent runtime is told, for the binary {@link FY} names. */
const INSTRUCTION = AGENT_BASE_INSTRUCTION('fy');
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
  'mcp_servers.ferretry.env_vars=["FY_HOME","FY_URL","FY_SESSION_ID","FY_SESSION_TOKEN","FY_SESSION_BOARD_CAPABILITY"]',
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
    version: 1,
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
          hooks: CLAUDE_QUESTION_HOOKS,
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
      hooks: CLAUDE_QUESTION_HOOKS,
    });
    should(actual.entries.some(entry => entry.key === 'skipAutoPermissionPrompt')).be.false();
    should(actual.entries.map(entry => [entry.purpose, entry.key, entry.value])).containDeep([
      ['permission-mode', 'permissions.defaultMode', 'bypassPermissions'],
      ['skip-prompt', 'skipDangerousModePermissionPrompt', true],
    ]);
  });

  it('should hand the daemon every question Claude asks through an overlay hook, and never through settings', () => {
    // Act
    const actual = layerOf({
      harness: 'claude',
      agentPermissions: 'skip',
      cwd: CWD,
      fyCommand: FY,
      acceptsAutoPermissionMode: false,
    });

    // Assert — Claude 2.1.281 writes an AskUserQuestion call to its transcript only once the form is
    // answered, so the hook is how the daemon learns of an open one: before the form, for that tool alone.
    should(actual.claudeSettingsOverlay?.hooks).deepEqual({
      PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: CLAUDE_QUESTION_HOOK_COMMAND }] }],
    });
    // The file it writes is the one the daemon names per pane, and it never fails the tool it watches.
    should(CLAUDE_QUESTION_HOOK_COMMAND).containEql('"$FY_QUESTION_FILE"');
    should(CLAUDE_QUESTION_HOOK_COMMAND).endWith('exit 0');
    // A settings entry is written OVER the profile's own settings, which would drop a person's own hooks.
    should(actual.entries.some(entry => entry.path[0] === 'hooks')).be.false();
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

  it("should hand both tools servers the ferret's own credential under its documented name", () => {
    // Codex passes only what is named, so the bearer `fy mcp serve` presents must be named; the older
    // name stays for a server from before the rename. Claude passes the whole environment and blanks
    // only FY_TOKEN, so the credential reaches it unnamed.
    should(codexToolsServer(FY).env_vars).containEql('FY_SESSION_TOKEN');
    should(codexToolsServer(FY).env_vars).containEql('FY_SESSION_BOARD_CAPABILITY');
    should(claudeToolsConfig(FY)).deepEqual({
      mcpServers: { ferretry: { type: 'stdio', command: FY, args: ['mcp', 'serve'], env: { FY_TOKEN: '' } } },
    });
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
    should(teaching).containEql('global = every ferret, repo = this project');
    should(teaching).containEql('File each once.');
    // Compressed to make room for the Board section (cap 7,400 for the whole prompt).
    should(teaching.length).be.below(270);
    should(teaching).containEql('lessons_suggest');
  });
});

describe('hypermedia teaching', () => {
  it('should be a per-ferret system prompt section and teach every form with one fenced example', () => {
    // Arrange
    const forms = ['mermaid', 'svg', 'html', 'chart', 'card, board (live cards), map, image, video, audio, pdf'];
    const teaching = HYPERMEDIA_INSTRUCTION('zz');

    // Act
    const lines = teaching.split('\n');

    // Assert
    should(FERRETRY_MCP_ENV_VARS).not.containEql(HYPERMEDIA_ENV);
    should(FERRET_SECTIONS('zz')[0]).deepEqual({ id: 'hypermedia', env: HYPERMEDIA_ENV, text: teaching });
    should(HYPERMEDIA_ENV).equal('FY_HYPERMEDIA');
    for (const form of forms) should(lines.some(line => line.startsWith(`- ${form}:`))).be.true();
    should(lines).containDeepOrdered(['```fy-render', 'type: mermaid', '---', '```']);
    should(teaching).containEql('anything not simple');
    // The owner's three asks: reach for it when teaching, keep it inline, and tell it interactively.
    should(teaching).startWith('Hypermedia: to teach, explain or compare anything not simple');
    should(teaching).containEql('Inline: never publish a page or link unless asked.');
    // The owner: "interactive should not be steppers … the visualization changes based on user interaction".
    should(teaching).containEql(
      'Make it interactive: a visual the reader changes (sliders, toggles) that redraws live, no steppers;',
    );
    should(teaching).not.containEql('Next buttons');
    should(teaching).containEql('prefers-reduced-motion');
    // The owner's explainer rule (&C48): ADHD-friendly, said in those words, with an example for each point.
    should(teaching).containEql(
      'Explainers are ADHD-friendly: answer first, one idea per line, plain words, bold only the key point, an example per point.',
    );
    // fy-render draws in chat, agenda tabs and cards, so "chat only" no longer contradicts the agenda's tabs.
    should(teaching).containEql('Renders in chat, agenda tabs, cards; never in repo files, docs, commits, PRs.');
    should(teaching).not.containEql('Chat only');
    // The theme is the reader's: a ferret never paints a chart or a diagram.
    should(teaching).containEql('{kind: bar|line|area|pie|…, x: […], series: [{name, data}]}');
    // Map, media and chart's full spec are one command away, named with the binary.
    should(teaching).containEql('full spec: `zz render guide chart`');
    should(teaching).containEql('- card, board (live cards), map, image, video, audio, pdf: `zz render guide <type>`');
    should(teaching).not.containEql('`fy ');
    should(teaching).containEql('auto-themed: no %%{init}%% or colours');
    // A phone column is narrow: a ferret is taught to draw top-down with short labels.
    should(teaching).containEql('flowchart TB');
    should(teaching).containEql('top-down, short labels');
    should(teaching).not.containEql('flowchart LR');
    // In every prompt, so it is capped: 1,970 with the top-down hint, then cut to ~1,500 by moving map, media and
    // chart's full spec behind `render guide` to make room for the Board section. The explainer rule (&C48) was paid
    // for by tightening the first lines and the mermaid, svg and html lines: 1,320 → 1,209; then the html line's theme-token rule (&B163).
    should(teaching.length).be.below(1_550);
  });
});

describe('Pack mode teaching', () => {
  it('should be the per-ferret section after hypermedia, before agenda and lessons, naming every step by the binary it is given', () => {
    // Arrange
    const binary = 'zz';

    // Act
    const sections = FERRET_SECTIONS(binary);
    const teaching = PACK_INSTRUCTION(binary);

    // Assert
    should(sections.map(section => section.env)).deepEqual([
      HYPERMEDIA_ENV,
      PACK_ENV,
      AGENDA_ENV,
      PASSIVE_LEARNING_ENV,
    ]);
    should(sections[1]?.text).equal(teaching);
    should(PACK_ENV).equal('FY_PACK');
    for (const step of [
      '`zz recommend`',
      '`zz new --runtime',
      '`zz new --auto',
      '--name "<short task title>"',
      '`zz wait <id>`',
      'Label sends: `--kind blocker|action|fyi` (fyi rarely)',
      '`zz status --subtree` instead of asking them',
      'Delegate screenshot review to a sub-agent and keep only its verdict.',
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

describe('NOTIFY_INSTRUCTION', () => {
  it('should teach one quiet notice command, the opt-in ping, and no progress, with the binary name given', () => {
    // Act
    const text = NOTIFY_INSTRUCTION('zz');

    // Assert
    should(text).startWith('Notify: the owner reads the Inbox, not your replies.');
    should(text).containEql('`zz notify "<summary>" [--body "<detail>"]`');
    should(text).containEql('a quiet Inbox notice');
    should(text).containEql('Add `--ping` only when it must reach their phone now.');
    should(text).containEql('Never notify progress or chatter.');
    // The agenda is its own switchable section: the always-on rule never teaches it, and never says Attention.
    should(text).not.containEql('agenda');
    should(text).not.containEql('Attention');
    should(text).not.containEql('`fy ');
  });

  it('should stay short: it is in every prompt', () => {
    // Assert
    should(NOTIFY_INSTRUCTION('fy').length).be.below(450);
  });

  it('should ride in the always-on instruction after the settings rules, not behind a switch', () => {
    // Assert
    should(leadInstruction('fy')).containEql(`\n\n${NOTIFY_INSTRUCTION('fy')}\n\n`);
    should(leadInstruction('fy').indexOf(SET_UP_FERRETRY_INSTRUCTION('fy'))).be.below(
      leadInstruction('fy').indexOf(NOTIFY_INSTRUCTION('fy')),
    );
    should(FERRET_SECTIONS('fy').map(section => section.id)).not.containEql('notify');
  });
});

describe('AGENDA_INSTRUCTION', () => {
  it('should teach what an agenda is first: one channel, the three-part test, search-check-open, split', () => {
    // Act
    const text = AGENDA_INSTRUCTION('zz');

    // Assert
    should(text).startWith("Agenda mode: one channel of the owner's attention; only what they can give.");
    should(text).containEql('Share if same place, same context, same pace;');
    // Dependent things are always one agenda: splitting them would make the owner decide half a thing.
    should(text).containEql('dependent things always share.');
    should(text).containEql('Search, check, then open (`zz search`): none fits→open, else closest.');
    should(text).containEql('`split` misfits, `merge` items that share.');
  });

  it('should teach the one command that opens one, cold-readable, with the shape of every kind', () => {
    // Act
    const text = AGENDA_INSTRUCTION('zz');

    // Assert — premise and context are part of the one command: every item is read cold.
    should(text).containEql('Open: `zz agenda add --title "<topic>" --premise "<now>" --context "<facts>" "<ask>"`.');
    // The tabs are the live document (&F923): the main tab is no longer a short status, so the open line names none.
    should(text).containEql('Title ≤40, ask ≤80. Read cold');
    should(text).not.containEql('short status');
    // The owner's formatting rule: short points, answer first, no Markdown headings anywhere.
    should(text).containEql(
      'Read cold: no ids/paths/jargon (`--term X=meaning`); short points, answer first, no headings.',
    );
    // ONE ANSWER SHAPE PER KIND, in the protocol's own words (the CLI's help and refusals say the same).
    should(text).containEql(AGENDA_SHAPE_LINE);
    // When it is needed: it blocks now, will block later, or by a time.
    should(text).containEql('`--blocking`=stuck, `--will-block`=later, `--by <time>`.');
  });

  it("should teach the states: Needs you buzzes, Resting is quiet, the owner's reply rests it, only the ferret marks Done", () => {
    // Act
    const text = AGENDA_INSTRUCTION('zz');

    // Assert
    should(text).containEql('Needs you buzzes; Resting is quiet.');
    should(text).containEql('Owner reply/answer rests it;');
    // The ferret's answer ON the item brings it back; an owner's question is answered there, its options open.
    should(text).containEql('`answer <id> "…"` returns it.');
    should(text).containEql('`rest <id> --why …`=working.');
    // The owner (&C48): "make sure the chat ALWAYS update their asks, their body"; tabs hold any kind, and steps and
    // explainers stay in them.
    // And READ → EDIT (the owner: "we need to read to know what needs to be updated"): every part, the ask's too.
    should(text).containEql(
      "Every update: `show <id> --yaml` whole, rewrite all that's stale (premise, context, ask, options, kind, still-open, each tab), then `patch <id> --file f`; chat points there.",
    );
    should(text).containEql('Tabs hold any kind (to-dos, steps, explainers), one each, serial stays one, kept there.');
    should(text).not.containEql('(main)');
    should(text).not.containEql('--back');
    should(text).containEql("Only you mark it `done` when nothing's left.");
    // No item type (the owner: "now agenda doesn't have a "main" type any more"): the stage chain is not taught.
    should(text).not.containEql('Type:');
    should(text).not.containEql('`--stage`');
    // All discussion about an agenda lands in it, the owner's words verbatim (!A304), copied by `log` (DoD 16).
    should(text).containEql(
      'Chat: `log <id> --reply|--rest` logs their words verbatim; link it; unsure→closest, say so.',
    );
  });

  it("should keep the owner's two standing rules word for word: one agenda for a bug batch, and an owner's question answered on its item", () => {
    // Act
    const text = AGENDA_INSTRUCTION('zz');

    // Assert — the bug batch is ONE agenda with a line per bug and where each is tracked.
    should(text).containEql('Bug batch: ONE agenda, line each + where tracked.');
    // Both owner-question cases: it is about an item → answer ON it, the options stay; there is none → ONE `-k info`.
    should(text).containEql('Owner Q: answer ON it, options stay; no item: ONE `-k info`.');
    // The retired tracking rule stays gone.
    should(text).not.containEql('No tracking items');
  });

  it('should name only the verbs that exist today, under the binary name given', () => {
    // Act
    const text = AGENDA_INSTRUCTION('zz');

    // The conversation verbs ship on this branch, inside the unchanged section and total budgets.
    should(text).containEql('`log <id> --reply|--rest`');
    should(text).containEql('`split` misfits, `merge` items that share');
    should(text).not.containEql('Attention');
    should(text).not.containEql('`fy ');
    // The retired rules: an agenda now evolves into a tracker, and a reply no longer parks it.
    should(text).not.containEql('No tracking items');
    should(text).not.containEql('parks it');
  });

  it('should stay within its cap: it is in every prompt that turns the mode on', () => {
    // Assert — measured 1,269: main's 1,236 plus PR 3's `log`, `split` and `merge` (the chat line names `log`, the
    // split line names both verbs), paid for in part by `answer <id> "…"`, plus the `done` verb and "say so", paid
    // for by "logs their words verbatim" and "unsure→closest". Then 1,289: the body as the live document (F909, the
    // owner on !A332) — `--where`=short status, and the body rewritten whole with `edit --body-file` while the chat
    // only points at it — paid for in part by the old "(rest: `--body`, one-screen summary; full report: `--link`)",
    // ", `--where`=now" and "Keep current (`edit`)" (cap 1,270 → 1,300). The tabs (&F923) kept it at 1,289: the main tab
    // and a ferret's own tabs, paid for by dropping ", `--where`=short status". Then 1,311: the owner's split rule (&F946),
    // "tabs by content kind (serial stays one)", paid for in part by the open line's placeholders ("<now>", "<facts>")
    // and `--term X=meaning` unquoted (cap 1,300 → 1,320). Then 1,338: the owner's always-rewrite and tabs-hold-anything
    // rules (&C48), paid for in part by the stage chain and `--stage` (cap 1,320 → 1,340); then 1,352 for read → edit,
    // paid for in part by the stage chain; review then restored the open line's value placeholders, so a copied command
    // runs (1,380, cap 1,390).
    should(AGENDA_INSTRUCTION('fy').length).be.below(1_390);
  });

  it('should be a per-ferret section between pack and learning, on only when FY_AGENDA is exactly 1', () => {
    // Act
    const sections = FERRET_SECTIONS('fy');

    // Assert
    should(sections.map(section => section.id)).deepEqual(['hypermedia', 'pack', 'agenda', 'learning']);
    should(sections.find(section => section.id === 'agenda')).match({ env: AGENDA_ENV });
    should(AGENDA_ENV).equal('FY_AGENDA');
  });
});

describe('BOARD_INSTRUCTION', () => {
  it('should make the board opt-in: a card only when asked, handed one or switched on', () => {
    // Act
    const text = BOARD_INSTRUCTION('zz');

    // Assert — the daemon's opt-in refusal says how to ask for the Yes (`board/opt-in.ts`).
    should(text).startWith('Board: opt-in, enforced; overrides other task rules.');
    should(text).containEql(
      "Card only if `zz board status` is on, under your card (`--parent`), or on the owner's Yes (`--approval !A<n>`).",
    );
    should(text).not.containEql('all work is a card');
    should(text).not.containEql('make one)');
  });

  it('should say a card never asks, its agenda moves it, and one card is never an umbrella', () => {
    // Act
    const text = BOARD_INSTRUCTION('zz');

    // Assert — the owner (&C48): "TASK no longer have user interactivity anymore! agenda tracks all those".
    should(text).containEql('Cards (&F412) never ask: answers, tests, Done ride its agenda, which moves it.');
    should(text).containEql('One outcome, no umbrellas; add to a related card.');
  });

  it('should teach planning as a phase, the title as a sitrep and the status rewritten whole', () => {
    // Act
    const text = BOARD_INSTRUCTION('zz');

    // Assert — the owner (&C48): "planning can be a phase!", "reading the title should directly reflect what is doing".
    should(text).containEql('Planning is a phase.');
    should(text).containEql("Title+summary=what it's doing (sitrep).");
    should(text).containEql(
      'Each step: `zz task show <id> --yaml`, rewrite stale title, summary, status (PRs in doneSoFar), howToTest (where/do/see) before try, then `zz task patch <id> --file f`.',
    );
    should(text).not.containEql('no cards for planning');
  });

  it("should teach that the owner's asks are public top-level cards, never --parent or --private", () => {
    // Act
    const text = BOARD_INSTRUCTION('zz');

    // Assert — the board answers "status of all I asked?"; a sub-card or a private card is hidden from it.
    should(text).containEql(
      'Public=the owner\'s asks ("status of all I asked?"): top-level, never `--private`; private=your sub-cards.',
    );
    // The gate words are gone: the ask of a card lives in its agenda, and nothing says the owner closes it.
    should(text).not.containEql('Gate?');
    should(text).not.containEql('raise nothing');
    should(text).not.containEql('owner closes');
  });

  it('should teach working a card, with the real verbs and the binary name given', () => {
    // Act
    const text = BOARD_INSTRUCTION('zz');

    // Assert — tasks are `&`, agenda items are `!`, and nothing prints the retired `#F`.
    should(text).not.containEql('#F');
    should(text).containEql('howToTest (where/do/see) before try');
    should(text).containEql('`zz task move <id> <lane> --reason "<why>"`');
    should(text).containEql('Blocked:');
    should(text).containEql('Blocked: `zz task depend`/`block`.');
    should(text).containEql('`zz task reopen <id> --to <lane> --ask "<words>"`');
    should(text).containEql("Owner's bug:");
    should(text).endWith('PRs, merges, `zz signal done` self-move.');
    should(text).not.containEql('`fy ');
  });

  it('should ride last in the always-on instruction, after the notify rule, not behind a switch', () => {
    // Assert
    should(leadInstruction('fy')).endWith(`\n\n${NOTIFY_INSTRUCTION('fy')}\n\n${BOARD_INSTRUCTION('fy')}`);
    should(FERRET_SECTIONS('fy').map(section => section.id)).not.containEql('board');
    // 757 → 814 for the owner's board rules (&C48): never ask, public/private, planning, sitrep titles, read → edit and
    // the three-part status (cap 760 → 820).
    should(BOARD_INSTRUCTION('fy').length).be.below(820);
  });
});

describe('ALWAYS_ON_SECTIONS', () => {
  it('should be exactly the always-on instruction, section by section, in order', () => {
    // Act
    const sections = ALWAYS_ON_SECTIONS('zz');

    // Assert
    should(sections.map(section => section.id)).deepEqual(['tools', 'settings', 'notify', 'board']);
    should(sections.map(section => section.text).join('\n\n')).equal(
      `${AGENT_BASE_INSTRUCTION('zz')}\n\n${LEAD_RULES_INSTRUCTION('zz')}`,
    );
  });
});

describe('instructionDigest', () => {
  it('should be a short, stable fingerprint that changes with the words', () => {
    // Act
    const once = instructionDigest(NOTIFY_INSTRUCTION('fy'));
    const again = instructionDigest(NOTIFY_INSTRUCTION('fy'));
    const other = instructionDigest(NOTIFY_INSTRUCTION('zz'));

    // Assert
    should(once).match(/^[0-9a-f]{14}$/u);
    should(once).equal(again);
    should(once).not.equal(other);
    should(instructionDigest('')).match(/^[0-9a-f]{14}$/u);
  });
});

describe('AGENT_TOOLS_INSTRUCTION — saved logins', () => {
  it('should tell a ferret to read account_hint before a sign-in and name no unbuilt tool (M2), with the old sentence gone', () => {
    // Arrange — the sentence is the whole of what teaches the pair of tools.

    // Act
    const text = AGENT_TOOLS_INSTRUCTION;

    // Assert
    should(text).containEql('account_hint before sign-in.');
    should(text).not.containEql('account_propose');
    should(text).not.containEql('Before a web sign-in, login_hint says how and where.');
  });
});

describe('AGENT_TOOLS_INSTRUCTION — phone prompts', () => {
  it('should send a phone prompt (tap Yes, a number) to request_input with push: true', () => {
    // Act
    const text = AGENT_TOOLS_INSTRUCTION;

    // Assert
    should(text).containEql('Phone prompt (tap Yes, a number): request_input push: true.');
  });
});

describe('AGENT_TOOLS_INSTRUCTION — one-time codes', () => {
  it('should teach sensitivity code for a 2FA or email code, reading it from an inbox, typed only on its own sign-in', () => {
    // Act
    const text = AGENT_TOOLS_INSTRUCTION;

    // Assert — the old "private" rule for a code is gone; the place rule is what stops a relayed code.
    should(text).containEql('code for a 2FA/email code: you see both.');
    should(text).containEql('terminal_send is blocked until answered (not for a code)');
    should(text).containEql('Or read it from an inbox you have; type it only on its sign-in page.');
    should(text).not.containEql('An echoing 2FA code: private.');
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
      [AGENDA_ENV]: '1',
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
          id: 'notify',
          chars: NOTIFY_INSTRUCTION(binary).length,
          digest: instructionDigest(NOTIFY_INSTRUCTION(binary)),
        },
        {
          id: 'board',
          chars: BOARD_INSTRUCTION(binary).length,
          digest: instructionDigest(BOARD_INSTRUCTION(binary)),
        },
        {
          id: 'hypermedia',
          chars: HYPERMEDIA_INSTRUCTION(binary).length,
          digest: instructionDigest(HYPERMEDIA_INSTRUCTION(binary)),
        },
        { id: 'pack', chars: PACK_INSTRUCTION(binary).length, digest: instructionDigest(PACK_INSTRUCTION(binary)) },
        {
          id: 'agenda',
          chars: AGENDA_INSTRUCTION(binary).length,
          digest: instructionDigest(AGENDA_INSTRUCTION(binary)),
        },
        {
          id: 'learning',
          chars: LESSONS_INSTRUCTION(binary).length,
          digest: instructionDigest(LESSONS_INSTRUCTION(binary)),
        },
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
    const pack = on.sections.find(section => section.id === 'pack');
    should(pack?.chars).equal(PACK_INSTRUCTION('fy').length + 1 + line.length);
    should(pack?.digest).equal(instructionDigest(`${PACK_INSTRUCTION('fy')}\n${line}`));
    should(pack?.digest).not.equal(instructionDigest(PACK_INSTRUCTION('fy')));
    should(off.sections.map(section => section.id)).deepEqual(['tools', 'settings', 'notify', 'board']);
  });

  it.each([
    ['interactive', { [SESSION_MODE_ENV]: 'interactive' }],
    ['auto', { [SESSION_MODE_ENV]: 'auto' }],
    ['unset', {}],
    ['every switch on', { [HYPERMEDIA_ENV]: '1', [PACK_ENV]: '1', [AGENDA_ENV]: '1', [PASSIVE_LEARNING_ENV]: '1' }],
    ['every switch off', { [HYPERMEDIA_ENV]: '0', [PACK_ENV]: '0', [AGENDA_ENV]: '0', [PASSIVE_LEARNING_ENV]: '0' }],
  ])(
    'should report the notify section, between settings and the per-ferret sections, for a %s launch',
    (_name, env) => {
      // Act
      const ids = launchInstructions('fy', env).sections.map(section => section.id);

      // Assert
      should(ids.slice(0, 3)).deepEqual(['tools', 'settings', 'notify']);
      should(launchInstructions('fy', env).sections[2]?.chars).equal(NOTIFY_INSTRUCTION('fy').length);
    },
  );

  it('should carry only the always-on sections, and withhold questions, for a launch with no mode and no switch exactly 1', () => {
    // Arrange
    const env = { [HYPERMEDIA_ENV]: '0', [PACK_ENV]: 'yes', [PASSIVE_LEARNING_ENV]: '' };

    // Act
    const launched = launchInstructions('fy', env);

    // Assert
    should(launched.sections.map(section => section.id)).deepEqual(['tools', 'settings', 'notify', 'board']);
    should(launched.mode).equal('auto');
    should(launched.questions).be.false();
  });

  it('should list the agenda section only when FY_AGENDA is exactly 1, and keep the order hypermedia, pack, agenda, learning', () => {
    // Act
    const off = launchInstructions('fy', { [HYPERMEDIA_ENV]: '1', [PACK_ENV]: '1', [PASSIVE_LEARNING_ENV]: '1' });
    const zero = launchInstructions('fy', { [AGENDA_ENV]: '0' });
    const yes = launchInstructions('fy', { [AGENDA_ENV]: 'yes' });
    const on = launchInstructions('fy', {
      [HYPERMEDIA_ENV]: '1',
      [PACK_ENV]: '1',
      [AGENDA_ENV]: '1',
      [PASSIVE_LEARNING_ENV]: '1',
    });

    // Assert
    should(off.sections.map(section => section.id)).not.containEql('agenda');
    should(zero.sections.map(section => section.id)).not.containEql('agenda');
    should(yes.sections.map(section => section.id)).not.containEql('agenda');
    should(on.sections.map(section => section.id)).deepEqual([
      'tools',
      'settings',
      'notify',
      'board',
      'hypermedia',
      'pack',
      'agenda',
      'learning',
    ]);
    // A per-ferret section carries a size and a fingerprint, so a changed word is told from a changed switch.
    should(on.sections.find(section => section.id === 'agenda')).deepEqual({
      id: 'agenda',
      chars: AGENDA_INSTRUCTION('fy').length,
      digest: instructionDigest(AGENDA_INSTRUCTION('fy')),
    });
  });

  it('should keep every always-on digest stable whether or not the agenda is on', () => {
    // Act
    const off = launchInstructions('fy', {});
    const on = launchInstructions('fy', { [AGENDA_ENV]: '1' });

    // Assert
    should(on.sections.slice(0, 4)).deepEqual(off.sections.slice(0, 4));
  });
});

describe('SUB_FERRET_INSTRUCTION', () => {
  it('should replace the notify, board and agenda rules with two short lines that name the real verbs', () => {
    // Act
    const text = SUB_FERRET_INSTRUCTION('zz');

    // Assert
    should(text.split('\n')).have.length(2);
    should(text).containEql('`zz send <lead-callsign> "<message>"`');
    should(text).containEql('Never raise agenda items or notify the owner;');
    should(text).containEql(
      "Label every send: `--kind blocker` (stuck until answered; at once), `--kind action` (default; to do; batched a minute), `--kind fyi` (rarely; no action; at the receiver's turn end).",
    );
    should(text).containEql('batched a minute');
    should(text).containEql('Only a password, code or approval the daemon asks for reaches the owner from you.');
    should(text).containEql('Link your PR `zz task link <id> --pr <url>` (or `--branch`)');
    should(text).containEql('`zz task note`');
    should(text).containEql(
      'message your lead (`zz send <lead-callsign> "<message>"`) only for a result, a blocker or a decision it must make.',
    );
    // The owner (&C48): "sub-ferrets and ferrets should update them!" — the one card edit a sub-ferret may make.
    should(text).containEql(
      'With a card: each step, `zz task show <id> --yaml`, rewrite its status (now/doneSoFar/next, PR links) and howToTest, then `zz task patch <id> --file f`; `zz task note` adds history.',
    );
    // The holder writes its own How to test now, so its report no longer carries the steps.
    should(text).not.containEql('Your final report says how the owner tests it.');
    should(text).containEql(
      "it moves itself (start, PR, merge, `zz signal done`). Lead's card? `zz task claim <id>`, don't ask. No card? Make none.",
    );
    should(text).not.containEql('agenda add');
    should(text).not.containEql('task move');
  });

  it('should leave the lead prompt byte-identical and make the sub-ferret prompt the smaller one', () => {
    // Assert
    should(leadInstruction('fy')).equal(`${AGENT_BASE_INSTRUCTION('fy')}\n\n${LEAD_RULES_INSTRUCTION('fy')}`);
    const lead = leadInstruction('fy').length;
    const sub = `${AGENT_BASE_INSTRUCTION('fy')}\n\n${SUB_FERRET_INSTRUCTION('fy')}`.length;
    should(sub).be.below(lead);
    // 759 → 840 for the card-status line (&C48, cap 760 → 880); still smaller than the lead's prompt.
    should(SUB_FERRET_INSTRUCTION('fy').length).be.below(880);
  });

  it('should keep the agenda section out of a sub-ferret launch record, whatever FY_AGENDA says', () => {
    // Act
    const launched = launchInstructions('zz', {
      [SUB_FERRET_ENV]: '1',
      [AGENDA_ENV]: '1',
      [PACK_ENV]: '1',
    });

    // Assert
    should(launched.sections.map(section => section.id)).deepEqual(['tools', 'settings', 'sub-ferret', 'pack']);
    should(launched.sections.find(section => section.id === 'sub-ferret')?.chars).equal(
      SUB_FERRET_INSTRUCTION('zz').length,
    );
  });

  it('should name the sub-ferret always-on sections in order, and the lead ones when the switch is off', () => {
    // Assert
    should(ALWAYS_ON_SECTIONS('zz', true).map(section => section.id)).deepEqual(['tools', 'settings', 'sub-ferret']);
    should(ALWAYS_ON_SECTIONS('zz', false)).deepEqual(ALWAYS_ON_SECTIONS('zz'));
    should(launchInstructions('zz', { [SUB_FERRET_ENV]: '0', [AGENDA_ENV]: '1' }).sections.map(s => s.id)).deepEqual([
      'tools',
      'settings',
      'notify',
      'board',
      'agenda',
    ]);
  });
});
