/**
 * E-276 0a: the setup service's own read of each harness's settings file. A first-run import writes the host's settings
 * (Claude's JSON `settings.json`, Codex's TOML `config.toml`) as component files, then composes the fleet from them: the
 * service reads each back in the harness's own format (`SETTINGS_FORMAT` in `setup-service.ts`) before it materialises.
 * The golden is what the apply is handed: the configuration documents it writes and every operation of the plan it applies,
 * so a harness whose settings file is read in the wrong format changes the runtime's own config file in the plan.
 *
 * The host is the in-memory homes of `support/host-world.ts`; the scan, the files, the provisioner and the secret store
 * are stand-ins, so no disk, no process and no network is touched.
 */
import { createHash } from 'node:crypto';
import { describe, it } from 'bun:test';
import { fakeLoginChanges, fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import { claudeRuntimesKit } from '../../../../claude-code/daemon/lib/runtimes-kit/index.ts';
import { codexRuntimesKit } from '../../../../codex/daemon/lib/runtimes-kit/index.ts';
import { HostHarnessScanner } from '../../../daemon/adapters/host-harness-scan.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { FleetDocumentWrite, FleetLayout, FleetModelApplyPlan } from '../../../daemon/lib/provisioning.ts';
import type { AccountDocumentReading } from '../../../daemon/lib/service/catalog-service.ts';
import { createFleetSetupSubsystem, type FleetSetupServiceDeps } from '../../../daemon/lib/service/setup-service.ts';
import { expectGolden } from './support/golden.ts';
import { HOST_HOME, HOSTS, memoryHostFiles } from './support/host-world.ts';

const LAYOUT: FleetLayout = {
  stateHome: '/state',
  userHome: HOST_HOME,
  fleetDirectory: '/state/fleet',
  binDirectory: '/state/fleet/bin',
  homesDirectory: '/state/fleet/homes',
  assetsDirectory: '/state/fleet/assets',
  manifestPath: '/state/fleet/manifest.json',
  defaultHomeDirectories: [`${HOST_HOME}/.claude`, `${HOST_HOME}/.codex`],
};

const MACHINE = {
  governance: { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) },
  agent: false,
  claim: () => false,
} as never;

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const kits = new Map([
  ['claude', claudeRuntimesKit],
  ['codex', codexRuntimesKit],
] as const);

const reading = (): AccountDocumentReading =>
  ({
    format: 'none',
    model: parseAccountModel({ version: 1 }),
    revision: 'absent',
    unreadable: [],
    stoodInLogins: [],
    documents: () => [],
  }) as never;

async function importOnce(include: readonly ('claude-code' | 'codex')[]) {
  const applied: { plan: FleetModelApplyPlan; documents: readonly FleetDocumentWrite[] }[] = [];
  const assets: Record<string, string> = {};
  let minted = 0;
  const logins = fakeLogins([
    sampleLogin('claude-host', { email: 'claude@example.test' }),
    sampleLogin('codex-host', { harness: 'codex', harnesses: ['codex'], email: 'codex@example.test' }),
  ]);
  const scanner = new HostHarnessScanner({
    kits: () => kits,
    files: memoryHostFiles(HOSTS.both as never),
    userHome: HOST_HOME,
    commands: { resolve: command => `/opt/harness/bin/${command}` },
    logins,
    maxDocumentBytes: 8192,
  });
  const deps = {
    catalog: {
      kits: () => kits,
      document: async () => reading(),
      readAsset: async (path: string) => assets[path],
      documentRevision: async () => 'absent',
      ids: async () => undefined,
      locate: (harness: string) => `/opt/harness/bin/${harness}`,
      machineName: () => 'studio',
      credentials: logins,
      loginChanges: fakeLoginChanges(),
      provisioner: {
        preview: async () => {
          throw new Error('not used');
        },
        apply: async (plan: FleetModelApplyPlan, documents: readonly FleetDocumentWrite[] = []) => {
          applied.push({ plan, documents });
          for (const document of documents) assets[document.path] = document.content;
          return {
            accountCount: plan.manifest.accounts.length,
            operationCount: plan.operations.length,
            manifestPath: LAYOUT.manifestPath,
            prunedWrappers: [],
            sharedHistory: [],
          } as never;
        },
      },
      layout: LAYOUT,
      mint: () => `00000000-0000-4000-8000-00000000000${String(++minted)}`,
      now: () => Date.parse('2026-10-13T08:00:00.000Z'),
      claudeStatusline: (own?: string) => (own === undefined ? "'fy' statusline" : `'fy' statusline --then '${own}'`),
      fyCommand: '/opt/ferretry/bin/fy',
      acceptsAutoPermissionMode: true,
    },
    scan: async () => await scanner.scan(),
    tools: { plans: () => [], refresh: async () => undefined, install: async () => [] },
    secrets: {
      names: async () => [],
      held: async () => [],
      put: async () => undefined,
      filedSame: async () => false,
    },
    readFolder: async () => ({ files: [], skipped: [] }),
    skillItems: async () => [],
    digest,
    daemonId: () => 'daemon-source',
    randomBytes: (length: number) => Uint8Array.from({ length }, (_, index) => (index * 11 + 37) % 256),
    exportKeys: { read: async () => undefined, write: async () => undefined },
    cloneBase: { read: async () => undefined, update: async () => false },
  } as unknown as FleetSetupServiceDeps;
  const service = createFleetSetupSubsystem(deps);
  const change = { kind: 'setup.import', include } as never;
  const description = await service.executors.setup.describe(change, MACHINE);
  const summary = await service.executors.setup.execute(change, MACHINE);
  return {
    description,
    summary,
    applied: applied.map(run => ({ operations: run.plan.operations, documents: run.documents })),
  };
}

describe('setup import goldens', () => {
  for (const include of [['claude-code', 'codex'], ['codex'], ['claude-code']] as const) {
    it(`should apply the first-run import of ${include.join(' and ')} exactly as the base does`, async () => {
      expectGolden(`setup-import/${include.join('-')}`, await importOnce(include));
    });
  }
});
