/**
 * Mixed-fleet parity (E-276 PR 17a, review r1 [3]): for every kit a fleet can be handed with a member missing, the plan the
 * Runtimes daemon makes is BYTE-IDENTICAL to what the base (before the harness-kit close-out) made. The expected plans are
 * `fixtures/kit-member-parity.json`, captured from the base commit by running this file there with `FY_PARITY_WRITE=<path>`.
 *
 * What it pins: Claude stays available whichever of `runtimeExtras`, `ownedSkillEntries`, `fixedLayer` or `assets` its kit leaves out
 * (its refusal is a missing kit, a launch line, a command, a home variable or where its documents land, and nothing else; the three
 * destinations every harness has come from the settings file and instructions file it already names, so `assets` only adds its own);
 * Codex is refused by name when its kit leaves out any of those; and a Codex kit that is absent altogether is refused AND still has
 * its SQLite directory made. A harness's plugin being off or empty never changes what another harness's runtime does with a model
 * set (which model ids are whose is a fact that holds with a plugin off, `harness-kind.ts`). A kit that names no settings file or no
 * instructions file is still planned, to the byte (the base planned both harnesses from a table).
 */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import { EMPTY_RUNTIME_IDS } from '../../../daemon/lib/account/ids.ts';
import {
  hasComfortOf,
  keepsSharedStateOf,
  kitDocumentsOf,
  neededKitMembers,
  supportedKinds,
} from '../../../daemon/lib/harness-kind.ts';
import { materialiseFleet } from '../../../daemon/lib/account/materialise.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { FleetLayout } from '../../../daemon/lib/provisioning.ts';
import { REAL_KITS } from '../../support/real-kits.ts';

const LAYOUT: FleetLayout = {
  stateHome: '/fy',
  userHome: '/home/person',
  fleetDirectory: '/fy/fleet',
  binDirectory: '/fy/fleet/bin',
  homesDirectory: '/fy/fleet/homes',
  assetsDirectory: '/fy/fleet/assets',
  manifestPath: '/fy/fleet/manifest.json',
  defaultHomeDirectories: ['/home/person/.claude', '/home/person/.codex'],
};

const MODEL = parseAccountModel({
  version: 1,
  credentials: {
    'claude-env': { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: '${secret:SYNTH_KEY}' } },
    'codex-env': { harness: 'codex', store: 'environment', env: { OPENAI_API_KEY: '${secret:SYNTH_OTHER}' } },
  },
  components: {
    modelSets: {
      claude: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' },
      codex: { models: ['gpt-6'], default: 'gpt-6' },
    },
  },
  profiles: { default: { layers: ['modelSets/claude', 'modelSets/codex'] } },
  runtimes: {
    'claude-env': { credential: 'claude-env', profile: 'default' },
    'codex-env': { credential: 'codex-env', profile: 'default' },
  },
});

type Kits = ReadonlyMap<'claude' | 'codex', RuntimesHarnessKit> | undefined;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The plan, with every file's text and the manifest replaced by their SHA-256 so one byte of difference still shows. */
const digest = (made: unknown): unknown => {
  const result = made as {
    readonly operations: readonly { readonly kind: string; readonly path: string; readonly content?: string }[];
    readonly manifest: { readonly accounts: readonly { readonly displayName: string }[] };
    readonly [rest: string]: unknown;
  };
  return {
    ...result,
    manifest: { accounts: result.manifest.accounts, sha256: sha(JSON.stringify(result.manifest)) },
    operations: result.operations.map(operation =>
      operation.content === undefined
        ? operation
        : { ...operation, content: undefined, bytes: operation.content.length, sha256: sha(operation.content) },
    ),
  };
};

const plan = (kits: Kits): unknown => {
  const ids = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b'];
  return digest(
    materialiseFleet({
      model: MODEL,
      layout: LAYOUT,
      ids: EMPTY_RUNTIME_IDS,
      mint: () => ids.shift() ?? 'exhausted',
      generatedAt: '2026-10-13T08:00:00.000Z',
      claudeStatusline: () => "'fy' statusline",
      fyCommand: '/opt/ferretry/bin/fy',
      hostCodexHome: '/home/person/.codex',
      acceptsAutoPermissionMode: true,
      kits,
    }),
  );
};

const real = (harness: 'claude' | 'codex'): RuntimesHarnessKit => REAL_KITS.get(harness) as RuntimesHarnessKit;
const without = (kit: RuntimesHarnessKit, ...members: (keyof RuntimesHarnessKit)[]): RuntimesHarnessKit => {
  const copy: Record<string, unknown> = { ...kit };
  for (const member of members) delete copy[member];
  return copy as RuntimesHarnessKit;
};
const fleet = (claude: RuntimesHarnessKit | undefined, codex: RuntimesHarnessKit | undefined): Kits =>
  new Map([
    ...(claude === undefined ? [] : ([['claude', claude]] as const)),
    ...(codex === undefined ? [] : ([['codex', codex]] as const)),
  ]);

const PROBES: Readonly<Record<string, () => Kits>> = {
  'both real kits': () => REAL_KITS,
  'claude without runtimeExtras': () => fleet(without(real('claude'), 'runtimeExtras'), real('codex')),
  'claude without ownedSkillEntries': () => fleet(without(real('claude'), 'ownedSkillEntries'), real('codex')),
  'claude without fixedLayer': () => fleet(without(real('claude'), 'fixedLayer'), real('codex')),
  'claude without assets': () => fleet(without(real('claude'), 'assets'), real('codex')),
  'claude without all three': () =>
    fleet(without(real('claude'), 'runtimeExtras', 'ownedSkillEntries', 'fixedLayer'), real('codex')),
  'claude without settingsFile': () => fleet(without(real('claude'), 'settingsFile'), real('codex')),
  'claude without importSetup': () => fleet(without(real('claude'), 'importSetup'), real('codex')),
  'claude without its command': () => fleet(without(real('claude'), 'command'), real('codex')),
  'codex without runtimeExtras': () => fleet(real('claude'), without(real('codex'), 'runtimeExtras')),
  'codex without ownedSkillEntries': () => fleet(real('claude'), without(real('codex'), 'ownedSkillEntries')),
  'codex without fixedLayer': () => fleet(real('claude'), without(real('codex'), 'fixedLayer')),
  'codex without assets': () => fleet(real('claude'), without(real('codex'), 'assets')),
  'codex without settingsFile': () => fleet(real('claude'), without(real('codex'), 'settingsFile')),
  'codex without importSetup': () => fleet(real('claude'), without(real('codex'), 'importSetup')),
  'codex without its command': () => fleet(real('claude'), without(real('codex'), 'command')),
  'codex without keepsSharedState': () => fleet(real('claude'), without(real('codex'), 'keepsSharedState')),
  'codex an empty kit': () => fleet(real('claude'), {}),
  'codex kit absent': () => fleet(real('claude'), undefined),
  'claude kit absent': () => fleet(undefined, real('codex')),
  'no kits at all': () => undefined,
};

const FIXTURE = new URL('./fixtures/kit-member-parity.json', import.meta.url);

/**
 * A probe that has no plan of its own in the fixture because the base made, for it, exactly the plan of another: `assets` is read
 * by no base code (Claude's destinations are derived from the settings file and instructions file its kit already names, and Codex
 * without it is refused by name, as without `ownedSkillEntries`).
 */
const SAME_PLAN_AS: Readonly<Record<string, string>> = {
  'claude without assets': 'both real kits',
  'codex without assets': 'codex without ownedSkillEntries',
  // Where a profile's settings and instructions land is a fact that holds with the kit silent (`harness-kind.ts`): the base planned
  // both harnesses from a table, so a kit that names neither is still planned, and the plan is byte for byte the whole kit's.
  'claude without settingsFile': 'both real kits',
  'claude without importSetup': 'both real kits',
  'codex without settingsFile': 'both real kits',
  'codex without importSetup': 'both real kits',
};

describe('a mixed fleet whose kits leave members out', () => {
  const written = process.env.FY_PARITY_WRITE;
  const actual = Object.fromEntries(Object.entries(PROBES).map(([name, kits]) => [name, plan(kits())]));

  if (written !== undefined)
    it('should write the plans it makes, for the base to be compared with', () => {
      writeFileSync(written, `${JSON.stringify(actual, null, 2)}\n`);
    });
  else {
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
    it('should hold one expected plan per probe', () => {
      expect([...Object.keys(expected), ...Object.keys(SAME_PLAN_AS)].toSorted()).toEqual(
        Object.keys(PROBES).toSorted(),
      );
    });
    for (const name of Object.keys(PROBES))
      it(`should make the plan the base made: ${name}`, () => {
        expect(JSON.parse(JSON.stringify(actual[name]))).toEqual(expected[SAME_PLAN_AS[name] ?? name]);
      });
  }
});

describe('the facts that hold with a plugin off', () => {
  for (const kind of supportedKinds())
    it(`should agree with the ${kind} kit, so the table of words and the plugin never drift apart`, () => {
      const kit = REAL_KITS.get(kind) as RuntimesHarnessKit;
      expect(kit.keepsSharedState === true).toBe(keepsSharedStateOf(kind));
      expect(kit.comfortSettings !== undefined).toBe(hasComfortOf(kind));
      expect(kit.settingsFile).toMatchObject(kitDocumentsOf(kind).settings);
      expect(kit.importSetup?.instructionsName).toBe(kitDocumentsOf(kind).memory);
      for (const stage of ['planned', 'launched'] as const)
        for (const member of neededKitMembers(kind, stage)) expect(kit[member]).toBeDefined();
    });
});
