/**
 * MERGE BAR (docs/rebuild/merge-bar.md): a converted home's fleet configuration LOADS the way `fy runtimes` loads it.
 *
 * The converter's own tests read each written file back with its schema, one file at a time. That let a whole kind
 * ship in a shape 5.0 never reads (instructions written as `<name>.md` where 5.0 reads `<name>.yaml`), and one such
 * gap makes EVERY runtime, profile and model set unreadable at once ("profile ... uses unknown instructions
 * component ..."). This test runs the real Settings and Logins steps over a v4-shaped home that mirrors a real machine,
 * then reads the result through the code path `fy runtimes` takes: the kernel's configuration service over the written
 * `config/` folder, then the runtimes plugin's own `runtimesConfigFiles(...).load()`.
 *
 * The 5.0 code is imported by path, like the other tests of this package that need a 5.0 reader: this package is not a
 * workspace member, and the load needs the runtimes plugin's daemon adapters, which no contract exports.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loginsStep } from '../../src/steps/logins.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { fixture } from './ferret-fixture.ts';

const repo = join(import.meta.dir, '../../../..');
const { createConfigFiles } = await import(repo + '/packages/core/kernel/host/config/service.ts');
const { createNodeHostFs } = await import(repo + '/packages/core/kernel/host/state/host-fs.ts');
const { INSTRUCTION_ITEMS, MODEL_SET_ITEMS, PROFILE_ITEMS, RUNTIME_ITEMS, RUNTIMES_CONFIG } = await import(
  repo + '/packages/plugins/runtimes/contract/index.ts'
);
const { ProfileMcpSource } = await import(repo + '/packages/plugins/runtimes/contract/component-source.ts');
const { runtimesConfigFiles } = await import(
  repo + '/packages/plugins/runtimes/daemon/adapters/runtimes-config-files.ts'
);
const { fakeLogins, sampleLogin } = await import(repo + '/packages/plugins/logins/contract/testing/index.ts');

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

/** A v4 config file, written as the owner's text. */
const v4Config = async (path: string, text: string) => {
  const target = join(f.from, 'config', path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { mode: 0o600 });
};
const v4Asset = async (path: string, text: string) => {
  const target = join(f.from, 'fleet/assets', path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { mode: 0o600 });
};

const MAIN_DOCUMENT = '# House rules\n\nBe kind. Keep answers short.\n';
const SECOND_DOCUMENT = '# Codex notes\n\nPrefer small diffs.\n';

/** The v4 runtimes of this machine, each with the login it spends. */
const RUNTIMES: readonly (readonly [string, string, string, 'claude' | 'codex'])[] = [
  ['claude-default', 'claude-you', 'claude-default', 'claude'],
  ['claude-atomi', 'claude-atomi', 'claude-default', 'claude'],
  ['claude-llm1', 'claude', 'claude-default', 'claude'],
  ['claude-llm2', 'claude-2', 'claude-default', 'claude'],
  ['claude-llm3', 'claude-3', 'claude-default', 'claude'],
  ['claude-llm4', 'claude-4', 'claude-default', 'claude'],
  ['claude-liftoff', 'claude-liftoff', 'claude-default', 'claude'],
  ['deepseek', 'deepseek', 'claude-default', 'claude'],
  ['glm-a', 'glm-a', 'claude-default', 'claude'],
  ['glm-b', 'glm-b', 'claude-default', 'claude'],
  ['mm', 'mm', 'claude-default', 'claude'],
  ['codex-main', 'codex-main', 'codex-default', 'codex'],
];

/** An environment login made from a provider preset: the secret is a `${secret:...}` reference, never a value. */
const envLogin = (preset: string, baseUrl: string, secret: string) =>
  [
    'harness: claude',
    'store: environment',
    `preset: ${preset}`,
    'env:',
    `  ANTHROPIC_BASE_URL: ${baseUrl}`,
    `  ANTHROPIC_AUTH_TOKEN: \${secret:${secret}}`,
    '',
  ].join('\n');

/** A machine shaped like the owner's: a host-store Claude login, Ferretry-store ones, env ones from presets, a Codex one. */
async function plantMachine() {
  const ids: Record<string, { id: string; formerNames: string[] }> = {};
  for (const [index, [name]] of RUNTIMES.entries())
    ids[name] = { id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, formerNames: [] };
  await f.put('fleet/ids.json', { version: 1, runtimes: ids });

  for (const [name, login, profile, harness] of RUNTIMES)
    await v4Config(
      `runtimes/${name}.yaml`,
      `credential: ${login}\nprofile: ${profile}\nharness: ${harness}\nagent: true\n`,
    );

  await v4Config(
    'profiles/claude-default.yaml',
    'contents:\n  - instructions/main\n  - modelSets/heavy\n  - mcp/github\n',
  );
  await v4Config('profiles/codex-default.yaml', 'contents:\n  - instructions/codex-notes\n  - modelSets/heavy\n');
  await v4Config('components/modelSets/heavy.yaml', 'models: [claude-opus-5-5]\ndefault: claude-opus-5-5\n');
  await v4Config(
    'components/mcp/github.yaml',
    'command: npx\nargs: [fake-mcp]\nenv:\n  GITHUB_TOKEN: ${secret:FAKE_GITHUB}\n',
  );
  await v4Config('components/instructions/main.yaml', 'file: instructions/main.md\n');
  await v4Config('components/instructions/codex-notes.yaml', 'file: instructions/codex-notes.md\nharness: codex\n');
  await v4Asset('instructions/main.md', MAIN_DOCUMENT);
  await v4Asset('instructions/codex-notes.md', SECOND_DOCUMENT);

  // Logins: the host store (the harness's own), Ferretry-store ones, env ones from the presets, and a Codex one.
  await v4Config('logins/claude-you.yaml', 'harness: claude\nstore: host\n');
  for (const login of ['claude-atomi', 'claude', 'claude-2', 'claude-3', 'claude-4', 'claude-liftoff'])
    await v4Config(`logins/${login}.yaml`, 'harness: claude\nstore: ferretry\n');
  await v4Config('logins/deepseek.yaml', envLogin('deepseek', 'https://api.example.com/deepseek', 'FAKE_DEEPSEEK_KEY'));
  await v4Config('logins/glm-a.yaml', envLogin('zai-glm', 'https://api.example.com/zai', 'FAKE_GLM_A_KEY'));
  await v4Config('logins/glm-b.yaml', envLogin('zai-glm', 'https://api.example.com/zai', 'FAKE_GLM_B_KEY'));
  await v4Config('logins/mm.yaml', envLogin('minimax', 'https://api.example.com/minimax', 'FAKE_MM_KEY'));
  await v4Config('logins/codex-main.yaml', 'harness: codex\nstore: ferretry\n');

  // The sign-in folders of the Ferretry-store logins (FAKE bytes: not credentials).
  for (const login of ['claude-atomi', 'claude', 'claude-2', 'claude-3', 'claude-4', 'claude-liftoff', 'codex-main']) {
    const folder = join(f.from, 'fleet/credentials', login);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(
      join(folder, login === 'codex-main' ? 'auth.json' : '.credentials.json'),
      '{"FAKE":"not-a-token"}',
      {
        mode: 0o600,
      },
    );
  }
}

/** The login list of the converted home, as Logins would state it: one view per converted `config/logins/*.yaml`. */
async function convertedLogins() {
  const views = [];
  for (const file of (await readdir(join(f.to, 'config/logins'))).toSorted()) {
    const id = file.replace(/\.yaml$/u, '');
    const document = parse(await readFile(join(f.to, 'config/logins', file), 'utf8'), { version: '1.2' }) as {
      harness: string;
      store: string;
    };
    views.push(
      document.store === 'environment'
        ? sampleLogin(id, {
            harness: document.harness,
            harnesses: [document.harness],
            store: 'environment',
            environment: {
              variables: [],
              quotaSource: 'none',
              missingSecrets: [],
              test: { available: false, reason: 'x' },
            },
          })
        : sampleLogin(id, { harness: document.harness, harnesses: [document.harness], store: document.store }),
    );
  }
  return views;
}

/** `fy runtimes`'s own read: the kernel configuration service over `<home>/config`, then the runtimes plugin's load. */
async function loadLikeFyRuntimes() {
  const files = createConfigFiles({
    home: f.to,
    fs: createNodeHostFs(),
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined },
    log: quiet,
    binary: 'fy',
    defs: [RUNTIMES_CONFIG, RUNTIME_ITEMS, PROFILE_ITEMS, MODEL_SET_ITEMS, INSTRUCTION_ITEMS].map(def => ({
      plugin: 'runtimes',
      def,
    })),
  });
  await files.reload();
  const port = files.port('runtimes');
  // The MCP owner's source, read from the converted `config/mcp/*.yaml` (the plugin that owns the kind is not booted here).
  const mcpFolder = join(f.to, 'config/mcp');
  const mcp = {
    list: async () => (await readdir(mcpFolder)).map(file => file.replace(/\.yaml$/u, '')).toSorted(),
    read: async (name: string) =>
      parse(await readFile(join(mcpFolder, `${name}.yaml`), 'utf8'), { version: '1.2' }) as Record<string, unknown>,
  };
  return await runtimesConfigFiles({
    config: port,
    logins: fakeLogins(await convertedLogins()),
    components: (hook: unknown) => (hook === ProfileMcpSource ? mcp : 'unavailable'),
    within: (work: Promise<unknown>) => work,
  }).load();
}

describe('a converted home’s fleet configuration loads the way `fy runtimes` loads it', () => {
  test('CASE 1, every login carried: load() resolves, every v4 runtime is in the model, instructions "main" holds its document', async () => {
    await plantMachine();
    const settings = await settingsStep.run(f.ctx());
    expect({ status: settings.status, note: settings.note }).toEqual({ status: 'converted', note: undefined });
    const logins = await loginsStep.run(f.ctx());
    expect(logins.status).toBe('converted');

    const loaded = await loadLikeFyRuntimes();

    const model = loaded.evaluation.effective.model;
    expect(Object.keys(model.runtimes).toSorted()).toEqual(RUNTIMES.map(([name]) => name).toSorted());
    expect(model.components.instructions.main).toMatchObject({ text: MAIN_DOCUMENT });
    expect(model.components.instructions['codex-notes']).toMatchObject({ text: SECOND_DOCUMENT, harness: 'codex' });
    expect(Object.keys(model.profiles).toSorted()).toEqual(['claude-default', 'codex-default']);
    expect(loaded.unreadable).toEqual([]);
  });
  // CASE 2 (logins held out of the preview) is converted-fleet-loads-preview.test.ts.
});
