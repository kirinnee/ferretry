/**
 * MERGE-BAR CASE 2 (docs/rebuild/merge-bar.md): the preview stage, with the logins carried as signed-out shells and the
 * Codex ones held out, still loads its WHOLE fleet configuration through the very path `fy runtimes` takes (the kernel's
 * `createConfigFiles` plus `runtimesConfigFiles(...).load()`), never `fleet_catalog_unreadable`: every carried runtime
 * is in the model, and every runtime the preview did not carry is named in the report's hold list with one plain line.
 * Fixtures and temp homes only; every key is fake.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Log } from '@ferretry/kernel/contract';
import { LoginFileSchema } from '@ferretry/plugin-logins/contract';
import {
  CREDENTIAL_STATUS_LABELS,
  CredentialStatusService,
  InMemoryCredentialStatusStore,
} from '../../../../packages/plugins/logins/daemon/lib/credentials/credential-status.ts';
import { resolveCredentialStore } from '../../../../packages/plugins/logins/daemon/lib/credentials/credentials.ts';
import { credentialOf } from '../../../../packages/plugins/logins/daemon/lib/shared/credential.ts';
import { fakeLogins, sampleLogin } from '../../../../packages/plugins/logins/contract/testing/index.ts';
import { createConfigFiles } from '../../../../packages/core/kernel/host/config/service.ts';
import { createNodeHostFs } from '../../../../packages/core/kernel/host/state/host-fs.ts';
import {
  INSTRUCTION_ITEMS,
  MODEL_SET_ITEMS,
  PROFILE_ITEMS,
  RUNTIME_ITEMS,
  RUNTIMES_CONFIG,
} from '../../../../packages/plugins/runtimes/contract/index.ts';
import { runtimesConfigFiles } from '../../../../packages/plugins/runtimes/daemon/adapters/runtimes-config-files.ts';
import { parse } from 'yaml';
import { prepare, heldSection } from '../../preview/driver.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const FAKE_KEY = 'sk-ant-FAKE-0000-not-a-real-key';
const put = async (path: string, text: string) => {
  await mkdir(join(f.from, path, '..'), { recursive: true });
  await writeFile(join(f.from, path), text);
};

const silentLog: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

/** A v4 home shaped like the owner's: Claude on a host login, on a Ferretry-store login, an env login, and Codex. */
async function v4Home(withInstructions: boolean) {
  await put('layout-version', '2\n');
  await put(
    'config/logins/claude-you.yaml',
    'harness: claude\nstore: host\nlabel: Me\nbudget:\n  daily:\n    hard: 20\nclonedFrom: elsewhere\n',
  );
  await put('config/logins/claude-atomi.yaml', 'harness: claude\nstore: ferretry\n');
  await put(
    'config/logins/glm-a.yaml',
    `harness: claude\nstore: environment\npreset: zai-glm\nenv:\n  ANTHROPIC_BASE_URL: https://api.example.com\n  ANTHROPIC_AUTH_TOKEN: \${secret:GLM_KEY}\n  ANTHROPIC_API_KEY: ${FAKE_KEY}\n`,
  );
  await put('config/logins/codex-login.yaml', 'harness: codex\nstore: ferretry\n');
  await put('fleet/credentials/claude-atomi/.credentials.json', `{"fake":"${FAKE_KEY}"}`);
  await put('config/components/modelSets/fast.yaml', 'models: [m-a]\ndefault: m-a\n');
  if (withInstructions) {
    await put('config/components/instructions/main.yaml', 'file: instructions/main.md\nharness: claude\n');
    await put('fleet/assets/instructions/main.md', '# House rules\nBe kind.\n');
  }
  await put(
    'config/profiles/claude-default.yaml',
    `contents:\n${withInstructions ? '  - instructions/main\n' : ''}  - modelSets/fast\n`,
  );
  await put('config/profiles/codex-default.yaml', 'contents: []\n');
  await put('config/runtimes/claude-default.yaml', 'credential: claude-you\nprofile: claude-default\nagent: true\n');
  await put('config/runtimes/claude-atomi.yaml', 'credential: claude-atomi\nprofile: claude-default\n');
  await put('config/runtimes/glm-a.yaml', 'credential: glm-a\nprofile: claude-default\n');
  await put('config/runtimes/codex-main.yaml', 'credential: codex-login\nprofile: codex-default\n');
}

const prepared = () =>
  prepare({
    v4Home: f.from,
    target: f.to,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    home: join(f.root, 'home'),
  });

/**
 * The status of each converted login, from the REAL logins status service (not a hardcoded word): a signed-out store
 * (no credential file anywhere) and the preview's EMPTY vault, whose names are read from nowhere because the vault file
 * does not exist.
 */
async function statusOf(id: string, file: ReturnType<typeof LoginFileSchema.parse>) {
  expect(existsSync(join(f.to, 'state/vault/vault.json'))).toBe(false);
  const service = new CredentialStatusService({
    local: async () => ({ shape: { kind: 'decided', reading: { state: 'missing' } } }),
    passiveUsage: async () => undefined,
    activeUsage: async () => {
      throw new Error('a status read never asks the provider');
    },
    refresh: { refresh: async () => ({ outcome: 'unavailable', reason: 'not in this test' }) },
    heads: new InMemoryCredentialStatusStore(),
    secretNames: async () => new Set<string>(),
    now: () => 1_000_000,
    usageIntervalMs: 60_000,
  });
  const resolution = resolveCredentialStore(id, credentialOf(file), {
    fleetRoot: join(f.to, 'fleet'),
    userHome: join(f.root, 'home'),
  });
  return (await service.view({ id, resolution })).status;
}

/** The statuses the last {@link loadFleet} read from the service, by login. */
let statusesSeen: Record<string, string> = {};

/** The `fy runtimes` read, over the converted home's own config folder and its own login files (signed out). */
async function loadFleet() {
  const files = createConfigFiles({
    home: f.to,
    fs: createNodeHostFs(),
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined } as never,
    log: silentLog,
    binary: 'fy',
    defs: [RUNTIMES_CONFIG, RUNTIME_ITEMS, PROFILE_ITEMS, MODEL_SET_ITEMS, INSTRUCTION_ITEMS].map(def => ({
      plugin: 'runtimes',
      def: def as never,
    })),
  });
  await files.reload();
  const logins = [];
  const statuses: Record<string, string> = {};
  for (const entry of (await readdir(join(f.to, 'config/logins')).catch(() => [])).sort()) {
    const id = entry.replace(/\.yaml$/u, '');
    const file = LoginFileSchema.parse(parse(await readFile(join(f.to, 'config/logins', entry), 'utf8')));
    const status = await statusOf(id, file);
    statuses[id] = `${status.word}/${status.reason}`;
    logins.push(
      sampleLogin(id, {
        harness: file.harness,
        harnesses: [file.harness],
        store: file.store,
        status: {
          word: status.word,
          label: CREDENTIAL_STATUS_LABELS[status.word],
          reason: status.reason,
          explanation: 'From the logins status service.',
          lastCheckInconclusive: false,
        },
      } as never),
    );
  }
  statusesSeen = statuses;
  return runtimesConfigFiles({
    config: files.port('runtimes'),
    logins: fakeLogins(logins),
    components: () => 'unavailable',
    within: work => work,
  }).load();
}

describe('merge-bar case 2: the preview stage loads its whole fleet configuration', () => {
  test('logins held out or shelled, every carried runtime is in the model and every other one is named as held', async () => {
    await v4Home(false);
    const done = await prepared();
    expect(done.report?.complete).toBe(true);

    // The `fy runtimes` path resolves: never fleet_catalog_unreadable.
    const loaded = await loadFleet();
    expect(loaded.unreadable).toEqual([]);
    const carried = Object.keys(loaded.evaluation.effective.model.runtimes).sort();
    expect(carried).toEqual(['claude-atomi', 'claude-default', 'glm-a']);

    // Every v4 runtime the preview did not carry is named in the report, with one plain line.
    const v4Runtimes = ['claude-atomi', 'claude-default', 'codex-main', 'glm-a'];
    const held = done.report?.steps.flatMap(step => step.notCarried) ?? [];
    for (const name of v4Runtimes.filter(runtime => !carried.includes(runtime))) {
      const line = held.find(item => item.what.startsWith(`runtime ${name} `));
      expect(line?.why.length ?? 0).toBeGreaterThan(0);
      expect(heldSection(done.report as never)).toContain(`runtime ${name} `);
    }
    expect(heldSection(done.report as never)).toContain('login codex-login (Codex)');

    // Every carried login says "Needs sign-in" because the REAL status service says so: a signed-out store, and an
    // environment login whose ${secret:NAME} is not in the (empty) preview vault.
    expect(statusesSeen).toEqual({
      'claude-atomi': 'needs_sign_in/not_signed_in',
      'claude-you': 'needs_sign_in/not_signed_in',
      'glm-a': 'needs_sign_in/secret_not_stored',
    });
  });

  test('(with an instructions layer) the fleet still loads and the component "main" is in the model', async () => {
    await v4Home(true);
    const done = await prepared();
    expect(done.report?.complete).toBe(true);
    const loaded = await loadFleet();
    expect(loaded.unreadable).toEqual([]);
    expect(Object.keys(loaded.evaluation.effective.model.runtimes).sort()).toEqual([
      'claude-atomi',
      'claude-default',
      'glm-a',
    ]);
    const instructions: string[] = await readdir(join(f.to, 'config/instructions')).catch(() => []);
    expect(instructions).toContain('main.yaml');
  });
});
