import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import type { HarnessKind } from '../../../daemon/lib/manifest.ts';
import * as importModule from '../../../daemon/lib/account/import.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { claudeRuntimesKit } from '../../../../claude-code/daemon/lib/runtimes-kit/index.ts';
import { codexRuntimesKit } from '../../../../codex/daemon/lib/runtimes-kit/index.ts';

const real = { ...importModule };
const calls: { group: string; harness: HarnessKind; kit: RuntimesHarnessKit | undefined }[] = [];
mock.module('../../../daemon/lib/account/import.ts', () => ({
  ...real,
  harvest: (...args: Parameters<typeof real.harvest>) => {
    calls.push({ group: 'harvest', harness: args[0].harness, kit: args[6] });
    return real.harvest(...args);
  },
  loginNote: (...args: Parameters<typeof real.loginNote>) => {
    calls.push({ group: 'loginNote', harness: args[0], kit: args[2] });
    return real.loginNote(...args);
  },
}));
afterAll(() => mock.module('../../../daemon/lib/account/import.ts', () => real));
beforeEach(() => {
  calls.length = 0;
});

const { planImport } = await import('../../../daemon/lib/account/import-plan.ts');
const { fileFleetSetupDeps } = await import('../../../daemon/adapters/setup-files.ts');
const { FleetSetupService } = await import('../../../daemon/lib/service/setup-service.ts');
const kits = new Map<HarnessKind, RuntimesHarnessKit>([
  ['claude', claudeRuntimesKit],
  ['codex', codexRuntimesKit],
]);

const scan = (harness: HarnessKind): importModule.HostHarnessScan => ({
  harness,
  command: `/fixture/bin/${harness}`,
  login: { state: 'not-signed-in' },
  instructions: { kind: 'absent', source: `/fixture/${harness}/instructions` },
  settings: { kind: 'absent', source: `/fixture/${harness}/settings` },
  skills: [],
  missingCommands: [],
  problems: [],
});
const scans = [scan('claude'), scan('codex')];
const expectKits = (expected: ReadonlyMap<HarnessKind, RuntimesHarnessKit>) => {
  expect(calls).toHaveLength(4);
  for (const call of calls) expect(call.kit).toBe(expected.get(call.harness));
};

describe('host import kit threading', () => {
  it('hands harvest and loginNote each harness own real kit without changing the plan', () => {
    const withKits = planImport(scans, { digest: text => text, kits });
    expectKits(kits);
    expect(calls.map(call => call.group).sort()).toEqual(['harvest', 'harvest', 'loginNote', 'loginNote']);
    calls.length = 0;
    expect(planImport(scans, { digest: text => text })).toEqual(withKits);
    expectKits(new Map());
  });

  it('never substitutes another harness kit for a missing entry', () => {
    const codexOnly = new Map<HarnessKind, RuntimesHarnessKit>([['codex', codexRuntimesKit]]);
    planImport(scans, { digest: text => text, kits: codexOnly });
    expectKits(codexOnly);
  });

  it('reads kits live through the file adapter for each host scan and the service planner', async () => {
    const requested: HarnessKind[] = [];
    let online = false;
    const current = (): ReadonlyMap<HarnessKind, RuntimesHarnessKit> =>
      new (class extends Map<HarnessKind, RuntimesHarnessKit> {
        override get(harness: HarnessKind) {
          requested.push(harness);
          return online ? kits.get(harness) : undefined;
        }
      })();
    const deps = fileFleetSetupDeps({
      host: {
        files: { lstat: async () => undefined },
        texts: {},
        claimFor: () => ({}),
      },
      catalog: {
        kits: current,
        layout: {
          userHome: '/fixture/home',
          manifestPath: '/fixture/fleet/manifest.json',
          fleetDirectory: '/fixture/fleet',
        },
        locate: (harness: string) => `/fixture/bin/${harness}`,
        document: async () => ({ format: 'none', model: parseAccountModel({ version: 1 }) }),
        readAsset: async () => undefined,
        machineName: () => 'fixture',
      },
      logins: fakeLogins([]),
      tools: { plans: () => [] },
      secrets: {},
    } as never);
    const service = new FleetSetupService(deps);
    await service.scan();
    expectKits(new Map());
    expect(requested).toEqual(['claude', 'codex', 'claude', 'codex', 'claude', 'codex']);
    calls.length = 0;
    requested.length = 0;
    online = true;
    await service.scan();
    expectKits(kits);
    expect(requested).toEqual(['claude', 'codex', 'claude', 'codex', 'claude', 'codex']);
  });
});
