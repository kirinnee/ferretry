import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { fakeLogins } from '@ferretry/plugin-logins/contract/testing';
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import type { HarnessKind } from '../../../daemon/lib/manifest.ts';
import * as importModule from '../../../daemon/lib/account/import.ts';
import { UnsupportedHarnessError } from '../../../daemon/lib/harness-kind.ts';
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

const { HostHarnessScanner } = await import('../../../daemon/adapters/host-harness-scan.ts');
const { planImport, planImportRefusing, scansRefusing } = await import('../../../daemon/lib/account/import-plan.ts');
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
  it('hands harvest and loginNote each harness own real kit and refuses a missing map', () => {
    const withKits = planImport(scans, { digest: text => text, kits });
    expectKits(kits);
    expect(calls.map(call => call.group).sort()).toEqual(['harvest', 'harvest', 'loginNote', 'loginNote']);
    expect(withKits.imported).toEqual(['claude', 'codex']);
    calls.length = 0;
    expect(() => planImport(scans, { kits: undefined, digest: text => text })).toThrow('claude is not supported here');
    expect(calls).toEqual([]);
  });

  it('never substitutes another harness kit for a missing entry', () => {
    const codexOnly = new Map<HarnessKind, RuntimesHarnessKit>([['codex', codexRuntimesKit]]);
    expect(() => planImport(scans, { digest: text => text, kits: codexOnly })).toThrow('claude is not supported here');
    expect(calls).toEqual([]);
  });

  it('never substitutes another harness kit for a missing Codex entry', () => {
    const claudeOnly = new Map<HarnessKind, RuntimesHarnessKit>([['claude', claudeRuntimesKit]]);
    expect(() => planImport(scans, { digest: text => text, kits: claudeOnly })).toThrow('codex is not supported here');
  });

  for (const [harness, own] of [
    ['claude', claudeRuntimesKit],
    ['codex', codexRuntimesKit],
  ] as const) {
    for (const member of ['importSetup', 'harvest', 'loginNote'] as const) {
      it(`refuses a ${harness} kit without ${member}`, () => {
        const incomplete = new Map(kits);
        incomplete.set(harness, { ...own, [member]: undefined });
        expect(() => planImport(scans, { kits: incomplete, digest: text => text })).toThrow(
          `${harness} is not supported here`,
        );
      });
    }
  }

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
        kits(this: unknown) {
          expect(this).toBe(deps.catalog);
          return current();
        },
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
    await expect(service.scan()).rejects.toThrow('claude is not supported here');
    expect(calls).toEqual([]);
    expect(requested).toEqual(['claude']);
    calls.length = 0;
    requested.length = 0;
    online = true;
    await service.scan();
    expectKits(kits);
    expect(requested).toEqual(['claude', 'codex', 'claude', 'codex']);
  });
});

describe('the refusals a route names', () => {
  const refuse = (sentence: string) => new Error(`refused: ${sentence}`);

  it('words a missing kit in the refusal of the route that asked, before any harvest', () => {
    expect(() => planImportRefusing(refuse, scans, { kits: undefined, digest: text => text })).toThrow(
      'refused: claude is not supported here',
    );
    expect(calls).toEqual([]);
  });

  it('lets any other planning failure through as it is', () => {
    const boom = new Error('boom');
    const throwing = new Map(kits).set('codex', {
      ...codexRuntimesKit,
      harvest: () => {
        throw boom;
      },
    });
    expect(() => planImportRefusing(refuse, scans, { digest: text => text, kits: throwing })).toThrow(boom);
  });

  it('words an unsupported scan in the route refusal and any other scan failure as unreadable', async () => {
    const unreadable = (error: unknown) => new Error(`unreadable: ${(error as Error).message}`);
    expect(await scansRefusing(async () => scans, refuse, unreadable)).toBe(scans);
    await expect(
      scansRefusing(
        async () => {
          throw new UnsupportedHarnessError('codex');
        },
        refuse,
        unreadable,
      ),
    ).rejects.toThrow('refused: codex is not supported here');
    await expect(scansRefusing(() => Promise.reject(new Error('disk')), refuse, unreadable)).rejects.toThrow(
      'unreadable: disk',
    );
  });
});

describe('host scan kit refusal', () => {
  const scannerOver = (kitMap: ReadonlyMap<HarnessKind, RuntimesHarnessKit> | undefined) => {
    const touched: string[] = [];
    const note = (path: string) => {
      touched.push(path);
      return undefined;
    };
    const scanner = new HostHarnessScanner({
      kits: () => kitMap,
      files: {
        stat: async path => note(path),
        lstat: async path => note(path),
        readText: async path => note(path),
        readBytes: async path => note(path),
        list: async path => note(path),
      },
      userHome: '/fixture/home',
      commands: { resolve: () => undefined },
      logins: fakeLogins([]),
      maxDocumentBytes: 1024,
    });
    return { scanner, touched };
  };

  it('refuses a missing kit map, and each harness missing its own kit or scan member, before any host read', async () => {
    const cases: [string, ReadonlyMap<HarnessKind, RuntimesHarnessKit> | undefined, string][] = [
      ['no kits', undefined, 'claude is not supported here'],
      ['no Codex kit', new Map([['claude', claudeRuntimesKit]]), 'codex is not supported here'],
      ['no Claude kit', new Map([['codex', codexRuntimesKit]]), 'claude is not supported here'],
      [
        'a Codex kit without scanHost',
        new Map([
          ['claude', claudeRuntimesKit],
          ['codex', { ...codexRuntimesKit, scanHost: undefined }],
        ]),
        'codex is not supported here',
      ],
    ];
    for (const [, kitMap, sentence] of cases) {
      const { scanner, touched } = scannerOver(kitMap);
      await expect(scanner.scan()).rejects.toThrow(sentence);
      expect(touched).toEqual([]);
    }
  });

  it('scans both harnesses with their own kits', async () => {
    const { scanner } = scannerOver(kits);
    expect((await scanner.scan()).map(found => found.harness)).toEqual(['claude', 'codex']);
  });
});
