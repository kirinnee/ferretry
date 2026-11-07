import { afterEach, beforeEach, expect, test } from 'bun:test';
import { HarnessConfigSchema as ClaudeHarnessSchema } from '@ferretry/plugin-claude-code/contract';
import { HarnessConfigSchema as CodexHarnessSchema } from '@ferretry/plugin-codex/contract';
import { LimitsFileSchema } from '@ferretry/core-ferrets/contract';
import { AccountsConfigSchema } from '@ferretry/plugin-accounts/contract';
import { AgendaConfigSchema } from '@ferretry/plugin-agenda/contract';
import { BrowsersConfigSchema } from '@ferretry/plugin-browsers/contract';
import { ConversationConfigSchema } from '@ferretry/plugin-conversation/contract';
import { EndpointFileSchema, LoginFileSchema, ModelCatalogFileSchema } from '@ferretry/plugin-logins/contract';
import { McpItemSchema } from '@ferretry/plugin-mcp/contract';
import {
  ModelSetFileSchema,
  ProfileFileSchema,
  RuntimeFileSchema,
  RuntimesFileSchema,
} from '@ferretry/plugin-runtimes/contract';
import { SkillsItemSchema } from '@ferretry/plugin-skills/contract';
import { UsageFileSchema } from '@ferretry/plugin-usage/contract';
import { WardenFileSchema } from '@ferretry/plugin-warden/contract';
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import { settingsStep } from '../../src/steps/settings.ts';
import { classifyV4ConfigPath, rawSecretPaths } from '../../src/v4/config.ts';
import { fixture, RUNTIME } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const MODELINE = '# yaml-language-server: $schema=../.schema/runtime.json\n';

/** A v4 config file, written as the owner's text. */
const yaml = async (path: string, text: string) => {
  const target = join(f.from, 'config', path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { mode: 0o600 });
};

const text = (path: string) => readFile(join(f.to, 'config', path), 'utf8');
const read = async <T>(path: string, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(parse(await text(path), { version: '1.2', uniqueKeys: true }) ?? {});
const exists = (path: string) =>
  stat(join(f.to, 'config', path)).then(
    () => true,
    () => false,
  );

const PRESET = `label: Fake gateway
summary: A fake gateway for tests.
docs: https://example.com/docs
verified: "2026-01-01"
env:
  ANTHROPIC_AUTH_TOKEN:
    secretName: FAKE_GATEWAY_KEY
test:
  kind: none
  reason: no test
quota:
  source: transcript-pricing
  note: counted from the transcript
`;

const CATALOG = `label: Fake catalog
docs: https://example.com/models
verified: "2026-01-01"
claude:
  models:
    - id: fake-model
      label: Fake model
      tier: balanced
      default: true
`;

async function fullHome() {
  await f.put('fleet/ids.json', {
    version: 1,
    runtimes: { 'claude-work': { id: RUNTIME, formerNames: ['claude-old'] } },
  });
  await yaml(
    'runtimes/claude-work.yaml',
    `${MODELINE}# my main runtime\ncredential: work-login # the login it spends\nprofile: main\nharness: claude\nagent: true\ncompactAt: auto\n`,
  );
  await yaml('profiles/main.yaml', 'contents:\n  - instructions/house\n  - mcp/github\n  - modelSets/fast\n');
  await yaml('components/modelSets/fast.yaml', 'models: [m-a, m-b]\ndefault: m-a\n');
  await yaml(
    'components/mcp/github.yaml',
    'command: npx\nargs: [fake-mcp]\nenv:\n  GITHUB_TOKEN: ${secret:FAKE_GITHUB}\n',
  );
  await yaml('components/skills/mine.yaml', 'items: [one, two]\n');
  await yaml('components/instructions/house.yaml', 'file: instructions/house.md\nharness: claude\n');
  await mkdir(join(f.from, 'fleet/assets/instructions'), { recursive: true });
  await writeFile(join(f.from, 'fleet/assets/instructions/house.md'), '# House rules\nBe kind.\n');
  await yaml(
    'logins/work-login.yaml',
    '# a gateway login\nharness: claude\nstore: environment\nbudget:\n  daily:\n    hard: 20\nenv:\n  ANTHROPIC_BASE_URL: https://api.example.com\n  ANTHROPIC_AUTH_TOKEN: ${secret:FAKE_API_KEY}\n',
  );
  await yaml('presets/fake-gateway.yaml', PRESET);
  await yaml('models/fake-catalog.yaml', CATALOG);
  await yaml('limits.yaml', '# keep the daemon reachable\nenabled: true\nperFerret:\n  memoryMax: 4G\n');
  await yaml('account-defaults.yaml', 'sites:\n  github.com: FAKE_ACCOUNT\n');
  await yaml(
    'warden.yaml',
    [
      '# my warden',
      'enabled: true',
      'triage: llm',
      'layers:',
      '  jev: true',
      'autoMigrate:',
      '  enabled: true',
      'mayActAlone:',
      '  nudge: true',
      '  resume: false',
      '  stop: false',
      'guard:',
      '  threshold: 0.8',
      'providerOutage:',
      '  minDistinctSessions: 3',
      'accounts:',
      '  - agent: claude-old',
      '    model: fake-model',
      '',
    ].join('\n'),
  );
  await yaml(
    'machine.yaml',
    [
      '# yaml-language-server: $schema=.schema/machine.json',
      '# this machine',
      'agentPermissions: skip # I trust my agents',
      'defaultRuntime: claude-old',
      'agentControl:',
      '  ferretrySettings: true',
      'conversations:',
      '  listComputer: false',
      'browserMode: window',
      'browserProxy:',
      '  url: http://proxy.example.com:8080',
      '  username: ${secret:FAKE_PROXY_USER}',
      '  password: ${secret:FAKE_PROXY_PASS}',
      'browserPorts: per-user',
      'autoResume: false',
      'attentionNudge: true',
      'agendaNudge: false',
      'agendaMode: false',
      'timeZone: Europe/Berlin',
      'publicUsageFeed: true',
      'advanced:',
      '  path:',
      '    announce: false',
      '',
    ].join('\n'),
  );
}

test('converts every v4 config kind into the v5 file that owns it, read back with v5 schemas', async () => {
  await fullHome();
  const report = await settingsStep.run(f.ctx());
  expect(report.note).toBeUndefined();
  expect(report.status).toBe('converted');

  const runtime = await read('runtimes/claude-work.yaml', RuntimeFileSchema);
  expect(runtime).toMatchObject({
    login: 'work-login',
    profile: 'main',
    harness: 'claude-code',
    agent: true,
    compactAt: 'auto',
  });
  const runtimeText = await text('runtimes/claude-work.yaml');
  expect(runtimeText).toContain('# my main runtime');
  expect(runtimeText).toContain('# the login it spends');
  expect(runtimeText).not.toContain('yaml-language-server');
  expect(runtimeText).not.toContain('credential');

  expect((await read('profiles/main.yaml', ProfileFileSchema)).contents).toEqual([
    'instructions/house',
    'mcp/github',
    'modelSets/fast',
  ]);
  expect(await read('model-sets/fast.yaml', ModelSetFileSchema)).toMatchObject({ default: 'm-a' });
  expect((await read('mcp/github.yaml', McpItemSchema)).env).toEqual({ GITHUB_TOKEN: '${secret:FAKE_GITHUB}' });
  expect((await read('skills/mine.yaml', SkillsItemSchema)).items).toEqual(['one', 'two']);
  expect(await text('instructions/house.md')).toBe('# House rules\nBe kind.\n');

  const login = await read('logins/work-login.yaml', LoginFileSchema);
  expect(login.env?.ANTHROPIC_AUTH_TOKEN).toBe('${secret:FAKE_API_KEY}');
  expect(login.budget).toEqual({ daily: { hard: 20 } });
  expect(login.harness).toBe('claude-code');
  expect(await text('logins/work-login.yaml')).toContain('# a gateway login');
  expect((await read('endpoints/fake-gateway.yaml', EndpointFileSchema)).label).toBe('Fake gateway');
  expect((await read('models/fake-catalog.yaml', ModelCatalogFileSchema)).label).toBe('Fake catalog');
  expect((await read('accounts.yaml', AccountsConfigSchema)).sites).toEqual({ 'github.com': 'FAKE_ACCOUNT' });

  const limits = await read('limits.yaml', LimitsFileSchema);
  expect(limits).toEqual({ enabled: true, perFerret: { memoryMax: '4G' }, agentControl: { ferretrySettings: true } });
  expect(await text('limits.yaml')).toContain('# keep the daemon reachable');

  const warden = await read('warden.yaml', WardenFileSchema);
  expect(warden.autoMove).toEqual({ enabled: true });
  expect(warden.layers).toEqual({ jev: true, llm: true });
  expect(warden.mayActAlone).toEqual({ nudge: true, resume: false, restart: false, stop: false, closeLeftovers: true });
  expect(warden.jevActs).toEqual({ nudge: 0.7, resume: 0.7, restart: 0.7, stop: 0.8 });
  expect(warden.providerOutage).toEqual({ minDistinctFerrets: 3 });
  expect(warden.accounts).toEqual([{ agent: 'claude-work', model: 'fake-model' }]);
  const wardenText = await text('warden.yaml');
  expect(wardenText).toContain('# my warden');
  expect(wardenText).not.toContain('triage');

  // machine.yaml, split key by key.
  for (const [path, schema] of [
    ['harness-claude-code.yaml', ClaudeHarnessSchema],
    ['harness-codex.yaml', CodexHarnessSchema],
  ] as const)
    expect((await read(path, schema)).permissionMode).toBe('skip');
  expect(await text('harness-claude-code.yaml')).toContain('# I trust my agents');
  expect(await read('runtimes.yaml', RuntimesFileSchema)).toEqual({ defaultRuntime: 'claude-work' });
  expect(await read('conversation.yaml', ConversationConfigSchema)).toEqual({ keepInSync: false });
  const browsers = await read('browsers.yaml', BrowsersConfigSchema);
  expect(browsers.mode).toBe('window');
  expect(browsers.proxy?.password).toBe('${secret:FAKE_PROXY_PASS}');
  expect(await read('agenda.yaml', AgendaConfigSchema)).toMatchObject({ agendaNudge: false, agendaMode: false });
  expect(await read('usage.yaml', UsageFileSchema)).toEqual({ timeZone: 'Europe/Berlin', publicFeed: true });
  expect(await text('usage.yaml')).toContain('Carried from v4 config/machine.yaml');

  expect((await stat(join(f.to, 'config/runtimes/claude-work.yaml'))).mode & 0o777).toBe(0o600);
  const notCarried = report.notCarried.map(item => item.what);
  for (const key of ['browserPorts', 'autoResume', 'advanced', 'attentionNudge'])
    expect(notCarried).toContain(`config/machine.yaml ${key}`);
  expect(report.kept).toContainEqual({ what: 'runtimes', count: 1 });
  expect(report.kept).toContainEqual({ what: 'instruction documents', count: 1 });
});

test('agenda check: attentionNudge carries when agendaNudge is absent, and is not reported as dropped', async () => {
  await yaml('machine.yaml', 'attentionNudge: false\n');
  const report = await settingsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect((await read('agenda.yaml', AgendaConfigSchema)).agendaNudge).toBe(false);
  expect(report.notCarried.map(item => item.what)).not.toContain('config/machine.yaml attentionNudge');
});

test('the Global lessons component is dropped and every profile stops layering it (v5 gives lessons to every ferret)', async () => {
  await yaml('components/instructions/lessons.yaml', 'file: instructions/lessons.md\n');
  await yaml('components/instructions/house.yaml', 'file: instructions/house.md\n');
  await mkdir(join(f.from, 'fleet/assets/instructions'), { recursive: true });
  await writeFile(join(f.from, 'fleet/assets/instructions/lessons.md'), '# Lessons\n- a rule\n');
  await writeFile(join(f.from, 'fleet/assets/instructions/house.md'), '# House rules\n');
  await yaml('profiles/main.yaml', '# mine\ncontents:\n  - instructions/house\n  - instructions/lessons # learned\n');
  await yaml('profiles/bare.yaml', 'contents:\n  - instructions/lessons\n');
  await yaml('profiles/other.yaml', 'contents:\n  - instructions/house\n');

  const report = await settingsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(await exists('instructions/lessons.md')).toBe(false);
  expect(await exists('instructions/lessons.yaml')).toBe(false);
  expect(await text('instructions/house.md')).toBe('# House rules\n');
  expect((await read('profiles/main.yaml', ProfileFileSchema)).contents).toEqual(['instructions/house']);
  expect(await text('profiles/main.yaml')).toContain('# mine');
  expect((await read('profiles/bare.yaml', ProfileFileSchema)).contents).toEqual([]);
  expect((await read('profiles/other.yaml', ProfileFileSchema)).contents).toEqual(['instructions/house']);

  const dropped = report.notCarried.find(item => item.what === 'config/components/instructions/lessons.yaml');
  expect(dropped?.why).toContain('EVERY ferret');
  expect(report.kept).toContainEqual({
    what: 'profiles that no longer layer instructions/lessons (v5 gives lessons to every ferret)',
    count: 2,
  });
  expect(report.kept).toContainEqual({ what: 'instruction documents', count: 1 });
});

test('an empty home converts to nothing; a dry run writes nothing', async () => {
  expect((await settingsStep.run(f.ctx())).status).toBe('converted');
  await fullHome();
  const report = await settingsStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(await exists('runtimes.yaml')).toBe(false);
  await expect(readdir(f.to)).rejects.toThrow();
});

test('a raw secret fails the step naming the file and key, never the value', async () => {
  const fake = `sk-ant-${'x'.repeat(24)}`;
  await yaml('logins/leaky.yaml', `harness: claude\nstore: environment\nenv:\n  ANTHROPIC_API_KEY: ${fake}\n`);
  const report = await settingsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('config/logins/leaky.yaml');
  expect(report.note).toContain('env.ANTHROPIC_API_KEY');
  expect(report.note).not.toContain(fake);
  expect(await exists('logins/leaky.yaml')).toBe(false);
});

test('a file v5 refuses fails the step before anything is written, naming key paths only', async () => {
  await yaml('profiles/main.yaml', 'contents: []\n');
  await yaml('runtimes/shouty.yaml', 'credential: Work-Login\nprofile: main\n');
  const report = await settingsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('config/runtimes/shouty.yaml');
  expect(report.note).toContain('login (invalid_format)');
  expect(report.note).not.toContain('Work-Login');
  expect(await exists('profiles/main.yaml')).toBe(false);
});

test('an unknown machine key, a syntax error and a non-mapping body each fail by name', async () => {
  await yaml('machine.yaml', 'nonsense: 1\n');
  expect((await settingsStep.run(f.ctx())).note).toBe('config/machine.yaml: nonsense is not a v4 machine setting');
  await yaml('machine.yaml', 'a: [1\n');
  expect((await settingsStep.run(f.ctx())).note).toMatch(/^config\/machine.yaml: is not valid YAML \(line \d+\)$/u);
  await yaml('machine.yaml', '- a\n');
  expect((await settingsStep.run(f.ctx())).note).toBe('config/machine.yaml: is not a YAML mapping');
});

test('files with no v5 config schema yet leave the step pending, and everything else is still written', async () => {
  await yaml('voice.yaml', 'postProcessing:\n  provider: "off"\n');
  await yaml('pack.yaml', 'enabled: true\n');
  await yaml('components/settings/quiet.yaml', 'harness: claude\nenv:\n  DISABLE_TELEMETRY: "1"\n');
  await yaml('components/hooks/mine.yaml', 'harness: claude\nfile: hooks/hooks.json\n');
  await yaml('components/instructions/outside.yaml', 'file: ~/notes/rules.md\n');
  await yaml('components/skills/mine.yaml', 'items: [one]\n');
  await yaml('learning.yaml', 'enabled: true\n');
  const report = await settingsStep.run(f.ctx());
  expect(report.status).toBe('pending');
  for (const file of [
    'config/voice.yaml',
    'config/components/settings/quiet.yaml',
    'config/components/hooks/mine.yaml',
    'config/components/instructions/outside.yaml',
  ])
    expect(report.note).toContain(file);
  expect(report.note).not.toContain('learning');
  // pack.yaml is the Packs step's.
  expect(report.note).not.toContain('pack.yaml');
  expect(await exists('skills/mine.yaml')).toBe(true);
});

test('an instructions document reached through a link is not copied; a link in config/ is never followed', async () => {
  await mkdir(join(f.root, 'elsewhere'), { recursive: true });
  await writeFile(join(f.root, 'elsewhere/rules.md'), 'outside\n');
  await mkdir(join(f.from, 'fleet/assets'), { recursive: true });
  await symlink(join(f.root, 'elsewhere'), join(f.from, 'fleet/assets/linked'));
  await yaml('components/instructions/linked.yaml', 'file: linked/rules.md\n');
  await yaml('components/instructions/escape.yaml', 'file: ../../elsewhere/rules.md\n');
  await mkdir(join(f.from, 'config/runtimes'), { recursive: true });
  await writeFile(join(f.root, 'elsewhere/r.yaml'), 'credential: a\nprofile: b\n');
  await symlink(join(f.root, 'elsewhere/r.yaml'), join(f.from, 'config/runtimes/linked.yaml'));
  await writeFile(join(f.from, 'config/daemon.json'), '{}');
  const report = await settingsStep.run(f.ctx());
  expect(report.status).toBe('pending');
  expect(report.note).toContain('config/components/instructions/linked.yaml');
  expect(report.note).toContain('config/components/instructions/escape.yaml');
  expect(await exists('instructions/linked.md')).toBe(false);
  expect(await exists('runtimes/linked.yaml')).toBe(false);
  expect(report.notCarried.map(item => item.what)).toContain('config/runtimes/linked.yaml');
  expect(report.notCarried.map(item => item.what)).not.toContain('config/daemon.json');
});

test("v4's path grammar and the raw-secret rule", () => {
  expect(classifyV4ConfigPath('machine.yaml')).toEqual({ kind: 'machine' });
  expect(classifyV4ConfigPath('runtimes/a.yaml')).toEqual({ kind: 'runtime', name: 'a' });
  expect(classifyV4ConfigPath('components/modelSets/x.yaml')).toEqual({
    kind: 'component',
    componentKind: 'modelSets',
    name: 'x',
  });
  expect(classifyV4ConfigPath('components/other/x.yaml')).toBeUndefined();
  expect(classifyV4ConfigPath('runtimes/.hidden.yaml')).toBeUndefined();
  expect(classifyV4ConfigPath('daemon.json')).toBeUndefined();
  expect(rawSecretPaths({ env: { API_KEY: '${secret:FAKE}', URL: 'https://example.com' } })).toEqual([]);
  expect(rawSecretPaths({ env: { API_TOKEN: 'Zx9qLm2Pw8Rt5Vb7Nc4K' } })).toEqual(['env.API_TOKEN']);
});
