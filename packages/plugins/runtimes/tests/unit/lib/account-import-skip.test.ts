import { describe, it } from 'bun:test';
import should from 'should';
import { ImportItemIdSchema, importItemId, importNamedItemId } from '../../../contract/index.ts';
import { SetupScanSchema } from '../../../contract/wire/setup.ts';
import {
  claudeProjectFolders,
  type HostDocumentRead,
  type HostHarnessScan,
  type ImportPlan,
  mergeImport,
  mergeImportRecord,
  planImport,
} from '../../../daemon/lib/account/import.ts';

/** Placeholder secret values: shaped like real ones so detection fires, worthless as credentials. */
const FAKE_KEY = 'sk-placeholder-not-a-real-key-0000';

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
  login: { state: 'signed-in' },
  instructions: text('/h/.claude/CLAUDE.md', '# Claude words\n'),
  settings: text(
    '/h/.claude/settings.json',
    JSON.stringify({
      model: 'claude-opus-5',
      env: { ANTHROPIC_API_KEY: FAKE_KEY, LOG_LEVEL: 'debug' },
      hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt' }] }] },
    }),
  ),
  mcp: text(
    '/h/.claude.json',
    JSON.stringify({
      mcpServers: {
        notes: { command: 'uvx', args: ['notes'] },
        docs: { type: 'http', url: 'https://mcp.example.test/' },
      },
      projects: { '/work/app': { allowedTools: [] }, '/work/lib': {}, relative: {}, '/bad\npath': {} },
    }),
  ),
  skills: [
    { item: 'review', source: '/h/.claude/skills/review', digest: 'a' },
    { item: 'deploy', source: '/h/.claude/skills/deploy', digest: 'b' },
  ],
  missingCommands: [],
  problems: [],
  ...patch,
});

const codex = (patch: Partial<HostHarnessScan> = {}): HostHarnessScan => ({
  harness: 'codex',
  command: '/bin/codex',
  login: { state: 'signed-in' },
  instructions: text('/h/.codex/AGENTS.md', '# Codex words\n'),
  settings: text(
    '/h/.codex/config.toml',
    [
      'model = "gpt-5.6"',
      '[shell_environment_policy.set]',
      `OPENAI_API_KEY = "${FAKE_KEY}"`,
      '[profiles.fast]',
      'model = "gpt-5.6-mini"',
      'model_reasoning_effort = "low"',
      'approval_policy = "never"',
      '[profiles.deep]',
      'model_reasoning_effort = "high"',
      '[mcp_servers.linear]',
      'command = "npx"',
    ].join('\n'),
  ),
  hooks: text('/h/.codex/hooks.json', JSON.stringify({ hooks: { Stop: [{ command: 'bell' }, { command: 'ding' }] } })),
  skills: [{ item: 'review', source: '/h/.codex/skills/review', digest: 'c' }],
  missingCommands: [],
  problems: [],
  ...patch,
});

const kinds = (plan: ImportPlan): string[] => plan.components.map(item => `${item.kind}/${item.name}`);
const everything = (plan: ImportPlan): string => JSON.stringify(plan);

describe('planImport — items the person skipped', () => {
  it('should leave a skipped MCP server out of the plan', () => {
    const plan = planImport([claude()], { digest, skip: [importNamedItemId('claude-code', 'mcp', 'notes')] });

    should(kinds(plan)).containEql('mcp/docs');
    should(kinds(plan)).not.containEql('mcp/notes');
    should(plan.preview.harnesses[0]?.mcpServers).deepEqual(['docs']);
  });

  it('should leave a skipped skill out of the plan, its folder copy included', () => {
    const plan = planImport([claude()], { digest, skip: [importNamedItemId('claude-code', 'skill', 'deploy')] });

    should(plan.components.find(item => item.kind === 'skills')?.value).deepEqual({
      items: ['review'],
      harness: 'claude',
    });
    should(plan.files.map(file => file.path)).not.containEql('skills/deploy');
    should(plan.files.map(file => file.path)).containEql('skills/review');
  });

  it('should leave skipped instructions out of the plan', () => {
    const plan = planImport([claude()], { digest, skip: [importItemId('claude-code', 'instructions')] });

    should(kinds(plan).some(reference => reference.startsWith('instructions/'))).be.false();
    should(plan.files.some(file => file.path.startsWith('components/instructions/'))).be.false();
    should(plan.preview.harnesses[0]?.instructions).be.undefined();
  });

  it('should leave skipped settings out but still import the env, and the reverse', () => {
    const noSettings = planImport([claude()], { digest, skip: [importItemId('claude-code', 'settings')] });
    const settings = noSettings.components.find(item => item.kind === 'settings')?.value as {
      file?: string;
      env?: unknown;
    };
    should(settings.file).be.undefined();
    should(settings.env).deepEqual({ LOG_LEVEL: 'debug', ANTHROPIC_API_KEY: '${secret:ANTHROPIC_API_KEY}' });

    const noEnv = planImport([claude()], { digest, skip: [importItemId('claude-code', 'env')] });
    const kept = noEnv.components.find(item => item.kind === 'settings')?.value as { file?: string; env?: unknown };
    should(kept.file).be.a.String();
    should(kept.env).be.undefined();
  });

  it('should move no secret when the env that held it is skipped', () => {
    const claudeSkipped = planImport([claude()], { digest, skip: [importItemId('claude-code', 'env')] });
    should(claudeSkipped.secrets).deepEqual([]);
    should(claudeSkipped.preview.harnesses[0]?.secretKeys).deepEqual([]);
    should(everything(claudeSkipped)).not.containEql(FAKE_KEY);

    const codexSkipped = planImport([codex()], { digest, skip: [importItemId('codex', 'env')] });
    should(codexSkipped.secrets).deepEqual([]);
    should(everything(codexSkipped)).not.containEql(FAKE_KEY);

    const kept = planImport([claude(), codex()], { digest });
    should(kept.secrets.length).be.above(0);
  });

  it('should leave the other harness alone when one harness item is skipped', () => {
    const plan = planImport([claude(), codex()], { digest, skip: [importNamedItemId('codex', 'skill', 'review')] });

    should(plan.components.find(item => item.kind === 'skills')?.value).deepEqual({
      items: ['review', 'deploy'],
      harness: 'claude',
    });
  });

  it('should ignore an item that is not there', () => {
    const base = planImport([claude()], { digest });
    const same = planImport([claude()], { digest, skip: [importNamedItemId('claude-code', 'mcp', 'nothing')] });

    should(kinds(same)).deepEqual(kinds(base));
  });
});

describe('planImport — hooks are never imported', () => {
  it('should make no hooks component and no profile layer, for either harness', () => {
    const plan = planImport([claude(), codex()], { digest });

    should(kinds(plan).some(reference => reference.startsWith('hooks/'))).be.false();
    should(plan.files.some(file => file.path.includes('hooks'))).be.false();
    for (const profile of Object.values(plan.profiles)) {
      should(profile.layers.some(layer => layer.startsWith('hooks/'))).be.false();
    }
    should(everything(plan)).not.containEql('fmt');
    should(everything(plan)).not.containEql('bell');
  });

  it('should still count them for the screen, by where they are', () => {
    const plan = planImport([claude(), codex()], { digest });

    should(plan.preview.harnesses[0]?.settings?.hooks).equal(1);
    should(plan.preview.harnesses[1]?.settings?.hooks).equal(2);
  });

  it('should treat hooks alone as nothing found: a Starter profile, not a Default', () => {
    const plan = planImport(
      [
        codex({
          instructions: absent('/h/.codex/AGENTS.md'),
          settings: absent('/h/.codex/config.toml'),
          skills: [],
        }),
      ],
      { digest },
    );

    should(Object.keys(plan.profiles)).deepEqual(['codex-starter']);
    should(plan.preview.harnesses[0]?.settings?.hooks).equal(2);
  });
});

describe('planImport — hints that are listed, not imported', () => {
  it('should list the Codex profiles with only their name, model and effort', () => {
    const plan = planImport([codex()], { digest });

    should(plan.preview.harnesses[0]?.codexProfiles).deepEqual([
      { name: 'fast', model: 'gpt-5.6-mini', effort: 'low' },
      { name: 'deep', effort: 'high' },
    ]);
    should(JSON.stringify(plan.preview.harnesses[0]?.codexProfiles)).not.containEql('approval_policy');
  });

  it('should list a profile that sets only a model, and skip a profiles entry that is not a table', () => {
    const settings = text(
      '/h/.codex/config.toml',
      ['[profiles]', 'odd = 1', '[profiles.plain]', 'model = "m"'].join('\n'),
    );
    const plan = planImport([codex({ settings })], { digest });

    should(plan.preview.harnesses[0]?.codexProfiles).deepEqual([{ name: 'plain', model: 'm' }]);
  });

  it('should list no Codex profiles for Claude', () => {
    should(planImport([claude()], { digest }).preview.harnesses[0]?.codexProfiles).deepEqual([]);
  });

  it('should name the project folders Claude keeps, absolute and printable only, and read nothing in them', () => {
    should(claudeProjectFolders(claude())).deepEqual(['/work/app', '/work/lib']);
    should(claudeProjectFolders(codex())).deepEqual([]);
    should(claudeProjectFolders(claude({ mcp: absent('/h/.claude.json') }))).deepEqual([]);
    should(claudeProjectFolders(claude({ mcp: text('/h/.claude.json', 'not json') }))).deepEqual([]);
  });

  it('should carry the hints a scan was given into the preview, and make nothing of them', () => {
    const hints = [{ path: '/work/app', file: 'CLAUDE.md', verified: false }];
    const plan = planImport([claude({ projectInstructions: hints })], { digest });

    should(plan.preview.harnesses[0]?.projectInstructions).deepEqual(hints);
    should(kinds(plan).some(reference => reference.includes('work'))).be.false();
    should(plan.files.some(file => file.path.includes('work'))).be.false();
  });
});

describe('the wire contract for skip and the scan', () => {
  it('should accept the item grammar and refuse anything else', () => {
    for (const id of [
      'claude-code:instructions',
      'claude-code:env',
      'codex:settings',
      'claude-code:mcp:notes',
      'codex:skill:review',
      'codex:profile:fast',
    ]) {
      should(ImportItemIdSchema.safeParse(id).success).be.true();
    }
    for (const id of [
      '',
      'claude:instructions',
      'codex:hooks',
      'codex:mcp',
      'codex:mcp:',
      'codex:instructions:extra',
      'codex:skill:a:b',
      `codex:skill:${'x'.repeat(201)}`,
    ]) {
      should(ImportItemIdSchema.safeParse(id).success).be.false();
    }
  });

  it('should round-trip a plan preview through the scan schema without a value', () => {
    const plan = planImport(
      [claude({ projectInstructions: [{ path: '/work/app', file: 'CLAUDE.md', verified: true }] }), codex()],
      { digest },
    );
    const body = {
      machine: 'm',
      format: 'none',
      tools: [],
      harnesses: plan.preview.harnesses.map(harness => ({
        ...harness,
        harness: harness.harness === 'claude' ? 'claude-code' : 'codex',
      })),
      runtimes: [],
      updates: [],
      duplicates: [],
      notes: [],
      importing: { available: true },
    };

    should(SetupScanSchema.safeParse(body).success).be.true();
    should(JSON.stringify(body)).not.containEql(FAKE_KEY);
  });
});

describe('planImport — a skip is applied before models and settings are derived', () => {
  /** A Codex host whose models differ from the Starter ones, so "taken from the host" can be told from "the starter". */
  const hostCodex = (): HostHarnessScan =>
    codex({
      settings: text(
        '/h/.codex/config.toml',
        [
          'model = "gpt-host-1"',
          '[profiles.fast]',
          'model = "gpt-5.6-mini"',
          'model_reasoning_effort = "low"',
          '[profiles.deep]',
          'model_reasoning_effort = "high"',
        ].join('\n'),
      ),
    });
  const modelsOf = (plan: ImportPlan, harness: 'claude' | 'codex'): { models: string[]; default: string } =>
    plan.components.find(item => item.kind === 'modelSets' && item.name.startsWith(harness))?.value as {
      models: string[];
      default: string;
    };
  const settingsFileOf = (plan: ImportPlan): string =>
    plan.files.map(file => (file.kind === 'write' ? file.content : '')).join('\n');

  it('should not take the default model from skipped Codex settings', () => {
    const plan = planImport([hostCodex()], { digest, skip: [importItemId('codex', 'settings')] });

    const set = modelsOf(plan, 'codex');
    should(set.models).not.containEql('gpt-host-1');
    should(set.default).not.equal('gpt-host-1');
    should(settingsFileOf(plan)).not.containEql('gpt-host-1');
  });

  it('should keep the profiles still selected when Codex settings are skipped, and drop the skipped ones', () => {
    const plan = planImport([hostCodex()], {
      digest,
      skip: [importItemId('codex', 'settings'), importNamedItemId('codex', 'profile', 'deep')],
    });

    const written = settingsFileOf(plan);
    should(written).containEql('profiles.fast');
    should(written).containEql('gpt-5.6-mini');
    should(written).not.containEql('profiles.deep');
    should(written).not.containEql('gpt-host-1');
    should(modelsOf(plan, 'codex').models).containEql('gpt-5.6-mini');
    should(modelsOf(plan, 'codex').models).not.containEql('gpt-host-1');
    should(modelsOf(plan, 'codex').default).not.equal('gpt-host-1');
  });

  it('should write no settings file when Codex settings and every profile are skipped', () => {
    const plan = planImport([hostCodex()], {
      digest,
      skip: [
        importItemId('codex', 'settings'),
        importNamedItemId('codex', 'profile', 'fast'),
        importNamedItemId('codex', 'profile', 'deep'),
      ],
    });

    should(settingsFileOf(plan)).not.containEql('profiles');
    should(plan.components.some(item => item.kind === 'settings')).be.false();
  });

  it('should leave an accepted Codex profile out of the model set and the written settings', () => {
    const plan = planImport([hostCodex()], { digest, skip: [importNamedItemId('codex', 'profile', 'fast')] });

    should(modelsOf(plan, 'codex').models).not.containEql('gpt-5.6-mini');
    should(modelsOf(plan, 'codex').models).containEql('gpt-host-1');
    const written = settingsFileOf(plan);
    should(written).not.containEql('gpt-5.6-mini');
    should(written).not.containEql('profiles.fast');
    should(written).containEql('profiles.deep');
    // The profile is still LISTED, so the screen can show it and let the person take the skip back.
    should(plan.preview.harnesses[0]?.codexProfiles.map(profile => profile.name)).deepEqual(['fast', 'deep']);
  });

  it('should keep every profile when none is skipped, and when the skipped name is not there', () => {
    const plan = planImport([hostCodex()], { digest, skip: [importNamedItemId('codex', 'profile', 'nope')] });

    should(modelsOf(plan, 'codex').models).containEql('gpt-5.6-mini');
    should(settingsFileOf(plan)).containEql('profiles.fast');
  });

  it('should drop the profiles table when every profile is skipped', () => {
    const plan = planImport([hostCodex()], {
      digest,
      skip: [importNamedItemId('codex', 'profile', 'fast'), importNamedItemId('codex', 'profile', 'deep')],
    });

    should(settingsFileOf(plan)).not.containEql('profiles');
  });

  it('should take no model from a Claude settings or env that was skipped', () => {
    const settings = text(
      '/h/.claude/settings.json',
      JSON.stringify({ model: 'claude-host-1', env: { ANTHROPIC_MODEL: 'claude-sonnet-5' } }),
    );
    const base = modelsOf(planImport([claude({ settings })], { digest }), 'claude');
    should(base.models).containEql('claude-host-1');
    should(base.models).containEql('claude-sonnet-5');

    const noSettings = modelsOf(
      planImport([claude({ settings })], { digest, skip: [importItemId('claude-code', 'settings')] }),
      'claude',
    );
    should(noSettings.models).not.containEql('claude-host-1');
    should(noSettings.models).not.containEql('claude-sonnet-5');

    const noEnv = modelsOf(
      planImport([claude({ settings })], { digest, skip: [importItemId('claude-code', 'env')] }),
      'claude',
    );
    should(noEnv.models).containEql('claude-host-1');
    should(noEnv.models).not.containEql('claude-sonnet-5');
  });
});

describe('Import again after a skill was left out', () => {
  const claudeEdited = (body: string, extra: HostHarnessScan['skills'] = []) =>
    claude({
      instructions: text('/h/.claude/CLAUDE.md', body),
      skills: [
        { item: 'review', source: '/h/.claude/skills/review', digest: 'a' },
        { item: 'deploy', source: '/h/.claude/skills/deploy', digest: 'b' },
        ...extra,
      ],
    });
  const skipDeploy = [importNamedItemId('claude-code', 'skill', 'deploy')];
  const first = () => {
    const plan = planImport([claudeEdited('# Claude words\n')], { digest, skip: skipDeploy });
    return { model: mergeImport(undefined, plan), record: mergeImportRecord(plan) };
  };

  it('should offer only the changed instructions, never the skill that was left out', () => {
    // Arrange
    const { model, record } = first();

    // Act — the scan sends no skip list; only CLAUDE.md changed.
    const scan = planImport([claudeEdited('# Claude words, edited\n')], { digest, existing: model, record });
    const applied = planImport([claudeEdited('# Claude words, edited\n')], {
      digest,
      existing: model,
      record,
      skip: skipDeploy,
    });

    // Assert — and the update the scan offers is one the apply offers too.
    should(scan.updates.map(update => update.reference)).deepEqual(['instructions/claude-instructions']);
    should(applied.updates.map(update => update.reference)).deepEqual(['instructions/claude-instructions']);
  });

  it('should still offer a skill that is new in the source, without the one that was left out', () => {
    // Arrange
    const { model, record } = first();

    // Act
    const scan = planImport(
      [claudeEdited('# Claude words\n', [{ item: 'lint', source: '/h/.claude/skills/lint', digest: 'c' }])],
      { digest, existing: model, record },
    );

    // Assert
    should(scan.updates.map(update => update.reference)).deepEqual(['skills/claude-skills']);
    should(scan.updates[0]?.component.value).deepEqual({ items: ['review', 'lint'], harness: 'claude' });
    should(scan.updates[0]?.files.map(file => file.path)).not.containEql('skills/deploy');
    should(mergeImportRecord(scan, ['skills/claude-skills']).components['skills/claude-skills']?.left).deepEqual([
      'deploy',
    ]);
  });
});

describe('planImport — the model set can be left out on its own (r10 O8)', () => {
  const NAMED = JSON.stringify({ model: 'claude-sonnet-5', env: { LOG_LEVEL: 'debug' } });
  const modelSet = (plan: ImportPlan, name: string): unknown =>
    plan.components.find(item => item.kind === 'modelSets' && item.name === name)?.value;

  it('should take the models the settings name when the model set is kept', () => {
    const plan = planImport([claude({ settings: text('/h/.claude/settings.json', NAMED) })], { digest });
    should(modelSet(plan, 'claude-models')).deepEqual({ models: ['claude-sonnet-5'], default: 'claude-sonnet-5' });
  });

  it('should give the starter model set when the model set is skipped, settings and the rest still imported', () => {
    const plan = planImport([claude({ settings: text('/h/.claude/settings.json', NAMED) })], {
      digest,
      skip: [importItemId('claude-code', 'model-set')],
    });
    should(modelSet(plan, 'claude-models')).deepEqual({ models: ['claude-opus-5'], default: 'claude-opus-5' });
    should(plan.components.some(item => item.kind === 'settings')).be.true();
    should(plan.components.some(item => item.kind === 'instructions')).be.true();
  });

  it('should skip only the named harness’s model set', () => {
    const plan = planImport([claude(), codex()], { digest, skip: [importItemId('claude-code', 'model-set')] });
    should(modelSet(plan, 'codex-models')).deepEqual({ models: ['gpt-5.6', 'gpt-5.6-mini'], default: 'gpt-5.6' });
  });

  it('should accept the id on the wire and refuse a model-set id with a name', () => {
    should(ImportItemIdSchema.safeParse('claude-code:model-set').success).be.true();
    should(ImportItemIdSchema.safeParse('codex:model-set').success).be.true();
    should(ImportItemIdSchema.safeParse('codex:model-set:fast').success).be.false();
  });
});
